import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabasePool, initialOwnerId, type DatabasePool, withTransaction } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createPostgresChronicleGenerationTransactionPort } from "../../packages/database/src/chronicle-repository.js";
import type { ChronicleContextPreview } from "../../packages/application/src/memory/index.js";
import { chronicleContentHash } from "../../packages/domain/src/chronicle-memory-helpers.js";
import {
  evaluateChronicleRetrieval,
  type ChronicleRetrievalApplication,
  type ChronicleRetrievalCorpus
} from "../../scripts/lib/chronicle-retrieval-evaluator.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe.sequential : describe.skip;

integration("Chronicle retrieval evaluation integration seam", () => {
  let pool: DatabasePool;
  let ownerUserId = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("reaches the production generation retrieval interface without a bypass", async () => {
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id, title) VALUES ($1,$2) RETURNING id",
      [ownerUserId, "Chronicle evaluator fixture"]
    );
    const version = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id, owner_user_id, version_number, content)
       VALUES ($1,$2,1,$3::jsonb) RETURNING id`,
      [world.rows[0]!.id, ownerUserId, JSON.stringify({ world: { title: "Evaluator fixture" }, entities: [] })]
    );
    const campaign = await pool.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id, world_version_id, title) VALUES ($1,$2,$3) RETURNING id",
      [ownerUserId, version.rows[0]!.id, "Chronicle evaluator fixture"]
    );
    await pool.query(
      "INSERT INTO campaign_state (campaign_id, owner_user_id) VALUES ($1,$2)",
      [campaign.rows[0]!.id, ownerUserId]
    );
    const firstTurn = await pool.query<{ id: string }>(
      `INSERT INTO turns (owner_user_id, campaign_id, turn_number, action, narration, state_snapshot_private)
       VALUES ($1,$2,1,'Scope action one.','Scope narration one.','{}'::jsonb) RETURNING id`,
      [ownerUserId, campaign.rows[0]!.id]
    );
    const secondTurn = await pool.query<{ id: string }>(
      `INSERT INTO turns (owner_user_id, campaign_id, turn_number, action, narration, state_snapshot_private)
       VALUES ($1,$2,2,'Scope action two.','Scope narration two.','{}'::jsonb) RETURNING id`,
      [ownerUserId, campaign.rows[0]!.id]
    );
    const replaced = await pool.query<{ id: string }>(
      `INSERT INTO campaign_canonical_facts
         (id, owner_user_id, campaign_id, world_version_id, source_turn_id, source_turn_number, source_fact_index,
          content, normalized_content, valid_from_turn, valid_until_turn)
       VALUES ($1,$2,$3,$4,$5,1,0,'Scope old fact.','scope old fact.',1,2) RETURNING id`,
      [randomUUID(), ownerUserId, campaign.rows[0]!.id, version.rows[0]!.id, firstTurn.rows[0]!.id]
    );
    const replacement = await pool.query<{ id: string }>(
      `INSERT INTO campaign_canonical_facts
         (id, owner_user_id, campaign_id, world_version_id, source_turn_id, source_turn_number, source_fact_index,
          content, normalized_content, valid_from_turn)
       VALUES ($1,$2,$3,$4,$5,2,0,'Scope replacement fact.','scope replacement fact.',2) RETURNING id`,
      [randomUUID(), ownerUserId, campaign.rows[0]!.id, version.rows[0]!.id, secondTurn.rows[0]!.id]
    );
    await pool.query("UPDATE campaign_canonical_facts SET superseded_by_fact_id = $1 WHERE id = $2", [replacement.rows[0]!.id, replaced.rows[0]!.id]);
    const embeddingProvider = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles
         (owner_user_id, name, provider_type, provider_role, base_url, default_model)
       VALUES ($1,'Chronicle evaluator embedding','openai_compatible','embedding','http://fixture.invalid/v1','fixture-embedding-v1')
       RETURNING id`,
      [ownerUserId]
    );
    const embeddingProviderId = embeddingProvider.rows[0]!.id;
    await pool.query(
      `INSERT INTO campaign_memory_configs
         (campaign_id, owner_user_id, embedding_enabled, embedding_provider_profile_id, embedding_model)
       VALUES ($1,$2,true,$3,'fixture-embedding-v1')`,
      [campaign.rows[0]!.id, ownerUserId, embeddingProviderId]
    );
    const memory = await pool.query<{ id: string }>(
      `INSERT INTO chronicle_memories
         (owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content, token_estimate,
          embedding, embedding_provider_profile_id, embedding_model, embedding_dimensions,
          embedding_content_hash, embedding_updated_at, embedding_provider_fingerprint)
       VALUES ($1,$2,$3,'campaign_summary',1,'scope anchor',4,'[1,0]'::vector,$4,'fixture-embedding-v1',2,$5,now(),'evaluation-fingerprint') RETURNING id`,
      [ownerUserId, campaign.rows[0]!.id, version.rows[0]!.id, embeddingProviderId, chronicleContentHash("scope anchor")]
    );
    const future = await pool.query<{ id: string }>(
      `INSERT INTO chronicle_memories
         (owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content, token_estimate)
       VALUES ($1,$2,$3,'canonical_fact',3,'scope anchor future decoy',4) RETURNING id`,
      [ownerUserId, campaign.rows[0]!.id, version.rows[0]!.id]
    );
    // The campaign/owner composite foreign key forbids a different owner on this
    // campaign. This is the closest valid owner-isolation fixture: every owned
    // relation is foreign, while campaign and world-version decoys below vary
    // exactly one eligible boundary each.
    const foreignUser = await pool.query<{ id: string }>("INSERT INTO users (display_name) VALUES ('Scope decoy owner') RETURNING id");
    const foreignWorld = await pool.query<{ id: string }>("INSERT INTO worlds (owner_user_id, title) VALUES ($1,$2) RETURNING id", [foreignUser.rows[0]!.id, "Scope decoy world"]);
    const foreignVersion = await pool.query<{ id: string }>(
      "INSERT INTO world_versions (world_id, owner_user_id, version_number, content) VALUES ($1,$2,1,$3::jsonb) RETURNING id",
      [foreignWorld.rows[0]!.id, foreignUser.rows[0]!.id, JSON.stringify({ world: { title: "Scope decoy" }, entities: [] })]
    );
    const foreignCampaign = await pool.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id, world_version_id, title) VALUES ($1,$2,$3) RETURNING id",
      [foreignUser.rows[0]!.id, foreignVersion.rows[0]!.id, "Scope decoy campaign"]
    );
    await pool.query("INSERT INTO campaign_state (campaign_id, owner_user_id) VALUES ($1,$2)", [foreignCampaign.rows[0]!.id, foreignUser.rows[0]!.id]);
    const foreign = await pool.query<{ id: string }>(
      `INSERT INTO chronicle_memories
         (owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content, token_estimate)
       VALUES ($1,$2,$3,'campaign_summary',1,'scope anchor foreign decoy',4) RETURNING id`,
      [foreignUser.rows[0]!.id, foreignCampaign.rows[0]!.id, foreignVersion.rows[0]!.id]
    );
    const campaignDecoy = await pool.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id, world_version_id, title) VALUES ($1,$2,$3) RETURNING id",
      [ownerUserId, version.rows[0]!.id, "Scope same-owner campaign decoy"]
    );
    await pool.query("INSERT INTO campaign_state (campaign_id, owner_user_id) VALUES ($1,$2)", [campaignDecoy.rows[0]!.id, ownerUserId]);
    const campaignMemory = await pool.query<{ id: string }>(
      `INSERT INTO chronicle_memories
         (owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content, token_estimate, entities)
       VALUES ($1,$2,$3,'campaign_summary',1,'scope anchor entity campaign decoy',4,ARRAY['scope anchor']) RETURNING id`,
      [ownerUserId, campaignDecoy.rows[0]!.id, version.rows[0]!.id]
    );
    const otherVersion = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id, owner_user_id, version_number, content)
       VALUES ($1,$2,2,$3::jsonb) RETURNING id`,
      [world.rows[0]!.id, ownerUserId, JSON.stringify({ world: { title: "Scope alternate version" }, entities: [] })]
    );
    const versionMemory = await pool.query<{ id: string }>(
      `INSERT INTO chronicle_memories
         (owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content, token_estimate,
          embedding, embedding_provider_profile_id, embedding_model, embedding_dimensions,
          embedding_content_hash, embedding_updated_at, embedding_provider_fingerprint)
       VALUES ($1,$2,$3,'open_thread',2,'scope anchor semantic world-version decoy',4,'[1,0]'::vector,$4,'fixture-embedding-v1',2,$5,now(),'evaluation-fingerprint') RETURNING id`,
      [ownerUserId, campaign.rows[0]!.id, otherVersion.rows[0]!.id, embeddingProviderId, chronicleContentHash("scope anchor semantic world-version decoy")]
    );
    const entityDecoyTurn = await pool.query<{ id: string }>(
      `INSERT INTO turns (owner_user_id, campaign_id, turn_number, action, narration, state_snapshot_private)
       VALUES ($1,$2,3,'Scope entity action.','Scope entity narration.','{}'::jsonb) RETURNING id`,
      [ownerUserId, campaign.rows[0]!.id]
    );
    const entityMemory = await pool.query<{ id: string }>(
      `INSERT INTO chronicle_memories
         (owner_user_id, campaign_id, world_version_id, turn_id, memory_kind, ordinal, content, token_estimate, entities,
          embedding, embedding_provider_profile_id, embedding_model, embedding_dimensions,
          embedding_content_hash, embedding_updated_at, embedding_provider_fingerprint)
       VALUES ($1,$2,$3,$4,'turn_fiction',2,'scope anchor entity world-version decoy',4,ARRAY['scope anchor'],
               '[1,0]'::vector,$5,'fixture-embedding-v1',2,$6,now(),'evaluation-fingerprint') RETURNING id`,
      [ownerUserId, campaign.rows[0]!.id, otherVersion.rows[0]!.id, entityDecoyTurn.rows[0]!.id, embeddingProviderId, chronicleContentHash("scope anchor entity world-version decoy")]
    );
    const corpus: ChronicleRetrievalCorpus = {
      version: "v1",
      cases: [{
        id: "exact-reference",
        scope: {
          ownerUserId,
          campaignId: campaign.rows[0]!.id,
          worldVersionId: version.rows[0]!.id,
          request: { budgetTokens: 4_096, compression: "auto", query: "scope anchor", recentTurns: 2, throughTurnNumber: 2 }
        },
        expectedLabels: ["fixture-summary", "replacement-fact"],
        labelByMemoryId: {
          [memory.rows[0]!.id]: "fixture-summary",
          [future.rows[0]!.id]: "future-decoy",
          [foreign.rows[0]!.id]: "owner-decoy",
          [campaignMemory.rows[0]!.id]: "entity-campaign-decoy",
          [versionMemory.rows[0]!.id]: "semantic-world-version-decoy",
          [entityMemory.rows[0]!.id]: "entity-world-version-decoy",
          [replaced.rows[0]!.id]: "superseded-fact",
          [replacement.rows[0]!.id]: "replacement-fact"
        },
        forbiddenLabels: { futureTurn: ["future-decoy"], crossCampaign: ["owner-decoy"], supersededFact: ["superseded-fact"] },
        excludedLabels: {
          owner: ["owner-decoy"],
          campaign: ["entity-campaign-decoy"],
          worldVersion: ["semantic-world-version-decoy", "entity-world-version-decoy"]
        }
      }]
    };
    const application: ChronicleRetrievalApplication = {
      generation: createPostgresChronicleGenerationTransactionPort({
        embeddings: {
          async resolve(_database, scope) {
            return scope.selectedProviderProfileId
              ? { status: "resolved" as const, resolutionSource: "dedicated_embedding" as const, resolvedRole: "embedding" as const, providerProfileId: scope.selectedProviderProfileId, providerType: "openai_compatible", model: "fixture-embedding-v1" }
              : { status: "unconfigured" as const, resolutionSource: "none" as const, resolvedRole: null };
          },
          async load() { return { id: "fixture-embedding", model: "fixture-embedding-v1", providerType: "openai_compatible", async embed(documents: readonly string[]) { return { embeddings: documents.map(() => [1, 0]), responseId: "fixture", usage: {}, reportedCost: null }; } }; },
          async embed(provider, documents) { return provider.embed(documents); },
          async fingerprint() { return "evaluation-fingerprint"; },
          async recordHealth() {},
          async recordCost() { return null; },
          logDiagnostic() {}
        }
      })
    };
    const originalBuildContextPreview = application.generation.buildContextPreview.bind(application.generation);
    let preview: ChronicleContextPreview | undefined;
    const buildContextPreview = vi.spyOn(application.generation, "buildContextPreview").mockImplementation(async (...args) => {
      preview = await originalBuildContextPreview(...args);
      return preview;
    });
    const generation: ChronicleRetrievalApplication["generation"] = new Proxy({ buildContextPreview }, {
      get(target, property, receiver) {
        if (property !== "buildContextPreview") {
          throw new Error(`The evaluator bypassed the production retrieval seam with ${String(property)}.`);
        }
        return Reflect.get(target, property, receiver);
      }
    });
    const evaluatorApplication: ChronicleRetrievalApplication = { generation };

    const report = await withTransaction(pool, (database) => evaluateChronicleRetrieval(
      evaluatorApplication,
      database,
      corpus
    ));

    expect(buildContextPreview).toHaveBeenCalledOnce();
    expect(report).toMatchObject({
      metrics: { recallAt5: 1, leakageCounts: { crossCampaign: 0, futureTurn: 0, supersededFact: 0 } },
      cases: [expect.objectContaining({ retrievedLabels: expect.arrayContaining(["fixture-summary", "replacement-fact"]) })]
    });
    expect(report.cases[0]!.retrievedLabels).not.toContain("future-decoy");
    expect(report.cases[0]!.retrievedLabels).not.toContain("owner-decoy");
    expect(report.cases[0]!.retrievedLabels).not.toContain("entity-campaign-decoy");
    expect(report.cases[0]!.retrievedLabels).not.toContain("semantic-world-version-decoy");
    expect(report.cases[0]!.retrievedLabels).not.toContain("entity-world-version-decoy");
    expect(report.cases[0]!.retrievedLabels).not.toContain("superseded-fact");
    expect(report.cases[0]!.ranks["replacement-fact"]).toBe(2);
    expect(preview).toEqual(expect.objectContaining({
      retrieval: expect.objectContaining({ semanticAvailable: true, embeddedCandidates: 1, scopeEligibleCandidates: 2 })
    }));
  });
});
