import { assertContinuityReviewCommit, assertGenerationReviewAcceptance, bindManifestToProducingRequest, validatedChoiceRequestHashes, continuityReviewCheckpointSchema, type ContinuityReviewCheckpoint } from "../../application/src/memory/continuity-review-checkpoint.js";
import { generationReviewCheckpointSchema, generationReviewFindingsHash, type GenerationReviewCheckpoint } from "../../application/src/generation/review-checkpoint.js";
import type { GenerationFailureDiagnostic } from "../../contracts/src/generation-review.js";
import { storyMemoryPolicySnapshotSchema } from "../../contracts/src/story-memory-policy.js";
import { assertContinuityReviewPromptSnapshot } from "../../contracts/src/prompt-library.js";
import { sha256Hex } from "../../contracts/src/hash.js";
import {
  readFrozenResponseContracts,
  readQueuedResponsePolicy,
  queuedResponsePolicyHash,
  readAttemptResponseContractAudit,
  readResponseContractInvocationAudit,
  responseContractInvocationAuditId,
  type AttemptResponseContractAudit,
  type FrozenResponseContracts,
  type QueuedResponsePolicy,
  type ResponseInvocationKey,
  type ResponseContractInvocationAudit,
  type ResponseContractOperation
} from "../../contracts/src/generation-response-contract.js";
import { canonicalEvidenceJson, type GenerationEvidenceManifest } from "../../application/src/memory/generation-context.js";
import { projectSafeGenerationDiagnostic, type SafeGenerationDiagnostic } from "../../contracts/src/story-prompt.js";
import type {
  CampaignWorldVersionMemoryScope,
  ClaimedGeneration,
  GenerationClaimRepository,
  GenerationExecutionRequest,
  IllustrationGenerationTransactionPort,
  MemoryGenerationTransactionPort
} from "../../application/src/index.js";
import {
  pendingEventTriggerSchema,
  playerEventTriggerSchema,
  playerRpgStatSchema,
  storyTurnOutputSchema,
  type CampaignTracker,
  type PlayerEventTrigger,
  type PlayerRpgStat,
  type StoryTurnOutput
} from "../../contracts/src/generation.js";
import {
  chronicleRetrievalAuditSchema,
  type ChronicleRetrievalAudit,
  type MemoryContextQuery
} from "../../contracts/src/memory.js";
import type { PromptSnapshot } from "../../contracts/src/prompt-library.js";
import {
  generationPolicySnapshotSchema,
  type GenerationPolicySnapshot
} from "../../contracts/src/campaign-generation-policy.js";
import type { StoryLengthProfile } from "../../contracts/src/story-settings.js";
import {
  applyTriggerHits,
  buildTurnFictionMemory,
  type ActivatedEvent,
  type PrivateRollResolution,
  type ProviderResult
} from "../../story-engine/src/index.js";
import { mechanicsLeakFields } from "../../story-engine/src/output.js";
import {
  buildScopedEntityCatalog,
  normalizeCampaignTrackers,
  resolveEntityMetadata,
  stableStringify
} from "../../domain/src/index.js";
import {
  isGenerationBaseIdentityV3,
  readGenerationBaseIdentity
} from "../../application/src/memory/generation-context.js";
import {
  resolveGenerationAuthoritySnapshot,
  type GenerationBaseIdentity
} from "./generation-authority.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";
import { normalizeCampaignEventTriggers } from "../../domain/src/campaign-event-triggers.js";
import { withTransaction } from "./pool.js";

async function enqueueChunkIndexBestEffort(
  client: DatabaseClient,
  memory: MemoryGenerationTransactionPort,
  scope: CampaignWorldVersionMemoryScope,
): Promise<void> {
  await client.query("SAVEPOINT accepted_turn_chunk_enqueue");
  try {
    await memory.enqueueChunkIndex(client, scope);
    await client.query("RELEASE SAVEPOINT accepted_turn_chunk_enqueue");
  } catch {
    await client.query("ROLLBACK TO SAVEPOINT accepted_turn_chunk_enqueue");
    await client.query("RELEASE SAVEPOINT accepted_turn_chunk_enqueue");
  }
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** v1 permits every currently authorized operation plus explicit retries without growing unbounded. */
const responseContractInvocationLedgerLimit = 24;

function responseContractInvocations(value: unknown): readonly ResponseContractInvocationAudit[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > responseContractInvocationLedgerLimit) throw new Error("Response-contract invocation ledger is invalid.");
  const ids = new Set<string>();
  return value.map((candidate) => {
    const item = readResponseContractInvocationAudit(candidate);
    if (ids.has(item.id)) throw new Error("Response-contract invocation ledger is invalid.");
    ids.add(item.id);
    return item;
  });
}

function responseContractState(jobId: string, value: GenerationOrchestrationState): void {
  const queued = readQueuedResponsePolicy(value.queuedResponsePolicy);
  const frozen = readFrozenResponseContracts(value.frozenResponseContracts);
  const ledger = responseContractInvocations(value.responseContractInvocations);
  if (frozen && (!queued || queuedResponsePolicyHash(queued) !== queuedResponsePolicyHash(frozen.queuedPolicy))) {
    throw new Error("Frozen response contract does not match the queued policy.");
  }
  if (ledger && !frozen) throw new Error("Response-contract invocation ledger requires a frozen contract.");
  if (ledger && frozen) {
    for (const entry of ledger) {
      if (!auditMatchesFrozenInvocation(frozen, entry.invocationKey, entry.request)
        || !operationMatchesInvocation(entry.operation, entry.invocationKey)
        || entry.id !== responseContractInvocationAuditId(jobId, entry.logicalAttemptId, entry.invocationKey, entry.operation, entry.requestPayloadHash)
        || entry.request.returnedModel !== null || entry.request.returnedProviderRoute !== null || entry.request.diagnosticCode !== null) {
        throw new Error("Response-contract invocation ledger is inconsistent with its frozen contract.");
      }
    }
  }
}

function operationMatchesInvocation(operation: ResponseContractOperation, invocationKey: ResponseInvocationKey): boolean {
  if (operation === "story_choice_repair") return invocationKey === "choices:nonstream";
  if (operation === "story_continuity_review") return invocationKey === "continuity_review:nonstream";
  return invocationKey === "story:nonstream" || (operation === "story_generation" && invocationKey === "story:stream");
}

function auditMatchesFrozenInvocation(
  frozen: FrozenResponseContracts,
  invocationKey: ResponseInvocationKey,
  audit: AttemptResponseContractAudit
): boolean {
  const contract = frozen.contracts[invocationKey];
  if (!contract || audit.selectionHash !== frozen.selectionHash || audit.invocationKey !== invocationKey
    || audit.requestedModel !== frozen.queuedPolicy.model || audit.mode !== contract.mode) return false;
  if (contract.mode === "json_object") return audit.schemaVersion === null && audit.schemaHash === null && audit.providerRoutingSlugs.length === 0;
  return audit.schemaVersion === contract.schemaVersion && audit.schemaHash === contract.schemaHash
    && stableStringify(audit.providerRoutingSlugs) === stableStringify(contract.providerRoutingSlugs);
}

async function updateResponseContractInvocation(
  pool: DatabasePool,
  scope: GenerationLeaseScope,
  invocationId: string,
  nextStatus: "dispatched" | "completed",
  expectedRequestPayloadHash?: string,
  response?: Pick<AttemptResponseContractAudit, "returnedModel" | "returnedProviderRoute" | "diagnosticCode">
): Promise<ResponseContractInvocationAudit | null> {
  return withTransaction(pool, async (client) => {
    const result = await client.query<{ orchestrationPrivate: GenerationOrchestrationState }>(
      `SELECT orchestration_private AS "orchestrationPrivate" FROM generation_jobs
        WHERE id=$1 AND owner_user_id=$2 AND lease_owner=$3 AND status IN ('assessing','generating','validating') AND lease_expires_at > now() FOR UPDATE`,
      [scope.jobId, scope.ownerUserId, scope.workerId]
    );
    const row = result.rows[0]; if (!row) return null;
    responseContractState(scope.jobId, row.orchestrationPrivate);
    const ledger = [...(responseContractInvocations(row.orchestrationPrivate.responseContractInvocations) ?? [])];
    const index = ledger.findIndex((item) => item.id === invocationId);
    if (index < 0) return null;
    const existing = ledger[index]!;
    if (nextStatus === "dispatched" && existing.requestPayloadHash !== expectedRequestPayloadHash) return null;
    if (existing.status === "completed") {
      if (nextStatus === "completed" && stableStringify(existing.response) === stableStringify({ returnedModel: response?.returnedModel ?? null, returnedProviderRoute: response?.returnedProviderRoute ?? null, diagnosticCode: response?.diagnosticCode ?? null })) return existing;
      return null;
    }
    if (nextStatus === "dispatched" && existing.status !== "reserved") return null;
    if (nextStatus === "completed" && existing.status !== "dispatched") return null;
    const at = new Date().toISOString();
    const updated: ResponseContractInvocationAudit = nextStatus === "dispatched"
      ? { ...existing, status: "dispatched", dispatchedAt: existing.dispatchedAt ?? at }
      : { ...existing, status: "completed", completedAt: at, response: { returnedModel: response?.returnedModel ?? null, returnedProviderRoute: response?.returnedProviderRoute ?? null, diagnosticCode: response?.diagnosticCode ?? null } };
    let parsed: ResponseContractInvocationAudit;
    try { parsed = readResponseContractInvocationAudit(updated); } catch { return null; }
    ledger[index] = parsed;
    const write = await client.query<{ id: string }>(`UPDATE generation_jobs SET orchestration_private=orchestration_private || jsonb_build_object('responseContractInvocations',$4::jsonb), updated_at=now() WHERE id=$1 AND owner_user_id=$2 AND lease_owner=$3 AND status IN ('assessing','generating','validating') AND lease_expires_at > now() RETURNING id`, [scope.jobId, scope.ownerUserId, scope.workerId, json(ledger)]);
    if (!write.rows[0]) return null;
    return parsed;
  });
}

export type GenerationLeaseScope = Readonly<{
  jobId: string;
  ownerUserId: string;
  workerId: string;
}>;

/** Durable boundary between validated narration and downstream orchestration. */
export type GenerationValidatedMainDraftCheckpoint = Readonly<{
  version: 2;
  ownerUserId: string;
  campaignId: string;
  worldVersionId: string | null;
  baseIdentity: GenerationBaseIdentity;
  promptProtocolVersion: string;
  generationPolicyIdentity?: string;
  providerId: string;
  providerModel: string;
  /** Hash of the effective non-secret provider configuration used on the wire. */
  providerConfigurationHash: string;
  action: string;
  /** Normalized original action sent to the generation workflow. */
  originalInputHash: string;
  /** Exact serialized request body that produced the accepted draft. Private only. */
  requestBody: string;
  requestPayloadHash: string;
  draftHash: string;
  producingAttempt: number;
  story: StoryTurnOutput;
  response: ProviderResult;
  sentFactIds: readonly string[];
  /** Explicit user-authorized representation repair provenance; never provider output. */
  factFormatRepair?: {
    version: 1;
    reviewId: string;
    revision: number;
    planHash: string;
    rawOutputHash: string;
    resultHash: string;
  } | undefined;
}>;

/** Immutable record of each user-authorized fact-format repair application. */
export type FactFormatRepairApplication = Readonly<{
  version: 1;
  jobId: string;
  reviewId: string;
  revision: number;
  planHash: string;
  sourceResponseId: string | null;
  rawOutputReference: string;
  producingRequestHash: string;
  rawOutputHash: string;
  resultHash: string;
  providerConfigurationHash: string;
}>;

