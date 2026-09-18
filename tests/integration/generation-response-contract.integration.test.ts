import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generationRequestSchema, generationRetryLatestRequestSchema } from "../../packages/contracts/src/generation.js";
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
  function policy(policy: "auto" | "required" = "auto") {
    return { version: 1 as const, policy, providerProfileId, model: "contract-model", endpointIdentity: "test-endpoint", providerConfigurationHash: hash, verificationRegistryHash: hash, operationClosureVersion: 1 as const, invocationKeys: ["story:nonstream" as const] };
  }
  function selection(queuedPolicy = policy()) {
    const selected = { version: 1 as const, queuedPolicy, selectedAt: "2026-09-18T00:00:00.000Z", capabilityEvidenceHash: hash, contracts: {
      "story:nonstream": { version: 1 as const, mode: "json_object" as const, operation: "story" as const, streaming: false, forbidFormatFallback: true as const }
    } };
    return { ...selected, selectionHash: frozenResponseContractsSelectionHash(selected) };
  }
  function audit(frozen: ReturnType<typeof selection>) {
    return { version: 1 as const, selectionHash: frozen.selectionHash, invocationKey: "story:nonstream" as const, mode: "json_object" as const, schemaVersion: null, schemaHash: null, requestedModel: "contract-model", providerRoutingSlugs: [], returnedModel: null, returnedProviderRoute: null, diagnosticCode: null };
  }
  async function claimed(queuedId: string, workerId = `matrix-${crypto.randomUUID()}`) {
    const repository = createPostgresGenerationExecutionRepository(pool);
    const claim = await repository.claimNext({ workerId, leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queuedId);
    const payload = await repository.loadExecutionPayload({ workerId, leaseSeconds: 30, claim: claim! });
    expect(payload?.id).toBe(queuedId);
    return { repository, claim: claim!, payload: payload!, scope: { jobId: queuedId, ownerUserId, workerId } };
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
    await expect(repository.reserveResponseContractInvocation!(scope, { logicalAttemptId, invocationKey: "story:nonstream", operation: "story_recovery", requestPayloadHash: "d".repeat(64), request: { ...audit, returnedModel: "premature" } })).resolves.toBeNull();
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
    await expect(repository.completeResponseContractInvocation!(scope, primary!.id, { returnedModel: "", returnedProviderRoute: null, diagnosticCode: null } as never)).resolves.toBeNull();
    const completed = await repository.completeResponseContractInvocation!(scope, primary!.id, response);
    expect(completed?.status).toBe("completed");
    await expect(repository.completeResponseContractInvocation!(scope, primary!.id, response)).resolves.toEqual(completed);
    await expect(repository.completeResponseContractInvocation!(scope, primary!.id, { ...response, returnedModel: "changed-model" })).resolves.toBeNull();
    expect(await repository.saveOrchestration(scope, { ...job!.orchestration_private, frozenResponseContracts: { ...frozen, selectionHash: "c".repeat(64) } })).toBe(true);
    const stored = await pool.query<{ orchestrationPrivate: { frozenResponseContracts?: { selectionHash: string } } }>("SELECT orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [queued.id]);
    expect(stored.rows[0]?.orchestrationPrivate.frozenResponseContracts?.selectionHash).toBe(frozen.selectionHash);
  });

  it("captures replacement policy privately once, ignoring client injection and duplicate resolution", async () => {
    const imported = await campaign();
    let resolutions = 0;
    const repository = createPostgresGenerationCommandRepository(pool, {
      resolvePromptSnapshot: (client, owner, campaignId) => loadPromptSnapshotForTest(client, owner, campaignId),
      promptProtocolVersion: providerPromptProtocolVersion,
      readTurnReportedCosts: (owner, _campaign, turnIds) => readTurnReportedCostsForTest(pool, owner, [...turnIds]),
      resolveQueuedResponsePolicy: async () => {
        resolutions += 1;
        return policy();
      }
    });
    const request = generationRetryLatestRequestSchema.parse({
      action: "Replace the observatory with a trusted policy.", providerProfileId, expectedCurrentTurnNumber: 1,
      idempotencyKey: crypto.randomUUID(), context: { budgetTokens: 16000, compression: "full", recentTurns: 8 },
      queuedResponsePolicy: { policy: "required", model: "client-injected" }
    } as never);
    const first = await repository.enqueueReplacement({ ownerUserId, campaignId: imported.campaignId }, request);
    const duplicate = await repository.enqueueReplacement({ ownerUserId, campaignId: imported.campaignId }, request);
    expect(duplicate).toMatchObject({ id: first.id, duplicate: true });
    expect(resolutions).toBe(1);
    const row = await pool.query<{ orchestrationPrivate: { queuedResponsePolicy?: Record<string, unknown> }; recoveryMetadata: Record<string, unknown> }>(
      "SELECT orchestration_private AS \"orchestrationPrivate\",recovery_metadata AS \"recoveryMetadata\" FROM generation_jobs WHERE id=$1", [first.id]
    );
    expect(row.rows[0]?.orchestrationPrivate.queuedResponsePolicy).toMatchObject({ policy: "auto", providerProfileId, model: "contract-model" });
    expect(row.rows[0]?.recoveryMetadata.queuedResponsePolicy).toBeUndefined();
    await pool.query("UPDATE generation_jobs SET status='cancelled', lease_owner=NULL, lease_expires_at=NULL WHERE id=$1", [first.id]);
  });

  it("rejects required json-object selection and makes the queued-policy hash a stale-lease CAS guard", async () => {
    const imported = await campaign();
    const queued = await commands(true).enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse({ action: "Freeze the policy hash.", providerProfileId, idempotencyKey: crypto.randomUUID(), context: { budgetTokens: 16000, compression: "full", recentTurns: 8 } }));
    const first = await claimed(queued.id, `expired-${crypto.randomUUID()}`);
    const logicalAttemptId = crypto.randomUUID();
    expect(await first.repository.saveOrchestration(first.scope, { ...first.payload.orchestration_private, logicalAttempt: { version: 1, id: logicalAttemptId, semanticRepairsConsumed: 0, reviewsConsumed: 0, automaticRepairsConsumed: 0, choiceRepairsConsumed: 0, eventCoverageRepairsConsumed: 0 } })).toBe(true);
    const required = selection(policy("required"));
    await expect(first.repository.saveFrozenResponseContracts!(first.scope, queuedResponsePolicyHash(policy()), required as never)).resolves.toBeNull();
    await pool.query("UPDATE generation_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [queued.id]);
    const second = await claimed(queued.id, `reclaimer-${crypto.randomUUID()}`);
    const valid = selection();
    await expect(second.repository.saveFrozenResponseContracts!(second.scope, "b".repeat(64), valid)).resolves.toBeNull();
    await expect(second.repository.saveFrozenResponseContracts!(second.scope, queuedResponsePolicyHash(policy()), valid)).resolves.toEqual(valid);
    await expect(first.repository.saveFrozenResponseContracts!(first.scope, queuedResponsePolicyHash(policy()), valid)).resolves.toBeNull();
    await pool.query("UPDATE generation_jobs SET status='cancelled', lease_owner=NULL, lease_expires_at=NULL WHERE id=$1", [queued.id]);
  });

  it("keeps all protected contract fields and nested nulls across generic saves and rejects ledger overflow", async () => {
    const imported = await campaign();
    const queued = await commands(true).enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse({ action: "Preserve null provenance.", providerProfileId, idempotencyKey: crypto.randomUUID(), context: { budgetTokens: 16000, compression: "full", recentTurns: 8 } }));
    const fixture = await claimed(queued.id);
    const logicalAttemptId = crypto.randomUUID();
    const frozen = selection();
    const initial = { ...fixture.payload.orchestration_private, logicalAttempt: { version: 1 as const, id: logicalAttemptId, semanticRepairsConsumed: 0, reviewsConsumed: 0, automaticRepairsConsumed: 0, choiceRepairsConsumed: 0, eventCoverageRepairsConsumed: 0 } };
    expect(await fixture.repository.saveOrchestration(fixture.scope, initial)).toBe(true);
    await expect(fixture.repository.saveFrozenResponseContracts!(fixture.scope, queuedResponsePolicyHash(policy()), frozen)).resolves.toEqual(frozen);
    const reloaded = await fixture.repository.loadExecutionPayload({ workerId: fixture.scope.workerId, leaseSeconds: 30, claim: fixture.claim });
    expect(reloaded?.orchestration_private.frozenResponseContracts).toEqual(frozen);
    expect(await fixture.repository.saveOrchestration(fixture.scope, { ...reloaded!.orchestration_private, harmless: { nested: null } } as never)).toBe(true);
    const afterSave = await fixture.repository.loadExecutionPayload({ workerId: fixture.scope.workerId, leaseSeconds: 30, claim: fixture.claim });
    expect(afterSave?.orchestration_private.frozenResponseContracts).toEqual(frozen);
    expect((afterSave?.orchestration_private as Record<string, unknown> | undefined)?.harmless).toEqual({ nested: null });
    const requestAudit = audit(frozen);
    for (let index = 0; index < 24; index += 1) {
      const reserved = await fixture.repository.reserveResponseContractInvocation!(fixture.scope, { logicalAttemptId, invocationKey: "story:nonstream", operation: index % 2 ? "event_extension" : "story_generation", requestPayloadHash: index.toString(16).padStart(64, "0"), request: requestAudit });
      expect(reserved?.status).toBe("reserved");
    }
    await expect(fixture.repository.reserveResponseContractInvocation!(fixture.scope, { logicalAttemptId, invocationKey: "story:nonstream", operation: "story_recovery", requestPayloadHash: "f".repeat(64), request: requestAudit })).resolves.toBeNull();
    const row = await pool.query<{ orchestrationPrivate: { responseContractInvocations?: unknown[] } }>("SELECT orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [queued.id]);
    expect(row.rows[0]?.orchestrationPrivate.responseContractInvocations).toHaveLength(24);
    await pool.query("UPDATE generation_jobs SET status='cancelled', lease_owner=NULL, lease_expires_at=NULL WHERE id=$1", [queued.id]);
  });

  it("fails closed on malformed private versions without mutating authoritative campaign rows", async () => {
    const imported = await campaign();
    const queued = await commands(true).enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse({ action: "Reject unknown durable envelope.", providerProfileId, idempotencyKey: crypto.randomUUID(), context: { budgetTokens: 16000, compression: "full", recentTurns: 8 } }));
    const before = await Promise.all([
      pool.query("SELECT active_turn_number FROM campaigns WHERE id=$1", [imported.campaignId]),
      pool.query("SELECT trackers,rpg_stats,event_triggers,pending_event_triggers FROM campaign_state WHERE campaign_id=$1", [imported.campaignId]),
      pool.query("SELECT id,turn_number,narration FROM turns WHERE campaign_id=$1 ORDER BY turn_number", [imported.campaignId]),
      pool.query("SELECT id,content FROM campaign_canonical_facts WHERE campaign_id=$1 ORDER BY id", [imported.campaignId]),
      pool.query("SELECT id,content FROM chronicle_memories WHERE campaign_id=$1 ORDER BY id", [imported.campaignId])
    ]);
    await pool.query("UPDATE generation_jobs SET orchestration_private=orchestration_private || jsonb_build_object('queuedResponsePolicy',jsonb_build_object('version',99)) WHERE id=$1", [queued.id]);
    const repository = createPostgresGenerationExecutionRepository(pool);
    const workerId = `malformed-${crypto.randomUUID()}`;
    const claim = await repository.claimNext({ workerId, leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queued.id);
    await expect(repository.loadExecutionPayload({ workerId, leaseSeconds: 30, claim: claim! })).resolves.toBeNull();
    const after = await Promise.all([
      pool.query("SELECT active_turn_number FROM campaigns WHERE id=$1", [imported.campaignId]),
      pool.query("SELECT trackers,rpg_stats,event_triggers,pending_event_triggers FROM campaign_state WHERE campaign_id=$1", [imported.campaignId]),
      pool.query("SELECT id,turn_number,narration FROM turns WHERE campaign_id=$1 ORDER BY turn_number", [imported.campaignId]),
      pool.query("SELECT id,content FROM campaign_canonical_facts WHERE campaign_id=$1 ORDER BY id", [imported.campaignId]),
      pool.query("SELECT id,content FROM chronicle_memories WHERE campaign_id=$1 ORDER BY id", [imported.campaignId])
    ]);
    expect(after.map((result) => result.rows)).toEqual(before.map((result) => result.rows));
    await expect(pool.query<{ status: string; errorCode: string }>("SELECT status,error_code AS \"errorCode\" FROM generation_jobs WHERE id=$1", [queued.id])).resolves.toMatchObject({ rows: [{ status: "recoverable", errorCode: "generation_checkpoint_incompatible" }] });
  });
});
