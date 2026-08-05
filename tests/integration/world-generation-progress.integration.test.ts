import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import type { WorldCampaignApplication } from "../../packages/application/src/world-campaign/index.js";
import { createApiWorldCampaignApplication } from "../../services/runtime/src/world-campaign-composition.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("durable world-generation progress", () => {
  let pool: DatabasePool;
  let ownerUserId: string;
  let application: WorldCampaignApplication;

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    application = createApiWorldCampaignApplication(pool, { credentialSecret: "progress-integration-secret" });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("stores and reads progress for its owner", async () => {
    const key = `world-gen-integration-${crypto.randomUUID()}`;
    const scope = { ownerUserId, progressKey: key };
    await application.createWorldGenerationProgress(scope);
    await application.updateWorldGenerationProgress(scope, {
      status: "processing",
      phase: "extracting",
      progressPercent: 10,
      message: "Preparing prompt"
    });

    await expect(application.getWorldGenerationProgress(scope)).resolves.toMatchObject({
      status: "processing",
      phase: "extracting",
      progressPercent: 10,
      message: "Preparing prompt"
    });
  });

  it("does not return another owner's progress record", async () => {
    const key = `world-gen-owner-${crypto.randomUUID()}`;
    await application.createWorldGenerationProgress({ ownerUserId, progressKey: key });

    await expect(application.getWorldGenerationProgress({ ownerUserId: crypto.randomUUID(), progressKey: key })).resolves.toBeNull();
  });

  it("removes expired progress records", async () => {
    const key = `world-gen-expired-${crypto.randomUUID()}`;
    await application.createWorldGenerationProgress({ ownerUserId, progressKey: key });
    await pool.query(
      "UPDATE world_generation_progress SET expires_at = now() - interval '1 second' WHERE progress_key = $1",
      [key]
    );

    await expect(application.getWorldGenerationProgress({ ownerUserId, progressKey: key })).resolves.toBeNull();
    expect(await application.deleteExpiredWorldGenerationProgress({ ownerUserId }, new Date().toISOString())).toBeGreaterThanOrEqual(0);
  });
});
