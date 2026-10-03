import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { initialOwnerId } from "../../packages/database/src/pool.js";
import { createPostgresGenerationCommandRepository } from "../../packages/database/src/generation-repository.js";
import { importLegacyStory } from "../helpers/memory-aware-services.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { createProvider, loadPromptSnapshotForTest, providerPromptProtocolVersion, readTurnReportedCostsForTest } from "../helpers/provider-application-fixtures.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDatabasePool, type DatabasePool } from "../../packages/database/src/pool.js";
import { generationResponseFormatProjection } from "../../packages/database/src/generation-response-format-projection.js";
import { projectGenerationResponseFormat } from "../../packages/contracts/src/generation-response-format-projection.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("generation response-contract SQL projection", () => {
  let pool: DatabasePool;
  beforeAll(async () => { pool = createDatabasePool(databaseUrl!, 2); await migrateDatabase(pool, resolve("database/migrations")); });
  afterAll(async () => { await pool.end(); });

  test("keeps actual owner-scoped polling projections identical with oversized private evidence", async () => {
    const ownerUserId = await initialOwnerId(pool);
    const story = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    story.world.title = `Projection ${randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "projection.story", story }));
    const provider = await createProvider(pool, {
      name: `Projection ${randomUUID()}`, providerType: "openai_compatible", providerRole: "text",
      baseUrl: "http://127.0.0.1:9911", defaultModel: "projection-model", contextWindowTokens: 32768,
      maxOutputTokens: 4096, temperature: 0, enabled: true, configuration: {}
    }, "synthetic-projection-secret");
    const repository = createPostgresGenerationCommandRepository(pool, {
      resolvePromptSnapshot: (client, owner, campaignId) => loadPromptSnapshotForTest(client, owner, campaignId),
      promptProtocolVersion: providerPromptProtocolVersion,
      readTurnReportedCosts: (owner, _campaignId, ids) => readTurnReportedCostsForTest(pool, owner, [...ids])
    });
    const canary = "PRIVATE_OVERSIZED_PROJECTION_CANARY";
    const evidence = canary + randomBytes(8 * 1024 * 1024).toString("base64");
    const review = { version: 1, reviewId: randomUUID(), revision: 1, state: "pending", stage: "continuity", candidateScope: "final",
      reasons: ["review_unavailable"], eligibility: { complete: true, structurallyValid: true, mechanicsClean: true, authorityValid: true, stageComplete: true, retryAvailable: true },
      gateCandidate: { story: { narration: canary } }, decisionJournal: [] };
    const cases = [
      {},
      { queuedResponsePolicy: { version: 1, policy: "auto", model: "model-a" }, generationReview: review,
        lastFailureDiagnostic: { version: 1, category: "output_incomplete", code: "output_limit", phase: "story", attemptNumber: 1, occurredAt: "2026-10-03T00:00:00.000Z" },
        continuityReview: { version: 2, status: "dispatched", verdict: "unavailable", unavailableReason: "output_limit", outcome: null,
          prompt: canary, attempts: [
            { ordinal: 1, route: "primary", reservationStatus: "completed", outcome: { kind: "technical_failure", failure: "output_limit" } },
            { ordinal: 2, route: "fallback", reservationStatus: "dispatched", outcome: null }
          ] } },
      { queuedResponsePolicy: { version: 2, policy: "required", admission: { mode: "json_schema", basis: "model_verified" }, authority: { kind: "model_verified", model: "model-a" } },
        frozenResponseContracts: { version: 2, contracts: { "story:stream": { mode: "json_schema", operation: "story", streaming: true, schemaHash: "a".repeat(64) } } },
        responseContractInvocations: [{ version: 2, invocationKey: "story:stream", request: {}, response: { returnedModel: "served-model" } }],
        generationReview: { ...review, state: "decided", decision: "retry", decisionJournal: [{ decision: "retry" }] } },
      { queuedResponsePolicy: { version: "malformed", policy: false }, generationReview: { ...review, revision: null, eligibility: {} }, responseContractInvocations: [null, false] },
      { queuedResponsePolicy: { version: 999, policy: "required" }, generationReview: { ...review, version: 999 }, frozenResponseContracts: { version: 999, contracts: {} } }
    ];
    for (const source of cases) {
      await pool.query("UPDATE generation_jobs SET status='discarded' WHERE campaign_id=$1", [imported.campaignId]);
      const job = await pool.query<{ id: string }>(
        `INSERT INTO generation_jobs (owner_user_id, campaign_id, provider_profile_id, idempotency_key, expected_turn_number, action, status, orchestration_private)
         VALUES ($1,$2,$3,$4,1,'Inspect the archive.','recoverable',$5::jsonb) RETURNING id`,
        [ownerUserId, imported.campaignId, provider.id, randomUUID(), JSON.stringify(source)]
      );
      const scope = { ownerUserId, jobId: job.rows[0]!.id };
      const expected = await repository.getJob(scope);
      await pool.query("UPDATE generation_jobs SET orchestration_private=$2::jsonb WHERE id=$1", [scope.jobId, JSON.stringify({ ...source, privateRequestEvidence: evidence })]);
      const stored = await pool.query("SELECT md5(orchestration_private::text) AS hash, octet_length(orchestration_private::text) AS bytes FROM generation_jobs WHERE id=$1", [scope.jobId]);
      expect(stored.rows[0].bytes).toBeGreaterThan(10 * 1024 * 1024);
      const actual = await repository.getJob(scope);
      expect(actual).toEqual(expected);
      expect(JSON.stringify(actual)).not.toContain(canary);
      expect(await pool.query("SELECT md5(orchestration_private::text) AS hash, octet_length(orchestration_private::text) AS bytes FROM generation_jobs WHERE id=$1", [scope.jobId])).toEqual(stored);
      await expect(repository.getJob({ ...scope, ownerUserId: randomUUID() })).rejects.toMatchObject({ kind: "not_found" });
    }
  }, 120_000);

  test("preserves numeric v1 and converts malformed boolean/scalars to safe unknown values", async () => {
    const source = {
      queuedResponsePolicy: { version: 1, policy: "required", model: "model-a" },
      frozenResponseContracts: { version: 1, contracts: { "story:stream": { mode: "json_schema", operation: "story", streaming: true, schemaVersion: "story-v1", schemaHash: "a".repeat(64) } } },
      responseContractInvocations: [{ version: 999999999999999999999999999999999999999999999999999999999999999999999, invocationKey: "story:stream", request: { mode: "json_schema", streaming: "not-a-boolean", requestedModel: "x".repeat(300), schemaHash: "a".repeat(64) }, response: { returnedModel: "model-b", returnedProviderRoute: "route-a", diagnosticCode: null } }]
    };
    const result = await pool.query<{ projected: unknown }>(`SELECT ${generationResponseFormatProjection("source")} AS projected FROM (SELECT $1::jsonb AS source) item`, [JSON.stringify(source)]);
    expect(result.rows[0]?.projected).toMatchObject({ queuedResponsePolicy: { version: 1 }, frozenResponseContracts: { version: 1 } });
    expect(projectGenerationResponseFormat(result.rows[0]?.projected)).toMatchObject({ savedPolicy: "required", effectiveMode: "unknown", preflight: "unknown" });
  });

  test("projects absent legacy, selected v1 ledger, and preflight unavailability from actual PostgreSQL JSONB", async () => {
    const selected = {
      queuedResponsePolicy: { version: 1, policy: "auto", model: "model-a" },
      frozenResponseContracts: { version: 1, contracts: { "story:nonstream": { mode: "json_object", operation: "story", streaming: false } } },
      responseContractInvocations: [{ version: 1, invocationKey: "story:nonstream", request: { mode: "json_object", requestedModel: "model-a" }, response: { returnedModel: "model-b", returnedProviderRoute: "route-b", diagnosticCode: null } }]
    };
    const result = await pool.query<{ projected: unknown }>(`SELECT ${generationResponseFormatProjection("source")} AS projected FROM (VALUES ('{}'::jsonb), ($1::jsonb)) AS cases(source) ORDER BY source = '{}'::jsonb DESC`, [JSON.stringify(selected)]);
    expect(projectGenerationResponseFormat(result.rows[0]?.projected)).toMatchObject({ savedPolicy: "legacy", effectiveMode: "legacy" });
    expect(projectGenerationResponseFormat(result.rows[1]?.projected)).toMatchObject({ savedPolicy: "auto", effectiveMode: "json_object", operation: "story", streaming: false, requestedModel: "model-a", returnedModel: "model-b", returnedRoute: "route-b", preflight: "selected" });
    expect(projectGenerationResponseFormat({ ...(result.rows[0]?.projected as object), queuedResponsePolicy: { version: 1, policy: "required" }, errorCode: "response_contract_unavailable" })).toMatchObject({ savedPolicy: "required", effectiveMode: "unavailable", preflight: "unavailable" });
  });

  test("projects v2 requested selection separately from observed serving identity without private authority", async () => {
    const privateCanary = "PRIVATE_ENDPOINT_CREDENTIAL_PROMPT";
    const source = {
      queuedResponsePolicy: {
        version: 2, policy: "required", admission: { mode: "json_schema", basis: "preset_trusted" },
        authority: {
          kind: "preset_trusted", selection: { kind: "openrouter_preset", slug: "night-shift" },
          endpointReference: privateCanary, credentialReference: privateCanary
        }
      },
      frozenResponseContracts: { version: 2, contracts: {
        "story:stream": { mode: "json_schema", operation: "story", streaming: true, schemaVersion: "story-v2", schemaHash: "b".repeat(64), schema: { prompt: privateCanary } }
      } },
      responseContractInvocations: [{
        version: 2, invocationKey: "story:stream",
        request: { schemaVersion: "story-v2", schemaHash: "b".repeat(64), requestedModel: "requested-route" },
        response: { returnedModel: "served-model", returnedProviderRoute: "served-route", diagnosticCode: null }
      }]
    };
    const result = await pool.query<{ projected: unknown }>(`SELECT ${generationResponseFormatProjection("source")} AS projected FROM (SELECT $1::jsonb AS source) item`, [JSON.stringify(source)]);
    const projected = projectGenerationResponseFormat(result.rows[0]?.projected);
    expect(projected).toMatchObject({
      version: 2, requestedSelection: { kind: "openrouter_preset", slug: "night-shift" }, assurance: "trusted_preset",
      actualServedIdentity: { status: "known", model: "served-model", providerRoute: "served-route" }
    });
    expect(JSON.stringify(result.rows[0]?.projected)).not.toContain(privateCanary);
    expect(JSON.stringify(projected)).not.toContain("requested-route");
  });

  test.each([
    ["choices:nonstream", "choices"],
    ["continuity_review:nonstream", "continuity_review"]
  ] as const)("projects the latest v2 %s contract through actual PostgreSQL JSONB", async (invocationKey, operation) => {
    const privateCanary = `PRIVATE_${operation.toUpperCase()}_SCHEMA`;
    const source = {
      queuedResponsePolicy: {
        version: 2, policy: "required", admission: { mode: "json_schema", basis: "model_verified" },
        authority: { kind: "model_verified", model: "requested-model" }
      },
      frozenResponseContracts: { version: 2, contracts: {
        "story:stream": { mode: "json_schema", operation: "story", streaming: true, schemaVersion: "story-v2", schemaHash: "a".repeat(64) },
        [invocationKey]: { mode: "json_schema", operation, streaming: false, schemaVersion: `${operation}-v2`, schemaHash: "b".repeat(64), schema: { privateCanary } }
      } },
      responseContractInvocations: [{
        version: 2, invocationKey,
        request: { schemaVersion: `${operation}-v2`, schemaHash: "b".repeat(64), requestedModel: "requested-model" },
        response: { returnedModel: "served-model", returnedProviderRoute: null, diagnosticCode: null }
      }]
    };
    const result = await pool.query<{ projected: unknown }>(`SELECT ${generationResponseFormatProjection("source")} AS projected FROM (SELECT $1::jsonb AS source) item`, [JSON.stringify(source)]);
    expect(projectGenerationResponseFormat(result.rows[0]?.projected)).toMatchObject({
      version: 2, operation, streaming: false, schemaVersion: `${operation}-v2`, schemaHash: "b".repeat(64),
      actualServedIdentity: { status: "known", model: "served-model", providerRoute: null }
    });
    expect(JSON.stringify(result.rows[0]?.projected)).not.toContain(privateCanary);
  });
});
