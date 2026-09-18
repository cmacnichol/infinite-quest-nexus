import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { readTurnValidationReport } from "../../scripts/report-turn-validation.js";
import { createProvider } from "../helpers/provider-application-fixtures.js";
import { importLegacyStory } from "../helpers/memory-aware-services.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const canary = "PRIVATE_OVERSIZED_REPORT_METADATA_CANARY";

integration("turn validation report PostgreSQL projection", () => {
  let pool: DatabasePool;
  let ownerUserId = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });

  afterAll(async () => { await pool.end(); });

  test("reads bounded private scalars and retains malformed or future contracts as unknown", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `report-projection-${randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "report-projection.story", story: fixture }));
    const profile = await createProvider(pool, {
      name: `report-projection-${randomUUID()}`, providerType: "openai_compatible", providerRole: "text",
      baseUrl: "http://127.0.0.1:9/v1", defaultModel: "report-model", contextWindowTokens: 32_768,
      maxOutputTokens: 4_096, temperature: 0, enabled: true, configuration: { textResponseFormatPolicy: "required" }
    }, "report-projection-secret");
    const oversized = `${canary}${"x".repeat(1_000_000)}`;
    const futureQueue = {
      queuedResponsePolicy: { version: 2, policy: "required", operationClosureVersion: 1 },
      lastFailureDiagnostic: { version: "1", category: "provider_timeout", code: "provider_request_timeout", phase: "story_generation", attemptNumber: 1, occurredAt: "2026-09-18T00:00:00.000Z" },
      responseContractInvocations: [{ version: 2, invocationKey: "story:stream", operation: "story_generation", status: "completed", dispatchedAt: oversized, completedAt: oversized, request: { mode: "json_schema", schemaVersion: "v1", schemaHash: "a".repeat(64), requestedModel: "report-model" }, response: { returnedModel: "report-model", returnedProviderRoute: oversized } }]
    };
    const malformedSelection = {
      queuedResponsePolicy: { version: 1, policy: "required", operationClosureVersion: 1 },
      frozenResponseContracts: { version: 2, queuedPolicy: { version: 1, policy: "required", operationClosureVersion: 1 } },
      responseContractInvocations: [{ version: 1, invocationKey: "story:stream", operation: "story_generation", status: "completed", dispatchedAt: "2026-09-18T00:00:00.000Z", completedAt: "2026-09-18T00:00:01.000Z", request: { mode: "json_schema", schemaVersion: "v1", schemaHash: "a".repeat(64), requestedModel: "report-model" }, response: { returnedModel: "report-model", returnedProviderRoute: "route" } }]
    };
    const validTransport = {
      lastFailureDiagnostic: { version: 1, category: "provider_transport", code: "provider_transport_error", phase: "story_generation", attemptNumber: 1, occurredAt: "2026-09-18T00:00:00.000Z" }
    };
    const validTimeout = {
      lastFailureDiagnostic: { version: 1, category: "provider_timeout", code: "provider_request_timeout", phase: "story_generation", attemptNumber: 2, occurredAt: "2026-09-18T00:00:01.000Z" }
    };
    await pool.query(
      `INSERT INTO generation_jobs (owner_user_id,campaign_id,provider_profile_id,idempotency_key,expected_turn_number,action,status,requested_model,orchestration_private)
       VALUES ($1,$2,$3,$4,1,'report fixture','failed','report-model',$5::jsonb),
              ($1,$2,$3,$6,2,'report fixture','failed','report-model',$7::jsonb),
              ($1,$2,$3,$8,3,'report fixture','failed','report-model',$9::jsonb),
              ($1,$2,$3,$10,4,'report fixture','failed','report-model',$11::jsonb)`,
      [ownerUserId, imported.campaignId, profile.id, randomUUID(), JSON.stringify(futureQueue), randomUUID(), JSON.stringify(malformedSelection), randomUUID(), JSON.stringify(validTransport), randomUUID(), JSON.stringify(validTimeout)]
    );
    const selectedRows: unknown[] = [];
    const client = {
      query: async (text: string, values?: readonly unknown[]) => {
        const result = await pool.query(text, values as unknown[] | undefined);
        if (text.includes("FROM generation_jobs") && !text.includes("CROSS JOIN LATERAL")) selectedRows.push(...result.rows);
        return result;
      }
    };

    const report = await readTurnValidationReport(client, { limit: 10, since: null, format: "json" });

    expect(selectedRows).toHaveLength(4);
    expect(JSON.stringify(selectedRows)).not.toContain(canary);
    expect(JSON.stringify(report)).not.toContain(canary);
    expect(report.cohorts).toEqual(expect.arrayContaining([
      expect.objectContaining({ policy: "unknown", effectiveMode: "unknown", operation: "unknown", streaming: "unknown" })
    ]));
    expect(report.metrics.primaryCalls).toBe(0);
    expect(report.jobsWithPersistedTransportDiagnostic).toBe(2);
    expect(report.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ failureDiagnostic: { code: "provider_transport_error", message: "The provider connection failed." } }),
      expect.objectContaining({ failureDiagnostic: { code: "provider_request_timeout", message: "The provider request timed out." } })
    ]));
  });
});
