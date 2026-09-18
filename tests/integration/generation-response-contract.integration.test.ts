import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generationRequestSchema } from "../../packages/contracts/src/generation.js";
import { frozenResponseContractsSelectionHash, queuedResponsePolicyHash } from "../../packages/contracts/src/generation-response-contract.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { createPostgresGenerationCommandRepository } from "../../packages/database/src/generation-repository.js";
import { createPostgresGenerationExecutionRepository } from "../../packages/database/src/generation-execution-repository.js";
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
    const legacyImported = await campaign();
    const request = generationRequestSchema.parse({ action: "Inspect the observatory.", providerProfileId, idempotencyKey: crypto.randomUUID(), context: { budgetTokens: 16000, compression: "full", recentTurns: 8 } });
    const protectedJob = await commands(true).enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, request);
    const legacyJob = await commands(false).enqueueAppend({ ownerUserId, campaignId: legacyImported.campaignId }, { ...request, idempotencyKey: crypto.randomUUID() });
    const rows = await pool.query<{ id: string; orchestrationPrivate: Record<string, unknown>; recoveryMetadata: Record<string, unknown> }>(`SELECT id, orchestration_private AS "orchestrationPrivate", recovery_metadata AS "recoveryMetadata" FROM generation_jobs WHERE id = ANY($1::uuid[])`, [[protectedJob.id, legacyJob.id]]);
    const stored = new Map(rows.rows.map((row) => [row.id, row]));
    expect(stored.get(protectedJob.id)?.orchestrationPrivate.queuedResponsePolicy).toMatchObject({ providerProfileId, model: "contract-model" });
    expect(stored.get(protectedJob.id)?.recoveryMetadata.queuedResponsePolicy).toBeUndefined();
    expect(stored.get(legacyJob.id)?.orchestrationPrivate.queuedResponsePolicy).toBeUndefined();
    await pool.query("UPDATE generation_jobs SET status='cancelled', lease_owner=NULL, lease_expires_at=NULL WHERE id = ANY($1::uuid[])", [[protectedJob.id, legacyJob.id]]);
  });

  it("binds multiple concrete operations to the persisted logical attempt and finalizes each response once", async () => {
    const imported = await campaign();
    const queuedPolicy = { version: 1 as const, policy: "auto" as const, providerProfileId, model: "contract-model", endpointIdentity: "test-endpoint", providerConfigurationHash: hash, verificationRegistryHash: hash, operationClosureVersion: 1 as const, invocationKeys: ["story:nonstream" as const] };
    const request = generationRequestSchema.parse({ action: "Secure the observatory ledger.", providerProfileId, idempotencyKey: crypto.randomUUID(), context: { budgetTokens: 16000, compression: "full", recentTurns: 8 } });
    const queued = await commands(true).enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, request);
    const repository = createPostgresGenerationExecutionRepository(pool);
    const workerId = `ledger-${crypto.randomUUID()}`;
    const claim = await repository.claimNext({ workerId, leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queued.id);
    const job = await repository.loadExecutionPayload({ workerId, leaseSeconds: 30, claim: claim! });
    expect(job?.id).toBe(queued.id);
    const scope = { jobId: queued.id, ownerUserId, workerId };
    const logicalAttemptId = crypto.randomUUID();
    expect(await repository.saveOrchestration(scope, { ...job!.orchestration_private, logicalAttempt: { version: 1, id: logicalAttemptId, semanticRepairsConsumed: 0, reviewsConsumed: 0, automaticRepairsConsumed: 0, choiceRepairsConsumed: 0, eventCoverageRepairsConsumed: 0 } })).toBe(true);
    const reloaded = await repository.loadExecutionPayload({ workerId, leaseSeconds: 30, claim: claim! });
    expect(reloaded?.orchestration_private.logicalAttempt?.id).toBe(logicalAttemptId);
    const frozenSelection = { version: 1 as const, queuedPolicy, selectedAt: "2026-09-18T00:00:00.000Z", capabilityEvidenceHash: hash, contracts: { "story:nonstream": { version: 1 as const, mode: "json_object" as const, operation: "story" as const, streaming: false, forbidFormatFallback: true as const } } };
    const frozen = { ...frozenSelection, selectionHash: frozenResponseContractsSelectionHash(frozenSelection) };
    await expect(repository.saveFrozenResponseContracts!(scope, hash, frozen)).resolves.toBeNull();
    await expect(repository.saveFrozenResponseContracts!(scope, queuedResponsePolicyHash(queuedPolicy), frozen)).resolves.toEqual(frozen);
    expect(await repository.markGenerating(scope)).toBe(true);
    expect(await repository.markValidating(scope)).toBe(true);
    const audit = { version: 1 as const, selectionHash: frozen.selectionHash, invocationKey: "story:nonstream" as const, mode: "json_object" as const, schemaVersion: null, schemaHash: null, requestedModel: "contract-model", providerRoutingSlugs: [], returnedModel: null, returnedProviderRoute: null, diagnosticCode: null };
    const primary = await repository.reserveResponseContractInvocation!(scope, { logicalAttemptId, invocationKey: "story:nonstream", operation: "story_generation", requestPayloadHash: hash, request: audit });
    expect(primary?.status).toBe("reserved");
    await expect(repository.reserveResponseContractInvocation!(scope, { logicalAttemptId, invocationKey: "story:nonstream", operation: "story_generation", requestPayloadHash: hash, request: audit })).resolves.toEqual(primary);
    await expect(repository.reserveResponseContractInvocation!(scope, { logicalAttemptId, invocationKey: "story:nonstream", operation: "story_generation", requestPayloadHash: hash, request: { ...audit, requestedModel: "tampered-model" } })).resolves.toBeNull();
    const extensionHash = "b".repeat(64);
    const extension = await repository.reserveResponseContractInvocation!(scope, { logicalAttemptId, invocationKey: "story:nonstream", operation: "event_extension", requestPayloadHash: extensionHash, request: audit });
    expect(extension?.id).not.toBe(primary?.id);
    await expect(repository.reserveResponseContractInvocation!(scope, { logicalAttemptId: crypto.randomUUID(), invocationKey: "story:nonstream", operation: "story_generation", requestPayloadHash: hash, request: audit })).resolves.toBeNull();
    const dispatched = await repository.markResponseContractInvocationDispatched!(scope, primary!.id, hash);
    expect(dispatched?.status).toBe("dispatched");
    await expect(repository.markResponseContractInvocationDispatched!(scope, primary!.id, hash)).resolves.toBeNull();
    await expect(repository.markResponseContractInvocationDispatched!({ ...scope, workerId: "stale-worker" }, primary!.id, hash)).resolves.toBeNull();
    const response = { returnedModel: "contract-model", returnedProviderRoute: null, diagnosticCode: null } as const;
    const completed = await repository.completeResponseContractInvocation!(scope, primary!.id, response);
    expect(completed?.status).toBe("completed");
    await expect(repository.completeResponseContractInvocation!(scope, primary!.id, response)).resolves.toEqual(completed);
    await expect(repository.completeResponseContractInvocation!(scope, primary!.id, { ...response, returnedModel: "changed-model" })).resolves.toBeNull();
    expect(await repository.saveOrchestration(scope, { ...job!.orchestration_private, frozenResponseContracts: { ...frozen, selectionHash: "c".repeat(64) } })).toBe(true);
    const stored = await pool.query<{ orchestrationPrivate: { frozenResponseContracts?: { selectionHash: string } } }>("SELECT orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [queued.id]);
    expect(stored.rows[0]?.orchestrationPrivate.frozenResponseContracts?.selectionHash).toBe(frozen.selectionHash);
  });
});
