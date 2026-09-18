import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generationRequestSchema, generationRetryLatestRequestSchema } from "../../packages/contracts/src/generation.js";
import { frozenResponseContractsSelectionHash, queuedResponsePolicyHash } from "../../packages/contracts/src/generation-response-contract.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { sha256Hex, storyTurnOutputSchema } from "../../packages/contracts/src/index.js";
import { generationReviewFindingsHash, type GenerationReviewCheckpoint } from "../../packages/application/src/generation/review-checkpoint.js";
import { canonicalEvidenceJson } from "../../packages/application/src/memory/generation-context.js";
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
  function strictSelection() {
    const queuedPolicy = policy("required");
    const schema = { additionalProperties: false, properties: { answer: { type: "string" }, nullable: { type: ["string", "null"] } }, required: ["answer"], type: "object" };
    const contract = { version: 1 as const, mode: "json_schema" as const, operation: "story" as const, streaming: false, forbidFormatFallback: true as const,
      schemaVersion: "contract-schema-v1", schemaHash: sha256Hex(JSON.stringify(schema)), schemaName: "story_contract", schema,
      providerRoutingSlugs: ["openai/structured"] as string[], routeConfigHash: hash, adapterProtocol: "text-schema-adapter-v1" as const };
    const selected = { version: 1 as const, queuedPolicy, selectedAt: "2026-09-18T00:00:00.000Z", capabilityEvidenceHash: hash, contracts: { "story:nonstream": contract } };
    return { ...selected, selectionHash: frozenResponseContractsSelectionHash(selected) };
  }
  function strictAudit(frozen: ReturnType<typeof strictSelection>) {
    const contract = frozen.contracts["story:nonstream"];
    return { version: 1 as const, selectionHash: frozen.selectionHash, invocationKey: "story:nonstream" as const, mode: "json_schema" as const, schemaVersion: contract.schemaVersion, schemaHash: contract.schemaHash, requestedModel: "contract-model", providerRoutingSlugs: contract.providerRoutingSlugs, returnedModel: null, returnedProviderRoute: null, diagnosticCode: null };
  }
  async function claimed(queuedId: string, workerId = `matrix-${crypto.randomUUID()}`) {
    const repository = createPostgresGenerationExecutionRepository(pool);
    const claim = await repository.claimNext({ workerId, leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queuedId);
    const payload = await repository.loadExecutionPayload({ workerId, leaseSeconds: 30, claim: claim! });
    expect(payload?.id).toBe(queuedId);
    return { repository, claim: claim!, payload: payload!, scope: { jobId: queuedId, ownerUserId, workerId } };
  }
  async function checkpointForPause(job: Awaited<ReturnType<typeof claimed>>, campaignId: string): Promise<GenerationReviewCheckpoint> {
    const world = await pool.query<{ worldId: string }>("SELECT w.id AS \"worldId\" FROM campaigns c JOIN world_versions v ON v.id=c.world_version_id JOIN worlds w ON w.id=v.world_id WHERE c.id=$1", [campaignId]);
    const story = storyTurnOutputSchema.parse({ narration: "The archive waits beneath the observatory.", choices: ["Enter.", "Wait.", "Listen.", "Leave."], custom_action_suggestion: "Study the archive.", scratchpad: "", tracker_updates: [], image_prompt: "An observatory archive.", continuity_summary: "The archive is open.", canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: [] });
    const candidate = {
      scope: "main" as const, story, storyHash: sha256Hex(canonicalEvidenceJson(story)), rawOutputReference: null,
      producingRequestHash: "a".repeat(64), producingResponseId: "pause-response", sentFactIds: [], ownerUserId, campaignId,
      worldId: world.rows[0]!.worldId, worldVersionId: job.payload.world_version_id ?? null,
      baseTurnNumber: job.payload.generation_base_identity.baseTurnNumber, expectedTurnNumber: job.payload.expected_turn_number,
      policy: {}, policyHash: "b".repeat(64), baseIdentity: job.payload.generation_base_identity,
      protocol: { version: job.payload.prompt_protocol_version, promptHash: "c".repeat(64) },
      provider: { type: "openai_compatible" as const, profileId: providerProfileId, configurationHash: "d".repeat(64) },
      resumeDependencies: { generationContext: {}, producingProviderResult: null, stageState: {}, frozenCommitInputs: {}, replacementTarget: null }
    };
    const reasons: GenerationReviewCheckpoint["reasons"] = ["invalid_structure"];
    return {
      version: 1, reviewId: crypto.randomUUID(), revision: 1, state: "pending", stage: "structure", candidateScope: "main",
      reasons, operationKind: "append", replacementTurnId: null,
      eligibility: { complete: true, structurallyValid: false, mechanicsClean: true, authorityValid: true, stageComplete: true, retryAvailable: true },
      originalCandidate: candidate, gateCandidate: candidate, workingCandidate: candidate, originalFindings: reasons,
      originalFindingsHash: generationReviewFindingsHash(reasons), retryFailure: null, decisionJournal: []
    } satisfies GenerationReviewCheckpoint;
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
    await expect(repository.markResponseContractInvocationDispatched!({ ...scope, ownerUserId: crypto.randomUUID() }, primary!.id, hash)).resolves.toBeNull();
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
    const currentTurn = (await pool.query<{ activeTurnNumber: number }>("SELECT active_turn_number AS \"activeTurnNumber\" FROM campaigns WHERE id=$1", [imported.campaignId])).rows[0]!.activeTurnNumber;
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
      action: "Replace the observatory with a trusted policy.", providerProfileId, expectedCurrentTurnNumber: currentTurn,
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
    await expect(first.repository.saveFrozenResponseContracts!(first.scope, queuedResponsePolicyHash(policy()), required as never)).rejects.toThrow("Frozen response contracts are invalid or incompatible");
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
    const legacyImported = await campaign();
    const legacyQueued = await commands(false).enqueueAppend({ ownerUserId, campaignId: legacyImported.campaignId }, generationRequestSchema.parse({ action: "Reject protected key injection.", providerProfileId, idempotencyKey: crypto.randomUUID(), context: { budgetTokens: 16000, compression: "full", recentTurns: 8 } }));
    const legacy = await claimed(legacyQueued.id);
    expect(await legacy.repository.saveOrchestration(legacy.scope, { ...legacy.payload.orchestration_private, queuedResponsePolicy: policy(), frozenResponseContracts: frozen } as never)).toBe(true);
    const legacyReloaded = await legacy.repository.loadExecutionPayload({ workerId: legacy.scope.workerId, leaseSeconds: 30, claim: legacy.claim });
    expect(legacyReloaded?.orchestration_private.queuedResponsePolicy).toBeUndefined();
    expect(legacyReloaded?.orchestration_private.frozenResponseContracts).toBeUndefined();
    await pool.query("UPDATE generation_jobs SET status='cancelled', lease_owner=NULL, lease_expires_at=NULL WHERE id=$1", [legacyQueued.id]);
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

  it("preserves validated prepared-response failures across stale generic saves", async () => {
    const imported = await campaign();
    const queued = await commands(true).enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse({ action: "Retain bounded failure evidence.", providerProfileId, idempotencyKey: crypto.randomUUID(), context: { budgetTokens: 16000, compression: "full", recentTurns: 8 } }));
    const fixture = await claimed(queued.id);
    const logicalAttemptId = crypto.randomUUID();
    const frozen = selection();
    const initial = { ...fixture.payload.orchestration_private, logicalAttempt: { version: 1 as const, id: logicalAttemptId, semanticRepairsConsumed: 0, reviewsConsumed: 0, automaticRepairsConsumed: 0, choiceRepairsConsumed: 0, eventCoverageRepairsConsumed: 0 } };
    expect(await fixture.repository.saveOrchestration(fixture.scope, initial)).toBe(true);
    await fixture.repository.saveFrozenResponseContracts!(fixture.scope, queuedResponsePolicyHash(policy()), frozen);
    const requestBody = "{}";
    const requestPayloadHash = sha256Hex(requestBody);
    const request = audit(frozen);
    expect(await fixture.repository.saveOrchestration(fixture.scope, { ...initial, primaryReservation: { version: 1 as const, requestBody, requestPayloadHash, providerConfigurationHash: hash, attempt: 1, status: "reserved" as const } })).toBe(true);
    const reserved = await fixture.repository.reserveResponseContractInvocation!(fixture.scope, { logicalAttemptId, invocationKey: "story:nonstream", operation: "story_generation", requestPayloadHash, request });
    expect(reserved?.status).toBe("reserved");
    await fixture.repository.markResponseContractInvocationDispatched!(fixture.scope, reserved!.id, requestPayloadHash);
    await fixture.repository.completeResponseContractInvocation!(fixture.scope, reserved!.id, { returnedModel: null, returnedProviderRoute: null, diagnosticCode: "provider_schema_invalid" });
    const failure = { version: 1 as const, invocationId: reserved!.id, requestBody, requestPayloadHash, responseId: "partial-id", partialContent: "private partial", partialContentTruncated: false, returnedModel: null, returnedProviderRoute: null, diagnosticCode: "provider_schema_invalid" };
    expect(await fixture.repository.saveOrchestration(fixture.scope, { ...initial, preparedResponseFailures: [failure] } as never)).toBe(true);
    expect(await fixture.repository.saveOrchestration(fixture.scope, { ...initial, preparedResponseFailures: [{ ...failure, partialContent: "tampered" }] } as never)).toBe(true);
    const reloaded = await fixture.repository.loadExecutionPayload({ workerId: fixture.scope.workerId, leaseSeconds: 30, claim: fixture.claim });
    expect(reloaded?.orchestration_private.preparedResponseFailures).toEqual([failure]);
    await pool.query(`UPDATE generation_jobs
      SET orchestration_private=jsonb_set(orchestration_private, '{preparedResponseFailures,0,diagnosticCode}', '"not_a_finite_response_format_code"'::jsonb)
      WHERE id=$1`, [queued.id]);
    await expect(fixture.repository.loadExecutionPayload({ workerId: fixture.scope.workerId, leaseSeconds: 30, claim: fixture.claim })).resolves.toBeNull();
    await expect(pool.query<{ status: string; errorCode: string }>("SELECT status,error_code AS \"errorCode\" FROM generation_jobs WHERE id=$1", [queued.id]))
      .resolves.toMatchObject({ rows: [{ status: "recoverable", errorCode: "generation_checkpoint_incompatible" }] });
  });

  it("rejects a tampered completed producing binding before a new-mode replay can dispatch", async () => {
    const imported = await campaign();
    const queued = await commands(true).enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse({ action: "Reject a tampered retained candidate.", providerProfileId, idempotencyKey: crypto.randomUUID(), context: { budgetTokens: 16000, compression: "full", recentTurns: 8 } }));
    const fixture = await claimed(queued.id);
    const logicalAttemptId = crypto.randomUUID(); const frozen = selection();
    const initial = { ...fixture.payload.orchestration_private, logicalAttempt: { version: 1 as const, id: logicalAttemptId, semanticRepairsConsumed: 0, reviewsConsumed: 0, automaticRepairsConsumed: 0, choiceRepairsConsumed: 0, eventCoverageRepairsConsumed: 0 } };
    await fixture.repository.saveOrchestration(fixture.scope, initial);
    await fixture.repository.saveFrozenResponseContracts!(fixture.scope, queuedResponsePolicyHash(policy()), frozen);
    const requestBody = "{}"; const requestPayloadHash = sha256Hex(requestBody);
    const reserved = await fixture.repository.reserveResponseContractInvocation!(fixture.scope, { logicalAttemptId, invocationKey: "story:nonstream", operation: "story_generation", requestPayloadHash, request: audit(frozen) });
    await fixture.repository.markResponseContractInvocationDispatched!(fixture.scope, reserved!.id, requestPayloadHash);
    await fixture.repository.completeResponseContractInvocation!(fixture.scope, reserved!.id, { returnedModel: null, returnedProviderRoute: null, diagnosticCode: null });
    await pool.query(`UPDATE generation_jobs SET orchestration_private=orchestration_private || jsonb_build_object('primaryResult',jsonb_build_object('version',1,'requestBody',$2::text,'requestPayloadHash',$3::text,'response',jsonb_build_object('content','{}','responseId','tampered','finishReason','stop','outputLimited',false,'modelInstanceId','m','usage',jsonb_build_object('inputTokens',0,'outputTokens',0,'totalTokens',0),'reportedCost',null,'rawMetadata',jsonb_build_object()),'sentFactIds','[]'::jsonb,'providerConfigurationHash',$4::text,'contextFingerprint','x','contextDiagnostics','{}'::jsonb,'chronicleRetrieval',jsonb_build_object())) WHERE id=$1`, [queued.id, requestBody, "f".repeat(64), hash]);
    await expect(fixture.repository.loadExecutionPayload({ workerId: fixture.scope.workerId, leaseSeconds: 30, claim: fixture.claim })).resolves.toBeNull();
    await expect(pool.query<{ status: string; errorCode: string }>("SELECT status,error_code AS \"errorCode\" FROM generation_jobs WHERE id=$1", [queued.id])).resolves.toMatchObject({ rows: [{ status: "recoverable", errorCode: "generation_checkpoint_incompatible" }] });
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

  it.each(["frozenResponseContracts", "responseContractInvocations"] as const)("fails closed on an unknown %s version without mutating derived rows", async (key) => {
    const imported = await campaign();
    const queued = await commands(true).enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse({ action: `Reject unknown ${key}.`, providerProfileId, idempotencyKey: crypto.randomUUID(), context: { budgetTokens: 16000, compression: "full", recentTurns: 8 } }));
    const before = await Promise.all([
      pool.query("SELECT id,status FROM chronicle_jobs WHERE campaign_id=$1 ORDER BY id", [imported.campaignId]),
      pool.query("SELECT id,memory_kind,content FROM chronicle_memories WHERE campaign_id=$1 ORDER BY id", [imported.campaignId]),
      pool.query("SELECT id,turn_number FROM turns WHERE campaign_id=$1 ORDER BY turn_number", [imported.campaignId])
    ]);
    const invalid = key === "responseContractInvocations" ? [{ version: 99 }] : { version: 99 };
    await pool.query("UPDATE generation_jobs SET orchestration_private=orchestration_private || jsonb_build_object($2::text,$3::jsonb) WHERE id=$1", [queued.id, key, JSON.stringify(invalid)]);
    const repository = createPostgresGenerationExecutionRepository(pool);
    const workerId = `unknown-${crypto.randomUUID()}`;
    const claim = await repository.claimNext({ workerId, leaseSeconds: 30 });
    await expect(repository.loadExecutionPayload({ workerId, leaseSeconds: 30, claim: claim! })).resolves.toBeNull();
    const after = await Promise.all([
      pool.query("SELECT id,status FROM chronicle_jobs WHERE campaign_id=$1 ORDER BY id", [imported.campaignId]),
      pool.query("SELECT id,memory_kind,content FROM chronicle_memories WHERE campaign_id=$1 ORDER BY id", [imported.campaignId]),
      pool.query("SELECT id,turn_number FROM turns WHERE campaign_id=$1 ORDER BY turn_number", [imported.campaignId])
    ]);
    expect(after.map((result) => result.rows)).toEqual(before.map((result) => result.rows));
    await expect(pool.query<{ status: string; errorCode: string }>("SELECT status,error_code AS \"errorCode\" FROM generation_jobs WHERE id=$1", [queued.id]))
      .resolves.toMatchObject({ rows: [{ status: "recoverable", errorCode: "generation_checkpoint_incompatible" }] });
  });

  it("persists and enforces a required json-schema contract through the complete invocation ledger", async () => {
    const imported = await campaign();
    const queued = await createPostgresGenerationCommandRepository(pool, {
      resolvePromptSnapshot: (client, owner, campaignId) => loadPromptSnapshotForTest(client, owner, campaignId),
      promptProtocolVersion: providerPromptProtocolVersion,
      readTurnReportedCosts: (owner, _campaign, turnIds) => readTurnReportedCostsForTest(pool, owner, [...turnIds]),
      resolveQueuedResponsePolicy: async () => policy("required")
    }).enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse({ action: "Validate the strict archive contract.", providerProfileId, idempotencyKey: crypto.randomUUID(), context: { budgetTokens: 16000, compression: "full", recentTurns: 8 } }));
    const fixture = await claimed(queued.id); const logicalAttemptId = crypto.randomUUID(); const frozen = strictSelection();
    await fixture.repository.saveOrchestration(fixture.scope, { ...fixture.payload.orchestration_private, logicalAttempt: { version: 1 as const, id: logicalAttemptId, semanticRepairsConsumed: 0, reviewsConsumed: 0, automaticRepairsConsumed: 0, choiceRepairsConsumed: 0, eventCoverageRepairsConsumed: 0 } });
    await expect(fixture.repository.saveFrozenResponseContracts!(fixture.scope, queuedResponsePolicyHash(policy("required")), frozen)).resolves.toEqual(frozen);
    const reloaded = await fixture.repository.loadExecutionPayload({ workerId: fixture.scope.workerId, leaseSeconds: 30, claim: fixture.claim });
    expect(reloaded?.orchestration_private.frozenResponseContracts).toEqual(frozen);
    expect(frozen.contracts["story:nonstream"].schema.properties.nullable).toEqual({ type: ["string", "null"] });
    const request = strictAudit(frozen);
    const reserved = await fixture.repository.reserveResponseContractInvocation!(fixture.scope, { logicalAttemptId, invocationKey: "story:nonstream", operation: "story_generation", requestPayloadHash: hash, request });
    expect(reserved?.status).toBe("reserved");
    for (const changed of [
      { selectionHash: "b".repeat(64) }, { mode: "json_object" as const, schemaVersion: null, schemaHash: null, providerRoutingSlugs: [] },
      { schemaVersion: "contract-schema-v2" }, { schemaHash: "c".repeat(64) }, { providerRoutingSlugs: ["other/route"] }, { requestedModel: "other-model" }
    ]) await expect(fixture.repository.reserveResponseContractInvocation!(fixture.scope, { logicalAttemptId, invocationKey: "story:nonstream", operation: "story_generation", requestPayloadHash: hash, request: { ...request, ...changed } as never })).resolves.toBeNull();
    const dispatched = await fixture.repository.markResponseContractInvocationDispatched!(fixture.scope, reserved!.id, hash);
    await expect(fixture.repository.completeResponseContractInvocation!(fixture.scope, dispatched!.id, { returnedModel: "contract-model", returnedProviderRoute: "openai/structured", diagnosticCode: null })).resolves.toMatchObject({ status: "completed" });
    const row = await pool.query<{ orchestrationPrivate: { responseContractInvocations: unknown[] } }>("SELECT orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [queued.id]);
    expect(row.rows[0]?.orchestrationPrivate.responseContractInvocations).toHaveLength(1);
    await pool.query("UPDATE generation_jobs SET status='cancelled', lease_owner=NULL, lease_expires_at=NULL WHERE id=$1", [queued.id]);
  });

  it("gives an explicit retry a new logical attempt while retaining frozen selection and immutable ledger", async () => {
    const imported = await campaign();
    const command = commands(true);
    const queued = await command.enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse({ action: "Retry without rewriting audit history.", providerProfileId, idempotencyKey: crypto.randomUUID(), context: { budgetTokens: 16000, compression: "full", recentTurns: 8 } }));
    const fixture = await claimed(queued.id);
    const originalAttempt = crypto.randomUUID(); const frozen = selection();
    await fixture.repository.saveOrchestration(fixture.scope, { ...fixture.payload.orchestration_private, logicalAttempt: { version: 1 as const, id: originalAttempt, semanticRepairsConsumed: 0, reviewsConsumed: 0, automaticRepairsConsumed: 0, choiceRepairsConsumed: 0, eventCoverageRepairsConsumed: 0 } });
    await fixture.repository.saveFrozenResponseContracts!(fixture.scope, queuedResponsePolicyHash(policy()), frozen);
    const reserved = await fixture.repository.reserveResponseContractInvocation!(fixture.scope, { logicalAttemptId: originalAttempt, invocationKey: "story:nonstream", operation: "story_generation", requestPayloadHash: hash, request: audit(frozen) });
    expect(reserved).not.toBeNull();
    expect(await fixture.repository.markRecoverable({ ...fixture.scope, providerResponseId: null, providerFinishReason: null, errorCode: "provider_failed", errorMessage: "retry fixture", recoveryMetadata: {} })).toBe(true);
    await expect(command.retry({ ownerUserId, jobId: queued.id })).resolves.toMatchObject({ id: queued.id });
    const reclaimer = await claimed(queued.id, `retry-${crypto.randomUUID()}`);
    expect(reclaimer.payload.orchestration_private.logicalAttempt?.id).not.toBe(originalAttempt);
    expect(reclaimer.payload.orchestration_private.frozenResponseContracts).toEqual(frozen);
    expect(reclaimer.payload.orchestration_private.responseContractInvocations).toEqual([reserved]);
    await pool.query("UPDATE generation_jobs SET status='cancelled', lease_owner=NULL, lease_expires_at=NULL WHERE id=$1", [queued.id]);
  });

  it("preserves frozen contracts, ledger nulls, and nested generic state through a real review pause", async () => {
    const imported = await campaign();
    const queued = await commands(true).enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse({ action: "Pause without dropping private contract evidence.", providerProfileId, idempotencyKey: crypto.randomUUID(), context: { budgetTokens: 16000, compression: "full", recentTurns: 8 } }));
    const fixture = await claimed(queued.id);
    const logicalAttemptId = crypto.randomUUID(); const frozen = selection();
    await fixture.repository.saveOrchestration(fixture.scope, { ...fixture.payload.orchestration_private, harmless: { nested: null }, logicalAttempt: { version: 1 as const, id: logicalAttemptId, semanticRepairsConsumed: 0, reviewsConsumed: 0, automaticRepairsConsumed: 0, choiceRepairsConsumed: 0, eventCoverageRepairsConsumed: 0 } } as never);
    await fixture.repository.saveFrozenResponseContracts!(fixture.scope, queuedResponsePolicyHash(policy()), frozen);
    const reserved = await fixture.repository.reserveResponseContractInvocation!(fixture.scope, { logicalAttemptId, invocationKey: "story:nonstream", operation: "story_generation", requestPayloadHash: hash, request: audit(frozen) });
    expect(await fixture.repository.pauseForReview(fixture.scope, await checkpointForPause(fixture, imported.campaignId))).toBe(true);
    const row = await pool.query<{ orchestrationPrivate: Record<string, unknown>; status: string }>("SELECT status,orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [queued.id]);
    expect(row.rows[0]).toMatchObject({ status: "recoverable", orchestrationPrivate: { frozenResponseContracts: frozen, responseContractInvocations: [reserved], harmless: { nested: null } } });
  });
});
