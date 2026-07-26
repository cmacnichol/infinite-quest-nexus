import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import {
  createWorldGenerationProgress,
  deleteExpiredWorldGenerationProgress,
  getWorldGenerationProgress,
  updateWorldGenerationProgress
} from "../../services/api/src/world-generation-progress-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("durable world-generation progress", () => {
  let pool: DatabasePool;
  let ownerUserId: string;

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("stores and reads progress for its owner", async () => {
    const key = `world-gen-integration-${crypto.randomUUID()}`;
    await createWorldGenerationProgress(pool, ownerUserId, key);
    await updateWorldGenerationProgress(pool, ownerUserId, key, {
      status: "processing",
      phase: "extracting",
      progressPercent: 10,
      message: "Preparing prompt"
    });

    await expect(getWorldGenerationProgress(pool, ownerUserId, key)).resolves.toMatchObject({
      status: "processing",
      phase: "extracting",
      progressPercent: 10,
      message: "Preparing prompt"
    });
  });

  it("does not return another owner's progress record", async () => {
    const key = `world-gen-owner-${crypto.randomUUID()}`;
    await createWorldGenerationProgress(pool, ownerUserId, key);

    await expect(getWorldGenerationProgress(pool, crypto.randomUUID(), key)).resolves.toBeNull();
  });

  it("removes expired progress records", async () => {
    const key = `world-gen-expired-${crypto.randomUUID()}`;
    await createWorldGenerationProgress(pool, ownerUserId, key);
    await pool.query(
      "UPDATE world_generation_progress SET expires_at = now() - interval '1 second' WHERE progress_key = $1",
      [key]
    );

    await expect(getWorldGenerationProgress(pool, ownerUserId, key)).resolves.toBeNull();
    expect(await deleteExpiredWorldGenerationProgress(pool)).toBeGreaterThanOrEqual(0);
  });
});
