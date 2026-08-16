import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPostgresChronicleGenerationTransactionPort } from "../../packages/database/src/chronicle-repository.js";
import { chronicleContentHash } from "../../packages/domain/src/chronicle-memory-helpers.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { snapshotTurnRows } from "../helpers/turn-row-snapshot.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe.sequential : describe.skip;

type CampaignFixture = Readonly<{
  ownerUserId: string;
  campaignId: string;
  worldVersionId: string;
}>;

integration("PostgreSQL Chronicle chunk retrieval", () => {
  let pool: DatabasePool;
  let ownerUserId = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 6);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });

  afterEach(async () => {
    await pool.query("DELETE FROM campaigns");
    await pool.query("DELETE FROM provider_profiles");
    await pool.query("DELETE FROM world_versions");
    await pool.query("DELETE FROM worlds");
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function campaignFixture(label: string, owner = ownerUserId): Promise<CampaignFixture> {
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id,title) VALUES ($1,$2) RETURNING id",
      [owner, `${label} world`]
    );
    const worldVersion = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id,owner_user_id,version_number,content)
       VALUES ($1,$2,1,$3::jsonb) RETURNING id`,
      [world.rows[0]!.id, owner, JSON.stringify({
        world: { title: `${label} world`, rules: "Moonlight reveals what shadows conceal." },
        entities: [{ id: "moon-warden", name: "Moon Warden", aliases: ["Shade", "Future Codename"], kind: "character" }]
      })]
    );
    const campaign = await pool.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id,world_version_id,title) VALUES ($1,$2,$3) RETURNING id",
      [owner, worldVersion.rows[0]!.id, `${label} campaign`]
    );
    await pool.query(
      `INSERT INTO campaign_state
         (campaign_id,owner_user_id,scratchpad_private,scratchpad_safe_for_prompt)
       VALUES ($1,$2,'private future traitor note',false)`,
      [campaign.rows[0]!.id, owner]
    );
    return {
      ownerUserId: owner,
      campaignId: campaign.rows[0]!.id,
      worldVersionId: worldVersion.rows[0]!.id
    };
  }

  async function turn(
    fixture: CampaignFixture,
    ordinal: number,
    action: string,
    narration: string
  ): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO turns (owner_user_id,campaign_id,turn_number,action,narration,state_snapshot_private)
       VALUES ($1,$2,$3,$4,$5,'{}'::jsonb) RETURNING id`,
      [fixture.ownerUserId, fixture.campaignId, ordinal, action, narration]
    );
    return result.rows[0]!.id;
  }

  async function parent(
    fixture: CampaignFixture,
    input: Readonly<{
      turnId: string | null;
      kind: "turn_fiction" | "open_thread" | "campaign_summary";
      ordinal: number;
      content: string;
      entities?: readonly string[];
      entityIds?: readonly string[];
    }>
  ): Promise<Readonly<{ id: string; contentHash: string }>> {
    const result = await pool.query<{ id: string; content_hash: string }>(
      `INSERT INTO chronicle_memories
         (owner_user_id,campaign_id,world_version_id,turn_id,memory_kind,ordinal,content,
          token_estimate,importance,entities,entity_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,CEIL(length($7::text)/4.0),0.8,$8::text[],$9::text[])
       RETURNING id,content_hash`,
      [fixture.ownerUserId, fixture.campaignId, fixture.worldVersionId, input.turnId, input.kind,
        input.ordinal, input.content, [...(input.entities ?? [])], [...(input.entityIds ?? [])]]
    );
    return { id: result.rows[0]!.id, contentHash: result.rows[0]!.content_hash };
  }

  async function embeddedChunk(
    fixture: CampaignFixture,
    providerId: string,
    value: Readonly<{
      parentId: string;
      parentContentHash: string;
      kind: "turn_narration" | "open_thread" | "campaign_summary";
      content: string;
      vector: readonly [number, number];
      entities?: readonly string[];
      entityIds?: readonly string[];
    }>
  ): Promise<void> {
    await pool.query(
      `INSERT INTO chronicle_memory_chunks
         (owner_user_id,campaign_id,world_version_id,parent_memory_id,parent_content_hash,
          chunking_protocol_version,chunk_ordinal,chunk_kind,content,source_start_offset,source_end_offset,
          token_estimate,entities,entity_ids,embedding,embedding_status,embedding_provider_profile_id,
          embedding_model,embedding_dimensions,embedding_protocol_version,embedding_provider_fingerprint,
          embedding_content_hash,embedding_updated_at)
       VALUES ($1,$2,$3,$4,$5,'chronicle-chunk-v1',0,$6,$7,0,length($7),
               CEIL(length($7::text)/4.0),$8::text[],$9::text[],$10::vector,'embedded',$11,
               'chunk-embed-v1',2,'chronicle-embedding-v1','chunk-fingerprint',$12,now())`,
      [fixture.ownerUserId, fixture.campaignId, fixture.worldVersionId, value.parentId,
        value.parentContentHash, value.kind, value.content, [...(value.entities ?? [])],
        [...(value.entityIds ?? [])], `[${value.vector.join(",")}]`, providerId,
        chronicleContentHash(value.content)]
    );
  }

  async function configuredFixture(label: string) {
    const fixture = await campaignFixture(label);
    const provider = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles
         (owner_user_id,name,provider_type,provider_role,base_url,default_model)
       VALUES ($1,$2,'openai_compatible','embedding','http://fixture.invalid/v1','chunk-embed-v1')
       RETURNING id`,
      [ownerUserId, `${label} provider`]
    );
    const providerId = provider.rows[0]!.id;
    await pool.query(
      `INSERT INTO campaign_memory_configs
         (campaign_id,owner_user_id,embedding_enabled,embedding_provider_profile_id,embedding_model,
          retrieval_implementation,retrieval_shadow_enabled)
       VALUES ($1,$2,true,$3,'chunk-embed-v1','chunked_hybrid',false)`,
      [fixture.campaignId, ownerUserId, providerId]
    );
    return { fixture, providerId };
  }

  function transaction(providerId: string, queries: string[]) {
    return createPostgresChronicleGenerationTransactionPort({
      embeddings: {
        async resolve(_database, requested) {
          return requested.selectedProviderProfileId === providerId ? providerId : null;
        },
        async load() {
          return {
            id: providerId,
            model: "chunk-embed-v1",
            providerType: "openai_compatible",
            async embed(documents: readonly string[]) {
              return { embeddings: documents.map(() => [1, 0]), responseId: "unused", usage: {}, reportedCost: null };
            }
          };
        },
        async embed(provider, documents) {
          queries.push(...documents);
          return provider.embed(documents);
        },
        async fingerprint() { return "chunk-fingerprint"; },
        async recordHealth() {},
        async recordCost() { return null; },
        logDiagnostic() {}
      }
    });
  }

  it("fuses exact, semantic, and authorized alias ranks without future, cross-scope, or superseded leakage", async () => {
    const { fixture, providerId } = await configuredFixture("chunk fusion");
    const firstTurn = await turn(fixture, 1, "Enter the moon court.", "The Moon Warden carries the silver key.");
    const secondTurn = await turn(fixture, 2, "Wait beneath the arch.", "Rain darkens the empty stones.");
    const futureTurn = await turn(fixture, 5, "Open the sealed vault.", "The future vault answer is obsidian.");
    const target = await parent(fixture, {
      turnId: firstTurn,
      kind: "turn_fiction",
      ordinal: 1,
      content: "Turn 1\nPlayer action: Enter the moon court.\nNarration: The Moon Warden carries the silver key.",
      entities: ["Moon Warden"],
      entityIds: ["world:moon-warden"]
    });
    const current = await parent(fixture, {
      turnId: secondTurn,
      kind: "turn_fiction",
      ordinal: 2,
      content: "Turn 2\nPlayer action: Wait beneath the arch.\nNarration: Rain darkens the empty stones."
    });
    const future = await parent(fixture, {
      turnId: futureTurn,
      kind: "turn_fiction",
      ordinal: 5,
      content: "Turn 5\nNarration: The future vault answer is obsidian.",
      entities: ["Future Oracle"],
      entityIds: ["world:future-oracle"]
    });
    const openThread = await parent(fixture, {
      turnId: null,
      kind: "open_thread",
      ordinal: 2,
      content: "Discover why the Moon Warden carries the silver key.",
      entities: ["Moon Warden"],
      entityIds: ["world:moon-warden"]
    });
    await embeddedChunk(fixture, providerId, {
      parentId: target.id,
      parentContentHash: target.contentHash,
      kind: "turn_narration",
      content: "The Moon Warden carries the silver key.",
      vector: [1, 0],
      entities: ["Moon Warden"],
      entityIds: ["world:moon-warden"]
    });
    await embeddedChunk(fixture, providerId, {
      parentId: current.id,
      parentContentHash: current.contentHash,
      kind: "turn_narration",
      content: "Rain darkens the empty stones.",
      vector: [0, 1]
    });
    await embeddedChunk(fixture, providerId, {
      parentId: future.id,
      parentContentHash: future.contentHash,
      kind: "turn_narration",
      content: "The future vault answer is obsidian.",
      vector: [1, 0],
      entities: ["Future Oracle"],
      entityIds: ["world:future-oracle"]
    });
    await embeddedChunk(fixture, providerId, {
      parentId: openThread.id,
      parentContentHash: openThread.contentHash,
      kind: "open_thread",
      content: "Discover why the Moon Warden carries the silver key.",
      vector: [1, 0],
      entities: ["Moon Warden"],
      entityIds: ["world:moon-warden"]
    });

    const replacedId = crypto.randomUUID();
    const replacementId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO campaign_canonical_facts
         (id,owner_user_id,campaign_id,world_version_id,source_turn_id,source_turn_number,source_fact_index,
          content,normalized_content,valid_from_turn,valid_until_turn,superseded_by_fact_id)
       VALUES ($1,$2,$3,$4,$5,1,0,'The iron key opens the gate.','the iron key opens the gate.',1,2,$6),
              ($6,$2,$3,$4,$7,2,0,'The silver key opens the gate.','the silver key opens the gate.',2,null,null)`,
      [replacedId, ownerUserId, fixture.campaignId, fixture.worldVersionId, firstTurn, replacementId, secondTurn]
    );

    const decoy = await campaignFixture("cross campaign decoy");
    const decoyParent = await parent(decoy, {
      turnId: null,
      kind: "campaign_summary",
      ordinal: 1,
      content: "Cross campaign silver key answer."
    });
    await embeddedChunk(decoy, providerId, {
      parentId: decoyParent.id,
      parentContentHash: decoyParent.contentHash,
      kind: "campaign_summary",
      content: "Cross campaign silver key answer.",
      vector: [1, 0]
    });

    const embeddingQueries: string[] = [];
    const generation = transaction(providerId, embeddingQueries);
    const before = await snapshotTurnRows(pool, ownerUserId, fixture.campaignId);
    const preview = await generation.buildContextPreview(pool, {
      ...fixture,
      request: {
        budgetTokens: 4_096,
        compression: "auto",
        query: "Shade seeks the key [[roll d20 target 18]].",
        recentTurns: 1,
        throughTurnNumber: 2
      }
    });
    const serialized = JSON.stringify(preview.scopes);

    expect(preview).toMatchObject({
      retrieval: { implementation: "chunked_hybrid", mode: "hybrid", semanticAvailable: true }
    });
    expect(serialized).toContain("Moon Warden carries the silver key");
    expect(serialized).toContain("The silver key opens the gate");
    expect(serialized).not.toMatch(/future vault answer|Cross campaign silver key answer|iron key opens|private future traitor/i);
    expect(embeddingQueries).toHaveLength(4);
    expect(embeddingQueries.join("\n")).toContain("Moon Warden");
    expect(embeddingQueries.join("\n")).not.toMatch(
      /roll|d20|target 18|future vault answer|private future traitor|future codename/i
    );
    expect(await snapshotTurnRows(pool, ownerUserId, fixture.campaignId)).toEqual(before);

    await pool.query(
      "UPDATE campaign_memory_configs SET retrieval_implementation='legacy_hybrid' WHERE campaign_id=$1",
      [fixture.campaignId]
    );
    const legacy = await generation.buildContextPreview(pool, {
      ...fixture,
      request: { budgetTokens: 4_096, compression: "auto", query: "Shade seeks the key.", recentTurns: 1, throughTurnNumber: 2 }
    });
    await pool.query(
      "UPDATE campaign_memory_configs SET retrieval_implementation='chunked_hybrid' WHERE campaign_id=$1",
      [fixture.campaignId]
    );
    await pool.query("DELETE FROM chronicle_memory_chunks WHERE parent_memory_id=$1", [current.id]);
    const fallback = await generation.buildContextPreview(pool, {
      ...fixture,
      request: { budgetTokens: 4_096, compression: "auto", query: "Shade seeks the key.", recentTurns: 1, throughTurnNumber: 2 }
    });

    expect(fallback).toMatchObject({ retrieval: { fallbackReason: "chunk_index_not_ready" } });
    expect(fallback.scopes).toEqual(legacy.scopes);
    expect(fallback.budget).toEqual(legacy.budget);
    expect(fallback.metrics).toEqual(legacy.metrics);
    expect(await snapshotTurnRows(pool, ownerUserId, fixture.campaignId)).toEqual(before);
  });
});