export type GenerationOrchestrationState = {
  /** Absent is the exact historical job shape; present values are server-owned and versioned. */
  queuedResponsePolicy?: QueuedResponsePolicy;
  frozenResponseContracts?: FrozenResponseContracts;
  responseContractInvocations?: readonly ResponseContractInvocationAudit[];
  /** Safe, last-known failure classification; attempts remain the historical ledger. */
  lastFailureDiagnostic?: GenerationFailureDiagnostic;
  /** A primary request was durably reserved; a lease reclaim cannot treat it as an unseen request. */
  primaryReservation?: {
    version: 1;
    requestBody: string;
    requestPayloadHash: string;
    providerConfigurationHash: string;
    attempt: number;
    status: "reserved" | "dispatched";
    authorizedReviewId?: string;
    authorizedRevision?: number;
  } | undefined;
  /** Complete primary response captured before parsing or any destructive validator/repair stage. */
  primaryResult?: {
    version: 1;
    requestBody: string;
    requestPayloadHash: string;
    response: ProviderResult;
    sentFactIds: readonly string[];
    providerConfigurationHash: string;
    contextFingerprint: string;
    contextDiagnostics: Record<string, unknown>;
    chronicleRetrieval: ChronicleRetrievalAudit;
    rawOutputReference?: string;
  } | undefined;
  /** Versioned counters belong to the logical user attempt, never the worker lease. */
  logicalAttempt?: {
    version: 1;
    id: string;
    semanticRepairsConsumed: number;
    reviewsConsumed: number;
    automaticRepairsConsumed: number;
    choiceRepairsConsumed: number;
    eventCoverageRepairsConsumed: number;
  };
  /** One self-contained continuity repair.  Its reservation is written before transport. */
  semanticRepair?: {
    version: 1;
    scope: "main" | "extension_only";
    rejectedFinalStoryHash: string;
    rejectedMainDraftHash: string;
    repairRequestBody: string;
    repairRequestPayloadHash: string;
    requiredEvidenceIds: readonly string[];
    status: "reserved" | "dispatched" | "validated";
    repairedStory?: StoryTurnOutput;
    repairedStoryHash?: string;
    response?: ProviderResult;
  };
  /** One scene rewrite reservation, persisted before provider transport. */
  sceneCoverageRepair?: {
    version: 1;
    rejectedMainStoryHash: string;
    repairRequestBody: string;
    repairRequestPayloadHash: string;
    status: "reserved" | "dispatched" | "validated";
    authorizedReviewId: string;
    authorizedRevision: number;
  } | undefined;
  continuityReview?: ContinuityReviewCheckpoint | undefined;
  /** Private, immutable candidate and decision evidence for a user review gate. */
  generationReview?: GenerationReviewCheckpoint | undefined;
  /** Append-only application history; a Retry may replace the current draft but never this evidence. */
  factFormatRepairApplications?: readonly FactFormatRepairApplication[];
  contextDiagnostic?: SafeGenerationDiagnostic;
  sourceEvidenceManifest?: GenerationEvidenceManifest;
  roll?: PrivateRollResolution | null;
  rpgAssessmentError?: string;
  beforeEvents?: ActivatedEvent[];
  beforeTriggerError?: string;
  afterEvents?: ActivatedEvent[] | undefined;
  afterTriggerError?: string;
  extension?: {
    story: StoryTurnOutput;
    /** Fences the exact validated extension object across lease reclaim. */
    finalStoryHash: string;
    producingAttempt: number;
    producingOperation: "event_extension" | "scene_coverage_rewrite";
    /** The exact validated main draft that this complete replacement extends. */
    validatedMainDraftHash: string;
    /** The serialized extension request, including its protected authority. */
    producingRequestPayloadHash: string;
    /** Private exact serialized extension request that produced the final story. */
    producingRequestBody?: string;
    providerConfigurationHash?: string;
    /** Complete final candidates retain the response that produced the extension. */
    response?: ProviderResult;
    /** Exact fact records rendered into that extension request. */
    sentFactIds: readonly string[];
  } | undefined;
  extensionError?: string | undefined;
  /** A durable fence for one automatic repair of a particular rejected draft. */
  automaticRepair?: {
    stage: "schema_repair" | "mechanics_cleanup";
    rejectedDraftHash: string;
    consumedAttempt: number;
  } | undefined;
  choiceRepair?: {
    version: 1;
    ownerUserId: string;
    campaignId: string;
    baseIdentity: GenerationBaseIdentity;
    providerId: string;
    providerModel: string;
    providerConfigurationHash: string;
    policyIdentity: string;
    baseHash: string;
    base: Omit<StoryTurnOutput, "choices" | "custom_action_suggestion">;
    originalRequestBody: string;
    originalRequestPayloadHash: string;
    originalSentFactIds: readonly string[];
    originalResponse: ProviderResult;
    consumedAttempt: number;
    repairRequestBody: string;
    repairRequestPayloadHash?: string;
    repairResponseFormat: "json_object" | "none";
    fields?: Pick<StoryTurnOutput, "choices" | "custom_action_suggestion">;
    resultHash?: string;
    /** Prepared after an exhausted generic recovery; only an explicit retry may dispatch it. */
    status: "pending" | "dispatched" | "validated";
    /** The sole review decision that may consume this choice-only repair. */
    authorizedReviewId?: string;
    authorizedRevision?: number;
  } | undefined;
  /** One durable, provenance-fenced rewrite allowance for rejected event fiction. */
  eventCoverageRepair?: {
    rejectedFinalStoryHash: string;
    validatedMainDraftHash: string;
    extensionFinalStoryHash: string | null;
    extensionProducingAttempt: number | null;
    consumedAttempt: number;
    /** Retains the consumed before/pending-stage allowance after an immediate repair. */
    mainRepairConsumed?: boolean;
    repairedFinalStoryHash?: string;
    repairedMainRequestPayloadHash?: string;
    /** The sole review decision that may consume this event-fiction rewrite. */
    authorizedReviewId?: string;
    authorizedRevision?: number;
  } | undefined;
  validatedMainDraft?: GenerationValidatedMainDraftCheckpoint;
};

export type { ResponseContractInvocationAudit } from "../../contracts/src/generation-response-contract.js";

function hasValidFactFormatRepairApplications(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 16) return false;
  const keys = new Set<string>();
  return value.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const application = entry as Record<string, unknown>;
    const key = `${application.jobId}:${application.reviewId}:${application.revision}`;
    if (keys.has(key)) return false;
    keys.add(key);
    return application.version === 1
      && typeof application.jobId === "string" && application.jobId.length > 0
      && typeof application.reviewId === "string" && application.reviewId.length > 0
      && typeof application.revision === "number" && Number.isSafeInteger(application.revision) && application.revision > 0
      && typeof application.planHash === "string" && /^[a-f0-9]{64}$/u.test(application.planHash)
      && (application.sourceResponseId === null || typeof application.sourceResponseId === "string")
      && typeof application.rawOutputReference === "string" && application.rawOutputReference.length > 0
      && ["producingRequestHash", "rawOutputHash", "resultHash", "providerConfigurationHash"]
        .every((key) => typeof application[key] === "string" && /^[a-f0-9]{64}$/u.test(application[key] as string));
  });
}

function hasValidAutomaticRepair(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const repair = value as Record<string, unknown>;
  return (repair.stage === "schema_repair" || repair.stage === "mechanics_cleanup")
    && typeof repair.rejectedDraftHash === "string" && repair.rejectedDraftHash.length > 0
    && typeof repair.consumedAttempt === "number" && Number.isSafeInteger(repair.consumedAttempt)
    && repair.consumedAttempt > 0;
}

function hasValidPrimaryResult(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return result.version === 1
    && typeof result.requestBody === "string" && result.requestBody.length > 0
    && typeof result.requestPayloadHash === "string" && result.requestPayloadHash === sha256Hex(result.requestBody)
    && typeof result.response === "object" && result.response !== null
    && typeof (result.response as Record<string, unknown>).content === "string"
    && typeof (result.response as Record<string, unknown>).outputLimited === "boolean"
    && Array.isArray(result.sentFactIds) && result.sentFactIds.every((id) => typeof id === "string")
    && typeof result.providerConfigurationHash === "string" && result.providerConfigurationHash.length > 0
    && typeof result.contextFingerprint === "string" && result.contextFingerprint.length > 0
    && typeof result.contextDiagnostics === "object" && result.contextDiagnostics !== null
    && typeof result.chronicleRetrieval === "object" && result.chronicleRetrieval !== null
    && (result.rawOutputReference === undefined || (typeof result.rawOutputReference === "string" && result.rawOutputReference.length > 0));
}

function hasValidPrimaryReservation(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const reservation = value as Record<string, unknown>;
  return reservation.version === 1
    && typeof reservation.requestBody === "string" && reservation.requestBody.length > 0
    && typeof reservation.requestPayloadHash === "string" && reservation.requestPayloadHash === sha256Hex(reservation.requestBody)
    && typeof reservation.providerConfigurationHash === "string" && reservation.providerConfigurationHash.length > 0
    && typeof reservation.attempt === "number" && Number.isSafeInteger(reservation.attempt) && reservation.attempt > 0
    && (reservation.status === "reserved" || reservation.status === "dispatched")
    && (reservation.authorizedReviewId === undefined || typeof reservation.authorizedReviewId === "string")
    && (reservation.authorizedRevision === undefined || (typeof reservation.authorizedRevision === "number" && Number.isSafeInteger(reservation.authorizedRevision) && reservation.authorizedRevision > 0));
}

function hasValidLogicalAttempt(value: unknown): boolean {
  if (value === undefined) return true; // Historical checkpoints are conservatively upgraded by the executor.
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ledger = value as Record<string, unknown>;
  return ledger.version === 1 && typeof ledger.id === "string" && ledger.id.length > 0
    && ["semanticRepairsConsumed", "reviewsConsumed", "automaticRepairsConsumed", "choiceRepairsConsumed", "eventCoverageRepairsConsumed"]
      .every((key) => typeof ledger[key] === "number" && Number.isSafeInteger(ledger[key]) && (ledger[key] as number) >= 0);
}

function hasValidSemanticRepair(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const repair = value as Record<string, unknown>;
  return repair.version === 1 && (repair.scope === "main" || repair.scope === "extension_only")
    && typeof repair.rejectedFinalStoryHash === "string" && repair.rejectedFinalStoryHash.length > 0
    && typeof repair.rejectedMainDraftHash === "string" && repair.rejectedMainDraftHash.length > 0
    && typeof repair.repairRequestBody === "string" && repair.repairRequestBody.length > 0
    && typeof repair.repairRequestPayloadHash === "string" && repair.repairRequestPayloadHash === sha256Hex(repair.repairRequestBody)
    && Array.isArray(repair.requiredEvidenceIds) && repair.requiredEvidenceIds.every((id) => typeof id === "string")
    && (repair.status === "reserved" || repair.status === "dispatched" || repair.status === "validated")
    && (repair.status !== "validated" || (typeof repair.repairedStoryHash === "string" && Boolean(repair.repairedStory) && typeof repair.repairedStory === "object"));
}

function hasValidSceneCoverageRepair(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const repair = value as Record<string, unknown>;
  return repair.version === 1
    && typeof repair.rejectedMainStoryHash === "string" && repair.rejectedMainStoryHash.length > 0
    && typeof repair.repairRequestBody === "string" && repair.repairRequestBody.length > 0
    && typeof repair.repairRequestPayloadHash === "string"
    && repair.repairRequestPayloadHash === sha256Hex(repair.repairRequestBody)
    && (repair.status === "reserved" || repair.status === "dispatched" || repair.status === "validated")
    && typeof repair.authorizedReviewId === "string" && repair.authorizedReviewId.length > 0
    && typeof repair.authorizedRevision === "number" && Number.isSafeInteger(repair.authorizedRevision)
    && repair.authorizedRevision > 0;
}

function hasValidChoiceRepair(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const repair = value as Record<string, unknown>;
  return repair.version === 1 && typeof repair.policyIdentity === "string" && repair.policyIdentity.length > 0
    && typeof repair.ownerUserId === "string" && repair.ownerUserId.length > 0
    && typeof repair.campaignId === "string" && repair.campaignId.length > 0
    && typeof repair.baseIdentity === "object" && repair.baseIdentity !== null
    && typeof repair.providerId === "string" && repair.providerId.length > 0
    && typeof repair.providerModel === "string" && repair.providerModel.length > 0
    && typeof repair.providerConfigurationHash === "string" && repair.providerConfigurationHash.length > 0
    && typeof repair.baseHash === "string" && repair.baseHash.length > 0
    && typeof repair.base === "object" && repair.base !== null && !Array.isArray(repair.base)
    && typeof repair.originalRequestBody === "string" && repair.originalRequestBody.length > 0
    && typeof repair.originalRequestPayloadHash === "string" && repair.originalRequestPayloadHash.length > 0
    && Array.isArray(repair.originalSentFactIds) && repair.originalSentFactIds.every((id) => typeof id === "string")
    && typeof repair.originalResponse === "object" && repair.originalResponse !== null
    && typeof repair.consumedAttempt === "number" && Number.isSafeInteger(repair.consumedAttempt) && repair.consumedAttempt > 0
    && typeof repair.repairRequestBody === "string" && repair.repairRequestBody.length > 0
    && (repair.repairResponseFormat === "json_object" || repair.repairResponseFormat === "none")
    && typeof repair.repairRequestPayloadHash === "string" && repair.repairRequestPayloadHash.length > 0
    && (repair.status === "pending" || repair.status === "dispatched" || repair.status === "validated")
    && (repair.authorizedReviewId === undefined || typeof repair.authorizedReviewId === "string")
    && (repair.authorizedRevision === undefined || (typeof repair.authorizedRevision === "number" && Number.isSafeInteger(repair.authorizedRevision) && repair.authorizedRevision > 0))
    && (repair.status !== "validated" || (typeof repair.repairRequestPayloadHash === "string" && typeof repair.resultHash === "string" && typeof repair.fields === "object" && repair.fields !== null));
}

