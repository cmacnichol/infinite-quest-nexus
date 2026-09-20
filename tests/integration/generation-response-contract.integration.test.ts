import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generationRequestSchema, generationRetryLatestRequestSchema } from "../../packages/contracts/src/generation.js";
import { frozenResponseContractsSelectionHash, frozenResponseContractsV2SelectionHash, queuedResponsePolicyHash, queuedResponsePolicyVersionedHash } from "../../packages/contracts/src/generation-response-contract.js";
import { getProviderOutputSchemaV2 } from "../../packages/contracts/src/provider-output-schema.js";
import { deriveTextExecutionPlan, textExecutionRouteBasisHash } from "../../packages/contracts/src/text-execution-plan.js";
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
import { sha256, stableStringify } from "../../packages/domain/src/index.js";

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
  function commands(withPolicy: boolean, responsePolicy?: ReturnType<typeof policy> | ReturnType<typeof v2Policy> | ReturnType<typeof v2ModelPolicy>, routeBasis?: ReturnType<typeof v2RouteBasis>) {
    return createPostgresGenerationCommandRepository(pool, {
      resolvePromptSnapshot: (client, owner, campaignId) => loadPromptSnapshotForTest(client, owner, campaignId),
      promptProtocolVersion: providerPromptProtocolVersion,
      readTurnReportedCosts: (owner, _campaign, turnIds) => readTurnReportedCostsForTest(pool, owner, [...turnIds]),
      ...(withPolicy ? { resolveQueuedResponsePolicy: async () => responsePolicy ?? ({ version: 1, policy: "auto" as const, providerProfileId, model: "contract-model", endpointIdentity: "test-endpoint", providerConfigurationHash: hash, verificationRegistryHash: hash, operationClosureVersion: 1 as const, invocationKeys: ["story:nonstream" as const] }) } : {}),
      ...(routeBasis ? { prepareTextExecutionRouteBasis: async () => routeBasis } : {})
    });
  }
  function policy(policy: "auto" | "required" = "auto") {
    return { version: 1 as const, policy, providerProfileId, model: "contract-model", endpointIdentity: "test-endpoint", providerConfigurationHash: hash, verificationRegistryHash: hash, operationClosureVersion: 1 as const, invocationKeys: ["story:nonstream" as const] };
  }
  function frozenTextPlan() {
    const plan = { version: 2 as const, selection: { kind: "model" as const, modelId: "contract-model" }, preset: null,
      candidates: [{ modelId: "contract-model", providerPolicy: {}, contextWindowTokens: 32768, maxOutputTokens: 4096 }],
      presetSystemPrompt: "", parameters: {}, prompt: "Frozen Story prompt.", promptHash: sha256("Frozen Story prompt."),
      endpointReference: "test-endpoint", credentialReference: providerProfileId, profileRevision: hash, protocolVersion: "text-execution-plan-v2" };
    return { ...plan, planHash: sha256(stableStringify(plan)) };
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
  function v2RouteBasis() {
    const draft = {
      version: 2 as const, selection: { kind: "openrouter_preset" as const, slug: "contract-preset" },
      preset: { slug: "contract-preset", versionId: "preset-v1", configHash: hash },
      candidates: [{ modelId: "contract-model", providerPolicy: {}, contextWindowTokens: 32768, maxOutputTokens: 4096 }],
      presetSystemPrompt: "Contract preset instructions.", parameters: {}, endpointReference: "test-endpoint",
      credentialReference: "contract-credential", profileRevision: "profile-v1", authorityRevision: "authority-v1",
      requestTimeoutMs: 30000, protocolVersion: "text-schema-adapter-v2"
    };
    return { ...draft, routeBasisHash: textExecutionRouteBasisHash({ ...draft, routeBasisHash: hash }) };
  }
  function v2Policy(routeBasisHash: string) {
    return {
      version: 2 as const, policy: "required" as const, providerProfileId,
      admission: { mode: "json_schema" as const, basis: "preset_trusted" as const },
      authority: { kind: "preset_trusted" as const, routeBasisHash, selection: { kind: "openrouter_preset" as const, slug: "contract-preset" }, endpointReference: "test-endpoint", credentialReference: "contract-credential", authorityRevision: "authority-v1", profileRevision: "profile-v1" },
      operationClosureVersion: 2 as const, invocationKeys: ["story:nonstream" as const]
    };
  }
  function v2Frozen(routeBasisHash: string) {
    const queuedPolicy = v2Policy(routeBasisHash); const story = getProviderOutputSchemaV2("story");
    const selected = { version: 2 as const, queuedPolicy, selectedAt: "2026-09-18T00:00:00.000Z", capabilityEvidenceHash: hash,
      contracts: { "story:nonstream": { version: 2 as const, mode: "json_schema" as const, admission: queuedPolicy.admission, operation: "story" as const, streaming: false, forbidFormatFallback: true as const, schemaVersion: story.version, schemaHash: story.schemaHash, schemaName: story.name, schema: story.schema, authority: { kind: "preset_trusted" as const, routeBasisHash } } } };
    return { ...selected, selectionHash: frozenResponseContractsV2SelectionHash(selected) };
  }
  function v2Audit(frozen: ReturnType<typeof v2Frozen>, prompt: string, plan: ReturnType<typeof deriveTextExecutionPlan>, requestPayloadHash: string) {
    const contract = frozen.contracts["story:nonstream"];
    return { version: 2 as const, selectionHash: frozen.selectionHash, invocationKey: "story:nonstream" as const, schemaVersion: contract.schemaVersion, schemaHash: contract.schemaHash, requestedModel: "contract-model", operationPromptHash: sha256Hex(prompt), planHash: plan.planHash, routeBasisHash: plan.routeBasisHash!, requestPayloadHash, returnedModel: null, returnedProviderRoute: null, diagnosticCode: null };
  }
  function v2ModelPolicy() {
    const schema = getProviderOutputSchemaV2("event_coverage");
    const verification = { version: 2 as const, providerType: "openrouter" as const, endpointIdentity: "test-endpoint", model: "contract-model", routeConfigHash: hash,
      adapterProtocol: "text-schema-adapter-v2" as const, operation: "event_coverage" as const, schemaHash: schema.schemaHash, streaming: false,
      verifiedAt: "2026-09-18T00:00:00.000Z", expiresAt: "2026-09-20T00:00:00.000Z", providerRoutingSlugs: [], nativeOpenTrackerObjects: false };
    const authority = { kind: "model_verified" as const, providerProfileId, providerType: "openrouter" as const, endpointIdentity: "test-endpoint", model: "contract-model", providerConfigurationHash: hash, routeConfigHash: hash, verificationRegistryHash: hash };
    return { version: 2 as const, policy: "required" as const, providerProfileId, admission: { mode: "json_schema" as const, basis: "model_verified" as const, verification }, authority,
      operationClosureVersion: 2 as const, invocationKeys: ["event_coverage:nonstream" as const] };
  }
  function v2ModelFrozen() {
    const queuedPolicy = v2ModelPolicy(); const schema = getProviderOutputSchemaV2("event_coverage");
    const selected = { version: 2 as const, queuedPolicy, selectedAt: "2026-09-18T00:00:00.000Z", capabilityEvidenceHash: hash,
      contracts: { "event_coverage:nonstream": { version: 2 as const, mode: "json_schema" as const, admission: queuedPolicy.admission, operation: "event_coverage" as const, streaming: false, forbidFormatFallback: true as const, schemaVersion: schema.version, schemaHash: schema.schemaHash, schemaName: schema.name, schema: schema.schema, authority: queuedPolicy.authority } } };
    return { ...selected, selectionHash: frozenResponseContractsV2SelectionHash(selected) };
  }
  function v2ModelAudit(frozen: ReturnType<typeof v2ModelFrozen>, prompt: string, requestPayloadHash: string) {
    const contract = frozen.contracts["event_coverage:nonstream"];
    return { version: 2 as const, selectionHash: frozen.selectionHash, invocationKey: "event_coverage:nonstream" as const, schemaVersion: contract.schemaVersion, schemaHash: contract.schemaHash, requestedModel: "contract-model", operationPromptHash: sha256Hex(prompt), planHash: null, routeBasisHash: null, requestPayloadHash, returnedModel: null, returnedProviderRoute: null, diagnosticCode: null };
  }
  async function claimed(queuedId: string, workerId = `matrix-${crypto.randomUUID()}`) {
    const repository = createPostgresGenerationExecutionRepository(pool);
    const claim = await repository.claimNext({ workerId, leaseSeconds: 30 });
    expect(claim?.jobId).toBe(queuedId);
    const payload = await repository.loadExecutionPayload({ workerId, leaseSeconds: 30, claim: claim! });
    expect(payload?.id).toBe(queuedId);
    return { repository, claim: claim!, payload: payload!, scope: { jobId: queuedId, ownerUserId, workerId } };
  }
  async function v2ModelFixture(action: string) {
    const imported = await campaign(); const frozen = v2ModelFrozen();
    const queued = await commands(true, frozen.queuedPolicy).enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse({ action, providerProfileId, idempotencyKey: crypto.randomUUID(), context: { budgetTokens: 16000, compression: "full", recentTurns: 8 } }));
    const fixture = await claimed(queued.id); const logicalAttemptId = crypto.randomUUID();
    const initial = { ...fixture.payload.orchestration_private, logicalAttempt: { version: 1 as const, id: logicalAttemptId, semanticRepairsConsumed: 0, reviewsConsumed: 0, automaticRepairsConsumed: 0, choiceRepairsConsumed: 0, eventCoverageRepairsConsumed: 0 } };
    expect(await fixture.repository.saveOrchestration(fixture.scope, initial)).toBe(true);
    expect(await fixture.repository.saveFrozenResponseContracts!(fixture.scope, queuedResponsePolicyVersionedHash(frozen.queuedPolicy), frozen)).toEqual(frozen);
    return { queued, fixture, frozen, logicalAttemptId, initial };
  }
  async function v2PresetFixture(action: string) {
    const routeBasis = v2RouteBasis(); const frozen = v2Frozen(routeBasis.routeBasisHash);
    const imported = await campaign();
    const queued = await commands(true, frozen.queuedPolicy, routeBasis).enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse({ action, providerProfileId, idempotencyKey: crypto.randomUUID(), context: { budgetTokens: 16000, compression: "full", recentTurns: 8 } }));
    const fixture = await claimed(queued.id); const logicalAttemptId = crypto.randomUUID();
    const initial = { ...fixture.payload.orchestration_private, textExecutionRouteBasis: routeBasis, logicalAttempt: { version: 1 as const, id: logicalAttemptId, semanticRepairsConsumed: 0, reviewsConsumed: 0, automaticRepairsConsumed: 0, choiceRepairsConsumed: 0, eventCoverageRepairsConsumed: 0 } };
    expect(await fixture.repository.saveOrchestration(fixture.scope, initial)).toBe(true);
    expect(await fixture.repository.saveFrozenResponseContracts!(fixture.scope, queuedResponsePolicyVersionedHash(frozen.queuedPolicy), frozen)).toEqual(frozen);
    return { queued, fixture, frozen, routeBasis, logicalAttemptId, initial };
  }
  function primaryResultCheckpoint(requestBody: string, requestPayloadHash: string) {
    return { version: 1, requestBody, requestPayloadHash, response: { content: "{}", responseId: "tampered", finishReason: "stop", outputLimited: false, modelInstanceId: "model", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, reportedCost: null, rawMetadata: {} }, sentFactIds: [], providerConfigurationHash: hash, contextFingerprint: "x", contextDiagnostics: {}, chronicleRetrieval: {} };
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

  it("persists one v2 closure for prompt-distinct primary and repair reservations behind lease and owner fences", async () => {
    const imported = await campaign();
    const routeBasis = v2RouteBasis(); const frozen = v2Frozen(routeBasis.routeBasisHash);
    const queued = await commands(true, frozen.queuedPolicy, routeBasis).enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse({ action: "Persist prompt-distinct response contracts.", providerProfileId, idempotencyKey: crypto.randomUUID(), context: { budgetTokens: 16000, compression: "full", recentTurns: 8 } }));
    const fixture = await claimed(queued.id); const logicalAttemptId = crypto.randomUUID();
    const initial = { ...fixture.payload.orchestration_private, textExecutionRouteBasis: routeBasis, logicalAttempt: { version: 1 as const, id: logicalAttemptId, semanticRepairsConsumed: 0, reviewsConsumed: 0, automaticRepairsConsumed: 0, choiceRepairsConsumed: 0, eventCoverageRepairsConsumed: 0 } };
    expect(await fixture.repository.saveOrchestration(fixture.scope, initial)).toBe(true);
    expect(await fixture.repository.saveFrozenResponseContracts!(fixture.scope, queuedResponsePolicyVersionedHash(frozen.queuedPolicy), frozen)).toEqual(frozen);
    expect(await fixture.repository.saveOrchestration(fixture.scope, initial)).toBe(true);
    const primaryPrompt = "Write the next turn."; const repairPrompt = "Repair the rejected turn.";
    const primaryPlan = deriveTextExecutionPlan(routeBasis, primaryPrompt); const repairPlan = deriveTextExecutionPlan(routeBasis, repairPrompt);
    const primaryBody = "{}"; const primaryHash = sha256Hex(primaryBody); const repairHash = "c".repeat(64);
    const primaryInput = { version: 2 as const, logicalAttemptId, invocationKey: "story:nonstream" as const, operation: "story_generation" as const, requestPayloadHash: primaryHash, request: v2Audit(frozen, primaryPrompt, primaryPlan, primaryHash), routeBasis, plan: primaryPlan, trustedOperationPrompt: primaryPrompt };
    const repairInput = { version: 2 as const, logicalAttemptId, invocationKey: "story:nonstream" as const, operation: "story_recovery" as const, requestPayloadHash: repairHash, request: v2Audit(frozen, repairPrompt, repairPlan, repairHash), routeBasis, plan: repairPlan, trustedOperationPrompt: repairPrompt };
    const primary = await fixture.repository.reserveResponseContractInvocation!(fixture.scope, primaryInput);
    expect(primary).toMatchObject({ version: 2, status: "reserved", request: { planHash: primaryPlan.planHash } });
    await expect(fixture.repository.reserveResponseContractInvocation!(fixture.scope, primaryInput)).resolves.toEqual(primary);
    await expect(fixture.repository.reserveResponseContractInvocation!(fixture.scope, { ...repairInput, request: { ...repairInput.request, requestedModel: "unrelated-model" } })).resolves.toBeNull();
    await expect(fixture.repository.reserveResponseContractInvocation!(fixture.scope, { ...repairInput, plan: primaryPlan })).resolves.toBeNull();
    const repair = await fixture.repository.reserveResponseContractInvocation!(fixture.scope, repairInput);
    expect(repair).toMatchObject({ version: 2, status: "reserved", request: { planHash: repairPlan.planHash } });
    expect(primaryPlan.planHash).not.toBe(repairPlan.planHash);
    await expect(fixture.repository.markResponseContractInvocationDispatched!(fixture.scope, primary!.id, primaryHash)).resolves.toMatchObject({ version: 2, status: "dispatched" });
    await expect(fixture.repository.completeResponseContractInvocation!(fixture.scope, primary!.id, { returnedModel: "contract-model", returnedProviderRoute: "route-a", diagnosticCode: null })).resolves.toMatchObject({ version: 2, status: "completed" });
    const failure = { version: 2 as const, invocationId: primary!.id, requestBody: primaryBody, requestPayloadHash: primaryHash, responseId: "partial-id", partialContent: "private partial", partialContentTruncated: false, returnedModel: "contract-model", returnedProviderRoute: "route-a", diagnosticCode: "provider_schema_invalid" as const };
    expect(await fixture.repository.saveOrchestration(fixture.scope, { ...initial, preparedResponseFailures: [failure] })).toBe(true);
    for (let index = 0; index < 22; index += 1) {
      const prompt = `Apply bounded repair evidence ${index}.`; const plan = deriveTextExecutionPlan(routeBasis, prompt);
      const requestPayloadHash = index.toString(16).padStart(64, "0");
      await expect(fixture.repository.reserveResponseContractInvocation!(fixture.scope, { version: 2 as const, logicalAttemptId, invocationKey: "story:nonstream" as const, operation: "event_extension" as const, requestPayloadHash, request: v2Audit(frozen, prompt, plan, requestPayloadHash), routeBasis, plan, trustedOperationPrompt: prompt })).resolves.toMatchObject({ version: 2, status: "reserved" });
    }
    await expect(fixture.repository.reserveResponseContractInvocation!(fixture.scope, { ...repairInput, requestPayloadHash: "f".repeat(64), request: v2Audit(frozen, repairPrompt, repairPlan, "f".repeat(64)) })).resolves.toBeNull();
    await expect(fixture.repository.reserveResponseContractInvocation!({ ...fixture.scope, ownerUserId: crypto.randomUUID() }, repairInput)).resolves.toBeNull();
    await pool.query("UPDATE generation_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [queued.id]);
    await expect(fixture.repository.reserveResponseContractInvocation!(fixture.scope, repairInput)).resolves.toBeNull();
    const reclaimer = await claimed(queued.id, `v2-reclaim-${crypto.randomUUID()}`);
    await expect(reclaimer.repository.reserveResponseContractInvocation!(reclaimer.scope, repairInput)).resolves.toEqual(repair);
    expect(reclaimer.payload.orchestration_private.frozenResponseContracts).toEqual(frozen);
    expect(reclaimer.payload.orchestration_private.preparedResponseFailures).toEqual([failure]);
    const stored = await pool.query<{ orchestrationPrivate: Record<string, unknown> }>("SELECT orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [queued.id]);
    expect(stored.rows[0]!.orchestrationPrivate.frozenResponseContracts).toEqual(frozen);
    expect(stored.rows[0]!.orchestrationPrivate.responseContractInvocations).toHaveLength(24);
    await pool.query("UPDATE generation_jobs SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1", [queued.id]);
  });

  it("persists a verified Model v2 invocation without a preset route basis or plan", async () => {
    const imported = await campaign(); const frozen = v2ModelFrozen();
    const queued = await commands(true, frozen.queuedPolicy).enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse({ action: "Persist a verified Model contract.", providerProfileId, idempotencyKey: crypto.randomUUID(), context: { budgetTokens: 16000, compression: "full", recentTurns: 8 } }));
    const fixture = await claimed(queued.id); const logicalAttemptId = crypto.randomUUID();
    const initial = { ...fixture.payload.orchestration_private, logicalAttempt: { version: 1 as const, id: logicalAttemptId, semanticRepairsConsumed: 0, reviewsConsumed: 0, automaticRepairsConsumed: 0, choiceRepairsConsumed: 0, eventCoverageRepairsConsumed: 0 } };
    expect(await fixture.repository.saveOrchestration(fixture.scope, initial)).toBe(true);
    expect(await fixture.repository.saveFrozenResponseContracts!(fixture.scope, queuedResponsePolicyVersionedHash(frozen.queuedPolicy), frozen)).toEqual(frozen);
    const requestBody = "{}"; const requestPayloadHash = sha256Hex(requestBody); const prompt = "Validate event coverage.";
    const input = { version: 2 as const, logicalAttemptId, invocationKey: "event_coverage:nonstream" as const, operation: "event_coverage_validation" as const, requestPayloadHash,
      request: v2ModelAudit(frozen, prompt, requestPayloadHash), routeBasis: undefined, plan: undefined, trustedOperationPrompt: prompt };
    const reserved = await fixture.repository.reserveResponseContractInvocation!(fixture.scope, input);
    expect(reserved).toMatchObject({ version: 2, request: { planHash: null, routeBasisHash: null, requestedModel: "contract-model" } });
    await expect(fixture.repository.markResponseContractInvocationDispatched!(fixture.scope, reserved!.id, requestPayloadHash)).resolves.toMatchObject({ status: "dispatched" });
    await expect(fixture.repository.completeResponseContractInvocation!(fixture.scope, reserved!.id, { returnedModel: "contract-model", returnedProviderRoute: "route-a", diagnosticCode: null })).resolves.toMatchObject({ status: "completed" });
    const reloaded = await fixture.repository.loadExecutionPayload({ workerId: fixture.scope.workerId, leaseSeconds: 30, claim: fixture.claim });
    expect(reloaded?.orchestration_private.frozenResponseContracts).toEqual(frozen);
    await pool.query("UPDATE generation_jobs SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1", [queued.id]);
  });

  it("rejects a rehashed v2 closure whose canonical schema body was tampered", async () => {
    const { queued, fixture, frozen } = await v2ModelFixture("Reject a rehashed v2 schema tamper.");
    const contract = frozen.contracts["event_coverage:nonstream"];
    const altered = { ...frozen, contracts: { ...frozen.contracts, "event_coverage:nonstream": { ...contract, schema: { ...contract.schema, x_tampered: true } } } };
    const tampered = { ...altered, selectionHash: frozenResponseContractsV2SelectionHash(altered) };
    await pool.query("UPDATE generation_jobs SET orchestration_private=orchestration_private || jsonb_build_object('frozenResponseContracts',$2::jsonb) WHERE id=$1", [queued.id, JSON.stringify(tampered)]);
    await expect(fixture.repository.loadExecutionPayload({ workerId: fixture.scope.workerId, leaseSeconds: 30, claim: fixture.claim })).resolves.toBeNull();
    await expect(pool.query<{ status: string; errorCode: string }>("SELECT status,error_code AS \"errorCode\" FROM generation_jobs WHERE id=$1", [queued.id]))
      .resolves.toMatchObject({ rows: [{ status: "recoverable", errorCode: "generation_checkpoint_incompatible" }] });
  });

  it("rejects a v2 completed checkpoint that has no durable invocation", async () => {
    const { queued, fixture } = await v2PresetFixture("Reject a v2 checkpoint without its invocation.");
    const body = "{}"; const requestPayloadHash = sha256Hex(body);
    await pool.query("UPDATE generation_jobs SET orchestration_private=orchestration_private || jsonb_build_object('primaryResult',$2::jsonb) WHERE id=$1", [queued.id, JSON.stringify(primaryResultCheckpoint(body, requestPayloadHash))]);
    await expect(fixture.repository.loadExecutionPayload({ workerId: fixture.scope.workerId, leaseSeconds: 30, claim: fixture.claim })).resolves.toBeNull();
    await expect(pool.query<{ status: string; errorCode: string }>("SELECT status,error_code AS \"errorCode\" FROM generation_jobs WHERE id=$1", [queued.id]))
      .resolves.toMatchObject({ rows: [{ status: "recoverable", errorCode: "generation_checkpoint_incompatible" }] });
  });

  it("rejects a v2 completed checkpoint whose invocation body identity differs", async () => {
    const { queued, fixture, frozen, routeBasis, logicalAttemptId } = await v2PresetFixture("Reject a v2 checkpoint with another invocation identity.");
    const requestBody = "{}"; const requestPayloadHash = sha256Hex(requestBody); const prompt = "Write the next turn."; const plan = deriveTextExecutionPlan(routeBasis, prompt);
    const input = { version: 2 as const, logicalAttemptId, invocationKey: "story:nonstream" as const, operation: "story_generation" as const, requestPayloadHash,
      request: v2Audit(frozen, prompt, plan, requestPayloadHash), routeBasis, plan, trustedOperationPrompt: prompt };
    const reserved = await fixture.repository.reserveResponseContractInvocation!(fixture.scope, input);
    await fixture.repository.markResponseContractInvocationDispatched!(fixture.scope, reserved!.id, requestPayloadHash);
    await fixture.repository.completeResponseContractInvocation!(fixture.scope, reserved!.id, { returnedModel: "contract-model", returnedProviderRoute: "route-a", diagnosticCode: null });
    await pool.query("UPDATE generation_jobs SET orchestration_private=orchestration_private || jsonb_build_object('primaryResult',$2::jsonb) WHERE id=$1", [queued.id, JSON.stringify(primaryResultCheckpoint(requestBody, "f".repeat(64)))]);
    await expect(fixture.repository.loadExecutionPayload({ workerId: fixture.scope.workerId, leaseSeconds: 30, claim: fixture.claim })).resolves.toBeNull();
    await expect(pool.query<{ status: string; errorCode: string }>("SELECT status,error_code AS \"errorCode\" FROM generation_jobs WHERE id=$1", [queued.id]))
      .resolves.toMatchObject({ rows: [{ status: "recoverable", errorCode: "generation_checkpoint_incompatible" }] });
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
    const textPlan = frozenTextPlan();
    await pool.query("UPDATE generation_jobs SET orchestration_private=orchestration_private || jsonb_build_object('textExecutionPlan',$2::jsonb) WHERE id=$1", [queued.id, JSON.stringify(textPlan)]);
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
    expect(afterSave?.orchestration_private.textExecutionPlan).toEqual(textPlan);
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
