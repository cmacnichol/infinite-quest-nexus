import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generationRequestSchema } from "../../packages/contracts/src/generation.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { createPostgresGenerationCommandRepository } from "../../packages/database/src/generation-repository.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createProvider, loadPromptSnapshotForTest, providerPromptProtocolVersion, readTurnReportedCostsForTest } from "../helpers/provider-application-fixtures.js";
import { importLegacyStory } from "../helpers/memory-aware-services.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const hash = "a".repeat(64);

integration("PostgreSQL response-contract persistence", () => {
  let pool: DatabasePool;
  let ownerUserId = "";
  let providerProfileId = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    providerProfileId = (await createProvider(pool, { name: `response-contract ${crypto.randomUUID()}`, providerType: "openai_compatible", providerRole: "text", baseUrl: "http://127.0.0.1:9911", defaultModel: "contract-model", contextWindowTokens: 32768, maxOutputTokens: 4096, temperature: 0, enabled: true, configuration: {} }, "response-contract-secret")).id;
  });
  afterAll(async () => { await pool.end(); });

  async function campaign() {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `response-contract ${crypto.randomUUID()}`;
    return importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "response-contract.story", story: fixture }));
  }
  function commands(withPolicy: boolean) {
    return createPostgresGenerationCommandRepository(pool, {
      resolvePromptSnapshot: (client, owner, campaignId) => loadPromptSnapshotForTest(client, owner, campaignId),
      promptProtocolVersion: providerPromptProtocolVersion,
      readTurnReportedCosts: (owner, _campaign, turnIds) => readTurnReportedCostsForTest(pool, owner, [...turnIds]),
      ...(withPolicy ? { resolveQueuedResponsePolicy: async () => ({ version: 1, policy: "auto" as const, providerProfileId, model: "contract-model", endpointIdentity: "test-endpoint", providerConfigurationHash: hash, verificationRegistryHash: hash, operationClosureVersion: 1 as const, invocationKeys: ["story:nonstream" as const] }) } : {})
    });
  }
  it("persists a trusted queued policy privately and retains a legacy row's absent shape", async () => {
    const imported = await campaign();
    const request = generationRequestSchema.parse({ action: "Inspect the observatory.", providerProfileId, idempotencyKey: crypto.randomUUID(), context: { budgetTokens: 16000, compression: "full", recentTurns: 8 } });
    const protectedJob = await commands(true).enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, request);
    const legacyJob = await commands(false).enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, { ...request, idempotencyKey: crypto.randomUUID() });
    const rows = await pool.query<{ id: string; orchestrationPrivate: Record<string, unknown>; recoveryMetadata: Record<string, unknown> }>(`SELECT id, orchestration_private AS "orchestrationPrivate", recovery_metadata AS "recoveryMetadata" FROM generation_jobs WHERE id = ANY($1::uuid[])`, [[protectedJob.id, legacyJob.id]]);
    const stored = new Map(rows.rows.map((row) => [row.id, row]));
    expect(stored.get(protectedJob.id)?.orchestrationPrivate.queuedResponsePolicy).toMatchObject({ providerProfileId, model: "contract-model" });
    expect(stored.get(protectedJob.id)?.recoveryMetadata.queuedResponsePolicy).toBeUndefined();
    expect(stored.get(legacyJob.id)?.orchestrationPrivate.queuedResponsePolicy).toBeUndefined();
  });
});