function hasValidEventCoverageRepair(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const repair = value as Record<string, unknown>;
  return typeof repair.rejectedFinalStoryHash === "string" && repair.rejectedFinalStoryHash.length > 0
    && typeof repair.validatedMainDraftHash === "string" && repair.validatedMainDraftHash.length > 0
    && (repair.extensionFinalStoryHash === null
      || (typeof repair.extensionFinalStoryHash === "string" && repair.extensionFinalStoryHash.length > 0))
    && (repair.extensionProducingAttempt === null
      || (typeof repair.extensionProducingAttempt === "number"
        && Number.isSafeInteger(repair.extensionProducingAttempt)
        && repair.extensionProducingAttempt > 0))
    && typeof repair.consumedAttempt === "number" && Number.isSafeInteger(repair.consumedAttempt)
    && repair.consumedAttempt > 0
    && (repair.mainRepairConsumed === undefined || typeof repair.mainRepairConsumed === "boolean")
    && (repair.repairedFinalStoryHash === undefined
      || (typeof repair.repairedFinalStoryHash === "string" && repair.repairedFinalStoryHash.length > 0))
    && (repair.repairedMainRequestPayloadHash === undefined
      || (typeof repair.repairedMainRequestPayloadHash === "string" && repair.repairedMainRequestPayloadHash.length > 0))
    && (repair.authorizedReviewId === undefined || typeof repair.authorizedReviewId === "string")
    && (repair.authorizedRevision === undefined || (typeof repair.authorizedRevision === "number"
      && Number.isSafeInteger(repair.authorizedRevision) && repair.authorizedRevision > 0));
}

type GenerationReviewExecutionBinding = Pick<GenerationExecutionPayload,
  "id" | "owner_user_id" | "campaign_id" | "world_id" | "expected_turn_number" | "operation_kind" | "replacement_turn_id" | "generation_base_identity" | "provider_profile_id" | "prompt_protocol_version"
> & Readonly<{ world_version_id?: string | null }>;

/** A parsed private review still must be bound to the locked job that resumes it. */
function generationReviewMatchesExecutionJob(review: GenerationReviewCheckpoint, job: GenerationReviewExecutionBinding): boolean {
  const candidate = review.gateCandidate;
  const matchesJob = candidate.ownerUserId === job.owner_user_id
    && candidate.campaignId === job.campaign_id
    && candidate.worldId === job.world_id
    && candidate.worldVersionId === (job.world_version_id ?? null)
    && candidate.expectedTurnNumber === job.expected_turn_number
    && candidate.provider.profileId === job.provider_profile_id
    && candidate.protocol.version === job.prompt_protocol_version
    && canonicalEvidenceJson(candidate.baseIdentity) === canonicalEvidenceJson(job.generation_base_identity)
    && review.operationKind === job.operation_kind
    && review.replacementTurnId === job.replacement_turn_id;
  if (!matchesJob || review.version !== 2) return matchesJob;
  const repair = review.factFormatRepair!;
  const receipts = repair.status === "authorized"
    ? review.decisionJournal.filter((entry) => entry.decision === "repair_format"
      && entry.reviewId === review.reviewId && entry.revision === review.revision - 1)
    : [];
  const receipt = receipts.length === 1 ? receipts[0] : undefined;
  return repair.ownerUserId === job.owner_user_id
    && repair.campaignId === job.campaign_id
    && repair.worldVersionId === (job.world_version_id ?? null)
    && repair.promptProtocolVersion === job.prompt_protocol_version
    && canonicalEvidenceJson(repair.baseIdentity) === canonicalEvidenceJson(job.generation_base_identity)
    && (repair.status !== "authorized" || (receipt !== undefined
      && receipt.actorUserId === job.owner_user_id
      && receipt.actionReceipt.jobId === job.id
      && receipt.actionReceipt.operationKind === job.operation_kind
      && receipt.actionReceipt.replacementTurnId === job.replacement_turn_id));
}

/** An applied repair may survive later review revisions, so its receipt identity lives on the saved draft. */
function appliedFactFormatRepairMatchesExecutionJob(
  review: GenerationReviewCheckpoint,
  orchestration: GenerationOrchestrationState,
  job: GenerationReviewExecutionBinding
): boolean {
  if (review.version !== 2 || review.factFormatRepair?.status !== "applied") return true;
  const repair = orchestration.validatedMainDraft?.factFormatRepair;
  if (!repair) return false;
  const receipts = review.decisionJournal.filter((entry) => entry.decision === "repair_format"
    && entry.reviewId === repair.reviewId && entry.revision === repair.revision);
  const receipt = receipts.length === 1 ? receipts[0] : undefined;
  return receipt !== undefined
    && receipt.actorUserId === job.owner_user_id
    && receipt.actionReceipt.jobId === job.id
    && receipt.actionReceipt.operationKind === job.operation_kind
    && receipt.actionReceipt.replacementTurnId === job.replacement_turn_id;
}

function factFormatRepairApplicationsMatchExecutionJob(
  review: GenerationReviewCheckpoint,
  orchestration: GenerationOrchestrationState,
  job: GenerationReviewExecutionBinding
): boolean {
  const applications = orchestration.factFormatRepairApplications;
  if (!hasValidFactFormatRepairApplications(applications)) return false;
  const applicationMatchesReceipt = (application: FactFormatRepairApplication): boolean => {
    const receipts = review.decisionJournal.filter((entry): entry is Extract<GenerationReviewCheckpoint["decisionJournal"][number], { decision: "repair_format" }> => entry.decision === "repair_format"
      && entry.reviewId === application.reviewId && entry.revision === application.revision
      && entry.planHash === application.planHash);
    const receipt = receipts.length === 1 ? receipts[0] : undefined;
    return receipt !== undefined
      && application.jobId === job.id
      && receipt.actorUserId === job.owner_user_id
      && receipt.actionReceipt.jobId === job.id
      && receipt.actionReceipt.operationKind === job.operation_kind
      && receipt.actionReceipt.replacementTurnId === job.replacement_turn_id
      && application.sourceResponseId === receipt.repair.sourceResponseId
      && application.rawOutputReference === receipt.repair.rawOutputReference
      && application.producingRequestHash === receipt.repair.producingRequestHash
      && application.rawOutputHash === receipt.repair.plan.rawOutputHash
      && application.resultHash === receipt.repair.plan.resultHash
      && application.providerConfigurationHash === receipt.repair.providerConfigurationHash;
  };
  if (!(applications ?? []).every(applicationMatchesReceipt)) return false;
  const applied = orchestration.validatedMainDraft?.factFormatRepair;
  if (!applied) return true;
  const matches = (applications ?? []).filter((application) => application.jobId === job.id
    && application.reviewId === applied.reviewId && application.revision === applied.revision
    && application.planHash === applied.planHash && application.rawOutputHash === applied.rawOutputHash
    && application.resultHash === applied.resultHash);
  return matches.length === 1;
}

export type GenerationStreamingState = Record<string, unknown> & {
  provisionalSetId?: string | null;
};

export type GenerationOrchestrationInputs = {
  useRpgStats: boolean;
  rpgStats: PlayerRpgStat[];
  eventTriggers: PlayerEventTrigger[];
  pendingEventTriggers: ActivatedEvent[];
  storyMemoryDefaults: {
    continuitySummary?: string;
    canonicalFacts: string[];
    supersededFacts: string[];
    openThreads?: string[];
  };
  suppressEventTriggers: boolean;
  characterProfile: Record<string, unknown> | null;
  characterSnapshot: Record<string, unknown> | null;
};

export type GenerationExecutionPayload = {
  id: string;
  owner_user_id: string;
  campaign_id: string;
  /** Immutable world authority used to bind a paused review candidate. */
  world_id?: string;
  world_version_id?: string;
  provider_profile_id: string;
  expected_turn_number: number;
  operation_kind: "append" | "replace_latest";
  replacement_turn_id: string | null;
  base_turn_number: number | null;
  base_state_private: Record<string, unknown>;
  base_scratchpad_safe_for_prompt: boolean;
  action: string;
  requested_input_mode: "auto" | "action" | "scene";
  resolved_input_mode: "action" | "scene";
  input_mode_source: "explicit" | "auto" | "generated_choice" | "opening_action" | "fallback";
  requested_model: string;
  context_options: MemoryContextQuery & {
    modelContextWindowTokens?: number;
    storyLengthProfile?: StoryLengthProfile;
    narrationMinWords?: number;
    narrationMaxWords?: number;
  };
  prompt_protocol_version: string;
  prompt_snapshot: PromptSnapshot;
  /** Null is a historical row whose policy must never be inferred from current settings. */
  generation_policy: GenerationPolicySnapshot | null;
  generation_base_identity: GenerationBaseIdentity;
  attempts: number;
  orchestration_private: GenerationOrchestrationState;
  streaming_segments_state: GenerationStreamingState;
  orchestration_inputs: GenerationOrchestrationInputs;
};

export type GenerationAttemptRecord = GenerationLeaseScope & Readonly<{
  attemptNumber: number;
  recoveryKind: string;
  requestMetadata: Record<string, unknown>;
  responseMetadata: Record<string, unknown>;
  providerResponseId: string | null;
  finishReason: string | null;
  rawOutput: string | null;
  validationErrors: readonly string[];
  overwrite: boolean;
}>;

export type GenerationRecoverableUpdate = GenerationLeaseScope & Readonly<{
  providerResponseId: string | null;
  providerFinishReason: string | null;
  errorCode: string;
  errorMessage: string;
  recoveryMetadata: Record<string, unknown>;
}>;

export type GenerationFailedUpdate = GenerationLeaseScope & Readonly<{
  errorCode: string;
  errorMessage: string;
  recoveryMetadata: Record<string, unknown>;
  lastFailureDiagnostic?: GenerationFailureDiagnostic;
}>;

type GenerationTextProvider = Readonly<{
  id: string;
  name?: string;
  providerType: string;
  model: string;
}>;

export type AcceptedGenerationCommitCollaborators = Readonly<{
  memory: MemoryGenerationTransactionPort;
  illustration: IllustrationGenerationTransactionPort;
  attributeGenerationCostsToTurn(
    client: DatabaseClient,
    ownerUserId: string,
    campaignId: string,
    generationJobId: string,
    turnId: string
  ): Promise<void>;
}>;

export type AcceptedGenerationCommit = Readonly<{
  scope: GenerationLeaseScope;
  job: GenerationExecutionPayload;
  story: StoryTurnOutput;
  provider: GenerationTextProvider;
  response: ProviderResult;
  contextFingerprint: string;
  contextDiagnostics: Record<string, unknown>;
  /** Exact canonical-fact IDs rendered into the producing story request. */
  sentFactIds?: readonly string[];
  chronicleRetrieval: ChronicleRetrievalAudit;
  inputs: GenerationOrchestrationInputs;
  orchestration: GenerationOrchestrationState;
  fictionAction: string;
  collaborators: AcceptedGenerationCommitCollaborators;
  onIllustrationEnqueueError(error: unknown, turnId: string): void;
}>;

