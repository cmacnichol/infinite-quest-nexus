import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabasePool, initialOwnerId, type DatabasePool, withTransaction } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import {
  evaluateChronicleRetrieval,
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

  it("reaches the production generation retrieval interface without a private ranking helper", async () => {
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
    const memory = await pool.query<{ id: string }>(
      `INSERT INTO chronicle_memories
         (owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content, token_estimate)
       VALUES ($1,$2,$3,'campaign_summary',1,'Sanitized evaluator fixture.',4) RETURNING id`,
      [ownerUserId, campaign.rows[0]!.id, version.rows[0]!.id]
    );
    const corpus: ChronicleRetrievalCorpus = {
      version: "v1",
      cases: [{
        id: "exact-reference",
        scope: {
          ownerUserId,
          campaignId: campaign.rows[0]!.id,
          worldVersionId: version.rows[0]!.id,
          request: { budgetTokens: 4_096, compression: "auto", query: "fixture", recentTurns: 2 }
        },
        expectedLabels: ["fixture-summary"],
        labelByMemoryId: { [memory.rows[0]!.id]: "fixture-summary" }
      }]
    };
    const application = apiMemoryApplication(pool);
    const buildContextPreview = vi.spyOn(application.generation, "buildContextPreview");
    const privateRankingHelper = vi.fn(() => {
      throw new Error("Private rank helpers are forbidden in the evaluator.");
    });

    const report = await withTransaction(pool, (database) => evaluateChronicleRetrieval(
      application,
      database,
      corpus,
      { privateRankingHelper } as never
    ));

    expect(buildContextPreview).toHaveBeenCalledOnce();
    expect(privateRankingHelper).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      metrics: { recallAt5: 1, leakageCounts: { crossCampaign: 0, futureTurn: 0, supersededFact: 0 } },
      cases: [expect.objectContaining({ retrievedLabels: ["fixture-summary"] })]
    });
  });
});
