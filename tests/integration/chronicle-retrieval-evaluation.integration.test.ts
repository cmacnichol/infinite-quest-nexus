import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabasePool, initialOwnerId, type DatabasePool, withTransaction } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import {
  evaluateChronicleRetrieval,
  type ChronicleRetrievalApplication,
  type ChronicleRetrievalCorpus
} from "../../scripts/lib/chronicle-retrieval-evaluator.js";
import { apiMemoryApplication } from "../helpers/memory-applications.js";

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
    const memory = await pool.query<{ id: string }>(
      `INSERT INTO chronicle_memories
         (owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content, token_estimate)
       VALUES ($1,$2,$3,'campaign_summary',1,'scope anchor',4) RETURNING id`,
      [ownerUserId, campaign.rows[0]!.id, version.rows[0]!.id]
    );
    const future = await pool.query<{ id: string }>(
      `INSERT INTO chronicle_memories
         (owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content, token_estimate)
       VALUES ($1,$2,$3,'canonical_fact',3,'scope anchor future decoy',4) RETURNING id`,
      [ownerUserId, campaign.rows[0]!.id, version.rows[0]!.id]
    );
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
    const versionDecoy = await pool.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id, world_version_id, title) VALUES ($1,$2,$3) RETURNING id",
      [ownerUserId, otherVersion.rows[0]!.id, "Scope world-version decoy"]
    );
    await pool.query("INSERT INTO campaign_state (campaign_id, owner_user_id) VALUES ($1,$2)", [versionDecoy.rows[0]!.id, ownerUserId]);
    const versionMemory = await pool.query<{ id: string }>(
      `INSERT INTO chronicle_memories
         (owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content, token_estimate)
       VALUES ($1,$2,$3,'campaign_summary',1,'scope anchor semantic world-version decoy',4) RETURNING id`,
      [ownerUserId, versionDecoy.rows[0]!.id, otherVersion.rows[0]!.id]
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
          [replaced.rows[0]!.id]: "superseded-fact",
          [replacement.rows[0]!.id]: "replacement-fact"
        },
        forbiddenLabels: { futureTurn: ["future-decoy"], crossCampaign: ["owner-decoy"], supersededFact: ["superseded-fact"] },
        excludedLabels: {
          owner: ["owner-decoy"],
          campaign: ["entity-campaign-decoy"],
          worldVersion: ["semantic-world-version-decoy"]
        }
      }]
    };
    const application = apiMemoryApplication(pool);
    const buildContextPreview = vi.spyOn(application.generation, "buildContextPreview");
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
    expect(report.cases[0]!.retrievedLabels).not.toContain("superseded-fact");
  });
});