export type GenerationExecutionRepository = Readonly<{
  loadExecutionPayload(request: GenerationExecutionRequest): Promise<GenerationExecutionPayload | null>;
  renewLease(scope: GenerationLeaseScope, leaseSeconds: number): Promise<boolean>;
  markGenerating(scope: GenerationLeaseScope): Promise<boolean>;
  /** Returns a repaired validating job to the normal assessment entrypoint. */
  restartAfterSemanticRepair?(scope: GenerationLeaseScope): Promise<boolean>;
  saveOrchestration(scope: GenerationLeaseScope, value: GenerationOrchestrationState): Promise<boolean>;
  /** Writes the first complete preflight selection once; lease reclaimers observe the winner. */
  saveFrozenResponseContracts?(scope: GenerationLeaseScope, expectedQueuedPolicyHash: string, value: FrozenResponseContracts): Promise<FrozenResponseContracts | null>;
  /** Private bounded operation ledger. This is distinct from generation_attempts and worker claim counts. */
  reserveResponseContractInvocation?(scope: GenerationLeaseScope, input: Readonly<{
    logicalAttemptId: string; invocationKey: ResponseInvocationKey; operation: ResponseContractOperation;
    requestPayloadHash: string; request: AttemptResponseContractAudit;
  }>): Promise<ResponseContractInvocationAudit | null>;
  /** Consumes a reservation once only when its prepared request hash still matches. */
  markResponseContractInvocationDispatched?(scope: GenerationLeaseScope, invocationId: string, expectedRequestPayloadHash: string): Promise<ResponseContractInvocationAudit | null>;
  completeResponseContractInvocation?(scope: GenerationLeaseScope, invocationId: string, response: Pick<AttemptResponseContractAudit, "returnedModel" | "returnedProviderRoute" | "diagnosticCode">): Promise<ResponseContractInvocationAudit | null>;
  /** Atomically publishes a pending review and releases the worker lease. */
  pauseForReview(scope: GenerationLeaseScope, checkpoint: GenerationReviewCheckpoint): Promise<boolean>;
  savePartialNarration(scope: GenerationLeaseScope, narration: string): Promise<boolean>;
  saveStreamingSegments(scope: GenerationLeaseScope, value: GenerationStreamingState): Promise<boolean>;
  recordAttempt(input: GenerationAttemptRecord): Promise<void>;
  markRecoverable(input: GenerationRecoverableUpdate): Promise<boolean>;
  markValidating(scope: GenerationLeaseScope): Promise<boolean>;
  markCommitting(scope: GenerationLeaseScope): Promise<boolean>;
  commitAcceptedTurn(input: AcceptedGenerationCommit): Promise<{ turnId: string }>;
  markFailed(input: GenerationFailedUpdate): Promise<boolean>;
}>;

/** Reconciles one accepted turn whose provisional illustration promotion rolled back. */
export async function reconcileNextAcceptedStreamingIllustration(
  pool: DatabasePool,
  illustration: IllustrationGenerationTransactionPort,
): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    const pending = await client.query<{
      id: string; owner_user_id: string; campaign_id: string; result_turn_id: string; narration: string;
    }>(
      `SELECT j.id,j.owner_user_id,j.campaign_id,j.result_turn_id,t.narration
         FROM generation_jobs j JOIN turns t ON t.id=j.result_turn_id AND t.owner_user_id=j.owner_user_id
        WHERE j.status='completed' AND j.result_turn_id IS NOT NULL
          AND j.streaming_segments_state->>'provisionalIllustrationReconciliation'='pending'
        ORDER BY j.completed_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1`
    );
    const job = pending.rows[0];
    if (!job) return false;
    const config = await illustration.loadStreamingIllustrationConfig(client, {
      ownerUserId: job.owner_user_id, campaignId: job.campaign_id
    });
    await illustration.promoteProvisionalSet(client, {
      ownerUserId: job.owner_user_id, campaignId: job.campaign_id, generationJobId: job.id, turnId: job.result_turn_id
    }, { finalNarration: job.narration, config });
    await client.query(
      `UPDATE generation_jobs
          SET streaming_segments_state = streaming_segments_state - 'provisionalIllustrationReconciliation', updated_at=now()
        WHERE id=$1 AND owner_user_id=$2`,
      [job.id, job.owner_user_id]
    );
    return true;
  });
}

type ExecutionPayloadRow = Omit<GenerationExecutionPayload, "orchestration_inputs"> & {
  legacy_settings: Record<string, unknown>;
  rpg_stats: unknown;
  event_triggers: unknown;
  pending_event_triggers: unknown;
  state_snapshot_private: Record<string, unknown> | null;
  character_profile: Record<string, unknown> | null;
  character_snapshot: Record<string, unknown> | null;
};

function claimedGeneration(row: {
  id: string;
  owner_user_id: string;
  campaign_id: string;
  provider_profile_id: string;
  expected_turn_number: number;
  attempts: number;
  operation_kind: "append" | "replace_latest";
  replacement_turn_id: string | null;
}): ClaimedGeneration {
  const base = {
    jobId: row.id,
    ownerUserId: row.owner_user_id,
    campaignId: row.campaign_id,
    providerProfileId: row.provider_profile_id,
    expectedTurnNumber: row.expected_turn_number,
    attempts: row.attempts
  };
  return row.operation_kind === "append"
    ? { ...base, operationKind: "append", replacementTurnId: null }
    : { ...base, operationKind: "replace_latest", replacementTurnId: row.replacement_turn_id! };
}

