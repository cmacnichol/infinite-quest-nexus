import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPostgresChronicleGenerationTransactionPort } from "../../packages/database/src/chronicle-repository.js";
import { chronicleContentHash } from "../../packages/domain/src/chronicle-memory-helpers.js";
import { CHRONICLE_RETRIEVAL_PROFILE_V2 } from "../../packages/domain/src/generated/chronicle-retrieval-profile-v2.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import {
  createDatabasePool,
  initialOwnerId,
  type DatabaseClient,
  type DatabasePool,
  withTransaction
} from "../../packages/database/src/pool.js";
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
      id?: string;
      turnId: string | null;
      kind: "turn_fiction" | "open_thread" | "campaign_summary" | "legacy_summary" | "canonical_fact";
      ordinal: number;
      content: string;
      entities?: readonly string[];
      entityIds?: readonly string[];
      metadata?: Readonly<Record<string, unknown>>;
    }>
  ): Promise<Readonly<{ id: string; contentHash: string }>> {
    const result = await pool.query<{ id: string; content_hash: string }>(
      `INSERT INTO chronicle_memories
         (id,owner_user_id,campaign_id,world_version_id,turn_id,memory_kind,ordinal,content,
          token_estimate,importance,entities,entity_ids,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CEIL(length($8::text)/4.0),0.8,$9::text[],$10::text[],$11::jsonb)
       RETURNING id,content_hash`,
      [input.id ?? crypto.randomUUID(), fixture.ownerUserId, fixture.campaignId, fixture.worldVersionId,
        input.turnId, input.kind, input.ordinal, input.content, [...(input.entities ?? [])], [...(input.entityIds ?? [])],
        JSON.stringify(input.metadata ?? {})]
    );
    return { id: result.rows[0]!.id, contentHash: result.rows[0]!.content_hash };
  }

  async function embeddedChunk(
    fixture: CampaignFixture,
    providerId: string,
    value: Readonly<{
      id?: string;
      parentId: string;
      parentContentHash: string;
      chunkOrdinal?: number;
      kind: "turn_action" | "turn_narration" | "open_thread" | "campaign_summary" | "canonical_fact";
      content: string;
      vector: readonly [number, number];
      entities?: readonly string[];
      entityIds?: readonly string[];
    }>
  ): Promise<void> {
    const id = value.id ?? crypto.randomUUID();
    await pool.query(
      `INSERT INTO chronicle_memory_chunks
         (id,owner_user_id,campaign_id,world_version_id,parent_memory_id,parent_content_hash,
          chunking_protocol_version,chunk_ordinal,chunk_kind,content,source_start_offset,source_end_offset,
          token_estimate,entities,entity_ids,embedding,embedding_status,embedding_provider_profile_id,
          embedding_model,embedding_dimensions,embedding_protocol_version,embedding_provider_fingerprint,
          embedding_content_hash,embedding_updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'chronicle-chunk-v1',$7,$8,$9,0,length($9),
               CEIL(length($9::text)/4.0),$10::text[],$11::text[],$12::vector,'embedded',$13,
               'chunk-embed-v1',2,'chronicle-embedding-v1','chunk-fingerprint',$14,now())`,
      [id, fixture.ownerUserId, fixture.campaignId, fixture.worldVersionId, value.parentId,
        value.parentContentHash, value.chunkOrdinal ?? 0, value.kind, value.content, [...(value.entities ?? [])],
        [...(value.entityIds ?? [])], `[${value.vector.join(",")}]`, providerId,
        chronicleContentHash(value.content)]
    );
  }

  async function configuredFixture(label: string, providerRole: "embedding" | "text" = "embedding") {
    const fixture = await campaignFixture(label);
    const provider = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles
         (owner_user_id,name,provider_type,provider_role,base_url,default_model)
       VALUES ($1,$2,'openai_compatible',$3,'http://fixture.invalid/v1','chunk-embed-v1')
       RETURNING id`,
      [ownerUserId, `${label} provider`, providerRole]
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

  function transaction(
    providerId: string,
    queries: string[],
    providerRole: "embedding" | "text" = "embedding",
    configuredDimensions: number | null = 2
  ) {
    return createPostgresChronicleGenerationTransactionPort({
      embeddings: {
        async resolve(_database, requested) {
          return requested.selectedProviderProfileId === providerId
            ? {
                status: "resolved" as const,
                resolutionSource: providerRole === "embedding" ? "dedicated_embedding" as const : "text_fallback" as const,
                resolvedRole: providerRole,
                providerProfileId: providerId,
                providerType: "openai_compatible",
                model: "chunk-embed-v1"
              }
            : { status: "unconfigured" as const, resolutionSource: "none" as const, resolvedRole: null };
        },
        async load() {
          return {
            id: providerId,
            model: "chunk-embed-v1",
            providerType: "openai_compatible",
            configuration: configuredDimensions === null ? {} : { embeddingDimensions: configuredDimensions },
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
      id: "10000000-0000-4000-8000-000000000001",
      turnId: firstTurn,
      kind: "turn_fiction",
      ordinal: 1,
      content: "Turn 1\nPlayer action: Enter the moon court.\nNarration: The Moon Warden carries the silver key.",
      entities: ["Moon Warden"],
      entityIds: ["world:moon-warden"]
    });
    const current = await parent(fixture, {
      id: "10000000-0000-4000-8000-000000000002",
      turnId: secondTurn,
      kind: "turn_fiction",
      ordinal: 2,
      content: "Turn 2\nPlayer action: Wait beneath the arch.\nNarration: Rain darkens the empty stones."
    });
    const future = await parent(fixture, {
      id: "10000000-0000-4000-8000-000000000005",
      turnId: futureTurn,
      kind: "turn_fiction",
      ordinal: 5,
      content: "Turn 5\nNarration: The future vault answer is obsidian.",
      entities: ["Future Oracle"],
      entityIds: ["world:future-oracle"]
    });
    const openThread = await parent(fixture, {
      id: "10000000-0000-4000-8000-000000000003",
      turnId: null,
      kind: "open_thread",
      ordinal: 2,
      content: "Discover why the Moon Warden carries the silver key.",
      entities: ["Moon Warden"],
      entityIds: ["world:moon-warden"]
    });
    const staleLegacySummary = await parent(fixture, {
      id: "10000000-0000-4000-8000-000000000004",
      turnId: null,
      kind: "legacy_summary",
      ordinal: 0,
      content: "Full history: a later turn reveals the obsidian vault answer."
    });
    await embeddedChunk(fixture, providerId, {
      id: "20000000-0000-4000-8000-000000000001",
      parentId: target.id,
      parentContentHash: target.contentHash,
      kind: "turn_action",
      content: "Shade seeks the key.",
      vector: [1, 0],
      entities: ["Moon Warden"],
      entityIds: ["world:moon-warden"]
    });
    await embeddedChunk(fixture, providerId, {
      id: "20000000-0000-4000-8000-000000000002",
      parentId: target.id,
      parentContentHash: target.contentHash,
      chunkOrdinal: 1,
      kind: "turn_narration",
      content: "Shade seeks the key beside the Moon Warden.",
      vector: [1, 0],
      entities: ["Moon Warden"],
      entityIds: ["world:moon-warden"]
    });
    await embeddedChunk(fixture, providerId, {
      id: "20000000-0000-4000-8000-000000000006",
      parentId: staleLegacySummary.id,
      parentContentHash: staleLegacySummary.contentHash,
      kind: "campaign_summary",
      content: "Full history: a later turn reveals the obsidian vault answer.",
      vector: [1, 0]
    });
    await embeddedChunk(fixture, providerId, {
      id: "20000000-0000-4000-8000-000000000003",
      parentId: current.id,
      parentContentHash: current.contentHash,
      kind: "turn_narration",
      content: "Shade seeks the key. Turn 2 Player action Wait beneath the arch. Narration Rain darkens the empty stones. Turn 1 Player action Enter the moon court. Narration The Moon Warden carries the silver key.",
      vector: [0, 1],
      entities: ["Moon Warden"],
      entityIds: ["world:moon-warden"]
    });
    await embeddedChunk(fixture, providerId, {
      id: "20000000-0000-4000-8000-000000000007",
      parentId: future.id,
      parentContentHash: future.contentHash,
      kind: "turn_narration",
      content: "The future vault answer is obsidian.",
      vector: [1, 0],
      entities: ["Future Oracle"],
      entityIds: ["world:future-oracle"]
    });
    await embeddedChunk(fixture, providerId, {
      id: "20000000-0000-4000-8000-000000000004",
      parentId: openThread.id,
      parentContentHash: openThread.contentHash,
      kind: "open_thread",
      content: "Shade seeks the key. Discover why the Moon Warden carries the silver key.",
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
    const supersededFactParent = await parent(fixture, {
      id: "10000000-0000-4000-8000-000000000006",
      turnId: firstTurn,
      kind: "canonical_fact",
      ordinal: 1,
      content: `- [fact_id: ${replacedId}] The iron key opens the gate.`,
      metadata: { structuredFactIds: [replacedId] }
    });
    const activeFactParent = await parent(fixture, {
      id: "10000000-0000-4000-8000-000000000007",
      turnId: secondTurn,
      kind: "canonical_fact",
      ordinal: 2,
      content: `- [fact_id: ${replacementId}] The silver key opens the gate.`,
      metadata: { structuredFactIds: [replacementId] }
    });
    await embeddedChunk(fixture, providerId, {
      id: "20000000-0000-4000-8000-000000000008",
      parentId: supersededFactParent.id,
      parentContentHash: supersededFactParent.contentHash,
      kind: "canonical_fact",
      content: "The iron key opens the gate.",
      vector: [1, 0]
    });
    await embeddedChunk(fixture, providerId, {
      id: "20000000-0000-4000-8000-000000000009",
      parentId: activeFactParent.id,
      parentContentHash: activeFactParent.contentHash,
      kind: "canonical_fact",
      content: "The silver key opens the gate.",
      vector: [1, 0]
    });
    await pool.query(
      `UPDATE chronicle_memories
          SET embedding='[1,0]'::vector,embedding_provider_profile_id=$2,
              embedding_model='chunk-embed-v1',embedding_dimensions=2,
              embedding_provider_fingerprint='chunk-fingerprint',
              embedding_content_hash=content_hash,embedding_updated_at=now()
        WHERE id=$1`,
      [supersededFactParent.id, providerId]
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
    const currentFacts = await generation.buildContextPreview(pool, {
      ...fixture,
      request: { budgetTokens: 4_096, compression: "auto", query: "key opens the gate", recentTurns: 1 }
    });
    const currentFactChronicle = (currentFacts.scopes as {
      chronicle: Array<{ content: string; semanticRelevance: number | null }>;
    }).chronicle;
    const activeFact = currentFactChronicle.find((memory) => memory.content.includes("The silver key opens the gate"));
    expect(activeFact?.semanticRelevance).toEqual(expect.any(Number));
    expect(Number(activeFact?.semanticRelevance)).toBeGreaterThan(0);
    expect(currentFactChronicle.some((memory) => memory.content.includes("The iron key opens the gate"))).toBe(false);

    embeddingQueries.length = 0;
    const historicalSummary = await generation.buildContextPreview(pool, {
      ...fixture,
      request: {
        budgetTokens: 4_096,
        compression: "summary",
        query: "obsidian vault answer",
        recentTurns: 1,
        throughTurnNumber: 2
      }
    });
    expect.soft(JSON.stringify(historicalSummary.scopes)).not.toContain("later turn reveals the obsidian vault answer");

    embeddingQueries.length = 0;
    const statements: string[] = [];
    const batchRequests = {
      semantic: [
        { signal: "semantic", variant: "action" },
        { signal: "semantic", variant: "entity_expanded" },
        { signal: "semantic", variant: "scene" },
        { signal: "semantic", variant: "open_thread" }
      ],
      full_text: [
        { signal: "full_text", variant: "action" },
        { signal: "full_text", variant: "entity_expanded" },
        { signal: "full_text", variant: "scene" },
        { signal: "full_text", variant: "open_thread" }
      ],
      entity: [{ signal: "entity", variant: "entity_expanded" }],
      static: [
        { signal: "recency", variant: "action" },
        { signal: "chronology", variant: "action" },
        { signal: "importance", variant: "action" },
        { signal: "kind", variant: "action" },
        { signal: "temporal", variant: "action" }
      ]
    } as const;
    const batchRows: Array<Readonly<{
      family: keyof typeof batchRequests;
      requestOrdinal: number;
      signal: string;
      variant: string;
      candidateId: string;
      parentMemoryId: string;
      signalRank: number;
    }>> = [];
    const preview = await withTransaction(pool, async (database) => {
      const intercepted = new Proxy(database, {
        get(target, property) {
          if (property === "query") {
            return async (statement: unknown, values?: readonly unknown[]) => {
              if (typeof statement === "string") statements.push(statement);
              const result = await target.query(statement as never, values as never);
              const family = typeof statement === "string"
                ? statement.match(/chronicle_rank_batch:(semantic|full_text|entity|static)/)?.[1]
                : undefined;
              if (family) {
                const typedFamily = family as keyof typeof batchRequests;
                for (const row of result.rows as unknown as Array<Record<string, unknown>>) {
                  const requestOrdinal = Number(row.request_ordinal);
                  const request = batchRequests[typedFamily][requestOrdinal];
                  if (!request) continue;
                  batchRows.push({
                    family: typedFamily,
                    requestOrdinal,
                    signal: request.signal,
                    variant: request.variant,
                    candidateId: String(row.candidate_id),
                    parentMemoryId: String(row.parent_memory_id),
                    signalRank: Number(row.signal_rank)
                  });
                }
              }
              return result;
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        }
      }) as DatabaseClient;
      return generation.buildContextPreview(intercepted, {
        ...fixture,
        request: {
          budgetTokens: 4_096,
          compression: "auto",
          query: "Shade seeks the key [[roll d20 target 18]].",
          recentTurns: 1,
          throughTurnNumber: 2
        }
      });
    });
    const serialized = JSON.stringify(preview.scopes);

    expect(preview).toMatchObject({
      retrieval: {
        implementation: "chunked_hybrid",
        mode: "hybrid",
        semanticAvailable: true,
        diversity: {
          candidateChunks: expect.any(Number),
          candidateParents: expect.any(Number),
          collapsedChunks: expect.any(Number),
          selectedParents: expect.any(Number),
          latestSceneParentsProtected: 1
        }
      },
      chronicleRetrieval: {
        configuredImplementation: "chunked_hybrid",
        effectiveImplementation: "chunked_hybrid",
        effectiveMode: "semantic_hybrid",
        provider: { resolutionSource: "dedicated_embedding", resolvedRole: "embedding" },
        queryVectorPath: "provider_only"
      }
    });
    const diversity = (preview.retrieval as { diversity: { collapsedChunks: number } }).diversity;
    expect(diversity.collapsedChunks).toBeGreaterThan(0);
    const targetParents = (preview.scopes as { chronicle: Array<{ id: string; content: string }> }).chronicle
      .filter((memory) => memory.id === target.id);
    expect((preview.scopes as { chronicle: Array<{ id: string }> }).chronicle.map((entry) => entry.id))
      .toEqual([target.id, ...[openThread.id, replacementId].sort()]);
    expect(statements.filter((sql) => sql.includes("chronicle_rank_batch:"))).toHaveLength(4);
    expect(statements.some((sql) => sql.includes("chronicle_rank:"))).toBe(false);
    expect(new Set(statements.flatMap((sql) => (
      sql.match(/chronicle_rank_batch:(semantic|full_text|entity|static)/)?.[1] ?? []
    )))).toEqual(new Set(["semantic", "full_text", "entity", "static"]));
    expect(statements.filter((sql) => /chronicle_rank_batch:(semantic|full_text|entity)/.test(sql))
      .every((sql) => sql.includes("request_variants(request_ordinal,variant_kind,"))).toBe(true);
    const rankedRows = (
      family: keyof typeof batchRequests,
      requestOrdinal: number,
      signal: string,
      variant: string,
      candidates: ReadonlyArray<readonly [candidateId: string, parentMemoryId: string]>
    ) => candidates.map(([candidateId, parentMemoryId], index) => ({
      family,
      requestOrdinal,
      signal,
      variant,
      candidateId,
      parentMemoryId,
      signalRank: index + 1
    }));
    const targetAction = ["20000000-0000-4000-8000-000000000001", target.id] as const;
    const targetNarration = ["20000000-0000-4000-8000-000000000002", target.id] as const;
    const currentNarration = ["20000000-0000-4000-8000-000000000003", current.id] as const;
    const openThreadChunk = ["20000000-0000-4000-8000-000000000004", openThread.id] as const;
    expect(batchRows).toEqual([
      ...rankedRows("semantic", 0, "semantic", "action", [targetAction, targetNarration, openThreadChunk, currentNarration]),
      ...rankedRows("semantic", 1, "semantic", "entity_expanded", [targetAction, targetNarration, openThreadChunk, currentNarration]),
      ...rankedRows("semantic", 2, "semantic", "scene", [targetAction, targetNarration, openThreadChunk, currentNarration]),
      ...rankedRows("semantic", 3, "semantic", "open_thread", [targetAction, targetNarration, openThreadChunk, currentNarration]),
      ...rankedRows("full_text", 0, "full_text", "action", [targetAction, targetNarration, currentNarration, openThreadChunk]),
      ...rankedRows("full_text", 1, "full_text", "entity_expanded", [targetNarration, openThreadChunk, currentNarration]),
      ...rankedRows("full_text", 2, "full_text", "scene", [currentNarration]),
      ...rankedRows("full_text", 3, "full_text", "open_thread", [openThreadChunk]),
      ...rankedRows("entity", 0, "entity", "entity_expanded", [targetAction, targetNarration, currentNarration, openThreadChunk]),
      ...rankedRows("static", 0, "recency", "action", [currentNarration, openThreadChunk, targetAction, targetNarration]),
      ...rankedRows("static", 1, "chronology", "action", [targetAction, targetNarration, currentNarration, openThreadChunk]),
      ...rankedRows("static", 2, "importance", "action", [currentNarration, openThreadChunk, targetAction, targetNarration]),
      ...rankedRows("static", 3, "kind", "action", [openThreadChunk, currentNarration, targetAction, targetNarration]),
      ...rankedRows("static", 4, "temporal", "action", [currentNarration, openThreadChunk, targetAction, targetNarration])
    ]);
    expect(targetParents).toHaveLength(1);
    expect(targetParents[0]?.content).toMatch(/Player action:[\s\S]+Narration:/);
    expect(targetParents[0]?.content).not.toBe("The Moon Warden carries the silver key.");
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
      request: { budgetTokens: 4_096, compression: "auto", query: "iron key opens the gate", recentTurns: 1, throughTurnNumber: 2 }
    });
    await pool.query(
      "UPDATE campaign_memory_configs SET retrieval_implementation='chunked_hybrid' WHERE campaign_id=$1",
      [fixture.campaignId]
    );
    await pool.query("DELETE FROM chronicle_memory_chunks WHERE parent_memory_id=$1", [current.id]);
    const fallback = await generation.buildContextPreview(pool, {
      ...fixture,
      request: { budgetTokens: 4_096, compression: "auto", query: "iron key opens the gate", recentTurns: 1, throughTurnNumber: 2 }
    });

    expect(fallback).toMatchObject({
      retrieval: { fallbackReason: "chunk_index_not_ready" },
      chronicleRetrieval: {
        configuredImplementation: "chunked_hybrid",
        effectiveImplementation: "legacy_hybrid",
        effectiveMode: "lexical_only",
        fallbackCode: "chunk_index_not_ready"
      }
    });
    expect(legacy).toMatchObject({
      retrieval: { semanticAvailable: false, fallbackReason: "semantic_retrieval_unavailable" }
    });
    expect(JSON.stringify(legacy.scopes)).not.toContain("The iron key opens the gate");
    expect(JSON.stringify(fallback.scopes)).not.toContain("The iron key opens the gate");
    expect(fallback.scopes).toEqual(legacy.scopes);
    expect(fallback.budget).toEqual(legacy.budget);
    expect(fallback.metrics).toEqual(legacy.metrics);
    expect(await snapshotTurnRows(pool, ownerUserId, fixture.campaignId)).toEqual(before);
  });

  it("uses the generated profile only after a campaign explicitly opts into chunked retrieval", async () => {
    const { fixture, providerId } = await configuredFixture("generated profile gate");
    const summary = await parent(fixture, {
      turnId: null,
      kind: "campaign_summary",
      ordinal: 1,
      content: "The generated profile gate remembers the moonlit crossing."
    });
    await embeddedChunk(fixture, providerId, {
      parentId: summary.id,
      parentContentHash: summary.contentHash,
      kind: "campaign_summary",
      content: "The generated profile gate remembers the moonlit crossing.",
      vector: [1, 0]
    });
    const rankLimits: number[] = [];
    const generation = transaction(providerId, []);
    const preview = async () => withTransaction(pool, async (database) => {
      const intercepted = new Proxy(database, {
        get(target, property) {
          if (property === "query") {
            return (statement: unknown, values?: readonly unknown[]) => {
              if (typeof statement === "string" && statement.includes("/* chronicle_rank_batch:")) {
                const parameter = Number(statement.match(/LIMIT \$(\d+)/)?.[1]);
                rankLimits.push(Number(values?.[parameter - 1]));
              }
              return target.query(statement as never, values as never);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        }
      }) as DatabaseClient;
      return generation.buildContextPreview(intercepted, {
        ...fixture,
        request: {
          budgetTokens: 4_096,
          compression: "auto",
          query: "Where is the moonlit crossing?",
          recentTurns: 1
        }
      });
    });

    await pool.query(
      "UPDATE campaign_memory_configs SET retrieval_implementation='legacy_hybrid' WHERE campaign_id=$1",
      [fixture.campaignId]
    );
    const legacy = await preview();
    expect(legacy).toMatchObject({ retrieval: { implementation: "legacy_hybrid" } });
    expect(rankLimits).toEqual([]);

    await pool.query(
      "UPDATE campaign_memory_configs SET retrieval_implementation='chunked_hybrid' WHERE campaign_id=$1",
      [fixture.campaignId]
    );
    const chunked = await preview();
    expect(chunked).toMatchObject({ retrieval: { implementation: "chunked_hybrid" } });
    expect(rankLimits.length).toBeGreaterThan(0);
    expect(new Set(rankLimits)).toEqual(new Set([CHRONICLE_RETRIEVAL_PROFILE_V2.candidateLimits.perSignal]));
  });

  it("applies one effective diversity selection to cutoff-valid historical canonical parents", async () => {
    const { fixture, providerId } = await configuredFixture("historical canonical diversity");
    const sameTurnId = await turn(
      fixture,
      2,
      "Review the moon court records.",
      "Three surviving facts are written beneath the arch."
    );
    const duplicateFactId = crypto.randomUUID();
    const lineageFactId = crypto.randomUUID();
    const turnLimitFactId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO campaign_canonical_facts
         (id,owner_user_id,campaign_id,world_version_id,source_turn_id,source_turn_number,source_fact_index,
          content,normalized_content,valid_from_turn,valid_until_turn,superseded_by_fact_id)
       VALUES ($1,$4,$5,$6,$7,2,0,'Café gate opens.','café gate opens.',2,null,null),
              ($2,$4,$5,$6,$7,2,1,'The river oath binds the Moon Warden.',
               'the river oath binds the moon warden.',2,null,null),
              ($3,$4,$5,$6,$7,2,2,'The third surviving fact remains distinct.',
               'the third surviving fact remains distinct.',2,null,null)`,
      [duplicateFactId, lineageFactId, turnLimitFactId, fixture.ownerUserId, fixture.campaignId,
        fixture.worldVersionId, sameTurnId]
    );
    const duplicateParent = await parent(fixture, {
      turnId: sameTurnId,
      kind: "open_thread",
      ordinal: 2,
      content: `- [fact_id: ${duplicateFactId}] CAFE\u0301 GATE OPENS.`,
      metadata: { structuredFactIds: [duplicateFactId] }
    });
    const lineageParent = await parent(fixture, {
      turnId: sameTurnId,
      kind: "campaign_summary",
      ordinal: 2,
      content: "An unrelated inscription is filed here.",
      metadata: { structuredFactIds: [lineageFactId] }
    });
    await embeddedChunk(fixture, providerId, {
      parentId: duplicateParent.id,
      parentContentHash: duplicateParent.contentHash,
      kind: "open_thread",
      content: "CAFE\u0301 GATE OPENS.",
      vector: [1, 0]
    });
    await embeddedChunk(fixture, providerId, {
      parentId: lineageParent.id,
      parentContentHash: lineageParent.contentHash,
      kind: "campaign_summary",
      content: "An unrelated inscription is filed here.",
      vector: [0, 1]
    });

    const preview = await transaction(providerId, []).buildContextPreview(pool, {
      ...fixture,
      request: {
        budgetTokens: 4_096,
        compression: "auto",
        query: "café gate",
        recentTurns: 1,
        throughTurnNumber: 2
      }
    });
    const renderedParents = (preview.scopes as {
      chronicle: Array<{ id: string; turnId: string | null; kind: string }>;
    }).chronicle;
    const retrieval = preview.retrieval as {
      implementation: string;
      diversity: Record<string, number>;
    };

    expect(renderedParents).toHaveLength(2);
    expect(renderedParents.every((memory) => memory.turnId === sameTurnId)).toBe(true);
    expect(retrieval.implementation).toBe("chunked_hybrid");
    expect(retrieval.diversity).toEqual({
      candidateChunks: 5,
      candidateParents: 5,
      collapsedChunks: 0,
      canonicalLineagesCollapsed: 1,
      normalizedDuplicatesRemoved: 1,
      latestSceneParentsProtected: 0,
      semanticPenaltiesApplied: 0,
      selectedKinds: 2,
      selectedEntityIds: 0,
      turnLimitParentsRemoved: 1,
      selectedParents: 2
    });
  });

  it("fails closed instead of throwing for malformed canonical parent metadata", async () => {
    const { fixture, providerId } = await configuredFixture("malformed canonical metadata");
    await parent(fixture, {
      turnId: null,
      kind: "canonical_fact",
      ordinal: 1,
      content: "Malformed canonical metadata must not enter context.",
      metadata: { structuredFactIds: "not-an-array" }
    });

    const preview = await transaction(providerId, []).buildContextPreview(pool, {
      ...fixture,
      request: { budgetTokens: 4_096, compression: "auto", query: "malformed canonical", recentTurns: 1 }
    });

    expect(JSON.stringify(preview.scopes)).not.toContain("Malformed canonical metadata must not enter context");
  });

  it("uses the complete legacy path without chunk ranks when every current chunk is sanitized-skipped", async () => {
    const { fixture, providerId } = await configuredFixture("all skipped readiness");
    const memory = await parent(fixture, {
      turnId: null,
      kind: "campaign_summary",
      ordinal: 1,
      content: "The all-skipped archive remembers the amber lantern."
    });
    await embeddedChunk(fixture, providerId, {
      parentId: memory.id,
      parentContentHash: memory.contentHash,
      kind: "campaign_summary",
      content: "The all-skipped archive remembers the amber lantern.",
      vector: [1, 0]
    });
    await pool.query(
      `UPDATE chronicle_memory_chunks
          SET embedding=NULL,embedding_status='skipped',embedding_skip_reason='chunk_embedding_skipped',
              embedding_provider_profile_id=NULL,embedding_model=NULL,embedding_dimensions=NULL,
              embedding_protocol_version=NULL,embedding_provider_fingerprint=NULL,
              embedding_content_hash=NULL,embedding_updated_at=NULL
        WHERE parent_memory_id=$1`,
      [memory.id]
    );
    const generation = transaction(providerId, []);
    const request = {
      ...fixture,
      request: { budgetTokens: 4_096, compression: "auto" as const, query: "amber lantern", recentTurns: 1 }
    };
    await pool.query(
      "UPDATE campaign_memory_configs SET retrieval_implementation='legacy_hybrid' WHERE campaign_id=$1",
      [fixture.campaignId]
    );
    const legacy = await generation.buildContextPreview(pool, request);
    await pool.query(
      "UPDATE campaign_memory_configs SET retrieval_implementation='chunked_hybrid' WHERE campaign_id=$1",
      [fixture.campaignId]
    );
    const chunkRankStatements: string[] = [];
    const actual = await withTransaction(pool, async (database) => {
      const intercepted = new Proxy(database, {
        get(target, property) {
          if (property === "query") {
            return (statement: unknown, values?: readonly unknown[]) => {
              if (typeof statement === "string" && statement.includes("/* chronicle_rank_batch:")) {
                chunkRankStatements.push(statement);
              }
              return target.query(statement as never, values as never);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        }
      }) as DatabaseClient;
      return generation.buildContextPreview(intercepted, request);
    });

    expect(actual).toMatchObject({ retrieval: { fallbackReason: "chunk_index_not_ready" } });
    expect(actual.scopes).toEqual(legacy.scopes);
    expect(actual.budget).toEqual(legacy.budget);
    expect(actual.metrics).toEqual(legacy.metrics);
    expect(chunkRankStatements).toEqual([]);
  });

  it("bounds legacy chronological coverage with a text-role embedding provider while still spanning long history", async () => {
    const { fixture, providerId } = await configuredFixture("long legacy campaign", "text");
    await pool.query(
      "UPDATE campaign_memory_configs SET retrieval_implementation='legacy_hybrid' WHERE campaign_id=$1",
      [fixture.campaignId]
    );
    const turnCount = 120;
    for (let turn = 1; turn <= turnCount; turn += 1) {
      const created = await pool.query<{ id: string }>(
        `INSERT INTO turns (owner_user_id,campaign_id,turn_number,action,narration,state_snapshot_private,accepted_at)
         VALUES ($1,$2,$3,$4,$5,'{}'::jsonb,now()) RETURNING id`,
        [fixture.ownerUserId, fixture.campaignId, turn, `Action ${turn}.`, `The company records passage ${turn}.`]
      );
      await pool.query(
        `INSERT INTO chronicle_memories
           (owner_user_id,campaign_id,world_version_id,turn_id,memory_kind,ordinal,content,token_estimate,importance)
         VALUES ($1,$2,$3,$4,'turn_fiction',$5,$6,12,0.5)`,
        [fixture.ownerUserId, fixture.campaignId, fixture.worldVersionId, created.rows[0]!.id, turn,
          `The company records passage ${turn}.`]
      );
    }
    await pool.query("UPDATE campaigns SET active_turn_number=$2 WHERE id=$1", [fixture.campaignId, turnCount]);

    const embeddingQueries: string[] = [];
    const preview = await transaction(providerId, embeddingQueries, "text").buildContextPreview(pool, {
      ...fixture,
      request: { budgetTokens: 32_000, compression: "auto" as const, query: "passage", recentTurns: 8 }
    });

    const chronicle = (preview.scopes as {
      chronicle: readonly Readonly<{ ordinal: number; reason: string }>[];
    }).chronicle;
    const chronological = chronicle.filter((entry) => entry.reason === "chronological");
    // Previously every turn memory was added and only the token budget trimmed the prompt, so
    // the Chronicle scope grew with campaign length and crowded out relevance-selected entries.
    expect(chronological.length).toBeLessThanOrEqual(32);
    expect(chronicle.length).toBeLessThan(turnCount);
    // The sweep reaches the start of the campaign and most of the way to its end; the final
    // turns are claimed earlier by the dedicated recency selection rather than by this sweep.
    const ordinals = chronological.map((entry) => entry.ordinal);
    expect(Math.min(...ordinals)).toBeLessThanOrEqual(5);
    expect(Math.max(...ordinals)).toBeGreaterThanOrEqual(Math.floor(turnCount * 0.7));
    // The newest accepted turn is rendered as the current scene rather than Chronicle history,
    // so recency selection reaches the turn immediately before it.
    expect(chronicle.some((entry) => entry.ordinal >= turnCount - 1)).toBe(true);
    expect(embeddingQueries).toHaveLength(1);
    expect(preview.chronicleRetrieval).toMatchObject({
      configuredImplementation: "legacy_hybrid",
      effectiveImplementation: "legacy_hybrid",
      effectiveMode: "lexical_only",
      fallbackCode: "semantic_retrieval_unavailable",
      provider: { resolutionSource: "text_fallback", resolvedRole: "text" },
      queryVectorPath: "provider_only",
      providerCallOutcome: "succeeded",
      queryEmbeddingRequests: 1
    });
  });

  it("loads candidate vectors once instead of rendering them in every rank query", async () => {
    const { fixture, providerId } = await configuredFixture("vector loading");
    const memory = await parent(fixture, {
      turnId: null,
      kind: "campaign_summary",
      ordinal: 1,
      content: "The lantern keeper recorded the amber ledger."
    });
    await embeddedChunk(fixture, providerId, {
      parentId: memory.id,
      parentContentHash: memory.contentHash,
      kind: "campaign_summary",
      content: "The lantern keeper recorded the amber ledger.",
      vector: [1, 0]
    });
    await pool.query(
      "UPDATE campaign_memory_configs SET retrieval_implementation='chunked_hybrid' WHERE campaign_id=$1",
      [fixture.campaignId]
    );

    const rankStatements: string[] = [];
    const vectorLoads: string[] = [];
    const generation = transaction(providerId, []);
    const preview = await withTransaction(pool, async (database) => {
      const intercepted = new Proxy(database, {
        get(target, property) {
          if (property === "query") {
            return (statement: unknown, values?: readonly unknown[]) => {
              if (typeof statement === "string") {
                if (statement.includes("/* chronicle_rank_batch:")) rankStatements.push(statement);
                if (statement.includes("embedding::text AS embedding")) vectorLoads.push(statement);
              }
              return target.query(statement as never, values as never);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
      return generation.buildContextPreview(intercepted as typeof database, {
        ...fixture,
        request: { budgetTokens: 4_096, compression: "auto" as const, query: "amber ledger", recentTurns: 1 }
      });
    });

    expect(preview.retrieval).toMatchObject({ implementation: "chunked_hybrid" });
    expect(rankStatements.length).toBeGreaterThan(1);
    // Rendering the campaign's vectors as text inside each rank query made retrieval latency
    // grow with campaign length; they are now fetched once for the fused candidate set.
    for (const statement of rankStatements) {
      expect(statement).not.toContain("embedding::text");
    }
    expect(vectorLoads).toHaveLength(1);
  });

  it.each([
    {
      failure: "times out",
      embed: async () => { throw new Error("fixture text embedding request timed out"); }
    },
    {
      failure: "returns a malformed vector",
      embed: async () => ({ embeddings: [[]], responseId: "malformed", usage: {}, reportedCost: null })
    },
    {
      failure: "returns an incompatible vector dimension",
      embed: async () => ({ embeddings: [[1, 0, 0]], responseId: "wrong-dimension", usage: {}, reportedCost: null })
    },
    {
      failure: "returns an all-zero vector",
      embed: async () => ({ embeddings: [[0, 0]], responseId: "zero-vector", usage: {}, reportedCost: null })
    }
  ])("uses the complete legacy path when an eligible text provider $failure for a ready chunk query", async ({ failure, embed }) => {
    const { fixture, providerId } = await configuredFixture(`text provider runtime fallback ${failure}`, "text");
    const memory = await parent(fixture, {
      turnId: null,
      kind: "campaign_summary",
      ordinal: 1,
      content: "The legacy fallback ledger remembers the cobalt lantern."
    });
    await embeddedChunk(fixture, providerId, {
      parentId: memory.id,
      parentContentHash: memory.contentHash,
      kind: "campaign_summary",
      content: "The legacy fallback ledger remembers the cobalt lantern.",
      vector: [1, 0]
    });
    const request = {
      ...fixture,
      request: {
        budgetTokens: 4_096,
        compression: "auto" as const,
        query: "cobalt lantern",
        recentTurns: 1
      }
    };
    let embeddingAttempts = 0;
    const generation = createPostgresChronicleGenerationTransactionPort({
      embeddings: {
        async resolve(_database, requested) {
          return requested.selectedProviderProfileId === providerId
            ? { status: "resolved" as const, resolutionSource: "text_fallback" as const, resolvedRole: "text" as const, providerProfileId: providerId, providerType: "openai_compatible", model: "chunk-embed-v1" }
            : { status: "unconfigured" as const, resolutionSource: "none" as const, resolvedRole: null };
        },
        async load() {
          return {
            id: providerId,
            model: "chunk-embed-v1",
            providerType: "openai_compatible",
            configuration: {},
            embed
          };
        },
        async embed(provider, documents) {
          embeddingAttempts += 1;
          return provider.embed(documents);
        },
        async fingerprint() { return "chunk-fingerprint"; },
        async recordHealth() {},
        async recordCost() { return null; },
        logDiagnostic() {}
      }
    });
    await pool.query(
      `UPDATE campaign_memory_configs
          SET retrieval_implementation='legacy_hybrid',embedding_enabled=false
        WHERE campaign_id=$1`,
      [fixture.campaignId]
    );
    const legacy = await generation.buildContextPreview(pool, request);
    await pool.query(
      `UPDATE campaign_memory_configs
          SET retrieval_implementation='chunked_hybrid',embedding_enabled=true
        WHERE campaign_id=$1`,
      [fixture.campaignId]
    );
    const chunkRankStatements: string[] = [];
    const actual = await withTransaction(pool, async (database) => {
      const intercepted = new Proxy(database, {
        get(target, property) {
          if (property === "query") {
            return (statement: unknown, values?: readonly unknown[]) => {
              if (typeof statement === "string" && statement.includes("/* chronicle_rank_batch:")) {
                chunkRankStatements.push(statement);
              }
              return target.query(statement as never, values as never);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        }
      }) as DatabaseClient;
      return generation.buildContextPreview(intercepted, request);
    });

    expect(actual).toMatchObject({
      retrieval: {
        implementation: "chunked_hybrid",
        mode: "lexical_fallback",
        semanticAvailable: false,
        fallbackReason: "semantic_retrieval_unavailable"
      },
      chronicleRetrieval: {
        configuredImplementation: "chunked_hybrid",
        effectiveImplementation: "legacy_hybrid",
        effectiveMode: "lexical_only",
        fallbackCode: "semantic_retrieval_unavailable",
        provider: { resolutionSource: "text_fallback", resolvedRole: "text" },
        queryVectorPath: "provider_only",
        providerCallOutcome: "failed",
        queryEmbeddingRequests: 1,
        queryCacheHits: 0,
        queryCacheMisses: 1
      }
    });
    expect(actual.scopes).toEqual(legacy.scopes);
    expect(actual.budget).toEqual(legacy.budget);
    expect(actual.metrics).toEqual(legacy.metrics);
    expect(embeddingAttempts).toBe(1);
    expect(chunkRankStatements).toEqual([]);
    const cached = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM chronicle_query_embedding_cache WHERE campaign_id=$1",
      [fixture.campaignId]
    );
    expect(cached.rows[0]?.count).toBe("0");
  });

  it("excludes a stale mixed-dimension chunk from inference before Legacy fallback embeds the query", async () => {
    const { fixture, providerId } = await configuredFixture("stale chunk dimension inference", "text");
    const memory = await parent(fixture, {
      turnId: null,
      kind: "campaign_summary",
      ordinal: 1,
      content: "The legacy fallback ledger remembers the violet lantern."
    });
    await embeddedChunk(fixture, providerId, {
      parentId: memory.id,
      parentContentHash: memory.contentHash,
      kind: "campaign_summary",
      content: "The legacy fallback ledger remembers the violet lantern.",
      vector: [1, 0]
    });
    await embeddedChunk(fixture, providerId, {
      parentId: memory.id,
      parentContentHash: memory.contentHash,
      chunkOrdinal: 1,
      kind: "campaign_summary",
      content: "A stale duplicate chunk must not influence inferred dimensions.",
      vector: [0, 1]
    });
    await pool.query(
      `UPDATE chronicle_memory_chunks
          SET embedding='[1,0,0]'::vector,embedding_dimensions=3,embedding_content_hash=NULL
        WHERE parent_memory_id=$1 AND chunk_ordinal=1`,
      [memory.id]
    );
    const request = {
      ...fixture,
      request: {
        budgetTokens: 4_096,
        compression: "auto" as const,
        query: "violet lantern",
        recentTurns: 1
      }
    };
    let embeddingAttempts = 0;
    const generation = createPostgresChronicleGenerationTransactionPort({
      embeddings: {
        async resolve() {
          return {
            status: "resolved" as const,
            resolutionSource: "text_fallback" as const,
            resolvedRole: "text" as const,
            providerProfileId: providerId,
            providerType: "openai_compatible",
            model: "chunk-embed-v1"
          };
        },
        async load() {
          return {
            id: providerId,
            model: "chunk-embed-v1",
            providerType: "openai_compatible",
            configuration: {},
            async embed() {
              return { embeddings: [[1, 0, 0]], responseId: "wrong-dimension", usage: {}, reportedCost: null };
            }
          };
        },
        async embed(provider, documents) {
          embeddingAttempts += 1;
          return provider.embed(documents);
        },
        async fingerprint() { return "chunk-fingerprint"; },
        async recordHealth() {},
        async recordCost() { return null; },
        logDiagnostic() {}
      }
    });
    await pool.query(
      "UPDATE campaign_memory_configs SET retrieval_implementation='legacy_hybrid',embedding_enabled=false WHERE campaign_id=$1",
      [fixture.campaignId]
    );
    const legacy = await generation.buildContextPreview(pool, request);
    await pool.query(
      "UPDATE campaign_memory_configs SET retrieval_implementation='chunked_hybrid',embedding_enabled=true WHERE campaign_id=$1",
      [fixture.campaignId]
    );
    const inferredDimensionRows: unknown[] = [];
    const chunkRankStatements: string[] = [];
    const actual = await withTransaction(pool, async (database) => {
      const intercepted = new Proxy(database, {
        get(target, property) {
          if (property === "query") {
            return async (statement: unknown, values?: readonly unknown[]) => {
              if (typeof statement === "string" && statement.includes("/* chronicle_rank_batch:")) {
                chunkRankStatements.push(statement);
              }
              const result = await target.query(statement as never, values as never);
              if (typeof statement === "string" && statement.includes("FROM chronicle_memory_chunks chunk")
                && statement.includes("END AS expected_dimensions")
                && !statement.includes("AS chunk_index_ready")) {
                inferredDimensionRows.push(...result.rows);
              }
              return result;
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        }
      }) as DatabaseClient;
      return generation.buildContextPreview(intercepted, request);
    });

    expect(inferredDimensionRows).toEqual([{ expected_dimensions: 2 }]);
    expect(actual.scopes).toEqual(legacy.scopes);
    expect(actual.budget).toEqual(legacy.budget);
    expect(actual.chronicleRetrieval).toMatchObject({
      configuredImplementation: "chunked_hybrid",
      effectiveImplementation: "legacy_hybrid",
      effectiveMode: "lexical_only",
      fallbackCode: "chunk_index_not_ready",
      provider: { resolutionSource: "text_fallback", resolvedRole: "text" },
      queryVectorPath: "provider_only",
      providerCallOutcome: "failed",
      queryEmbeddingRequests: 1,
      queryCacheHits: 0,
      queryCacheMisses: 1
    });
    expect(embeddingAttempts).toBe(1);
    expect(chunkRankStatements).toEqual([]);
    const cached = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM chronicle_query_embedding_cache WHERE campaign_id=$1",
      [fixture.campaignId]
    );
    expect(cached.rows[0]?.count).toBe("0");
  });

  it("treats a stale incompatible cached chunk query vector as a miss and replaces it from the provider", async () => {
    const { fixture, providerId } = await configuredFixture("stale chunk query cache");
    const memory = await parent(fixture, {
      turnId: null,
      kind: "campaign_summary",
      ordinal: 1,
      content: "The amber lantern marks the safe archive crossing."
    });
    await embeddedChunk(fixture, providerId, {
      parentId: memory.id,
      parentContentHash: memory.contentHash,
      kind: "campaign_summary",
      content: "The amber lantern marks the safe archive crossing.",
      vector: [1, 0]
    });
    const queries: string[] = [];
    const generation = transaction(providerId, queries, "embedding", null);
    const request = {
      ...fixture,
      request: { budgetTokens: 4_096, compression: "auto" as const, query: "amber lantern", recentTurns: 1 }
    };

    const initial = await generation.buildContextPreview(pool, request);
    expect(initial.chronicleRetrieval).toMatchObject({
      effectiveImplementation: "chunked_hybrid",
      effectiveMode: "semantic_hybrid",
      queryVectorPath: "provider_only",
      providerCallOutcome: "succeeded",
      queryEmbeddingRequests: 1,
      queryCacheHits: 0,
      queryCacheMisses: 1
    });
    await pool.query(
      `UPDATE chronicle_query_embedding_cache
          SET embedding='[1,0,0]'::vector,embedding_dimensions=3
        WHERE campaign_id=$1`,
      [fixture.campaignId]
    );
    queries.length = 0;

    const recovered = await generation.buildContextPreview(pool, request);

    expect(recovered.scopes).toEqual(initial.scopes);
    expect(recovered.budget).toEqual(initial.budget);
    expect(recovered.chronicleRetrieval).toMatchObject({
      effectiveImplementation: "chunked_hybrid",
      effectiveMode: "semantic_hybrid",
      queryVectorPath: "provider_only",
      providerCallOutcome: "succeeded",
      queryEmbeddingRequests: 1,
      queryCacheHits: 0,
      queryCacheMisses: 1
    });
    expect(queries).toHaveLength(1);
    const cached = await pool.query<{ embedding: string; embedding_dimensions: number }>(
      `SELECT embedding::text AS embedding,embedding_dimensions
         FROM chronicle_query_embedding_cache WHERE campaign_id=$1`,
      [fixture.campaignId]
    );
    expect(cached.rows).toEqual([{ embedding: "[1,0]", embedding_dimensions: 2 }]);
  });

  it("gates chunk retrieval on the complete terminal current-protocol readiness matrix", async () => {
    const cases = [
      { name: "wrong protocol", expected: "fallback" },
      { name: "wrong hash", expected: "fallback" },
      { name: "wrong provider", expected: "fallback" },
      { name: "wrong model", expected: "fallback" },
      { name: "wrong dimensions", expected: "fallback" },
      { name: "wrong embedding protocol", expected: "fallback" },
      { name: "wrong fingerprint", expected: "fallback" },
      { name: "pending", expected: "fallback" },
      { name: "embedded plus sanitized skipped", expected: "chunked" },
      { name: "embedded plus semantic disabled skip", expected: "chunked" },
      { name: "embedded plus capacity skip", expected: "chunked" },
      { name: "queued job", expected: "fallback" },
      { name: "running job", expected: "fallback" },
      { name: "failed job", expected: "fallback" },
      { name: "completed job", expected: "chunked" }
    ] as const;

    for (const readinessCase of cases) {
      const { fixture, providerId } = await configuredFixture(`readiness ${readinessCase.name}`);
      const firstTurn = await turn(fixture, 1, "Enter the archive.", "The first lantern is lit.");
      const secondTurn = await turn(fixture, 2, "Read the old oath.", "The second lantern is lit.");
      const first = await parent(fixture, {
        turnId: firstTurn,
        kind: "turn_fiction",
        ordinal: 1,
        content: "Turn 1\nNarration: The first lantern is lit."
      });
      const second = await parent(fixture, {
        turnId: secondTurn,
        kind: "turn_fiction",
        ordinal: 2,
        content: "Turn 2\nNarration: The second lantern is lit."
      });
      await embeddedChunk(fixture, providerId, {
        parentId: first.id,
        parentContentHash: first.contentHash,
        kind: "turn_narration",
        content: "The first lantern is lit.",
        vector: [1, 0]
      });
      await embeddedChunk(fixture, providerId, {
        parentId: second.id,
        parentContentHash: second.contentHash,
        kind: "turn_narration",
        content: "The second lantern is lit.",
        vector: [0, 1]
      });

      if (readinessCase.name === "wrong protocol") {
        await pool.query(
          "UPDATE chronicle_memory_chunks SET chunking_protocol_version='chronicle-chunk-v0' WHERE parent_memory_id=$1",
          [second.id]
        );
      } else if (readinessCase.name === "wrong hash") {
        await pool.query(
          "UPDATE chronicle_memory_chunks SET parent_content_hash=repeat('a',64) WHERE parent_memory_id=$1",
          [second.id]
        );
      } else if (readinessCase.name === "wrong provider") {
        const staleProvider = await pool.query<{ id: string }>(
          `INSERT INTO provider_profiles
             (owner_user_id,name,provider_type,provider_role,base_url,default_model)
           VALUES ($1,$2,'openai_compatible','embedding','http://stale.invalid/v1','chunk-embed-v1')
           RETURNING id`,
          [ownerUserId, `readiness stale provider ${fixture.campaignId}`]
        );
        await pool.query(
          "UPDATE chronicle_memory_chunks SET embedding_provider_profile_id=$2 WHERE parent_memory_id=$1",
          [second.id, staleProvider.rows[0]!.id]
        );
      } else if (readinessCase.name === "wrong model") {
        await pool.query(
          "UPDATE chronicle_memory_chunks SET embedding_model='chunk-embed-v0' WHERE parent_memory_id=$1",
          [second.id]
        );
      } else if (readinessCase.name === "wrong dimensions") {
        await pool.query(
          "UPDATE chronicle_memory_chunks SET embedding_dimensions=3 WHERE parent_memory_id=$1",
          [second.id]
        );
      } else if (readinessCase.name === "wrong embedding protocol") {
        await pool.query(
          "UPDATE chronicle_memory_chunks SET embedding_protocol_version='chronicle-embedding-v0' WHERE parent_memory_id=$1",
          [second.id]
        );
      } else if (readinessCase.name === "wrong fingerprint") {
        await pool.query(
          "UPDATE chronicle_memory_chunks SET embedding_provider_fingerprint='stale-fingerprint' WHERE parent_memory_id=$1",
          [second.id]
        );
      } else if (readinessCase.name === "pending") {
        await pool.query(
          `UPDATE chronicle_memory_chunks
              SET embedding=NULL,embedding_status='pending',embedding_skip_reason=NULL,
                  embedding_provider_profile_id=NULL,embedding_model=NULL,embedding_dimensions=NULL,
                  embedding_protocol_version=NULL,embedding_provider_fingerprint=NULL,
                  embedding_content_hash=NULL,embedding_updated_at=NULL
            WHERE parent_memory_id=$1`,
          [second.id]
        );
      } else if (readinessCase.name === "embedded plus sanitized skipped"
        || readinessCase.name === "embedded plus semantic disabled skip"
        || readinessCase.name === "embedded plus capacity skip") {
        const reason = readinessCase.name === "embedded plus semantic disabled skip"
          ? "semantic_retrieval_disabled"
          : readinessCase.name === "embedded plus capacity skip"
            ? "chunk_exceeds_provider_capacity"
            : "chunk_embedding_skipped";
        await pool.query(
          `UPDATE chronicle_memory_chunks
              SET embedding=NULL,embedding_status='skipped',embedding_skip_reason=$2,
                  embedding_provider_profile_id=NULL,embedding_model=NULL,embedding_dimensions=NULL,
                  embedding_protocol_version=NULL,embedding_provider_fingerprint=NULL,
                  embedding_content_hash=NULL,embedding_updated_at=NULL
            WHERE parent_memory_id=$1`,
          [second.id, reason]
        );
      } else if (readinessCase.name === "queued job") {
        await pool.query(
          "INSERT INTO chronicle_chunk_jobs (owner_user_id,campaign_id,status) VALUES ($1,$2,'queued')",
          [ownerUserId, fixture.campaignId]
        );
      } else if (readinessCase.name === "running job") {
        await pool.query(
          `INSERT INTO chronicle_chunk_jobs
             (owner_user_id,campaign_id,status,lease_owner,lease_token,lease_expires_at)
           VALUES ($1,$2,'running','readiness-worker',gen_random_uuid(),now()+interval '5 minutes')`,
          [ownerUserId, fixture.campaignId]
        );
      } else if (readinessCase.name === "failed job") {
        await pool.query(
          "INSERT INTO chronicle_chunk_jobs (owner_user_id,campaign_id,status,error_message) VALUES ($1,$2,'failed','fixture')",
          [ownerUserId, fixture.campaignId]
        );
      } else if (readinessCase.name === "completed job") {
        await pool.query(
          "INSERT INTO chronicle_chunk_jobs (owner_user_id,campaign_id,status,completed_at) VALUES ($1,$2,'completed',now())",
          [ownerUserId, fixture.campaignId]
        );
      }

      const queries: string[] = [];
      const generation = transaction(providerId, queries);
      await pool.query(
        "UPDATE campaign_memory_configs SET retrieval_implementation='legacy_hybrid' WHERE campaign_id=$1",
        [fixture.campaignId]
      );
      const legacy = await generation.buildContextPreview(pool, {
        ...fixture,
        request: {
          budgetTokens: 4_096,
          compression: "auto",
          query: "old oath",
          recentTurns: 1,
          throughTurnNumber: 2
        }
      });
      await pool.query(
        "UPDATE campaign_memory_configs SET retrieval_implementation='chunked_hybrid' WHERE campaign_id=$1",
        [fixture.campaignId]
      );
      const chunkRankStatements: string[] = [];
      const actual = await withTransaction(pool, async (database) => {
        const intercepted = new Proxy(database, {
          get(target, property) {
            if (property === "query") {
              return (statement: unknown, values?: readonly unknown[]) => {
                if (typeof statement === "string" && statement.includes("/* chronicle_rank_batch:")) {
                  chunkRankStatements.push(statement);
                }
                return target.query(statement as never, values as never);
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          }
        }) as DatabaseClient;
        return generation.buildContextPreview(intercepted, {
          ...fixture,
          request: {
            budgetTokens: 4_096,
            compression: "auto",
            query: "old oath",
            recentTurns: 1,
            throughTurnNumber: 2
          }
        });
      });

      if (readinessCase.expected === "chunked") {
        expect(actual, readinessCase.name).toMatchObject({
          retrieval: { implementation: "chunked_hybrid" }
        });
      } else {
        expect(actual, readinessCase.name).toMatchObject({
          retrieval: { fallbackReason: "chunk_index_not_ready" }
        });
        expect(actual.scopes, readinessCase.name).toEqual(legacy.scopes);
        expect(actual.budget, readinessCase.name).toEqual(legacy.budget);
        expect(actual.metrics, readinessCase.name).toEqual(legacy.metrics);
        expect(chunkRankStatements, readinessCase.name).toEqual([]);
      }
    }
  });
});