function orchestrationInputs(row: ExecutionPayloadRow): GenerationOrchestrationInputs {
  const stagedState = row.operation_kind === "replace_latest" ? row.base_state_private || {} : null;
  const rpgSource = stagedState && Array.isArray(stagedState.rpgStats) ? stagedState.rpgStats : row.rpg_stats;
  const eventSource = stagedState && Array.isArray(stagedState.eventTriggers)
    ? stagedState.eventTriggers
    : row.event_triggers;
  const pendingSource = stagedState && Array.isArray(stagedState.pendingEventTriggers)
    ? stagedState.pendingEventTriggers
    : row.pending_event_triggers;
  const rpgStats = (Array.isArray(rpgSource) ? rpgSource : []).flatMap((entry) => {
    const parsed = playerRpgStatSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  const eventTriggers = normalizeCampaignEventTriggers(Array.isArray(eventSource) ? eventSource : []).flatMap((entry) => {
    const parsed = playerEventTriggerSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  const pendingEventTriggers = (Array.isArray(pendingSource) ? pendingSource : []).flatMap((entry) => {
    const parsed = pendingEventTriggerSchema.safeParse(entry);
    return parsed.success ? [{ ...parsed.data, addTextAfter: false }] : [];
  });
  const latestSnapshot = stagedState || row.state_snapshot_private || {};
  const continuitySummary = typeof latestSnapshot.continuitySummary === "string"
    ? latestSnapshot.continuitySummary.trim()
    : "";
  const openThreads = Array.isArray(latestSnapshot.openThreads)
    ? latestSnapshot.openThreads.filter(
      (value): value is string => typeof value === "string" && Boolean(value.trim())
    )
    : undefined;
  return {
    useRpgStats: row.legacy_settings?.useRpgStats === true,
    rpgStats,
    eventTriggers,
    pendingEventTriggers,
    storyMemoryDefaults: {
      ...(continuitySummary ? { continuitySummary } : {}),
      canonicalFacts: [],
      supersededFacts: [],
      ...(openThreads ? { openThreads } : {})
    },
    suppressEventTriggers: Boolean(row.legacy_settings?.suppressEventTriggers),
    characterProfile: row.character_profile,
    characterSnapshot: row.character_snapshot
  };
}

function mergedTrackers(current: unknown, updates: Array<Record<string, unknown>>): CampaignTracker[] {
  const existing = normalizeCampaignTrackers(current);
  const map = new Map<string, Record<string, unknown>>(
    existing.map((item) => [item.id, { ...item }])
  );
  for (const update of updates) {
    const key = String(update.id || update.name || crypto.randomUUID());
    map.set(key, { ...(map.get(key) || {}), ...update });
  }
  return normalizeCampaignTrackers([...map.values()]);
}

/** A main Keep remains active only until a later retry authorizes a rewrite. */
function assertActiveMainKeepPreservation(
  checkpoint: GenerationReviewCheckpoint,
  orchestration: GenerationOrchestrationState,
  finalStory: StoryTurnOutput
): void {
  const mainKeepIndex = checkpoint.decisionJournal.map((entry) => entry.candidateScope === "main" && entry.decision === "keep")
    .lastIndexOf(true);
  if (mainKeepIndex < 0) return;
  const laterRewriteAuthorized = checkpoint.decisionJournal.slice(mainKeepIndex + 1).some((entry) => entry.decision === "retry"
    && (entry.candidateScope === "final" || entry.nextStage === "scene_coverage"));
  if (laterRewriteAuthorized) return;
  const activeMainDecision = checkpoint.decisionJournal[mainKeepIndex]!;
  const unavailable = (): never => {
    throw Object.assign(new Error("The kept main candidate cannot authorize this final commit."), {
      code: "generation_review_acceptance_unavailable"
    });
  };
  const main = activeMainDecision.offeredCandidate;
  const draft = orchestration.validatedMainDraft;
  if (!main.story || !draft) unavailable();
  const mainStory = main.story as StoryTurnOutput;
  const validatedMainDraft = draft as GenerationValidatedMainDraftCheckpoint;
  if (main.storyHash !== sha256Hex(canonicalEvidenceJson(mainStory))
    || canonicalEvidenceJson(mainStory) !== canonicalEvidenceJson(validatedMainDraft.story)
    || main.producingRequestHash !== validatedMainDraft.requestPayloadHash
    || main.producingResponseId !== validatedMainDraft.response.responseId) unavailable();
  if (!orchestration.extension) {
    if (canonicalEvidenceJson(finalStory) !== canonicalEvidenceJson(mainStory)) unavailable();
    return;
  }
  const extension = orchestration.extension;
  if (extension.validatedMainDraftHash !== validatedMainDraft.draftHash
    || extension.finalStoryHash !== stableStringify(finalStory)
    || extension.producingRequestPayloadHash.length !== 64
    || !finalStory.narration.startsWith(mainStory.narration)) unavailable();
}

/** Commit-time fence for a user-authorized format repair of the original primary response. */
function assertAppliedFactFormatRepair(
  checkpoint: GenerationReviewCheckpoint,
  orchestration: GenerationOrchestrationState,
  finalStory: StoryTurnOutput,
  job: GenerationReviewExecutionBinding
): void {
  const draft = orchestration.validatedMainDraft;
  if (!draft?.factFormatRepair) return;
  const receipts = checkpoint.decisionJournal.filter((entry) => entry.decision === "repair_format"
    && entry.reviewId === draft.factFormatRepair!.reviewId && entry.revision === draft.factFormatRepair!.revision);
  const receipt = receipts.length === 1 ? receipts[0] : undefined;
  const unavailable = (): never => { throw Object.assign(new Error("The applied fact-format repair cannot authorize this commit."), { code: "generation_review_acceptance_unavailable" }); };
  if (!receipt || receipt.decision !== "repair_format"
    || draft.factFormatRepair.revision !== receipt.revision
    || draft.factFormatRepair.planHash !== receipt.repair.planHash
    || draft.factFormatRepair.rawOutputHash !== receipt.repair.plan.rawOutputHash
    || draft.factFormatRepair.resultHash !== receipt.repair.plan.resultHash
    || draft.requestPayloadHash !== receipt.repair.producingRequestHash
    || draft.response.responseId !== receipt.repair.sourceResponseId
    || sha256Hex(draft.response.content) !== receipt.repair.plan.rawOutputHash
    || canonicalEvidenceJson(draft.story) !== canonicalEvidenceJson(receipt.repair.plan.story)
    || draft.providerConfigurationHash !== receipt.repair.providerConfigurationHash
    || !generationReviewMatchesExecutionJob(checkpoint, job)
    || draft.ownerUserId !== job.owner_user_id
    || draft.campaignId !== job.campaign_id
    || draft.worldVersionId !== (job.world_version_id ?? null)
    || draft.promptProtocolVersion !== job.prompt_protocol_version
    || canonicalEvidenceJson(draft.baseIdentity) !== canonicalEvidenceJson(job.generation_base_identity)
    || receipt.repair.ownerUserId !== job.owner_user_id
    || receipt.repair.campaignId !== job.campaign_id
    || receipt.repair.worldVersionId !== (job.world_version_id ?? null)
    || receipt.repair.promptProtocolVersion !== job.prompt_protocol_version
    || canonicalEvidenceJson(receipt.repair.baseIdentity) !== canonicalEvidenceJson(job.generation_base_identity)
    || receipt.offeredCandidate.ownerUserId !== job.owner_user_id
    || receipt.offeredCandidate.campaignId !== job.campaign_id
    || receipt.offeredCandidate.worldId !== job.world_id
    || receipt.offeredCandidate.worldVersionId !== (job.world_version_id ?? null)
    || receipt.offeredCandidate.expectedTurnNumber !== job.expected_turn_number
    || receipt.offeredCandidate.provider.profileId !== job.provider_profile_id
    || receipt.offeredCandidate.protocol.version !== job.prompt_protocol_version
    || canonicalEvidenceJson(receipt.offeredCandidate.baseIdentity) !== canonicalEvidenceJson(job.generation_base_identity)
    || receipt.actorUserId !== job.owner_user_id
    || receipt.actionReceipt.jobId !== job.id
    || receipt.actionReceipt.operationKind !== job.operation_kind
    || receipt.actionReceipt.replacementTurnId !== job.replacement_turn_id
    || (orchestration.extension === undefined && canonicalEvidenceJson(finalStory) !== canonicalEvidenceJson(draft.story))) unavailable();
}

async function commitAcceptedTurn(
  client: DatabaseClient,
  input: AcceptedGenerationCommit
): Promise<{ turnId: string }> {
  const chronicleRetrieval = chronicleRetrievalAuditSchema.parse(input.chronicleRetrieval);
  const { job, scope, provider, response, inputs, orchestration, collaborators } = input;
  // The commit boundary accepts only the current protocol. Historical/import
  // replay goes through the explicitly named Chronicle compatibility path.
  const story = storyTurnOutputSchema.parse(input.story);
  const lease = await client.query<{ id: string; owner_user_id: string; campaign_id: string; world_id: string; world_version_id: string | null; provider_profile_id: string; expected_turn_number: number; operation_kind: "append" | "replace_latest"; replacement_turn_id: string | null; generation_base_identity: GenerationBaseIdentity; context_options: Record<string, unknown>; prompt_protocol_version: string; prompt_snapshot: unknown; orchestration_private: GenerationOrchestrationState; streaming_segments_state: { provisionalSetId?: string } }>(
    `SELECT j.id, j.owner_user_id, j.campaign_id, j.provider_profile_id, wv.world_id, c.world_version_id, j.expected_turn_number,
            j.operation_kind, j.replacement_turn_id, j.generation_base_identity, j.context_options, j.prompt_protocol_version, j.prompt_snapshot,
            j.orchestration_private, j.streaming_segments_state
       FROM generation_jobs j JOIN campaigns c ON c.id=j.campaign_id AND c.owner_user_id=j.owner_user_id
       JOIN world_versions wv ON wv.id=c.world_version_id AND wv.owner_user_id=j.owner_user_id
      WHERE j.id = $1 AND j.owner_user_id = $2 AND j.lease_owner = $3 AND j.status = 'committing'
        AND j.lease_expires_at > now()
      FOR UPDATE OF j`,
    [scope.jobId, scope.ownerUserId, scope.workerId]
  );
  if (!lease.rows[0]) {
    throw Object.assign(new Error("Generation lease was lost or cancelled before commit."), {
      code: "lease_lost"
    });
  }
  const storedJob = lease.rows[0]!;
  let reviewAcceptanceAudit: Record<string, unknown> | undefined;
  const storedReview = generationReviewCheckpointSchema.safeParse(storedJob.orchestration_private.generationReview);
  if (Object.hasOwn(storedJob.orchestration_private, "generationReview") && !storedReview.success) {
    throw Object.assign(new Error("The persisted generation review checkpoint cannot authorize this commit."), {
      code: "generation_review_acceptance_unavailable"
    });
  }
  if (storedReview.success) {
    assertActiveMainKeepPreservation(storedReview.data, storedJob.orchestration_private, story);
    assertAppliedFactFormatRepair(storedReview.data, storedJob.orchestration_private, story, storedJob);
  }
  if (storedJob.context_options?.storyMemoryPolicy) {
    const policy = storyMemoryPolicySnapshotSchema.parse(storedJob.context_options.storyMemoryPolicy);
    if (policy.policy.continuityReview !== "off") {
      const saved = storedJob.orchestration_private;
      const requestBody = saved.extension?.producingRequestBody ?? saved.validatedMainDraft?.requestBody;
      if (storedJob.streaming_segments_state?.provisionalSetId) throw Object.assign(new Error("Reviewed commit source or illustration gate is invalid."), { code: "continuity_review_unavailable" });
      let manifest: GenerationEvidenceManifest | undefined;
      try { if (requestBody && saved.sourceEvidenceManifest) manifest = bindManifestToProducingRequest(saved.sourceEvidenceManifest, requestBody); } catch { /* Only an observed unavailable result can commit without verified review inputs. */ }
      const auxiliaryRequestHashes = validatedChoiceRequestHashes(saved.choiceRepair, saved.validatedMainDraft?.story, policy.providerConfigurationFingerprint);
      const prompts = assertContinuityReviewPromptSnapshot(storedJob.prompt_snapshot, policy.policy.continuityReview);
      const normalBinding = {
        draftHash: sha256Hex(stableStringify(story)), producingRequestHash: requestBody ? sha256Hex(requestBody) : null, manifestHash: manifest?.manifestHash ?? null, auxiliaryRequestHashes,
        providerConfigurationHash: policy.providerConfigurationFingerprint, promptHash: prompts.continuityReview!.review.hash,
        promptProtocol: "story-continuity-review-v1", policyHash: policy.policyHash
      } as const;
      const review = generationReviewCheckpointSchema.safeParse(saved.generationReview);
      const isFinalContinuityCheckpoint = review.success && review.data.state === "decided"
        && review.data.candidateScope === "final" && review.data.stage === "continuity";
      const hasFinalContinuityReview = isFinalContinuityCheckpoint
        && review.data.decisionJournal.some((entry) => entry.reviewId === review.data.reviewId
          && entry.revision === review.data.revision - 1 && entry.decision === "keep");
      if (hasFinalContinuityReview) {
        if (mechanicsLeakFields(story).length) {
          throw Object.assign(new Error("A kept generation candidate contains mechanics language."), { code: "mechanics_leak" });
        }
        assertGenerationReviewAcceptance(review.data, {
          jobId: storedJob.id, actorUserId: storedJob.owner_user_id, candidateScope: "final",
          candidateHash: sha256Hex(canonicalEvidenceJson(story)), stage: "continuity",
          findingsHash: generationReviewFindingsHash(review.data.reasons), ownerUserId: storedJob.owner_user_id,
          campaignId: storedJob.campaign_id, worldId: storedJob.world_id, worldVersionId: storedJob.world_version_id,
          baseIdentity: readGenerationBaseIdentity(storedJob.generation_base_identity),
          protocol: { version: storedJob.prompt_protocol_version, promptHash: prompts.continuityReview!.review.hash },
          policyHash: policy.policyHash, operationKind: storedJob.operation_kind, replacementTurnId: storedJob.replacement_turn_id
        });
        if (review.data.gateCandidate.producingResponseId !== response.responseId) {
          throw Object.assign(new Error("The saved generation review candidate was not produced by this response."), {
            code: "generation_review_acceptance_unavailable"
          });
        }
        const producingRequestHash = saved.extension?.producingRequestPayloadHash
          ?? saved.validatedMainDraft?.requestPayloadHash;
        if (!producingRequestHash || review.data.gateCandidate.producingRequestHash !== producingRequestHash) {
          throw Object.assign(new Error("The saved generation review candidate was not produced by the persisted request."), {
            code: "generation_review_acceptance_unavailable"
          });
        }
        const originalReview = continuityReviewCheckpointSchema.safeParse(saved.continuityReview);
        reviewAcceptanceAudit = {
          disposition: "accepted_by_user", reviewId: review.data.reviewId, revision: review.data.revision,
          candidateHash: review.data.gateCandidate.storyHash,
          originalVerdict: originalReview.success ? originalReview.data.verdict : "unavailable",
          originalReasonCodes: review.data.originalFindings,
          currentReasonCodes: review.data.reasons
        };
      } else {
        if (isFinalContinuityCheckpoint && !continuityReviewCheckpointSchema.safeParse(saved.continuityReview).success) {
          throw Object.assign(new Error("The final generation review has no valid Keep receipt."), {
            code: "generation_review_acceptance_unavailable"
          });
        }
        assertContinuityReviewCommit(policy.policy.continuityReview, saved.continuityReview, normalBinding);
      }
    }
  }
  const requestedSupersessionIds = [...new Set(story.canonical_fact_updates.flatMap((update) => update.supersedes_fact_ids))];
  if (requestedSupersessionIds.length) {
    const sentFactIds = new Set(input.sentFactIds ?? []);
    if (!input.sentFactIds || requestedSupersessionIds.some((id) => !sentFactIds.has(id))) {
      throw Object.assign(new Error("A canonical fact update referenced an ID that was not sent to the provider."), {
        code: "invalid_fact_supersession"
      });
    }
    const activeFacts = await client.query<{ id: string }>(
      `SELECT id FROM campaign_canonical_facts
        WHERE owner_user_id=$1 AND campaign_id=$2 AND world_version_id=$3 AND id=ANY($4::uuid[])
          AND valid_from_turn <= $5 AND (valid_until_turn IS NULL OR valid_until_turn > $5)
        FOR UPDATE`,
      [job.owner_user_id, job.campaign_id, job.world_version_id, requestedSupersessionIds, job.expected_turn_number - 1]
    );
    const activeIds = new Set(activeFacts.rows.map((fact) => fact.id));
    if (requestedSupersessionIds.some((id) => !activeIds.has(id))) {
      throw Object.assign(new Error("A canonical fact update referenced an inactive or out-of-scope fact."), {
        code: "invalid_fact_supersession"
      });
    }
  }
  const storedBaseIdentity = readGenerationBaseIdentity(job.generation_base_identity);
  const authority = await resolveGenerationAuthoritySnapshot(client, {
    ownerUserId: job.owner_user_id,
    campaignId: job.campaign_id,
    operationKind: job.operation_kind,
    expectedTurnNumber: job.expected_turn_number,
    ...(isGenerationBaseIdentityV3(storedBaseIdentity) ? { baseIdentityVersion: "generation-base-v3" as const, captureRecentWindow: storedBaseIdentity.recentWindowFingerprint !== undefined } : {})
  });
  if (!matchesGenerationBaseIdentity(storedBaseIdentity, authority.baseIdentity)) {
    throw Object.assign(new Error("Campaign authority changed before this generation could commit."), {
      code: "stale_campaign"
    });
  }
  const campaignResult = await client.query<{
    active_turn_number: number;
    world_version_id: string;
    character_snapshot: Record<string, unknown> | null;
    character_profile: Record<string, unknown> | null;
    world_content: Record<string, unknown>;
  }>(
    `SELECT c.active_turn_number, c.world_version_id, c.character_snapshot, c.character_profile,
            wv.content AS world_content
       FROM campaigns c
       JOIN world_versions wv ON wv.id = c.world_version_id AND wv.owner_user_id = c.owner_user_id
      WHERE c.id = $1 AND c.owner_user_id = $2
      FOR UPDATE OF c`,
    [job.campaign_id, job.owner_user_id]
  );
  const campaign = campaignResult.rows[0];
  if (!campaign) throw new Error("Campaign disappeared before story commit.");
  const entityCatalog = buildScopedEntityCatalog({
    worldContent: campaign.world_content,
    characterSnapshot: campaign.character_snapshot,
    characterProfile: campaign.character_profile
  });
  const isReplacement = job.operation_kind === "replace_latest";
  const expectedCampaignTurn = isReplacement ? job.expected_turn_number : job.expected_turn_number - 1;
  if (campaign.active_turn_number !== expectedCampaignTurn) {
    throw Object.assign(new Error("Campaign advanced before this generation could commit."), {
      code: "stale_campaign"
    });
  }
  if (isReplacement) {
    const replacement = await client.query<{ id: string }>(
      `SELECT id FROM turns
        WHERE id = $1 AND campaign_id = $2 AND owner_user_id = $3 AND turn_number = $4 FOR UPDATE`,
      [job.replacement_turn_id, job.campaign_id, job.owner_user_id, job.expected_turn_number]
    );
    if (!replacement.rows[0]) {
      throw Object.assign(new Error("The turn selected for replacement changed before commit."), {
        code: "stale_campaign"
      });
    }
    const conflictingWork = await client.query(
      `SELECT 'image' AS kind FROM image_jobs
        WHERE campaign_id = $1 AND owner_user_id = $2 AND turn_id = $3 AND status IN ('queued','generating')
       UNION ALL
       SELECT 'chronicle' AS kind FROM chronicle_jobs
        WHERE campaign_id = $1 AND owner_user_id = $2 AND status = 'running'
       LIMIT 1`,
      [job.campaign_id, job.owner_user_id, job.replacement_turn_id]
    );
    if (conflictingWork.rows[0]) {
      throw Object.assign(new Error("Active derived work prevented the replacement from committing safely."), {
        code: "replacement_work_active"
      });
    }
  }
  const stateResult = await client.query<{
    trackers: unknown;
    rpg_stats: unknown;
    event_triggers: unknown;
    pending_event_triggers: unknown;
  }>(
    `SELECT trackers,rpg_stats,event_triggers,pending_event_triggers
       FROM campaign_state WHERE campaign_id = $1 AND owner_user_id = $2 FOR UPDATE`,
    [job.campaign_id, job.owner_user_id]
  );
  const trackerBase = isReplacement && Array.isArray(job.base_state_private?.trackers)
    ? job.base_state_private.trackers
    : stateResult.rows[0]?.trackers;
  const trackers = mergedTrackers(trackerBase, story.tracker_updates);
  const storyOnly = job.generation_policy?.playMode === "story_only";
  const lockedMechanics = stateResult.rows[0];
  if (orchestration.extension && (
      orchestration.extension.finalStoryHash !== stableStringify(orchestration.extension.story)
      || stableStringify(story) !== orchestration.extension.finalStoryHash
      || !orchestration.validatedMainDraft
      || orchestration.extension.validatedMainDraftHash !== orchestration.validatedMainDraft.draftHash
      || !orchestration.extension.producingRequestPayloadHash
      || !Array.isArray(orchestration.extension.sentFactIds)
      || stableStringify([...(input.sentFactIds ?? [])].sort())
        !== stableStringify([...orchestration.extension.sentFactIds].sort()))) {
    throw Object.assign(new Error("The persisted final event story no longer matches its validated producing request."), {
      code: "generation_checkpoint_incompatible"
    });
  }
  const fulfilledEvents = storyOnly ? [] : [
    ...(orchestration.beforeEvents || []),
    // An after-event is fulfilled only when its immediate fiction was accepted.
    ...((orchestration.extension ? orchestration.afterEvents || [] : []).filter((event) => event.addTextAfter))
  ];
  const eventTriggers = storyOnly
    ? lockedMechanics?.event_triggers
    : applyTriggerHits(inputs.eventTriggers, fulfilledEvents, new Date().toISOString());
  const pendingEventTriggers = storyOnly ? lockedMechanics?.pending_event_triggers : (orchestration.afterEvents || [])
    .filter((event) => !event.addTextAfter || Boolean(orchestration.extensionError))
    .map(({ addTextAfter: _addTextAfter, ...event }) => event);
  const mechanicsPrivate = {
    roll: orchestration.roll || null,
    beforeEvents: orchestration.beforeEvents || [],
    afterEvents: orchestration.afterEvents || [],
    extensionApplied: Boolean(
      (orchestration.afterEvents || []).some((event) => event.addTextAfter)
      && !orchestration.extensionError
    )
  };
  if (isReplacement) {
    await client.query(
      `DELETE FROM campaign_state_edits
        WHERE campaign_id = $1 AND owner_user_id = $2 AND effective_turn_number > $3`,
      [job.campaign_id, job.owner_user_id, job.base_turn_number ?? 0]
    );
    await client.query(
      `DELETE FROM summary_checkpoints
        WHERE campaign_id = $1 AND owner_user_id = $2 AND through_turn > $3`,
      [job.campaign_id, job.owner_user_id, job.base_turn_number ?? 0]
    );
    await client.query(
      `DELETE FROM chronicle_jobs
        WHERE campaign_id = $1 AND owner_user_id = $2 AND status <> 'running'`,
      [job.campaign_id, job.owner_user_id]
    );
    await client.query(
      "DELETE FROM model_chains WHERE campaign_id = $1 AND owner_user_id = $2",
      [job.campaign_id, job.owner_user_id]
    );
    await client.query(
      "DELETE FROM turns WHERE id = $1 AND campaign_id = $2 AND owner_user_id = $3",
      [job.replacement_turn_id, job.campaign_id, job.owner_user_id]
    );
  }
  const turnResult = await client.query<{ id: string }>(
    `INSERT INTO turns (owner_user_id, campaign_id, turn_number, action, input_mode, input_mode_source, narration, choices,
       custom_action_suggestion, image_prompt, mechanics_private, state_snapshot_private, model_metadata, generation_policy)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [job.owner_user_id, job.campaign_id, job.expected_turn_number, job.action,
      job.resolved_input_mode, job.input_mode_source, story.narration, json(story.choices),
      story.custom_action_suggestion, story.image_prompt, json(mechanicsPrivate),
      json({
        scratchpad: story.scratchpad,
        trackers,
        eventTriggers,
        pendingEventTriggers,
        rpgStats: storyOnly ? lockedMechanics?.rpg_stats : inputs.rpgStats,
        continuitySummary: story.continuity_summary,
        canonicalFacts: story.canonical_facts,
        supersededFacts: story.superseded_facts,
        canonicalFactUpdates: story.canonical_fact_updates.map((update) => ({
          content: update.content,
          supersedesFactIds: update.supersedes_fact_ids
        })),
        openThreads: story.open_threads
      }),
      json({
        providerProfileId: provider.id,
        providerType: provider.providerType,
        model: provider.model,
        modelInstanceId: response.modelInstanceId,
        responseId: response.responseId,
        usage: response.usage,
        promptProtocolVersion: job.prompt_protocol_version,
        generationPolicy: job.generation_policy,
        contextFingerprint: input.contextFingerprint,
        contextDiagnostics: input.contextDiagnostics,
        chronicleRetrieval,
        ...(reviewAcceptanceAudit ? { reviewAcceptance: reviewAcceptanceAudit } : {})
      }), job.generation_policy === null ? null : json(job.generation_policy)]
  );
  const turnId = turnResult.rows[0]?.id;
  if (!turnId) throw new Error("Story turn insert did not return an ID.");
  await collaborators.attributeGenerationCostsToTurn(
    client,
    job.owner_user_id,
    job.campaign_id,
    job.id,
    turnId
  );
  if (storyOnly) {
    await client.query(
      `UPDATE campaign_state SET scratchpad_private = $3, scratchpad_safe_for_prompt = true, trackers = $4,
         revision = revision + 1, updated_at = now()
        WHERE campaign_id = $1 AND owner_user_id = $2`,
      [job.campaign_id, job.owner_user_id, story.scratchpad, json(trackers)]
    );
  } else {
    await client.query(
      `UPDATE campaign_state SET scratchpad_private = $3, scratchpad_safe_for_prompt = true, trackers = $4, event_triggers = $5,
         pending_event_triggers = $6, rpg_stats = $7, revision = revision + 1, updated_at = now()
        WHERE campaign_id = $1 AND owner_user_id = $2`,
      [job.campaign_id, job.owner_user_id, story.scratchpad, json(trackers), json(eventTriggers),
        json(pendingEventTriggers), json(inputs.rpgStats)]
    );
  }
  await client.query(
    "UPDATE campaigns SET active_turn_number = $3, updated_at = now() WHERE id = $1 AND owner_user_id = $2",
    [job.campaign_id, job.owner_user_id, job.expected_turn_number]
  );
  if (isReplacement) {
    await collaborators.memory.rebuildCampaignMemories(client, {
      ownerUserId: job.owner_user_id,
      campaignId: job.campaign_id,
      worldVersionId: campaign.world_version_id
    });
    await client.query(
      `INSERT INTO activity_events (owner_user_id, campaign_id, event_type, correlation_id, details)
       VALUES ($1,$2,'campaign_turn_replaced',$3,$4)`,
      [job.owner_user_id, job.campaign_id, job.id,
        json({ turnNumber: job.expected_turn_number, replacementTurnId: turnId })]
    );
  } else {
    await collaborators.memory.storeDerivedTurnMemories(client, {
      ownerUserId: job.owner_user_id,
      campaignId: job.campaign_id,
      worldVersionId: campaign.world_version_id,
      turnId,
      ordinal: job.expected_turn_number,
      derived: {
        continuitySummary: story.continuity_summary,
        canonicalFacts: story.canonical_facts,
        supersededFacts: story.superseded_facts,
        canonicalFactUpdates: story.canonical_fact_updates.map((update) => ({
          content: update.content,
          supersedesFactIds: update.supersedes_fact_ids
        })),
        openThreads: story.open_threads,
        entityCatalog
      }
    });
    const memory = buildTurnFictionMemory(
      { action: input.fictionAction, narration: story.narration },
      job.expected_turn_number
    );
    const entityMetadata = resolveEntityMetadata(memory.content, entityCatalog);
    await collaborators.memory.writeAcceptedTurnFiction(client, {
      ownerUserId: job.owner_user_id,
      campaignId: job.campaign_id,
      worldVersionId: campaign.world_version_id,
      turnId,
      ordinal: job.expected_turn_number,
      action: input.fictionAction,
      inputMode: job.resolved_input_mode,
      narration: story.narration
    });
  }
  await enqueueChunkIndexBestEffort(client, collaborators.memory, {
    ownerUserId: job.owner_user_id,
    campaignId: job.campaign_id,
    worldVersionId: campaign.world_version_id
  });
  await client.query("SAVEPOINT accepted_turn_illustration_enqueue");
  try {
    if (job.streaming_segments_state?.provisionalSetId) {
      const illustrationConfig = await collaborators.illustration.loadStreamingIllustrationConfig(
        client,
        { ownerUserId: job.owner_user_id, campaignId: job.campaign_id }
      ).catch(() => null);
      if (illustrationConfig) {
        await collaborators.illustration.promoteProvisionalSet(
          client,
          { ownerUserId: job.owner_user_id, campaignId: job.campaign_id, generationJobId: job.id, turnId },
          { finalNarration: story.narration, config: illustrationConfig }
        );
      } else {
        await collaborators.illustration.enqueueAcceptedTurnIllustrationSegments(
          client,
          { ownerUserId: job.owner_user_id, campaignId: job.campaign_id, turnId }
        );
      }
    } else {
      await collaborators.illustration.enqueueAcceptedTurnIllustrationSegments(
        client,
        { ownerUserId: job.owner_user_id, campaignId: job.campaign_id, turnId }
      );
    }
    await client.query("RELEASE SAVEPOINT accepted_turn_illustration_enqueue");
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT accepted_turn_illustration_enqueue");
    await client.query("RELEASE SAVEPOINT accepted_turn_illustration_enqueue");
    if (job.streaming_segments_state?.provisionalSetId) {
      await client.query(
        `UPDATE generation_jobs
            SET streaming_segments_state = streaming_segments_state
              || '{"provisionalIllustrationReconciliation":"pending"}'::jsonb
          WHERE id=$1 AND owner_user_id=$2`,
        [job.id, job.owner_user_id]
      );
    }
    input.onIllustrationEnqueueError(error, turnId);
  }
  await collaborators.memory.enqueueEmbeddingReindex(client, {
    ownerUserId: job.owner_user_id,
    campaignId: job.campaign_id,
    worldVersionId: campaign.world_version_id
  });
  const completed = await client.query<{ id: string }>(
    `UPDATE generation_jobs SET status = 'completed', result_turn_id = $3, provider_response_id = $4,
       provider_finish_reason = $5, completed_at = now(), updated_at = now(), lease_owner = NULL, lease_expires_at = NULL,
       partial_output = NULL, error_code = NULL, error_message = NULL
     WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $6 AND status = 'committing'
       AND lease_expires_at > now()
     RETURNING id`,
    [job.id, job.owner_user_id, turnId, response.responseId || null,
      response.finishReason || null, scope.workerId]
  );
  if (!completed.rows[0]) {
    throw Object.assign(new Error("Generation was cancelled or its lease was lost while marking the committed turn complete."), {
      code: "generation_cancelled"
    });
  }
  return { turnId };
}

function changed(result: { rows: readonly unknown[] }): boolean {
  return result.rows.length === 1;
}

function matchesGenerationBaseIdentity(
  stored: GenerationBaseIdentity,
  resolved: GenerationBaseIdentity
): boolean {
  return stableStringify(stored) === stableStringify(resolved);
}

export function createPostgresGenerationExecutionRepository(
  pool: DatabasePool
): GenerationClaimRepository & GenerationExecutionRepository {
  return {
    async claimNext(request) {
      return withTransaction(pool, async (client) => {
        const result = await client.query<{
          id: string;
          owner_user_id: string;
          campaign_id: string;
          provider_profile_id: string;
          expected_turn_number: number;
          operation_kind: "append" | "replace_latest";
          replacement_turn_id: string | null;
          attempts: number;
        }>(
          `WITH candidate AS (
             SELECT id FROM generation_jobs
              WHERE status IN ('queued','replacement_queued')
                 OR (status IN ('assessing','generating','validating','committing') AND lease_expires_at < now())
              ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
           )
           UPDATE generation_jobs j SET status = 'assessing', attempts = attempts + 1, lease_owner = $1,
                  lease_expires_at = now() + ($2::text || ' seconds')::interval, updated_at = now()
             FROM candidate WHERE j.id = candidate.id
           RETURNING j.id, j.owner_user_id, j.campaign_id, j.provider_profile_id,
                     j.expected_turn_number, j.operation_kind, j.replacement_turn_id, j.attempts`,
          [request.workerId, request.leaseSeconds]
        );
        return result.rows[0] ? claimedGeneration(result.rows[0]) : null;
      });
    },

    async loadExecutionPayload(request) {
      return withTransaction(pool, async (client) => {
        const result = await client.query<ExecutionPayloadRow>(
        `SELECT j.id, j.owner_user_id, j.campaign_id, j.provider_profile_id,
                j.expected_turn_number, j.operation_kind, j.replacement_turn_id,
                j.base_turn_number, j.base_state_private, j.base_scratchpad_safe_for_prompt,
                j.action, j.requested_input_mode, j.resolved_input_mode, j.input_mode_source,
                j.requested_model, j.context_options, j.prompt_protocol_version, j.prompt_snapshot,
                j.generation_base_identity, j.generation_policy,
                j.attempts, j.orchestration_private, j.streaming_segments_state,
                wv.world_id, c.world_version_id, c.legacy_settings, c.character_profile, c.character_snapshot,
                cs.rpg_stats, cs.event_triggers, cs.pending_event_triggers,
                latest.state_snapshot_private
           FROM generation_jobs j
           JOIN campaigns c ON c.id = j.campaign_id AND c.owner_user_id = j.owner_user_id
           JOIN world_versions wv ON wv.id = c.world_version_id AND wv.owner_user_id = c.owner_user_id
           JOIN campaign_state cs ON cs.campaign_id = c.id AND cs.owner_user_id = c.owner_user_id
           LEFT JOIN LATERAL (
             SELECT state_snapshot_private FROM turns
              WHERE campaign_id = c.id AND owner_user_id = c.owner_user_id
              ORDER BY turn_number DESC LIMIT 1
           ) latest ON true
          WHERE j.id = $1 AND j.owner_user_id = $2
            AND j.lease_owner = $3 AND j.status = 'assessing' AND j.lease_expires_at > now()
          FOR UPDATE OF j`,
        [request.claim.jobId, request.claim.ownerUserId, request.workerId]
      );
      const row = result.rows[0];
      if (!row) return null;
      let responseContractValid = true;
      try { responseContractState(row.id, row.orchestration_private); } catch { responseContractValid = false; }
      const storedReview = row.orchestration_private?.generationReview === undefined
        ? undefined : generationReviewCheckpointSchema.safeParse(row.orchestration_private.generationReview);
      if (!responseContractValid || (row.orchestration_private?.continuityReview !== undefined && !continuityReviewCheckpointSchema.safeParse(row.orchestration_private.continuityReview).success)
          || (storedReview !== undefined && (!storedReview.success
            || !generationReviewMatchesExecutionJob(storedReview.data, row)
            || !appliedFactFormatRepairMatchesExecutionJob(storedReview.data, row.orchestration_private, row)
            || !factFormatRepairApplicationsMatchExecutionJob(storedReview.data, row.orchestration_private, row)))
          || !hasValidFactFormatRepairApplications(row.orchestration_private?.factFormatRepairApplications)
          || !hasValidLogicalAttempt(row.orchestration_private?.logicalAttempt)
          || !hasValidPrimaryReservation(row.orchestration_private?.primaryReservation)
          || !hasValidPrimaryResult(row.orchestration_private?.primaryResult)
          || !hasValidSemanticRepair(row.orchestration_private?.semanticRepair)
          || !hasValidSceneCoverageRepair(row.orchestration_private?.sceneCoverageRepair)
          || !hasValidAutomaticRepair(row.orchestration_private?.automaticRepair)
          || !hasValidChoiceRepair(row.orchestration_private?.choiceRepair)
          || !hasValidEventCoverageRepair(row.orchestration_private?.eventCoverageRepair)) {
        await client.query(
          `UPDATE generation_jobs
              SET status = 'recoverable', error_code = 'generation_checkpoint_incompatible',
                  error_message = 'Saved generation recovery state is invalid.',
                  recovery_metadata = recovery_metadata || $4::jsonb,
                  lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
            WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $3
              AND status = 'assessing' AND lease_expires_at > now()`,
          [row.id, row.owner_user_id, request.workerId, json({ reason: "orchestration_repair_invalid" })]
        );
        return null;
      }
      if (row.generation_policy !== null && !generationPolicySnapshotSchema.safeParse(row.generation_policy).success) {
        await client.query(
          `UPDATE generation_jobs
              SET status = 'recoverable', error_code = 'generation_checkpoint_incompatible',
                  error_message = 'Saved generation policy is invalid.',
                  recovery_metadata = recovery_metadata || $4::jsonb,
                  lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
            WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $3
              AND status = 'assessing' AND lease_expires_at > now()`,
          [row.id, row.owner_user_id, request.workerId, json({ reason: "generation_policy_invalid" })]
        );
        return null;
      }
      let storedBaseIdentity: GenerationBaseIdentity;
      try {
        storedBaseIdentity = readGenerationBaseIdentity(row.generation_base_identity) as GenerationBaseIdentity;
      } catch {
        await client.query(
          `UPDATE generation_jobs
              SET status = 'recoverable', error_code = 'generation_checkpoint_incompatible',
                  error_message = 'Saved generation authority is invalid.',
                  recovery_metadata = recovery_metadata || $4::jsonb,
                  lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
            WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $3
              AND status = 'assessing' AND lease_expires_at > now()`,
          [row.id, row.owner_user_id, request.workerId, json({ reason: "generation_base_identity_invalid" })]
        );
        return null;
      }
      let authority: Awaited<ReturnType<typeof resolveGenerationAuthoritySnapshot>>;
      try {
        authority = await resolveGenerationAuthoritySnapshot(client, {
          ownerUserId: row.owner_user_id,
          campaignId: row.campaign_id,
          operationKind: row.operation_kind,
          expectedTurnNumber: row.expected_turn_number,
          ...(isGenerationBaseIdentityV3(storedBaseIdentity) ? { baseIdentityVersion: "generation-base-v3" as const, captureRecentWindow: storedBaseIdentity.recentWindowFingerprint !== undefined } : {})
        });
      } catch (error) {
        const detail = error as { code?: unknown; field?: unknown };
        if (detail.code !== "authoritative_context_invalid") throw error;
        await client.query(
          `UPDATE generation_jobs
              SET status = 'recoverable', error_code = 'generation_checkpoint_incompatible',
                  error_message = 'Persisted campaign authority is invalid.',
                  recovery_metadata = recovery_metadata || $4::jsonb,
                  lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
            WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $3
              AND status = 'assessing' AND lease_expires_at > now()`,
          [row.id, row.owner_user_id, request.workerId, json({
            reason: "authoritative_context_invalid",
            ...(typeof detail.field === "string" ? { field: detail.field } : {})
          })]
        );
        return null;
      }
      if (!matchesGenerationBaseIdentity(storedBaseIdentity, authority.baseIdentity)) {
        await client.query(
          `UPDATE generation_jobs
              SET status = 'recoverable', error_code = 'generation_authority_stale',
                  error_message = 'Campaign changed before generation could start.',
                  recovery_metadata = recovery_metadata || $4::jsonb,
                  lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
            WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $3
              AND status = 'assessing' AND lease_expires_at > now()`,
          [row.id, row.owner_user_id, request.workerId, json({ reason: "generation_authority_stale" })]
        );
        return null;
      }
      const {
        legacy_settings: _legacySettings,
        rpg_stats: _rpgStats,
        event_triggers: _eventTriggers,
        pending_event_triggers: _pendingEventTriggers,
        state_snapshot_private: _stateSnapshot,
        character_profile: _characterProfile,
        character_snapshot: _characterSnapshot,
        ...payload
      } = row;
      return { ...payload, generation_base_identity: storedBaseIdentity, orchestration_inputs: orchestrationInputs(row) };
      });
    },

    async renewLease(scope, leaseSeconds) {
      return changed(await pool.query<{ id: string }>(
        `UPDATE generation_jobs
            SET lease_expires_at = now() + ($4::text || ' seconds')::interval, updated_at = now()
          WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $3
            AND status IN ('assessing','generating','validating','committing')
            AND lease_expires_at > now()
          RETURNING id`,
        [scope.jobId, scope.ownerUserId, scope.workerId, leaseSeconds]
      ));
    },

    async markGenerating(scope) {
      return changed(await pool.query<{ id: string }>(
        `UPDATE generation_jobs SET status = 'generating', updated_at = now()
          WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $3 AND status = 'assessing'
            AND lease_expires_at > now()
          RETURNING id`,
        [scope.jobId, scope.ownerUserId, scope.workerId]
      ));
    },

    async restartAfterSemanticRepair(scope) {
      return changed(await pool.query<{ id: string }>(
        `UPDATE generation_jobs SET status = 'assessing', updated_at = now()
          WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $3 AND status = 'validating'
            AND lease_expires_at > now()
          RETURNING id`,
        [scope.jobId, scope.ownerUserId, scope.workerId]
      ));
    },

    async saveOrchestration(scope, value) {
      const safeContextDiagnostic = projectSafeGenerationDiagnostic(value.contextDiagnostic);
      return changed(await pool.query<{ id: string }>(
        `UPDATE generation_jobs SET orchestration_private =
              CASE WHEN $4::jsonb ? 'generationReview' THEN ($4::jsonb - 'queuedResponsePolicy' - 'frozenResponseContracts' - 'responseContractInvocations')
                   WHEN orchestration_private ? 'generationReview' THEN (($4::jsonb - 'queuedResponsePolicy' - 'frozenResponseContracts' - 'responseContractInvocations') || jsonb_build_object('generationReview', orchestration_private->'generationReview'))
                   ELSE ($4::jsonb - 'queuedResponsePolicy' - 'frozenResponseContracts' - 'responseContractInvocations')
               END
               || CASE WHEN orchestration_private ? 'queuedResponsePolicy' THEN jsonb_build_object('queuedResponsePolicy', orchestration_private->'queuedResponsePolicy') ELSE '{}'::jsonb END
               || CASE WHEN orchestration_private ? 'frozenResponseContracts' THEN jsonb_build_object('frozenResponseContracts', orchestration_private->'frozenResponseContracts') ELSE '{}'::jsonb END
               || CASE WHEN orchestration_private ? 'responseContractInvocations' THEN jsonb_build_object('responseContractInvocations', orchestration_private->'responseContractInvocations') ELSE '{}'::jsonb END,
            recovery_metadata = CASE WHEN $5::jsonb IS NULL THEN recovery_metadata ELSE recovery_metadata || jsonb_build_object('diagnostic',$5::jsonb) END,
            updated_at = now()
          WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $3
            AND status IN ('assessing','generating','validating','committing')
            AND lease_expires_at > now()
          RETURNING id`,
        [scope.jobId, scope.ownerUserId, scope.workerId, json(value), safeContextDiagnostic ? json(safeContextDiagnostic) : null]
      ));
    },

    async saveFrozenResponseContracts(scope, expectedQueuedPolicyHash, value) {
      const parsed = readFrozenResponseContracts(value);
      if (!parsed) throw new Error("Frozen response contracts are required.");
      return withTransaction(pool, async (client) => {
        const result = await client.query<{ orchestrationPrivate: GenerationOrchestrationState }>(
          `SELECT orchestration_private AS "orchestrationPrivate" FROM generation_jobs
            WHERE id=$1 AND owner_user_id=$2 AND lease_owner=$3 AND status='assessing' AND lease_expires_at > now() FOR UPDATE`,
          [scope.jobId, scope.ownerUserId, scope.workerId]
        );
        const row = result.rows[0];
        if (!row) return null;
        const stored = row.orchestrationPrivate;
        const queued = readQueuedResponsePolicy(stored.queuedResponsePolicy);
        if (!queued || queuedResponsePolicyHash(queued) !== expectedQueuedPolicyHash
          || queuedResponsePolicyHash(parsed.queuedPolicy) !== expectedQueuedPolicyHash) return null;
        const existing = readFrozenResponseContracts(stored.frozenResponseContracts);
        if (existing) return existing;
        const write = await client.query<{ id: string }>(
          `UPDATE generation_jobs SET orchestration_private=orchestration_private || jsonb_build_object('frozenResponseContracts',$4::jsonb), updated_at=now()
            WHERE id=$1 AND owner_user_id=$2 AND lease_owner=$3 AND status='assessing' AND lease_expires_at > now()
              AND NOT orchestration_private ? 'frozenResponseContracts' RETURNING id`,
          [scope.jobId, scope.ownerUserId, scope.workerId, json(parsed)]
        );
        if (!write.rows[0]) return null;
        return parsed;
      });
    },

    async reserveResponseContractInvocation(scope, input) {
      readAttemptResponseContractAudit(input.request);
      if (input.request.returnedModel !== null || input.request.returnedProviderRoute !== null || input.request.diagnosticCode !== null) return null;
      return withTransaction(pool, async (client) => {
        const result = await client.query<{ orchestrationPrivate: GenerationOrchestrationState }>(
          `SELECT orchestration_private AS "orchestrationPrivate" FROM generation_jobs
            WHERE id=$1 AND owner_user_id=$2 AND lease_owner=$3 AND status IN ('assessing','generating','validating') AND lease_expires_at > now() FOR UPDATE`,
          [scope.jobId, scope.ownerUserId, scope.workerId]
        );
        const row = result.rows[0]; if (!row) return null;
        responseContractState(scope.jobId, row.orchestrationPrivate);
        const frozen = readFrozenResponseContracts(row.orchestrationPrivate.frozenResponseContracts);
        const logicalAttempt = row.orchestrationPrivate.logicalAttempt;
        if (!logicalAttempt || !hasValidLogicalAttempt(logicalAttempt)
          || input.logicalAttemptId !== logicalAttempt.id
          || !frozen || frozen.selectionHash !== input.request.selectionHash
          || !frozen.queuedPolicy.invocationKeys.includes(input.invocationKey)
          || !operationMatchesInvocation(input.operation, input.invocationKey)
          || !auditMatchesFrozenInvocation(frozen, input.invocationKey, input.request)) return null;
        const ledger = [...(responseContractInvocations(row.orchestrationPrivate.responseContractInvocations) ?? [])];
        // Claim attempts are leases, not provider-authorized work. Only the persisted logical-attempt identity changes an operation id.
        const id = responseContractInvocationAuditId(scope.jobId, input.logicalAttemptId, input.invocationKey, input.operation, input.requestPayloadHash);
        const existing = ledger.find((item) => item.id === id);
        if (existing) {
          if (existing.logicalAttemptId !== input.logicalAttemptId || existing.invocationKey !== input.invocationKey
            || existing.operation !== input.operation || existing.requestPayloadHash !== input.requestPayloadHash
            || stableStringify(existing.request) !== stableStringify(input.request)) return null;
          return existing;
        }
        if (ledger.length >= responseContractInvocationLedgerLimit) return null;
        const entry = readResponseContractInvocationAudit({ version: 1, id, logicalAttemptId: input.logicalAttemptId, invocationKey: input.invocationKey,
          operation: input.operation, requestPayloadHash: input.requestPayloadHash, request: input.request,
          status: "reserved", reservedAt: new Date().toISOString(), dispatchedAt: null, completedAt: null, response: null });
        ledger.push(entry);
        const write = await client.query<{ id: string }>(`UPDATE generation_jobs SET orchestration_private=orchestration_private || jsonb_build_object('responseContractInvocations',$4::jsonb), updated_at=now() WHERE id=$1 AND owner_user_id=$2 AND lease_owner=$3 AND status IN ('assessing','generating','validating') AND lease_expires_at > now() RETURNING id`, [scope.jobId, scope.ownerUserId, scope.workerId, json(ledger)]);
        if (!write.rows[0]) return null;
        return entry;
      });
    },

    async markResponseContractInvocationDispatched(scope, invocationId, expectedRequestPayloadHash) {
      return updateResponseContractInvocation(pool, scope, invocationId, "dispatched", expectedRequestPayloadHash);
    },

    async completeResponseContractInvocation(scope, invocationId, response) {
      return updateResponseContractInvocation(pool, scope, invocationId, "completed", undefined, response);
    },

    async pauseForReview(scope, checkpoint) {
      const parsed = generationReviewCheckpointSchema.parse(checkpoint);
      return withTransaction(pool, async (client) => {
      const actual = await client.query<{ campaignId: string; worldId: string; worldVersionId: string | null; baseIdentity: GenerationBaseIdentity; providerProfileId: string; promptProtocolVersion: string; expectedTurnNumber: number; operationKind: "append" | "replace_latest"; replacementTurnId: string | null; prior: Record<string, unknown> }>(
        `SELECT j.campaign_id AS "campaignId", w.id AS "worldId", c.world_version_id AS "worldVersionId",
                j.generation_base_identity AS "baseIdentity", j.provider_profile_id AS "providerProfileId", j.prompt_protocol_version AS "promptProtocolVersion", j.expected_turn_number AS "expectedTurnNumber",
                j.operation_kind AS "operationKind", j.replacement_turn_id AS "replacementTurnId", j.orchestration_private AS prior
           FROM generation_jobs j JOIN campaigns c ON c.id=j.campaign_id AND c.owner_user_id=j.owner_user_id
           JOIN world_versions v ON v.id=c.world_version_id JOIN worlds w ON w.id=v.world_id
          WHERE j.id=$1 AND j.owner_user_id=$2 AND j.lease_owner=$3
            AND j.status IN ('assessing','generating','validating','committing') AND j.lease_expires_at > now() FOR UPDATE OF j`,
        [scope.jobId, scope.ownerUserId, scope.workerId]
      );
      const job = actual.rows[0];
      if (!job) return false;
      const candidate = parsed.gateCandidate;
      if (candidate.ownerUserId !== scope.ownerUserId || candidate.campaignId !== job.campaignId || candidate.worldId !== job.worldId
          || candidate.worldVersionId !== job.worldVersionId || candidate.expectedTurnNumber !== job.expectedTurnNumber
          || stableStringify(candidate.baseIdentity) !== stableStringify(readGenerationBaseIdentity(job.baseIdentity))
          || candidate.provider.profileId !== job.providerProfileId || parsed.operationKind !== job.operationKind
          || candidate.protocol.version !== job.promptProtocolVersion || parsed.replacementTurnId !== job.replacementTurnId) return false;
      const rawPrior = job.prior?.generationReview;
      const prior = rawPrior === undefined ? undefined : generationReviewCheckpointSchema.safeParse(rawPrior);
      if (prior && !prior.success) return false;
      if (prior?.success) {
        if (parsed.revision <= prior.data.revision || parsed.decisionJournal.length < prior.data.decisionJournal.length
            || stableStringify(parsed.originalCandidate) !== stableStringify(prior.data.originalCandidate)
            || stableStringify(parsed.originalFindings) !== stableStringify(prior.data.originalFindings)
            || stableStringify(parsed.decisionJournal.slice(0, prior.data.decisionJournal.length)) !== stableStringify(prior.data.decisionJournal)) return false;
      }
      return changed(await client.query<{ id: string }>(
        `UPDATE generation_jobs
            SET status = 'recoverable', orchestration_private = orchestration_private || jsonb_build_object('generationReview', $4::jsonb),
                error_code = 'generation_review_required', error_message = 'Generation requires review before it can continue.',
                lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
          WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $3
            AND status IN ('assessing','generating','validating','committing') AND lease_expires_at > now()
          RETURNING id`,
        [scope.jobId, scope.ownerUserId, scope.workerId, json(parsed)]
      ));
      });
    },

    async savePartialNarration(scope, narration) {
      return changed(await pool.query<{ id: string }>(
        `UPDATE generation_jobs SET partial_output = $4, updated_at = now()
          WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $3 AND status = 'generating'
            AND lease_expires_at > now()
          RETURNING id`,
        [scope.jobId, scope.ownerUserId, scope.workerId, narration]
      ));
    },

    async saveStreamingSegments(scope, value) {
      return changed(await pool.query<{ id: string }>(
        `UPDATE generation_jobs SET streaming_segments_state = $4, updated_at = now()
          WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $3 AND status = 'generating'
            AND lease_expires_at > now()
          RETURNING id`,
        [scope.jobId, scope.ownerUserId, scope.workerId, json(value)]
      ));
    },

    async recordAttempt(input) {
      const result = await pool.query(
        `WITH authorized_job AS MATERIALIZED (
           SELECT id FROM generation_jobs
            WHERE id = $2 AND owner_user_id = $1 AND lease_owner = $11
              AND status IN ('assessing','generating','validating','committing')
              AND lease_expires_at > now()
            FOR UPDATE
         )
         INSERT INTO generation_attempts (
           owner_user_id, generation_job_id, attempt_number, recovery_kind, request_metadata,
           response_metadata, provider_response_id, finish_reason, raw_output, validation_errors, completed_at
         ) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()
             FROM authorized_job
         ON CONFLICT (generation_job_id, attempt_number) DO UPDATE SET
           response_metadata = CASE WHEN $12 THEN EXCLUDED.response_metadata ELSE generation_attempts.response_metadata END,
           provider_response_id = CASE WHEN $12 THEN EXCLUDED.provider_response_id ELSE generation_attempts.provider_response_id END,
           finish_reason = CASE WHEN $12 THEN EXCLUDED.finish_reason ELSE generation_attempts.finish_reason END,
           raw_output = CASE WHEN $12 THEN EXCLUDED.raw_output ELSE generation_attempts.raw_output END,
           validation_errors = CASE WHEN $12 THEN EXCLUDED.validation_errors ELSE generation_attempts.validation_errors END,
           completed_at = CASE WHEN $12 THEN now() ELSE generation_attempts.completed_at END
         RETURNING generation_job_id`,
        [input.ownerUserId, input.jobId, input.attemptNumber, input.recoveryKind,
          json(input.requestMetadata), json(input.responseMetadata), input.providerResponseId,
          input.finishReason, input.rawOutput, json(input.validationErrors), input.workerId,
          input.overwrite]
      );
      if (!changed(result)) {
        throw Object.assign(new Error("Generation attempt owner, lease, or source state no longer matched."), {
          code: "generation_cancelled"
        });
      }
    },

    async markRecoverable(input) {
      return changed(await pool.query<{ id: string }>(
        `UPDATE generation_jobs SET status = 'recoverable', provider_response_id = $4,
           provider_finish_reason = $5, error_code = $6, error_message = $7,
           recovery_metadata = recovery_metadata || $8::jsonb,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $3
           AND status IN ('assessing','generating','validating','committing')
           AND lease_expires_at > now()
         RETURNING id`,
        [input.jobId, input.ownerUserId, input.workerId, input.providerResponseId,
          input.providerFinishReason, input.errorCode, input.errorMessage,
          json(input.recoveryMetadata)]
      ));
    },

    async markValidating(scope) {
      return changed(await pool.query<{ id: string }>(
        `UPDATE generation_jobs SET status = 'validating', updated_at = now()
          WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $3 AND status = 'generating'
            AND lease_expires_at > now()
          RETURNING id`,
        [scope.jobId, scope.ownerUserId, scope.workerId]
      ));
    },

    async markCommitting(scope) {
      return changed(await pool.query<{ id: string }>(
        `UPDATE generation_jobs SET status = 'committing', updated_at = now()
          WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $3 AND status = 'validating'
            AND lease_expires_at > now()
          RETURNING id`,
        [scope.jobId, scope.ownerUserId, scope.workerId]
      ));
    },

    async commitAcceptedTurn(input) {
      return withTransaction(pool, (client) => commitAcceptedTurn(client, input));
    },

    async markFailed(input) {
      return changed(await pool.query<{ id: string }>(
        `UPDATE generation_jobs SET status = 'failed', error_code = $4, error_message = $5,
           recovery_metadata = recovery_metadata || $6::jsonb,
           orchestration_private = CASE WHEN $7::jsonb IS NULL THEN orchestration_private
             ELSE orchestration_private || jsonb_build_object('lastFailureDiagnostic', $7::jsonb) END,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $3
           AND status IN ('assessing','generating','validating','committing')
           AND lease_expires_at > now()
         RETURNING id`,
        [input.jobId, input.ownerUserId, input.workerId, input.errorCode,
          input.errorMessage, json(input.recoveryMetadata), input.lastFailureDiagnostic ? json(input.lastFailureDiagnostic) : null]
      ));
    }
  };
}
