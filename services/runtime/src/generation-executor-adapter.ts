import { bindManifestToProducingRequest, validatedChoiceRequestHashes, continuityReviewCheckpointSchema, reviewBindingHash, type ContinuityReviewCheckpoint } from "../../../packages/application/src/memory/continuity-review-checkpoint.js";
import { prepareContinuityRepair, prepareContinuityReview, validatePreparedContinuityReviewResult } from "./story-continuity-review-adapter.js";
import { prepareGenerationReview } from "./generation-review-adapter.js";
import { applyAuthorizedFactFormatRepair, prepareFactFormatRepair } from "./fact-format-repair-adapter.js";
import { generationReviewCheckpointSchema, type GenerationReviewCandidate } from "../../../packages/application/src/generation/review-checkpoint.js";
import { canonicalEvidenceJson, isGenerationBaseIdentityV3 } from "../../../packages/application/src/memory/generation-context.js";
import { planGenerationPromptContext, type PromptCandidate } from "./generation-context-planner.js";
export { planGenerationPromptContext } from "./generation-context-planner.js";
import type {
  GenerationExecutor,
  IllustrationGenerationTransactionPort,
  MemoryGenerationAuthorityContext,
  MemoryGenerationTransactionPort,
  StreamingIllustrationConfig
} from "../../../packages/application/src/index.js";
import {
  PUBLIC_GENERATION_FAILURE_CODE,
  PUBLIC_GENERATION_FAILURE_MESSAGE,
  storyTurnOutputSchema,
  type PlayerEventTrigger,
  type StoryTurnOutput
} from "../../../packages/contracts/src/generation.js";
import {
  chronicleRetrievalAuditSchema,
  type ChronicleRetrievalAudit,
  type MemoryContextQuery
} from "../../../packages/contracts/src/memory.js";
import {
  promptSnapshotSchema,
  assertStoryPromptCompatibility,
  assertStoryMemoryPromptCompatibility,
  assertContinuityReviewPromptSnapshot,
  readPromptSnapshot,
  type
  PromptSnapshot,
  PromptTemplateKey
} from "../../../packages/contracts/src/prompt-library.js";
import { generationPolicySnapshotSchema } from "../../../packages/contracts/src/campaign-generation-policy.js";
import { effectiveProviderConfigurationFingerprint, storyMemoryPolicySnapshotSchema } from "../../../packages/contracts/src/story-memory-policy.js";
import { renderPromptTemplate } from "../../../packages/contracts/src/prompt-library.js";
import {
  storyLengthProfileFromUnknown,
  storyLengthWordRange,
  type StoryLengthWordRange
} from "../../../packages/contracts/src/story-settings.js";
import {
  composeStoryPromptSystemPrompt,
  projectSafeGenerationContextDiagnostic,
  projectSafeGenerationDiagnostic
} from "../../../packages/contracts/src/story-prompt.js";
import type { GenerationFailureDiagnostic } from "../../../packages/contracts/src/generation-review.js";
import type {
  AcceptedGenerationCommitCollaborators,
  GenerationExecutionPayload,
  GenerationExecutionRepository,
  GenerationLeaseScope,
  GenerationOrchestrationState,
  GenerationStreamingState
} from "../../../packages/database/src/generation-execution-repository.js";
import type { DatabaseClient, DatabasePool } from "../../../packages/database/src/pool.js";
import {
  activatedEventsFromResponse,
  buildEventExtensionPrompt,
  buildEventCoveragePrompt,
  buildEventTriggerPrompt,
  buildRpgAssessmentPrompt,
  buildSceneCoveragePrompt,
  buildStoryMemoryUserPrompt,
  buildStoryUserPrompt,
  compactStoryLengthWordRange,
  containsMechanicsLanguage,
  extractPartialNarration,
  ContextBudgetError,
  resolveEffectiveContextWindowTokens,
  estimatedInputSafetyAllowanceTokens,
  estimateStoryTokens,
  composeStoryMemorySystemPrompt,
  composeStoryOnlyChoiceRepairSystemPrompt,
  composeStoryOnlySystemPrompt,
  buildStoryOnlyChoiceRepairInput,
  generationExecutionProtocolIdentity,
  serializeProviderRequest,
  fictionGuidanceForEvents,
  fictionGuidanceForRoll,
  formatNarrationParagraphs,
  generationPolicyIdentity,
  isNarrationFieldComplete,
  localRpgAssessment,
  logProviderTransportError,
  mechanicsLanguageMatches,
  mechanicsLeakFields,
  parseEventExtension,
  parseEventCoverageOutput,
  parseRpgAssessment,
  parseSceneCoverageOutput,
  parseStoryOutput,
  parseStoryOnlyOutput,
  parseChoiceRepair,
  mergeChoiceRepair,
  performPrivateRoll,
  providerTransportErrorDetails,
  type ActivatedEvent,
  type ProviderRequest,
  type ProviderResult,
  type TextProviderProfile
} from "../../../packages/story-engine/src/index.js";
import type { RuntimeTextExecution } from "./provider-credential-transport-adapter.js";
import {
  StreamingSegmentTracker,
  characterVisualReference,
  generationStagePolicy,
  isIllustrationSegmentEligible,
  sha256,
  stableStringify
} from "../../../packages/domain/src/index.js";
import { logger } from "../../../packages/logger/src/index.js";
import { providerPromptProtocolVersion } from "./provider-application-composition.js";

type GenerationTextProvider = RuntimeTextExecution;

/** Extension repair is safe only when every blocking citation points into the
 * appended narration. Any state-field or main-text conflict replaces main. */
export function semanticRepairScope(input: Readonly<{
  hasExtension: boolean; mainNarration: string;
  findings: readonly { kind: string; output?: { path: string; start: number } }[];
}>): "main" | "extension_only" {
  const prefixLength = formatNarrationParagraphs(input.mainNarration).length;
  return input.hasExtension && input.findings.length > 0
    && input.findings.every((finding) => finding.kind === "contradiction"
      && finding.output?.path === "/narration" && finding.output.start >= prefixLength)
    ? "extension_only" : "main";
}

function frozenPolicyIdentity(job: GenerationExecutionPayload): string | null {
  return job.generation_policy ? generationPolicyIdentity(job.generation_policy) : null;
}

export function generationContextFingerprint(input: Readonly<{ providerId: string; model: string; protocol: string; expectedTurnNumber: number; action: string; inputMode: string; storyLength: unknown; context: unknown; generationPolicyIdentity?: string | null; storyMemoryPolicyIdentity?: string }>): string {
  return sha256(stableStringify({ provider: input.providerId, model: input.model, protocol: input.protocol,
    ...(input.generationPolicyIdentity ? { generationPolicyIdentity: input.generationPolicyIdentity } : {}),
    ...(input.storyMemoryPolicyIdentity ? { storyMemoryPolicyIdentity: input.storyMemoryPolicyIdentity } : {}),
    expectedTurnNumber: input.expectedTurnNumber, action: input.action, inputMode: input.inputMode,
    storyLength: input.storyLength, context: input.context }));
}

type GenerationCostAttribution = Readonly<{
  ownerUserId: string;
  campaignId: string;
  generationJobId: string;
  category: "story";
  operation: StoryCostOperation;
}>;

export type GenerationExecutionCollaborators = Readonly<{
  memory: MemoryGenerationTransactionPort;
  illustration: IllustrationGenerationTransactionPort;
  loadTextExecution(
    ownerUserId: string,
    providerProfileId: string,
    model?: string
  ): Promise<GenerationTextProvider>;
  promptFromSnapshot(
    snapshot: PromptSnapshot | Record<string, unknown> | undefined,
    key: PromptTemplateKey
  ): string;
  recordProfileCost(
    database: DatabaseClient | DatabasePool,
    profile: GenerationTextProvider,
    attribution: GenerationCostAttribution,
    result: ProviderResult
  ): Promise<string | null>;
  /** Observes every actual provider dispatch, including attempts that fail before a cost row exists. */
  onProviderDispatch?(operation: StoryCostOperation): void;
  attributeGenerationCostsToTurn(
    client: DatabaseClient,
    ownerUserId: string,
    campaignId: string,
    generationJobId: string,
    turnId: string
  ): Promise<void>;
}>;

export type GenerationExecutorDependencies = Readonly<{
  pool: DatabasePool;
  repository: GenerationExecutionRepository;
  collaborators: GenerationExecutionCollaborators;
}>;

type StoryCostOperation = "rpg_assessment" | "event_trigger_before" | "story_generation"
  | "story_recovery" | "story_choice_repair" | "event_trigger_after" | "event_extension"
  | "scene_coverage_validation" | "scene_coverage_rewrite" | "story_continuity_review" | "story_continuity_repair";

type TurnGenerationPhase =
  | "provider_loading"
  | "input_preparation"
  | "context_retrieval"
  | "orchestration_loading"
  | "rpg_assessment"
  | "before_event_evaluation"
  | "prompt_preparation"
  | "streaming_illustration_setup"
  | "story_generation"
  | "story_validation"
  | "story_recovery"
  | "story_choice_repair"
  | "scene_coverage_validation"
  | "scene_coverage_rewrite"
  | "after_event_evaluation"
  | "event_extension"
  | "story_continuity_review"
  | "story_continuity_repair"
  | "turn_commit";

type TurnGenerationDiagnosticContext = {
  generationJobId: string;
  campaignId: string;
  providerProfileId: string;
  expectedTurnNumber: number;
  operationKind: string;
  jobAttempt: number;
  workerId: string;
};

const SAFE_DIAGNOSTIC_ERROR_CODES = new Set([
  "active_generation_exists",
  "authoritative_context_invalid",
  "continuity_review_unavailable",
  "continuity_review_conflict",
  "context_budget_exceeded",
  "context_budget_invalid",
  "continuity_output_budget_exceeded",
  "extension_narration_limit_exceeded",
  "generation_cancelled",
  "invalid_json",
  "invalid_schema",
  "lease_lost",
  "mechanics_leak",
  "output_limit",
  "provider_request_timeout",
  "provider_transport_error",
  "replacement_work_active",
  "scene_coverage",
  "stale_campaign",
  "unsafe_turn_input"
]);

function diagnosticErrorCode(error: unknown): string {
  try {
    const code = typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
    if (typeof code === "string") {
      const normalized = code.trim().toLowerCase();
      if (SAFE_DIAGNOSTIC_ERROR_CODES.has(normalized)) return normalized;
    }
  } catch {
    // Provider-controlled accessors cannot replace the original failure.
  }
  return "unclassified_error";
}

function diagnosticErrorName(error: unknown): string {
  try {
    if (error instanceof TypeError) return "TypeError";
    if (error instanceof RangeError) return "RangeError";
    if (error instanceof ReferenceError) return "ReferenceError";
    if (error instanceof SyntaxError) return "SyntaxError";
    if (error instanceof URIError) return "URIError";
    if (error instanceof EvalError) return "EvalError";
  } catch {
    // A proxy can throw during instanceof checks.
  }
  return "Error";
}

function diagnosticBudgetScope(error: unknown): "campaign_context" | "provider_request" | "output_skeleton" | "extension_narration" | null {
  try {
    const scope = typeof error === "object" && error !== null
      ? (error as { scope?: unknown }).scope
      : undefined;
    return scope === "campaign_context" || scope === "provider_request" || scope === "output_skeleton" || scope === "extension_narration"
      ? scope
      : null;
  } catch {
    return null;
  }
}

function emitDiagnostic(emit: () => void): void {
  try {
    emit();
  } catch {
    // Diagnostics are observational.
  }
}

async function runTurnGenerationPhase<T>(
  context: TurnGenerationDiagnosticContext,
  phase: TurnGenerationPhase,
  generationStartedAt: number,
  operation: () => Promise<T>
): Promise<T> {
  const phaseStartedAt = Date.now();
  const base = { ...context, phase };
  emitDiagnostic(() => logger.info({
    event: "turn_generation_phase_started",
    ...base,
    totalDurationMs: phaseStartedAt - generationStartedAt
  }));
  const stallTimer = setInterval(() => {
    emitDiagnostic(() => {
      const current = Date.now();
      logger.warn({
        event: "turn_generation_phase_stalled",
        ...base,
        durationMs: current - phaseStartedAt,
        totalDurationMs: current - generationStartedAt
      });
    });
  }, 30_000);
  stallTimer.unref?.();
  try {
    const result = await operation();
    const completedAt = Date.now();
    emitDiagnostic(() => logger.info({
      event: "turn_generation_phase_completed",
      ...base,
      durationMs: completedAt - phaseStartedAt,
      totalDurationMs: completedAt - generationStartedAt
    }));
    return result;
  } catch (error) {
    const failedAt = Date.now();
    const budgetScope = diagnosticBudgetScope(error);
    emitDiagnostic(() => logger.error({
      event: "turn_generation_phase_failed",
      ...base,
      errorName: diagnosticErrorName(error),
      errorCode: diagnosticErrorCode(error),
      ...(budgetScope ? { budgetScope } : {}),
      durationMs: failedAt - phaseStartedAt,
      totalDurationMs: failedAt - generationStartedAt
    }));
    throw error;
  } finally {
    clearInterval(stallTimer);
  }
}

function generationLogContext(
  job: GenerationExecutionPayload,
  workerId?: string
) {
  return {
    generationJobId: job.id,
    campaignId: job.campaign_id,
    providerProfileId: job.provider_profile_id,
    expectedTurnNumber: job.expected_turn_number,
    operationKind: job.operation_kind,
    jobAttempt: job.attempts,
    ...(workerId ? { workerId } : {})
  };
}

function errorCodeFrom(error: unknown): string | null {
  return typeof error === "object" && error !== null
    && "code" in error && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : null;
}

const RECOVERABLE_INTEGRITY_ERROR_CODES = new Set([
  "authoritative_context_invalid",
  "continuity_review_unavailable",
  "continuity_review_conflict",
  "context_budget_exceeded",
  "context_budget_invalid",
  "continuity_output_budget_exceeded",
  "extension_narration_limit_exceeded",
  "generation_checkpoint_incompatible"
]);

function isRecoverableIntegrityError(error: unknown): error is ContextBudgetError {
  return error instanceof ContextBudgetError
    || (typeof error === "object" && error !== null
      && RECOVERABLE_INTEGRITY_ERROR_CODES.has(errorCodeFrom(error) || ""));
}

function recoverableIntegrityDiagnostic(error: unknown): Readonly<{
  errorCode: string;
  errorMessage: string;
  recoveryMetadata: Record<string, unknown>;
}> {
  const errorCode = errorCodeFrom(error);
  const scope = diagnosticBudgetScope(error);
  const diagnostic = error instanceof ContextBudgetError
    ? projectSafeGenerationDiagnostic({
      code: error.code,
      operation: "story_generation",
      action: error.code === "continuity_output_budget_exceeded"
        ? "adjust_output_or_state"
        : error.code === "extension_narration_limit_exceeded"
          ? "shorten_or_replace_turn"
          : "adjust_context",
      ...(scope ? { scope } : {}),
      ...("protectedComponents" in error ? { protectedComponents: error.protectedComponents } : {}),
      requiredTokens: error.requiredTokens,
      availableTokens: error.availableTokens,
      ...(error.requiredCharacters === undefined ? {} : { requiredCharacters: error.requiredCharacters }),
      ...(error.availableCharacters === undefined ? {} : { availableCharacters: error.availableCharacters }),
      countMode: "estimated",
      estimatorVersion: "story-token-estimate-v1"
    })
    : errorCode === "authoritative_context_invalid"
      ? projectSafeGenerationDiagnostic({ code: errorCode, operation: "story_generation", action: "repair_authority",
        ...((error as { field?: unknown }).field === "canonical_facts" ? { field: "canonical_facts" } : {}) })
      : errorCode === "continuity_review_unavailable" || errorCode === "continuity_review_conflict"
        ? projectSafeGenerationDiagnostic({ code: errorCode, operation: "story_continuity_review", action: "discard_and_reenqueue" })
        : errorCode === "generation_checkpoint_incompatible"
          ? projectSafeGenerationDiagnostic({ code: "prompt_protocol_upgrade_required", operation: "story_generation", action: "discard_and_reenqueue" }) : null;
  return {
    errorCode: RECOVERABLE_INTEGRITY_ERROR_CODES.has(errorCode || "")
      ? errorCode!
      : "context_budget_exceeded",
    errorMessage: "Generation context could not be safely prepared.",
    recoveryMetadata: {
      retryable: true,
      ...(scope ? { budgetScope: scope } : {}),
      ...(diagnostic ? { diagnostic } : {})
    }
  };
}

function safeLogErrorCode(value: unknown, fallback = "unclassified_error"): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  return /^[a-z][a-z0-9_]{0,63}$/.test(normalized) ? normalized : fallback;
}

function failureDiagnosticFor(error: unknown, attemptNumber: number, phase: string): GenerationFailureDiagnostic {
  const transport = providerTransportErrorDetails(error);
  const code = transport
    ? (transport.timedOut ? "provider_request_timeout" : "provider_transport_error")
    : safeLogErrorCode(errorCodeFrom(error) || "generation_failed", "generation_failed");
  const category = code === "provider_request_timeout" ? "provider_timeout"
    : code === "provider_transport_error" ? "provider_transport"
    : code === "mechanics_leak" ? "mechanics"
    : code === "scene_coverage" ? "continuity"
    : code === "invalid_schema" || code === "invalid_json" ? "format"
    : code === "output_limit" ? "output_incomplete"
    : code === "stale_campaign" ? "authority"
    : "unknown";
  const supportedCode = code === "provider_request_timeout" || code === "provider_transport_error"
    || code === "mechanics_leak" || code === "scene_coverage" || code === "invalid_schema"
    || code === "invalid_json" || code === "output_limit" || code === "stale_campaign"
    ? code : "generation_failed";
  return {
    version: 1,
    category,
    code: supportedCode === "invalid_json" ? "invalid_schema" : supportedCode,
    phase,
    attemptNumber,
    occurredAt: new Date().toISOString()
  } as GenerationFailureDiagnostic;
}

function emptyOutputFailureDiagnostic(attemptNumber: number): GenerationFailureDiagnostic {
  return {
    version: 1,
    category: "output_incomplete",
    code: "empty_output",
    phase: "story_validation",
    attemptNumber,
    occurredAt: new Date().toISOString()
  };
}

function rejectedCandidateFailureDiagnostic(
  reason: "invalid_structure" | "output_incomplete" | "mechanics_contamination" | "invalid_choices",
  attemptNumber: number
): GenerationFailureDiagnostic {
  const code = reason === "output_incomplete" ? "output_limit"
    : reason === "mechanics_contamination" ? "mechanics_leak"
    : "invalid_schema";
  return {
    version: 1,
    category: reason === "output_incomplete" ? "output_incomplete"
      : reason === "mechanics_contamination" ? "mechanics" : "format",
    code,
    phase: "story_validation",
    attemptNumber,
    occurredAt: new Date().toISOString()
  };
}

function assertActiveGenerationUpdate(changed: boolean, action: string): void {
  if (!changed) {
    throw Object.assign(new Error(`Generation was cancelled or its lease was lost while ${action}.`), {
      code: "generation_cancelled"
    });
  }
}

function safeTurnInput(value: string): string {
  const trimmed = value.trim();
  const matches = mechanicsLanguageMatches(trimmed);
  if (!trimmed || matches.length) {
    const findings = matches.map((match) => ({
      category: match.category,
      text: match.text,
      index: match.index
    }));
    const findingSummary = findings.length
      ? ` Blocked ${findings.length === 1 ? "fragment" : "fragments"}: ${findings.map((finding) => `"${finding.text}" (${finding.category.replaceAll("_", " ")})`).join(", ")}.`
      : " The input was empty after trimming whitespace.";
    throw Object.assign(new Error(`The turn input contains game-mechanics or engine language that cannot be sent to story generation.${findingSummary} Edit the input and retry; no part of it was silently removed.`), {
      statusCode: 400,
      code: "unsafe_turn_input",
      details: { code: "unsafe_turn_input", findings }
    });
  }
  return trimmed;
}

function recoveryPromptFromSnapshot(
  collaborators: GenerationExecutionCollaborators,
  job: GenerationExecutionPayload,
  reason: "output_limit" | "invalid_json" | "invalid_schema" | "mechanics_leak",
  errors: string[],
  storyLength: StoryLengthWordRange
) {
  if (reason === "output_limit") {
    const compact = compactStoryLengthWordRange(storyLength);
      return renderPromptTemplate(
        collaborators.promptFromSnapshot(job.prompt_snapshot, "story_recovery_output_limit"),
        compact
      );
  }
  if (reason === "mechanics_leak") {
    const details = errors.length
      ? ` The fiction-boundary validator found: ${errors.slice(0, 8).join("; ")}`
      : "";
    return renderPromptTemplate(
      collaborators.promptFromSnapshot(job.prompt_snapshot, "story_recovery_mechanics"),
      { details }
    );
  }
  const detail = errors.length
    ? ` Correct these validation errors: ${errors.slice(0, 8).join("; ")}.`
    : "";
  return renderPromptTemplate(
    collaborators.promptFromSnapshot(job.prompt_snapshot, "story_recovery_schema"),
    { errors: detail }
  );
}

function storyMemoryDefaultsFromContext(context: unknown) {
  if (!context || typeof context !== "object") return {};
  const chronicle = Array.isArray((context as { chronicle?: unknown }).chronicle)
    ? (context as { chronicle: unknown[] }).chronicle
    : [];
  const entries = chronicle.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const memory = entry as { kind?: unknown; ordinal?: unknown; content?: unknown };
    return typeof memory.content === "string"
      ? [{ kind: String(memory.kind || ""), ordinal: Number(memory.ordinal || 0), content: memory.content }]
      : [];
  });
  const latest = (kind: string) => entries
    .filter((entry) => entry.kind === kind)
    .sort((left, right) => right.ordinal - left.ordinal)[0];
  const summary = latest("campaign_summary")?.content.trim();
  const openThreads = latest("open_thread")?.content.split("\n").slice(1)
    .map((line) => line.replace(/^[-•]\s*/, "").trim())
    .filter(Boolean);
  return {
    ...(summary ? { continuitySummary: summary } : {}),
    canonicalFacts: [],
    supersededFacts: [],
    ...(openThreads ? { openThreads } : {})
  };
}

export function sentCanonicalFactIds(storyInput: string): string[] {
  let rendered: unknown;
  try {
    rendered = JSON.parse(storyInput);
  } catch {
    return [];
  }
  if (!rendered || typeof rendered !== "object") return [];
  const authorityFromTrustedInput = (input: unknown): unknown => {
    if (typeof input !== "string") return undefined;
    // LM Studio recovery appends these exact separators. Parse only the original
    // request prefix: a rejected provider draft must never establish authority.
    const original = input.split("\n\nREJECTED RESPONSE TO REWRITE:\n", 1)[0]!
      .split("\n\nRECOVERY REQUIREMENT:\n", 1)[0]!;
    try {
      const parsed = JSON.parse(original) as Record<string, unknown>;
      return parsed;
    } catch {
      return undefined;
    }
  };
  const directAuthority = (rendered as Record<string, unknown>).authoritative_context
    ?? (rendered as Record<string, unknown>).protected_fiction_safe_base_authority;
  const lmStudioAuthority = authorityFromTrustedInput((rendered as Record<string, unknown>).input);
  const messageAuthority = Array.isArray((rendered as { messages?: unknown }).messages)
    ? (rendered as { messages: unknown[] }).messages.flatMap((message) => {
      if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "user") return [];
      const authority = authorityFromTrustedInput((message as { content?: unknown }).content);
      return authority ? [authority] : [];
    })[0]
    : undefined;
  const authority = directAuthority
    || (lmStudioAuthority as { authoritative_context?: unknown; protected_fiction_safe_base_authority?: unknown } | undefined)?.authoritative_context
    || (lmStudioAuthority as { protected_fiction_safe_base_authority?: unknown } | undefined)?.protected_fiction_safe_base_authority
    || (messageAuthority as { authoritative_context?: unknown; protected_fiction_safe_base_authority?: unknown } | undefined)?.authoritative_context
    || (messageAuthority as { protected_fiction_safe_base_authority?: unknown } | undefined)?.protected_fiction_safe_base_authority;
  const repairFactIds = [rendered, lmStudioAuthority, messageAuthority].flatMap((candidate) => {
    const protectedAuthority = candidate && typeof candidate === "object"
      ? (candidate as { protected_authority?: unknown }).protected_authority : undefined;
    return Array.isArray(protectedAuthority) ? protectedAuthority.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as { canonicalFactId?: unknown; form?: unknown };
      // Only complete canonical-fact evidence grants a supersession permission.
      return record.form === "complete" && typeof record.canonicalFactId === "string" ? [record.canonicalFactId] : [];
    }) : [];
  });
  if (!authority || typeof authority !== "object") return [...new Set(repairFactIds)];
  const continuity = (authority as { currentContinuity?: unknown }).currentContinuity;
  const continuityFacts = continuity && typeof continuity === "object"
    ? (continuity as { canonicalFacts?: unknown }).canonicalFacts
    : [];
  const continuityFactIds = Array.isArray(continuityFacts) ? continuityFacts.flatMap((fact) => {
    if (!fact || typeof fact !== "object") return [];
    const id = (fact as { id?: unknown }).id;
    return typeof id === "string" ? [id] : [];
  }) : [];
  const chronicle = (authority as { chronicle?: unknown }).chronicle;
  // Cutoff generation retrieves individual canonical-fact table rows, so a
  // selected canonical candidate ID is that scoped fact UUID; grouped-memory
  // IDs are excluded. Never derive authority by parsing candidate content.
  const selectedHistoricalFactIds = Array.isArray(chronicle) ? chronicle.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as { id?: unknown; kind?: unknown };
    return candidate.kind === "canonical_fact" && typeof candidate.id === "string"
      ? [candidate.id]
      : [];
  }) : [];
  return [...new Set([...continuityFactIds, ...selectedHistoricalFactIds, ...repairFactIds])];
}

function preparedRequestForResult(
  result: ProviderResult,
  provider: GenerationTextProvider,
  request: Pick<ProviderRequest, "systemPrompt" | "input" | "recoveryInput" | "rejectedResponse">
): Readonly<{ body: string; payloadHash: string }> {
  const prepared = result.preparedRequest;
  if (prepared && typeof prepared.body === "string" && typeof prepared.payloadHash === "string"
      && prepared.payloadHash === sha256(prepared.body)) return prepared;
  const body = serializeProviderRequest({ ...provider, baseUrl: "" }, {
    systemPrompt: request.systemPrompt,
    input: request.input,
    ...(request.recoveryInput ? { recoveryInput: request.recoveryInput } : {}),
    ...(request.rejectedResponse ? { completeRejectedDraft: { content: request.rejectedResponse, complete: true as const } } : {})
  }).body;
  return { body, payloadHash: sha256(body) };
}

function choiceRepairPreparedRequest(
  provider: GenerationTextProvider,
  systemPrompt: string,
  base: Omit<StoryTurnOutput, "choices" | "custom_action_suggestion">,
  responseFormat: "json_object" | "none"
): Readonly<{ body: string; payloadHash: string }> {
  const prepared = serializeProviderRequest({ ...provider, baseUrl: "" }, {
    systemPrompt,
    input: buildStoryOnlyChoiceRepairInput(base),
    budgetOutput: { kind: "story_choice_repair" }
  }, { responseFormat: responseFormat === "json_object" });
  return { body: prepared.body, payloadHash: prepared.payloadHash };
}

function repairResponseFormat(body: string): "json_object" | "none" {
  try {
    const payload = JSON.parse(body) as { response_format?: unknown };
    return payload.response_format === undefined ? "none" : "json_object";
  } catch {
    throw new Error("Choice repair request body is not canonical JSON.");
  }
}

function effectiveContextWindowTokens(provider: GenerationTextProvider, job: GenerationExecutionPayload): number {
  return resolveEffectiveContextWindowTokens(provider.contextWindowTokens, job.context_options.modelContextWindowTokens);
}

function effectiveProviderConfigurationHash(provider: GenerationTextProvider, job: GenerationExecutionPayload): string {
  return effectiveProviderConfigurationFingerprint({
    providerId: provider.id, providerType: provider.providerType, model: provider.model,
    endpointIdentity: provider.endpointIdentity ?? "",
    contextWindowTokens: provider.contextWindowTokens, maxOutputTokens: provider.maxOutputTokens,
    temperature: provider.temperature, requestTimeoutMs: provider.requestTimeoutMs,
    configuration: provider.configuration,
    effectiveContextWindowTokens: effectiveContextWindowTokens(provider, job),
    inputSafetyPolicy: "estimated_20_percent_plus_1024"
  });
}

function sameFactIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === new Set(left).size
    && right.length === new Set(right).size
    && left.every((id) => typeof id === "string" && id.length > 0)
    && stableStringify([...left].sort()) === stableStringify([...right].sort());
}

function incrementLogicalAllowance(
  orchestration: GenerationOrchestrationState,
  field: "automaticRepairsConsumed" | "choiceRepairsConsumed" | "eventCoverageRepairsConsumed"
) {
  const current = orchestration.logicalAttempt ?? { version: 1 as const, id: "legacy", semanticRepairsConsumed: 0, reviewsConsumed: 0,
    automaticRepairsConsumed: orchestration.automaticRepair ? 1 : 0, choiceRepairsConsumed: orchestration.choiceRepair ? 1 : 0,
    eventCoverageRepairsConsumed: orchestration.eventCoverageRepair ? 1 : 0 };
  return { ...current, [field]: current[field] + 1 };
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0)
    && value.length === new Set(value).size;
}

function coveragePassed(coverage: ReturnType<typeof parseSceneCoverageOutput> | null): boolean {
  return Boolean(coverage?.covered
    && coverage.missing_required_beats.length === 0
    && coverage.contradictions.length === 0);
}

function eventCoverageRequirement(events: readonly ActivatedEvent[]) {
  return [...new Map(events.map((event) => [event.id, event])).values()]
    .map((event) => ({ id: event.id, fiction: fictionGuidanceForEvents([event]).join(" ") }));
}

function parseRequiredEventCoverage(content: string, events: readonly ActivatedEvent[]) {
  return parseEventCoverageOutput(content, [...new Set(events.map((event) => event.id))]);
}

function compatibleValidatedMainDraft(
  value: GenerationOrchestrationState["validatedMainDraft"] | undefined,
  job: GenerationExecutionPayload,
  provider: GenerationTextProvider,
  storyInput: string,
  semanticRepair?: GenerationOrchestrationState["semanticRepair"],
  generationReview?: GenerationOrchestrationState["generationReview"]
) {
  if (!value) return null;
  const validResponse = value.response && typeof value.response.content === "string"
    && typeof value.response.outputLimited === "boolean";
  const parsedStory = storyTurnOutputSchema.safeParse(value.story);
  const validProvenance = value.version === 2
    && typeof value.providerConfigurationHash === "string" && value.providerConfigurationHash.length > 0
    && typeof value.originalInputHash === "string" && value.originalInputHash.length > 0
    && typeof value.requestBody === "string"
    && typeof value.requestPayloadHash === "string" && value.requestPayloadHash.length > 0
    && typeof value.draftHash === "string" && value.draftHash.length > 0
    && Number.isSafeInteger(value.producingAttempt) && value.producingAttempt > 0
    && isStringList(value.sentFactIds);
  if (!validResponse || !parsedStory.success || !validProvenance) {
    throw Object.assign(new Error("The persisted validated draft checkpoint is malformed."), {
      code: "generation_checkpoint_incompatible"
    });
  }
  const repairedRequest = semanticRepair?.status === "validated"
    && semanticRepair.repairedStoryHash === value.draftHash
    && semanticRepair.repairRequestPayloadHash === value.requestPayloadHash
    && stableStringify(semanticRepair.repairedStory) === stableStringify(parsedStory.data);
  if (value.ownerUserId !== job.owner_user_id
      || value.campaignId !== job.campaign_id
      || value.worldVersionId !== (job.world_version_id || null)
      || stableStringify(value.baseIdentity) !== stableStringify(job.generation_base_identity)
      || value.promptProtocolVersion !== job.prompt_protocol_version
      || (job.generation_policy
        ? value.generationPolicyIdentity !== frozenPolicyIdentity(job)
        : value.generationPolicyIdentity !== undefined)
      || value.providerId !== provider.id
      || value.providerModel !== provider.model
      || value.providerConfigurationHash !== effectiveProviderConfigurationHash(provider, job)
      || value.action !== job.action
      || value.originalInputHash !== sha256(storyInput)
      || value.requestPayloadHash !== sha256(value.requestBody)
      || value.draftHash !== sha256(stableStringify(parsedStory.data))) {
    throw Object.assign(new Error("The persisted validated draft does not match this generation input."), {
      code: "generation_checkpoint_incompatible"
    });
  }
  if (!repairedRequest && value.requestPayloadHash !== sha256(value.requestBody)) {
    throw Object.assign(new Error("The persisted repaired draft request is incompatible."), { code: "generation_checkpoint_incompatible" });
  }
  if (value.factFormatRepair) {
    const review = generationReviewCheckpointSchema.safeParse(generationReview);
    const receipt = review.success ? review.data.decisionJournal.find((entry) => entry.decision === "repair_format"
      && entry.reviewId === value.factFormatRepair!.reviewId && entry.revision === value.factFormatRepair!.revision) : undefined;
    if (!review.success || !receipt || receipt.decision !== "repair_format") {
      throw Object.assign(new Error("The applied fact-format repair has no compatible review receipt."), { code: "generation_checkpoint_incompatible" });
    }
    const repair = receipt.repair;
    if (value.factFormatRepair.planHash !== repair.planHash
      || value.factFormatRepair.rawOutputHash !== repair.plan.rawOutputHash
      || value.factFormatRepair.resultHash !== repair.plan.resultHash
      || value.requestPayloadHash !== repair.producingRequestHash
      || value.response.responseId !== repair.sourceResponseId
      || sha256(value.response.content) !== repair.plan.rawOutputHash
      || canonicalEvidenceJson(parsedStory.data) !== canonicalEvidenceJson(repair.plan.story)) {
      throw Object.assign(new Error("The applied fact-format repair provenance is incompatible."), {
        code: "generation_checkpoint_incompatible"
      });
    }
    if (repair.ownerUserId !== job.owner_user_id
      || repair.campaignId !== job.campaign_id
      || repair.worldVersionId !== (job.world_version_id ?? null)
      || repair.promptProtocolVersion !== job.prompt_protocol_version
      || canonicalEvidenceJson(repair.baseIdentity) !== canonicalEvidenceJson(job.generation_base_identity)
      || receipt.offeredCandidate.ownerUserId !== job.owner_user_id
      || receipt.offeredCandidate.campaignId !== job.campaign_id
      || receipt.offeredCandidate.worldId !== job.world_id
      || receipt.offeredCandidate.worldVersionId !== (job.world_version_id ?? null)
      || receipt.offeredCandidate.expectedTurnNumber !== job.expected_turn_number
      || receipt.offeredCandidate.provider.profileId !== job.provider_profile_id
      || receipt.offeredCandidate.protocol.version !== job.prompt_protocol_version
      || canonicalEvidenceJson(receipt.offeredCandidate.baseIdentity) !== canonicalEvidenceJson(job.generation_base_identity)) {
      throw Object.assign(new Error("The applied fact-format repair is not bound to this generation job."), {
        code: "generation_checkpoint_incompatible"
      });
    }
  }
  if (!sameFactIds(value.sentFactIds, sentCanonicalFactIds(value.requestBody))) {
    throw Object.assign(new Error("The persisted validated draft fact visibility does not match its producing request."), {
      code: "generation_checkpoint_incompatible"
    });
  }
  return { ...value, story: parsedStory.data };
}

function compatibleEventCoverageRepair(
  repair: GenerationOrchestrationState["eventCoverageRepair"] | undefined,
  validatedDraft: ReturnType<typeof compatibleValidatedMainDraft>,
  extension: GenerationOrchestrationState["extension"] | undefined,
): boolean {
  if (!repair) return true;
  return validatedDraft !== null
    && (repair.validatedMainDraftHash === validatedDraft.draftHash
      || repair.repairedFinalStoryHash === validatedDraft.draftHash)
    && repair.extensionFinalStoryHash === (extension?.finalStoryHash || null)
    && repair.extensionProducingAttempt === (extension?.producingAttempt || null)
    && (!extension || (extension.finalStoryHash === stableStringify(extension.story)
      && extension.validatedMainDraftHash === validatedDraft.draftHash
      && typeof extension.producingRequestPayloadHash === "string"
      && extension.producingRequestPayloadHash.length > 0
      && typeof extension.producingRequestBody === "string"
      && extension.producingRequestPayloadHash === sha256(extension.producingRequestBody)
      && isStringList(extension.sentFactIds)
      && sameFactIds(extension.sentFactIds, sentCanonicalFactIds(extension.producingRequestBody))));
}

const NO_RETRIEVAL_AUDIT: ChronicleRetrievalAudit = {
  auditVersion: "chronicle-retrieval-audit-v1",
  configuredImplementation: "legacy_hybrid",
  effectiveImplementation: "legacy_hybrid",
  effectiveMode: "lexical_only",
  fallbackCode: "empty_query",
  provider: { resolutionSource: "none", resolvedRole: null, providerType: null, model: null },
  queryVectorPath: "none",
  providerCallOutcome: "not_attempted",
  queryEmbeddingRequests: 0,
  queryCacheHits: 0,
  queryCacheMisses: 0
};

function snapshottedStoryLength(context: GenerationExecutionPayload["context_options"]): StoryLengthWordRange {
  const profile = storyLengthProfileFromUnknown(context.storyLengthProfile);
  const fallback = storyLengthWordRange(profile);
  const minWords = Number(context.narrationMinWords);
  const maxWords = Number(context.narrationMaxWords);
  if (!Number.isInteger(minWords) || !Number.isInteger(maxWords)
      || minWords < 100 || maxWords > 10_000 || minWords > maxWords) {
    return fallback;
  }
  return { profile, minWords, maxWords };
}

async function persistOrchestration(
  repository: GenerationExecutionRepository,
  scope: GenerationLeaseScope,
  job: GenerationExecutionPayload,
  patch: Partial<GenerationOrchestrationState>
): Promise<GenerationOrchestrationState> {
  const merged = { ...(job.orchestration_private || {}), ...patch };
  assertActiveGenerationUpdate(
    await repository.saveOrchestration(scope, merged),
    "persisting private orchestration"
  );
  job.orchestration_private = merged;
  return merged;
}

async function callCampaignTextProvider(
  dependencies: GenerationExecutorDependencies,
  provider: GenerationTextProvider,
  job: GenerationExecutionPayload,
  operation: StoryCostOperation,
  request: ProviderRequest
) {
  const startedAt = Date.now();
  logger.info({
    event: "turn_generation_provider_started",
    ...generationLogContext(job),
    storyOperation: operation,
    providerType: provider.providerType,
    requestedModel: provider.model,
    streaming: typeof request.onChunk === "function",
    recovery: Boolean(request.recoveryInput)
  });
  try {
    dependencies.collaborators.onProviderDispatch?.(operation);
    const result = await provider.execute({
      ...request,
      // Every generation operation is serialized and checked before transport.
      // The transport adapter sends these prepared bytes without rebuilding them.
      canonicalBudgeting: true,
      effectiveContextWindowTokens: effectiveContextWindowTokens(provider, job)
    });
    await dependencies.collaborators.recordProfileCost(
      dependencies.pool,
      provider,
      {
        ownerUserId: job.owner_user_id,
        campaignId: job.campaign_id,
        generationJobId: job.id,
        category: "story",
        operation
      },
      result
    );
    logger.info({
      event: "turn_generation_provider_completed",
      ...generationLogContext(job),
      storyOperation: operation,
      providerType: provider.providerType,
      requestedModel: provider.model,
      streaming: typeof request.onChunk === "function",
      recovery: Boolean(request.recoveryInput),
      providerResponseId: result.responseId || null,
      finishReason: result.finishReason || null,
      outputLimited: result.outputLimited,
      modelInstanceId: result.modelInstanceId || null,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
      durationMs: Date.now() - startedAt
    });
    return result;
  } catch (error) {
    logProviderTransportError(error, {
      generationJobId: job.id,
      campaignId: job.campaign_id,
      providerProfileId: job.provider_profile_id,
      storyOperation: operation
    });
    const transportError = providerTransportErrorDetails(error);
    const rawErrorCode = transportError
      ? (transportError.timedOut ? "provider_request_timeout" : "provider_transport_error")
      : errorCodeFrom(error);
    const errorCode = rawErrorCode ? safeLogErrorCode(rawErrorCode) : null;
    const budgetScope = diagnosticBudgetScope(error);
    logger.warn({
      event: "turn_generation_provider_failed",
      ...generationLogContext(job),
      storyOperation: operation,
      streaming: typeof request.onChunk === "function",
      recovery: Boolean(request.recoveryInput),
      errorName: error instanceof Error ? error.name : "Error",
      ...(errorCode ? { errorCode } : {}),
      ...(budgetScope ? { budgetScope } : {}),
      ...(transportError ? { providerCategory: transportError.causeCategory } : {}),
      transportTimedOut: Boolean(transportError?.timedOut),
      durationMs: Date.now() - startedAt
    });
    throw error;
  }
}

async function evaluateTriggers(
  dependencies: GenerationExecutorDependencies,
  provider: GenerationTextProvider,
  phase: "before" | "after",
  context: unknown,
  job: GenerationExecutionPayload,
  triggers: PlayerEventTrigger[],
  narration = ""
): Promise<ActivatedEvent[]> {
  if (!triggers.length) return [];
  const response = await callCampaignTextProvider(
    dependencies,
    provider,
    job,
    phase === "before" ? "event_trigger_before" : "event_trigger_after",
    {
      systemPrompt: dependencies.collaborators.promptFromSnapshot(job.prompt_snapshot, "event_trigger"),
      input: buildEventTriggerPrompt(
        phase,
        context,
        job.action,
        job.expected_turn_number,
        triggers,
        narration
      )
    }
  );
  if (response.outputLimited) throw new Error("The private event evaluation reached its output limit.");
  return activatedEventsFromResponse(response.content, triggers, job.expected_turn_number);
}

export function createGenerationExecutor(
  dependencies: GenerationExecutorDependencies
): GenerationExecutor {
  return {
    async execute(request) {
      const job = await dependencies.repository.loadExecutionPayload(request);
      if (!job) return false;
      return executeLoadedGeneration(dependencies, request.workerId, request.leaseSeconds, job);
    }
  };
}

async function executeLoadedGeneration(
  dependencies: GenerationExecutorDependencies,
  workerId: string,
  leaseSeconds: number,
  job: GenerationExecutionPayload
): Promise<boolean> {
  const { repository, collaborators, pool } = dependencies;
  const scope = { jobId: job.id, ownerUserId: job.owner_user_id, workerId };
  const generationStartedAt = Date.now();
  const diagnosticContext: TurnGenerationDiagnosticContext = {
    generationJobId: job.id,
    campaignId: job.campaign_id,
    providerProfileId: job.provider_profile_id,
    expectedTurnNumber: job.expected_turn_number,
    operationKind: job.operation_kind,
    jobAttempt: job.attempts,
    workerId
  };
  let activePhase: TurnGenerationPhase = "orchestration_loading";
  const phase = <T>(phaseName: TurnGenerationPhase, operation: () => Promise<T>) => {
    activePhase = phaseName;
    return runTurnGenerationPhase(diagnosticContext, phaseName, generationStartedAt, operation);
  };
  const frozenStoryMemoryPolicy = job.context_options && typeof job.context_options === "object" && "storyMemoryPolicy" in job.context_options
    ? storyMemoryPolicySnapshotSchema.safeParse((job.context_options as Record<string, unknown>).storyMemoryPolicy)
    : null;
  const frozenStoryMemoryPolicySnapshot = frozenStoryMemoryPolicy?.success
    ? frozenStoryMemoryPolicy.data
    : null;
  if (frozenStoryMemoryPolicy && !frozenStoryMemoryPolicy.success) {
    assertActiveGenerationUpdate(await repository.markRecoverable({
      jobId: job.id, ownerUserId: job.owner_user_id, workerId, providerResponseId: null, providerFinishReason: null,
      errorCode: frozenStoryMemoryPolicy.success ? "story_memory_policy_worker_incompatible" : "story_memory_policy_invalid",
      errorMessage: "Saved Story Memory policy requires a compatible worker.",
      recoveryMetadata: { reason: "story_memory_policy_worker_incompatible", diagnostic: {
        code: "prompt_protocol_upgrade_required", operation: "story_generation", action: "discard_and_reenqueue"
      } }
    }), "saving incompatible Story Memory policy recovery state");
    return false;
  }
  const frozenPromptEnvelope = job.prompt_snapshot;
  const reviewMode = frozenStoryMemoryPolicySnapshot?.policy.continuityReview ?? "off";
  let promptSnapshot: ReturnType<typeof readPromptSnapshot>;
  try {
    // Once R1 enables this route, the worker validates only the bytes and
    // acknowledgement frozen on this job. It never re-reads mutable prompt
    // overrides while executing or reclaiming a lease.
    promptSnapshot = frozenStoryMemoryPolicySnapshot
      ? assertStoryMemoryPromptCompatibility(job.prompt_snapshot)
      : assertStoryPromptCompatibility(job.prompt_snapshot);
    if (frozenStoryMemoryPolicySnapshot) {
      const proof = promptSnapshot.storyMemoryCompatibility;
      const expectedPrefix = `${frozenStoryMemoryPolicySnapshot.promptProtocol}|`;
      // Pre-proof v14 shipped snapshots are the only compatible proof-less form.
      if ((proof && !proof.protocolIdentity.startsWith(expectedPrefix))
        || (!proof && frozenStoryMemoryPolicySnapshot.promptProtocol !== "story-v14-continuity-context")) {
        throw new Error("Frozen Story Memory policy and prompt acknowledgement disagree.");
      }
    }
    if (frozenStoryMemoryPolicySnapshot) assertContinuityReviewPromptSnapshot(promptSnapshot, reviewMode);
    // Every downstream prompt use reads the one normalized frozen envelope.
    job = { ...job, prompt_snapshot: promptSnapshot.templates as PromptSnapshot };
  } catch {
    assertActiveGenerationUpdate(await repository.markRecoverable({
      jobId: job.id,
      ownerUserId: job.owner_user_id,
      workerId,
      providerResponseId: null,
      providerFinishReason: null,
      errorCode: "generation_prompt_snapshot_invalid",
      errorMessage: "Saved generation instructions are invalid.",
      recoveryMetadata: { reason: "generation_prompt_snapshot_invalid", diagnostic: {
        code: "prompt_protocol_upgrade_required", operation: "story_generation", action: "discard_and_reenqueue"
      } }
    }), "saving invalid prompt snapshot recovery state");
    return false;
  }
  if (frozenStoryMemoryPolicySnapshot?.promptProtocol === "story-v14-continuity-context") {
    assertActiveGenerationUpdate(await repository.markRecoverable({
      jobId: job.id,
      ownerUserId: job.owner_user_id,
      workerId,
      providerResponseId: null,
      providerFinishReason: null,
      errorCode: "generation_prompt_snapshot_invalid",
      errorMessage: "Saved generation instructions require a newer protocol.",
      recoveryMetadata: { reason: "generation_prompt_snapshot_invalid", diagnostic: {
        code: "prompt_protocol_upgrade_required", operation: "story_generation", action: "discard_and_reenqueue"
      } }
    }), "saving legacy prompt protocol recovery state");
    return false;
  }
  const parsedGenerationPolicy = job.generation_policy === null
    ? null
    : generationPolicySnapshotSchema.safeParse(job.generation_policy);
  if (parsedGenerationPolicy !== null && !parsedGenerationPolicy.success) {
    assertActiveGenerationUpdate(await repository.markRecoverable({
      jobId: job.id,
      ownerUserId: job.owner_user_id,
      workerId,
      providerResponseId: null,
      providerFinishReason: null,
      errorCode: "generation_policy_invalid",
      errorMessage: "Saved generation policy is invalid.",
      recoveryMetadata: { reason: "generation_policy_invalid", retryable: true }
    }), "saving invalid generation policy recovery state");
    return false;
  }
  const generationPolicy = parsedGenerationPolicy === null ? null : parsedGenerationPolicy.data;
  const hasFrozenStoryMemoryPolicy = frozenStoryMemoryPolicySnapshot !== null;
  const frozenStoryPromptContractProtocol = hasFrozenStoryMemoryPolicy
    ? undefined
    : promptSnapshot.storyPromptCompatibility?.protocolIdentity;
  const storySystemContractProtocol = frozenStoryPromptContractProtocol
    && promptSnapshot.template("story_system").source !== "shipped"
    ? frozenStoryPromptContractProtocol
    : undefined;
  const storyOnlyChoiceRepairSystemPrompt = generationPolicy?.playMode === "story_only"
    ? composeStoryOnlyChoiceRepairSystemPrompt(
      generationPolicy.prompts.choiceRepairSystem,
      hasFrozenStoryMemoryPolicy,
      frozenStoryMemoryPolicySnapshot?.promptProtocol,
      frozenStoryPromptContractProtocol
    )
    : null;
  const stages = generationStagePolicy(generationPolicy?.playMode ?? "legacy");
  let frozenGenerationPolicyIdentity: string | null = null;
  let expectedExecutionProtocol: string | null = null;
  try {
    frozenGenerationPolicyIdentity = generationPolicy ? generationPolicyIdentity(generationPolicy) : null;
    const basePromptProtocol = providerPromptProtocolVersion(promptSnapshot.templates as PromptSnapshot);
    const legacyExecutionProtocol = generationPolicy
      ? generationExecutionProtocolIdentity(basePromptProtocol, generationPolicy) : basePromptProtocol;
    expectedExecutionProtocol = hasFrozenStoryMemoryPolicy
      ? `story-memory-v1|${legacyExecutionProtocol}`
      : frozenStoryPromptContractProtocol
        ? `story-prompt-v1|${frozenStoryPromptContractProtocol}|${legacyExecutionProtocol}`
        : legacyExecutionProtocol;
  } catch {
    assertActiveGenerationUpdate(await repository.markRecoverable({
      jobId: job.id,
      ownerUserId: job.owner_user_id,
      workerId,
      providerResponseId: null,
      providerFinishReason: null,
      errorCode: "generation_policy_invalid",
      errorMessage: "Saved Story Direction instructions no longer match their frozen hash.",
      recoveryMetadata: { reason: "generation_policy_invalid", retryable: true }
    }), "saving invalid generation policy recovery state");
    return false;
  }
  if ((generationPolicy || hasFrozenStoryMemoryPolicy) && expectedExecutionProtocol !== job.prompt_protocol_version) {
    assertActiveGenerationUpdate(await repository.markRecoverable({
      jobId: job.id,
      ownerUserId: job.owner_user_id,
      workerId,
      providerResponseId: null,
      providerFinishReason: null,
      errorCode: "generation_prompt_snapshot_invalid",
      errorMessage: "Saved generation instructions require a newer protocol.",
      recoveryMetadata: { reason: "generation_prompt_snapshot_invalid", diagnostic: {
        code: "prompt_protocol_upgrade_required", operation: "story_generation", action: "discard_and_reenqueue"
      } }
    }), "saving incompatible prompt protocol recovery state");
    return false;
  }
  logger.info({
    event: "turn_generation_started",
    ...generationLogContext(job, workerId)
  });
  const heartbeat = setInterval(() => {
    void repository.renewLease(scope, leaseSeconds).catch(() => undefined);
  }, Math.max(5000, Math.floor(leaseSeconds * 1000 / 3)));

  try {
    const savedReview = generationReviewCheckpointSchema.safeParse(job.orchestration_private.generationReview);
    const keepReceipt = savedReview.success && savedReview.data.state === "decided"
      && savedReview.data.stage === "continuity" && savedReview.data.candidateScope === "final"
      ? savedReview.data.decisionJournal.find((entry) => entry.reviewId === savedReview.data.reviewId
          && entry.revision === savedReview.data.revision - 1 && entry.decision === "keep")
      : undefined;
    if (keepReceipt && savedReview.success) {
      const candidate = savedReview.data.gateCandidate;
      const frozen = candidate.resumeDependencies.frozenCommitInputs;
      const generation = candidate.resumeDependencies.generationContext;
      const providerDescriptor = frozen.provider;
      const response = candidate.resumeDependencies.producingProviderResult;
      const frozenOrchestration = frozen.orchestration;
      const frozenInputs = frozen.inputs;
      const frozenSentFactIds = frozen.finalSentFactIds;
      const story = storyTurnOutputSchema.parse(candidate.story);
      if (candidate.ownerUserId !== job.owner_user_id || candidate.campaignId !== job.campaign_id
          || candidate.worldId !== job.world_id || candidate.worldVersionId !== (job.world_version_id || null)
          || canonicalEvidenceJson(candidate.baseIdentity) !== canonicalEvidenceJson(job.generation_base_identity)
          || candidate.protocol.version !== job.prompt_protocol_version
          || candidate.protocol.promptHash !== promptSnapshot.continuityReview?.review.hash
          || candidate.policyHash !== frozenStoryMemoryPolicySnapshot?.policyHash
          || candidate.storyHash !== sha256(canonicalEvidenceJson(story))
          || mechanicsLeakFields(story).length
          || !providerDescriptor || typeof providerDescriptor !== "object" || typeof (providerDescriptor as { id?: unknown }).id !== "string"
          || typeof (providerDescriptor as { providerType?: unknown }).providerType !== "string" || typeof (providerDescriptor as { model?: unknown }).model !== "string"
          || !response || typeof response !== "object" || typeof (response as { content?: unknown }).content !== "string"
          || typeof (response as { outputLimited?: unknown }).outputLimited !== "boolean"
          || !frozenOrchestration || typeof frozenOrchestration !== "object" || !frozenInputs || typeof frozenInputs !== "object"
          || !Array.isArray(frozenSentFactIds) || typeof frozen.fictionAction !== "string"
          || typeof generation.contextFingerprint !== "string" || !generation.contextDiagnostics || typeof generation.contextDiagnostics !== "object") {
        throw Object.assign(new Error("The final Keep receipt has incompatible frozen execution inputs."), { code: "generation_checkpoint_incompatible" });
      }
      const chronicleRetrieval = chronicleRetrievalAuditSchema.parse(generation.chronicleRetrieval);
      assertActiveGenerationUpdate(await repository.markGenerating(scope), "resuming final Keep generation state");
      assertActiveGenerationUpdate(await repository.markValidating(scope), "resuming final Keep validation");
      assertActiveGenerationUpdate(await repository.markCommitting(scope), "resuming final Keep commit");
      const { turnId } = await phase("turn_commit", () => repository.commitAcceptedTurn({
        scope, job, story,
        provider: providerDescriptor as { id: string; providerType: string; model: string },
        response: response as ProviderResult,
        contextFingerprint: generation.contextFingerprint as string,
        contextDiagnostics: generation.contextDiagnostics as Record<string, unknown>,
        sentFactIds: frozenSentFactIds as string[], chronicleRetrieval,
        inputs: frozenInputs as GenerationExecutionPayload["orchestration_inputs"],
        orchestration: frozenOrchestration as GenerationOrchestrationState,
        fictionAction: frozen.fictionAction as string,
        collaborators: { memory: collaborators.memory, illustration: collaborators.illustration,
          attributeGenerationCostsToTurn: collaborators.attributeGenerationCostsToTurn },
        onIllustrationEnqueueError(error, acceptedTurnId) {
          logger.warn({ event: "accepted_turn_illustration_enqueue_failed", generationJobId: job.id, campaignId: job.campaign_id,
            turnId: acceptedTurnId, errorMessage: error instanceof Error ? error.message : String(error) });
        }
      }));
      logger.info({ event: "turn_generation_completed", ...generationLogContext(job, workerId), resultTurnId: turnId,
        providerResponseId: (response as ProviderResult).responseId || null, finishReason: (response as ProviderResult).finishReason || null });
      return true;
    }
    const provider = await phase("provider_loading", () => collaborators.loadTextExecution(
      job.owner_user_id,
      job.provider_profile_id,
      job.requested_model
    ));

    if (frozenStoryMemoryPolicySnapshot && effectiveProviderConfigurationHash(provider, job) !== frozenStoryMemoryPolicySnapshot.providerConfigurationFingerprint) {
      assertActiveGenerationUpdate(await repository.markRecoverable({ ...scope, providerResponseId: null, providerFinishReason: null,
        errorCode: "generation_checkpoint_incompatible", errorMessage: "The provider configuration changed after this job was queued.",
        recoveryMetadata: { reason: "provider_configuration_changed", diagnostic: {
          code: "prompt_protocol_upgrade_required", operation: "story_generation", action: "discard_and_reenqueue"
        } }
      }), "saving changed provider configuration");
      return false;
    }

    if (reviewMode !== "off" && job.streaming_segments_state?.provisionalSetId) {
      assertActiveGenerationUpdate(await repository.markRecoverable({ ...scope, providerResponseId: null, providerFinishReason: null,
        errorCode: "generation_checkpoint_incompatible", errorMessage: "Saved provisional artwork predates the required review gate.",
        recoveryMetadata: { diagnostic: { code: "prompt_protocol_upgrade_required", operation: "story_generation", action: "discard_and_reenqueue" } }
      }), "rejecting incompatible provisional artwork");
      return true;
    }
    const preparedInput = await phase("input_preparation", async () => {
      const safeAction = safeTurnInput(job.action);
      const storyLength = snapshottedStoryLength(job.context_options);
      const effectiveContextWindow = effectiveContextWindowTokens(provider, job);
      const inputTokenLimit = effectiveContextWindow - provider.maxOutputTokens;
      const emptyPromptContext = { worldCanon: {}, campaignCanon: {}, chronicle: [], currentScene: null };
      const baseStorySystemPrompt = collaborators.promptFromSnapshot(job.prompt_snapshot, "story_system");
      const storySystemPrompt = generationPolicy?.playMode === "story_only"
        ? composeStoryOnlySystemPrompt(
          baseStorySystemPrompt,
          generationPolicy,
          hasFrozenStoryMemoryPolicy,
          frozenStoryMemoryPolicySnapshot?.promptProtocol,
          storySystemContractProtocol
        )
        : hasFrozenStoryMemoryPolicy
          ? composeStoryMemorySystemPrompt(baseStorySystemPrompt, "", frozenStoryMemoryPolicySnapshot.promptProtocol)
          : storySystemContractProtocol
            ? composeStoryPromptSystemPrompt(baseStorySystemPrompt, storySystemContractProtocol)
            : baseStorySystemPrompt;
      const fixedPromptEnvelope = estimateStoryTokens(storySystemPrompt)
        + estimateStoryTokens((hasFrozenStoryMemoryPolicy ? buildStoryMemoryUserPrompt : buildStoryUserPrompt)(
          emptyPromptContext,
          safeAction,
          false,
          [],
          storyLength,
          job.resolved_input_mode
        ))
        + 1024;
      if (inputTokenLimit - fixedPromptEnvelope < 512) {
        throw Object.assign(new Error(
          `The provider context window (${effectiveContextWindow}) cannot fit the configured output reserve (${provider.maxOutputTokens}) and story prompt envelope.`
        ), { code: "context_budget_invalid" });
      }
      const configuredCampaignContextBudget = Number(job.context_options.budgetTokens || 32000);
      const safeContextBudget = Math.max(512, Math.min(
        configuredCampaignContextBudget,
        inputTokenLimit - fixedPromptEnvelope
      ));
      return {
        safeAction,
        storyLength,
        effectiveContextWindow,
        inputTokenLimit,
        storySystemPrompt,
        configuredCampaignContextBudget,
        safeContextBudget
      };
    });
    const {
      safeAction,
      storyLength,
      effectiveContextWindow,
      inputTokenLimit,
      storySystemPrompt,
      configuredCampaignContextBudget,
      safeContextBudget
    } = preparedInput;

    // The authority read owns both scope verification and ranked candidates.
    // Do not select or mutate a public preview for provider work.
    const generationContext = await phase("context_retrieval", () => collaborators.memory.loadGenerationContext(
      pool,
      {
        ownerUserId: job.owner_user_id,
        campaignId: job.campaign_id,
        worldVersionId: job.world_version_id ?? "",
        operationKind: job.operation_kind,
        expectedTurnNumber: job.expected_turn_number,
        query: safeAction,
        retrievalBudgetTokens: safeContextBudget,
        expectedBaseIdentity: job.generation_base_identity,
        ...(hasFrozenStoryMemoryPolicy ? { storyMemoryPolicy: frozenStoryMemoryPolicySnapshot } : {})
      }
    ));
    const chronicleRetrieval = chronicleRetrievalAuditSchema.parse(
      generationContext.chronicleRetrieval ?? NO_RETRIEVAL_AUDIT
    );
    let promptContext: Record<string, unknown> & { chronicle: readonly PromptCandidate[] } = {
      authoritativeRules: Array.isArray(generationContext.authority.rules) ? generationContext.authority.rules : [],
      worldCanon: generationContext.authority.worldCanon ?? {},
      selectedCharacterId: generationContext.authority.selectedCharacterId ?? null,
      currentContinuity: generationContext.authority.currentContinuity ?? {},
      currentScene: generationContext.authority.latestTurn ?? null,
      chronicle: []
    };
    const inputs = await phase("orchestration_loading", async () => job.orchestration_inputs);
    let orchestration = job.orchestration_private || {};

    // A review retry is the only authority to replace an unusable primary
    // response.  Drop the immutable capture only after the decision has been
    // recorded, so a reclaim before this point still resumes the original.
    const structureRetryReceipt = savedReview.success && savedReview.data.state === "decided"
      && savedReview.data.stage === "structure" && savedReview.data.candidateScope === "main"
      ? savedReview.data.decisionJournal.find((entry) => entry.decision === "retry"
          && entry.reviewId === savedReview.data.reviewId && entry.revision === savedReview.data.revision - 1
          && entry.nextStage === "structure" && entry.candidateHash === savedReview.data.gateCandidate.storyHash)
      : undefined;
    const choiceRetryReceipt = savedReview.success && savedReview.data.state === "decided"
      && savedReview.data.stage === "choices" && savedReview.data.candidateScope === "main"
      ? savedReview.data.decisionJournal.find((entry) => entry.decision === "retry"
          && entry.reviewId === savedReview.data.reviewId && entry.revision === savedReview.data.revision - 1
          && entry.nextStage === "choices" && entry.candidateHash === savedReview.data.gateCandidate.storyHash)
      : undefined;
    const sceneKeepReceipt = savedReview.success && savedReview.data.state === "decided"
      && savedReview.data.stage === "scene_coverage" && savedReview.data.candidateScope === "main"
      ? savedReview.data.decisionJournal.find((entry) => entry.decision === "keep"
          && entry.reviewId === savedReview.data.reviewId && entry.revision === savedReview.data.revision - 1
          && entry.nextStage === null && entry.candidateHash === savedReview.data.gateCandidate.storyHash)
      : undefined;
    const sceneRetryReceipt = savedReview.success && savedReview.data.state === "decided"
      && savedReview.data.stage === "scene_coverage" && savedReview.data.candidateScope === "main"
      ? savedReview.data.decisionJournal.find((entry) => entry.decision === "retry"
          && entry.reviewId === savedReview.data.reviewId && entry.revision === savedReview.data.revision - 1
          && entry.nextStage === "scene_coverage" && entry.candidateHash === savedReview.data.gateCandidate.storyHash)
      : undefined;
    const eventRetryReceipt = savedReview.success && savedReview.data.state === "decided"
      && savedReview.data.stage === "event_coverage"
      ? savedReview.data.decisionJournal.find((entry) => entry.decision === "retry"
          && entry.reviewId === savedReview.data.reviewId && entry.revision === savedReview.data.revision - 1
          && entry.nextStage === "event_coverage" && entry.candidateHash === savedReview.data.gateCandidate.storyHash)
      : undefined;
    const reofferFailedAuthorizedRetry = async (
      stage: "structure" | "choices" | "scene_coverage" | "event_coverage" | "continuity",
      retryFailure: string
    ): Promise<boolean> => {
      if (!savedReview.success || savedReview.data.state !== "decided"
          || savedReview.data.stage !== stage) return false;
      const receipt = savedReview.data.decisionJournal.find((entry) => entry.decision === "retry"
        && entry.reviewId === savedReview.data.reviewId
        && entry.revision === savedReview.data.revision - 1
        && entry.nextStage === stage
        && entry.candidateHash === savedReview.data.gateCandidate.storyHash);
      if (!receipt) return false;
      const gate = prepareGenerationReview({
        candidate: savedReview.data.gateCandidate,
        stage,
        reasons: savedReview.data.originalFindings,
        operationKind: job.operation_kind,
        replacementTurnId: job.replacement_turn_id,
        eligibility: { ...savedReview.data.eligibility, retryAvailable: false },
        originalCandidate: savedReview.data.originalCandidate,
        originalFindings: savedReview.data.originalFindings,
        decisionJournal: savedReview.data.decisionJournal,
        revision: savedReview.data.revision + 1,
        retryFailure
      });
      assertActiveGenerationUpdate(await repository.pauseForReview(scope, gate), "re-offering the original candidate after an authorized repair failed");
      return true;
    };
    if (structureRetryReceipt) {
      orchestration = await persistOrchestration(repository, scope, job, {
        primaryResult: undefined,
        primaryReservation: undefined,
        automaticRepair: undefined
      });
    }

    if (!stages.allowEventEvaluation && (
      orchestration.roll !== undefined
      || orchestration.beforeEvents !== undefined
      || orchestration.afterEvents !== undefined
      || orchestration.extension !== undefined
      || orchestration.eventCoverageRepair !== undefined
    )) {
      assertActiveGenerationUpdate(await repository.markRecoverable({
        ...scope,
        providerResponseId: null,
        providerFinishReason: null,
        errorCode: "generation_checkpoint_incompatible",
        errorMessage: "The saved mechanical checkpoint is incompatible with the frozen Story Direction policy.",
        recoveryMetadata: { retryable: true, stage: "mechanics", reason: "story_only_mechanics_checkpoint" }
      }), "saving incompatible Story Direction mechanical checkpoint state");
      return true;
    }

    if (stages.allowRpgAssessment && orchestration.roll === undefined) {
      await phase("rpg_assessment", async () => {
        if (job.resolved_input_mode === "action" && inputs.useRpgStats
            && job.expected_turn_number > 1 && inputs.rpgStats.length) {
          let assessment;
          let assessmentError = "";
          try {
            const response = await callCampaignTextProvider(
              dependencies,
              provider,
              job,
              "rpg_assessment",
              {
                systemPrompt: collaborators.promptFromSnapshot(job.prompt_snapshot, "rpg_assessment"),
                input: buildRpgAssessmentPrompt(promptContext, job.action, inputs.rpgStats)
              }
            );
            if (response.outputLimited) throw new Error("The private RPG assessment reached its output limit.");
            assessment = parseRpgAssessment(response.content);
          } catch (error) {
            if (isRecoverableIntegrityError(error)) throw error;
            assessmentError = error instanceof Error ? error.message : String(error);
            assessment = localRpgAssessment(job.action, inputs.rpgStats);
          }
          orchestration = await persistOrchestration(repository, scope, job, {
            roll: performPrivateRoll(assessment, inputs.rpgStats),
            ...(assessmentError ? { rpgAssessmentError: assessmentError.slice(0, 2000) } : {})
          });
        } else {
          orchestration = await persistOrchestration(repository, scope, job, { roll: null });
        }
      });
    }
    if (stages.allowEventEvaluation && orchestration.beforeEvents === undefined) {
      await phase("before_event_evaluation", async () => {
        let activated: ActivatedEvent[] = [];
        let triggerError = "";
        if (!inputs.suppressEventTriggers) {
          const pendingTriggerIds = new Set(inputs.pendingEventTriggers.map((event) => event.sourceTriggerId));
          const triggers = inputs.eventTriggers.filter((trigger) => trigger.timing === "before" && !pendingTriggerIds.has(trigger.id));
          try {
            activated = await evaluateTriggers(
              dependencies,
              provider,
              "before",
              promptContext,
              job,
              triggers
            );
          } catch (error) {
            if (isRecoverableIntegrityError(error)) throw error;
            triggerError = error instanceof Error ? error.message : String(error);
          }
        }
        orchestration = await persistOrchestration(repository, scope, job, {
          beforeEvents: [...inputs.pendingEventTriggers, ...activated],
          ...(triggerError ? { beforeTriggerError: triggerError.slice(0, 2000) } : {})
        });
      });
    }

    const promptPreparation = await phase("prompt_preparation", async () => {
      const safeGuidance = [
        ...(stages.allowRpgAssessment ? fictionGuidanceForRoll(orchestration.roll || null) : []),
        ...(stages.allowEventEvaluation ? fictionGuidanceForEvents(orchestration.beforeEvents || []) : [])
      ].filter((entry) => entry && !containsMechanicsLanguage(entry));
      assertActiveGenerationUpdate(await repository.markGenerating(scope), "entering generation");
      const planned = planGenerationPromptContext(
        generationContext, provider, storySystemPrompt, safeAction, safeGuidance,
        storyLength, job.resolved_input_mode, configuredCampaignContextBudget, inputTokenLimit,
        isGenerationBaseIdentityV3(generationContext.baseIdentity) ? job.id : undefined,
        hasFrozenStoryMemoryPolicy ? "story_memory" : "legacy",
        frozenStoryMemoryPolicySnapshot?.policy
      );
      promptContext = planned.promptContext;
      const { storyInput, contextPlan } = planned;
      const contextFingerprint = generationContextFingerprint({ providerId: provider.id, model: provider.model,
        ...(frozenStoryMemoryPolicySnapshot ? { storyMemoryPolicyIdentity: `${frozenStoryMemoryPolicySnapshot.policyHash}|${frozenStoryMemoryPolicySnapshot.providerConfigurationFingerprint}` } : {}),
        protocol: job.prompt_protocol_version, ...(frozenGenerationPolicyIdentity ? { generationPolicyIdentity: frozenGenerationPolicyIdentity } : {}), expectedTurnNumber: job.expected_turn_number,
        action: safeAction, inputMode: job.resolved_input_mode, storyLength, context: promptContext });
      const contextDiagnostics = {
        countMode: "estimated",
        estimatorVersion: "story-token-estimate-v1",
        effectiveContextWindow,
        inputTokenLimit,
        reservedOutputTokens: provider.maxOutputTokens,
        estimatedPromptTokens: contextPlan.requestTokens,
        campaignId: job.campaign_id,
        worldVersionId: job.world_version_id ?? "",
        selectedCharacterId: generationContext.authority.selectedCharacterId ?? null,
        promptProtocolVersion: job.prompt_protocol_version,
        storyLength,
        selectedMemoryIds: promptContext.chronicle.map((memory) => String(memory.id)),
        selectedMemoryHashes: promptContext.chronicle.map((memory) => sha256(String(memory.content))),
        selectedContext: contextPlan.selected.map((block) => ({ id: block.id, revision: block.revision })),
        omittedContext: contextPlan.omitted.map((block) => ({ id: block.id, revision: block.revision, reason: block.reason })),
        contextTokens: contextPlan.contextTokens,
        requestTokens: contextPlan.requestTokens
      };
      const storyMemoryDefaults = {
        ...storyMemoryDefaultsFromContext(promptContext),
        ...inputs.storyMemoryDefaults
      };
      return { sourceManifest: planned.sourceManifest, storyInput, contextFingerprint, contextDiagnostics: { ...contextDiagnostics, ...(hasFrozenStoryMemoryPolicy ? { layers: planned.layerDiagnostics } : {}), ...(planned.worldReferenceOmissions ? { worldReferenceOmissions: planned.worldReferenceOmissions } : {}), sourceManifestHash: planned.sourceManifest?.manifestHash ?? null, sourceManifestEntries: planned.sourceManifest?.entries.map((entry) => ({ id: entry.id, source: entry.source, sourcePath: entry.sourcePath })) ?? [] }, storyMemoryDefaults };
    });
    const { sourceManifest, storyInput, contextFingerprint, contextDiagnostics, storyMemoryDefaults } = promptPreparation;
    if (frozenStoryMemoryPolicySnapshot) {
      const safeContext = projectSafeGenerationContextDiagnostic(contextDiagnostics);
      orchestration.contextDiagnostic = projectSafeGenerationDiagnostic({
        code: safeContext.reasonCodes?.length ? "context_evidence_omitted" : "context_ready",
        operation: "story_generation", action: "adjust_context", ...safeContext,
        protocolIdentity: frozenStoryMemoryPolicySnapshot.promptProtocol,
        policyIdentity: frozenStoryMemoryPolicySnapshot.policyHash,
        queryVariantCount: generationContext.chronicleRetrieval?.queryPlanning?.variantCount ?? 0
      })!;
      orchestration = await persistOrchestration(repository, scope, job, { contextDiagnostic: orchestration.contextDiagnostic, ...(sourceManifest ? { sourceEvidenceManifest: sourceManifest } : {}) });
    }
    const plannedSentFactIds = sentCanonicalFactIds(storyInput);
    let validatedDraft = compatibleValidatedMainDraft(
      orchestration.validatedMainDraft,
      job,
      provider,
      storyInput,
      orchestration.semanticRepair,
      orchestration.generationReview
    );
    const formatRepairReceipt = savedReview.success && savedReview.data.version === 2
      && savedReview.data.state === "decided" && savedReview.data.stage === "structure"
      && savedReview.data.candidateScope === "main" && savedReview.data.factFormatRepair?.status === "authorized"
      ? savedReview.data.decisionJournal.find((entry) => entry.decision === "repair_format"
        && entry.reviewId === savedReview.data.reviewId && entry.revision === savedReview.data.revision - 1)
      : undefined;
    if (!validatedDraft && formatRepairReceipt && savedReview.success) {
      const repair = savedReview.data.factFormatRepair!;
      const primary = orchestration.primaryResult;
      const incompatible = async (): Promise<true> => {
        assertActiveGenerationUpdate(await repository.markRecoverable({
          ...scope, providerResponseId: null, providerFinishReason: null,
          errorCode: "generation_checkpoint_incompatible",
          errorMessage: "The authorized fact-format repair no longer matches its original response.",
          recoveryMetadata: { retryable: true, stage: "structure", reason: "fact_format_repair_incompatible" }
        }), "saving incompatible fact-format repair checkpoint");
        return true;
      };
      if (!primary || !primary.rawOutputReference || primary.rawOutputReference !== repair.rawOutputReference
        || primary.requestPayloadHash !== repair.producingRequestHash
        || primary.response.responseId !== repair.sourceResponseId
        || primary.providerConfigurationHash !== repair.providerConfigurationHash) {
        await incompatible(); return true;
      }
      const plan = applyAuthorizedFactFormatRepair({
        checkpoint: savedReview.data, rawOutput: primary.response.content, requestBody: primary.requestBody, sentFactIds: primary.sentFactIds
      });
      const repaired = plan ? parseStoryOutput(JSON.stringify(plan.story), storyMemoryDefaults) : null;
      const storyOnlyRepair = generationPolicy?.playMode === "story_only" && plan
        ? parseStoryOnlyOutput(JSON.stringify(plan.story)) : null;
      if (!plan || plan.resultHash !== repair.plan.resultHash || !repaired?.ok || mechanicsLeakFields(repaired.story).length
        || (generationPolicy?.playMode === "story_only" && !storyOnlyRepair?.ok)) {
        await incompatible(); return true;
      }
      const appliedReview = generationReviewCheckpointSchema.parse({
        ...savedReview.data, factFormatRepair: { ...repair, status: "applied", failureCode: null }
      });
      const draft = {
        version: 2 as const, ownerUserId: job.owner_user_id, campaignId: job.campaign_id,
        worldVersionId: job.world_version_id || null, baseIdentity: job.generation_base_identity,
        promptProtocolVersion: job.prompt_protocol_version,
        ...(frozenGenerationPolicyIdentity ? { generationPolicyIdentity: frozenGenerationPolicyIdentity } : {}),
        providerId: provider.id, providerModel: provider.model,
        providerConfigurationHash: effectiveProviderConfigurationHash(provider, job), action: job.action,
        originalInputHash: sha256(storyInput), requestBody: primary.requestBody,
        requestPayloadHash: primary.requestPayloadHash, draftHash: sha256(stableStringify(repaired.story)),
        producingAttempt: job.attempts, story: repaired.story, response: primary.response, sentFactIds: primary.sentFactIds,
        factFormatRepair: { version: 1 as const, reviewId: savedReview.data.reviewId, revision: formatRepairReceipt.revision,
          planHash: repair.planHash, rawOutputHash: repair.plan.rawOutputHash, resultHash: repair.plan.resultHash }
      };
      orchestration = await persistOrchestration(repository, scope, job, { generationReview: appliedReview, validatedMainDraft: draft });
      validatedDraft = compatibleValidatedMainDraft(orchestration.validatedMainDraft, job, provider, storyInput, orchestration.semanticRepair, orchestration.generationReview);
      if (!validatedDraft) { await incompatible(); return true; }
    }
    if (stages.allowSceneCoverage && !compatibleEventCoverageRepair(
      orchestration.eventCoverageRepair,
      validatedDraft,
      orchestration.extension,
    )) {
      assertActiveGenerationUpdate(await repository.markRecoverable({
        ...scope,
        providerResponseId: null,
        providerFinishReason: null,
        errorCode: "generation_checkpoint_incompatible",
        errorMessage: "The saved event-coverage repair no longer matches its final-story provenance.",
        recoveryMetadata: { retryable: true, stage: "event_coverage", reason: "event_coverage_repair_incompatible" }
      }), "saving incompatible event coverage repair state");
      return true;
    }
    let resumedChoiceStory: StoryTurnOutput | null = null;
    const savedChoiceRepair = orchestration.choiceRepair;
    if (!validatedDraft && savedChoiceRepair?.status === "pending" && orchestration.automaticRepair) {
      assertActiveGenerationUpdate(await repository.markRecoverable({
        ...scope, providerResponseId: null, providerFinishReason: null,
        errorCode: "automatic_repair_consumed",
        errorMessage: "Story Direction choice repair awaits an explicit retry after the automatic recovery.",
        recoveryMetadata: { retryable: true, stage: "choice_repair" }
      }), "saving pending Story Direction choice repair state");
      return true;
    }
    const resumingPendingChoiceRepair = !validatedDraft
      && savedChoiceRepair?.status === "pending"
      && !orchestration.automaticRepair;
    if (!validatedDraft && savedChoiceRepair?.status === "dispatched") {
      assertActiveGenerationUpdate(await repository.markRecoverable({
        ...scope, providerResponseId: null, providerFinishReason: null,
        errorCode: "automatic_repair_consumed",
        errorMessage: "Story Direction choice repair was already dispatched and awaits an explicit recovery decision.",
        recoveryMetadata: { retryable: true, stage: "choice_repair" }
      }), "saving consumed dispatched Story Direction choice repair");
      return true;
    }
    if (!validatedDraft && savedChoiceRepair) {
      try {
        if (savedChoiceRepair.policyIdentity !== frozenGenerationPolicyIdentity
          || savedChoiceRepair.ownerUserId !== job.owner_user_id
          || savedChoiceRepair.campaignId !== job.campaign_id
          || stableStringify(savedChoiceRepair.baseIdentity) !== stableStringify(job.generation_base_identity)
          || savedChoiceRepair.providerId !== provider.id
          || savedChoiceRepair.providerModel !== provider.model
          || savedChoiceRepair.providerConfigurationHash !== effectiveProviderConfigurationHash(provider, job)
          || savedChoiceRepair.baseHash !== sha256(stableStringify(savedChoiceRepair.base))
          || (savedChoiceRepair.status !== "pending" && (savedChoiceRepair.status !== "validated" || !savedChoiceRepair.fields))
          || (savedChoiceRepair.status === "validated" && savedChoiceRepair.resultHash !== sha256(stableStringify(savedChoiceRepair.fields)))
          || savedChoiceRepair.originalRequestPayloadHash !== sha256(savedChoiceRepair.originalRequestBody)
          || savedChoiceRepair.repairRequestPayloadHash !== sha256(savedChoiceRepair.repairRequestBody)
          || stableStringify(choiceRepairPreparedRequest(provider,
            storyOnlyChoiceRepairSystemPrompt ?? "",
            savedChoiceRepair.base, savedChoiceRepair.repairResponseFormat))
            !== stableStringify({ body: savedChoiceRepair.repairRequestBody, payloadHash: savedChoiceRepair.repairRequestPayloadHash })
          || !sameFactIds(savedChoiceRepair.originalSentFactIds, sentCanonicalFactIds(savedChoiceRepair.originalRequestBody))) {
          throw new Error("Choice repair checkpoint provenance is incompatible.");
        }
        const original = parseStoryOnlyOutput(savedChoiceRepair.originalResponse.content);
        if (original.ok || original.kind !== "choices" || stableStringify(original.base) !== stableStringify(savedChoiceRepair.base)) {
          throw new Error("Choice repair checkpoint does not match the original rejected draft.");
        }
        if (savedChoiceRepair.status === "validated") {
          resumedChoiceStory = mergeChoiceRepair(savedChoiceRepair.base, savedChoiceRepair.fields!);
        }
      } catch {
        assertActiveGenerationUpdate(await repository.markRecoverable({
          ...scope, providerResponseId: null, providerFinishReason: null,
          errorCode: "generation_checkpoint_incompatible",
          errorMessage: "The saved Story Direction choice repair is incompatible.",
          recoveryMetadata: { retryable: true, stage: "choice_repair", reason: "choice_repair_checkpoint_incompatible" }
        }), "saving incompatible Story Direction choice repair checkpoint");
        return true;
      }
    }
    const sentFactIds = validatedDraft?.sentFactIds || savedChoiceRepair?.originalSentFactIds || plannedSentFactIds;

    const streamingIllustration = await phase("streaming_illustration_setup", async () => {
      const illustrationConfig = reviewMode !== "off" ? null : await collaborators.illustration.loadStreamingIllustrationConfig(
        pool,
        { ownerUserId: job.owner_user_id, campaignId: job.campaign_id }
      ).catch(() => null);
      return {
        illustrationConfig,
        segmentTracker: illustrationConfig
          ? new StreamingSegmentTracker(illustrationConfig.segmentWordCount)
          : null
      };
    });
    const { illustrationConfig, segmentTracker } = streamingIllustration;
    let provisionalSetId: string | null = null;
    let singleSectionDetected = false;
    let lastPartialUpdate = 0;
    let lastPartialContent = "";
    let lastStreamLogAt = 0;
    let lastStreamLogChars = 0;
    let lastStreamPersistWarningAt = 0;
    const onChunk = async (_delta: string, accumulated: string) => {
      const now = Date.now();
      if (now - lastPartialUpdate < 350 || accumulated === lastPartialContent) return;
      lastPartialUpdate = now;
      lastPartialContent = accumulated;
      try {
        assertActiveGenerationUpdate(
          await repository.savePartialNarration(scope, accumulated),
          "persisting streamed output"
        );
        if (lastStreamLogAt === 0 || now - lastStreamLogAt >= 5000
            || accumulated.length - lastStreamLogChars >= 4096) {
          const narration = extractPartialNarration(accumulated);
          logger.info({
            event: "turn_generation_stream_progress",
            ...generationLogContext(job, workerId),
            storyOperation: "story_generation",
            accumulatedChars: accumulated.length,
            narrationChars: narration.length,
            streamDurationMs: now - generationStartedAt
          });
          lastStreamLogAt = now;
          lastStreamLogChars = accumulated.length;
        }
      } catch (error) {
        if (errorCodeFrom(error) === "generation_cancelled") throw error;
        if (now - lastStreamPersistWarningAt >= 5000) {
          const rawErrorCode = errorCodeFrom(error);
          const errorCode = rawErrorCode ? safeLogErrorCode(rawErrorCode) : null;
          logger.warn({
            event: "turn_generation_stream_persist_failed",
            ...generationLogContext(job, workerId),
            storyOperation: "story_generation",
            errorName: error instanceof Error ? error.name : "Error",
            ...(errorCode ? { errorCode } : {})
          });
          lastStreamPersistWarningAt = now;
        }
      }

      if (!segmentTracker || !illustrationConfig) return;
      try {
        const narration = extractPartialNarration(accumulated);
        if (!narration) return;
        const newSegments = segmentTracker.detectNewSegments(narration);
        for (const segment of newSegments) {
          if (!provisionalSetId) {
            provisionalSetId = await collaborators.illustration.createProvisionalSet(
              pool,
              { ownerUserId: job.owner_user_id, campaignId: job.campaign_id, generationJobId: job.id },
              { visualReference: characterVisualReference(inputs.characterProfile, inputs.characterSnapshot) }
            );
            if (!provisionalSetId) {
              throw Object.assign(new Error(
                "Generation was cancelled before creating provisional illustrations."
              ), { code: "generation_cancelled" });
            }
            const streamingState: GenerationStreamingState = {
              ...(job.streaming_segments_state || {}),
              provisionalSetId
            };
            assertActiveGenerationUpdate(
              await repository.saveStreamingSegments(scope, streamingState),
              "persisting provisional illustration state"
            );
            job.streaming_segments_state = streamingState;
          }
          await collaborators.illustration.createProvisionalSegment(
            pool,
            {
              ownerUserId: job.owner_user_id,
              campaignId: job.campaign_id,
              generationJobId: job.id,
              setId: provisionalSetId
            },
            {
              segment,
              config: illustrationConfig,
              visualReference: characterVisualReference(inputs.characterProfile, inputs.characterSnapshot)
            }
          );
        }
        if (!singleSectionDetected && isNarrationFieldComplete(accumulated)
            && segmentTracker.emittedSegmentCount === 0
            && segmentTracker.accumulatedWordCount > 0) {
          singleSectionDetected = true;
          if (!isIllustrationSegmentEligible(
            { wordCount: segmentTracker.accumulatedWordCount },
            illustrationConfig.segmentWordCount
          )) return;
          if (!provisionalSetId) {
            provisionalSetId = await collaborators.illustration.createProvisionalSet(
              pool,
              { ownerUserId: job.owner_user_id, campaignId: job.campaign_id, generationJobId: job.id },
              { visualReference: characterVisualReference(inputs.characterProfile, inputs.characterSnapshot) }
            );
            if (!provisionalSetId) {
              throw Object.assign(new Error(
                "Generation was cancelled before creating provisional illustrations."
              ), { code: "generation_cancelled" });
            }
            const streamingState: GenerationStreamingState = {
              ...(job.streaming_segments_state || {}),
              provisionalSetId
            };
            assertActiveGenerationUpdate(
              await repository.saveStreamingSegments(scope, streamingState),
              "persisting provisional illustration state"
            );
            job.streaming_segments_state = streamingState;
          }
          await collaborators.illustration.createProvisionalSegment(
            pool,
            {
              ownerUserId: job.owner_user_id,
              campaignId: job.campaign_id,
              generationJobId: job.id,
              setId: provisionalSetId
            },
            {
              segment: {
                ordinal: 0,
                startWord: 0,
                endWord: segmentTracker.accumulatedWordCount,
                startOffset: 0,
                endOffset: narration.length,
                wordCount: segmentTracker.accumulatedWordCount,
                text: narration
              },
              config: illustrationConfig,
              visualReference: characterVisualReference(inputs.characterProfile, inputs.characterSnapshot)
            }
          );
        }
      } catch {
        // Streaming illustration failures do not affect text generation.
      }
    };

    const supportsStreaming = Boolean(
      provider.configuration
      && (provider.configuration.streaming === true
        || provider.configuration.streamingSupport === true)
    );
    const baseRequest = { systemPrompt: storySystemPrompt, input: storyInput };
    const primaryRequest = supportsStreaming && job.attempts === 1
      ? { ...baseRequest, onChunk }
      : baseRequest;
    if (!validatedDraft && !resumedChoiceStory && orchestration.automaticRepair) {
      assertActiveGenerationUpdate(await repository.markRecoverable({
        ...scope,
        providerResponseId: null,
        providerFinishReason: null,
        errorCode: "automatic_repair_consumed",
        errorMessage: "The automatic repair was already consumed for this draft. Retry explicitly to start a new bounded attempt.",
        recoveryMetadata: { retryable: true, stage: orchestration.automaticRepair.stage }
      }), "saving automatic repair recovery state");
      return true;
    }
    if (!validatedDraft && !savedChoiceRepair?.originalResponse && !orchestration.primaryResult && !orchestration.primaryReservation) {
      const preparedReservation = serializeProviderRequest({ ...provider, baseUrl: "" }, {
        systemPrompt: primaryRequest.systemPrompt,
        input: primaryRequest.input
      });
      orchestration = await persistOrchestration(repository, scope, job, {
        primaryReservation: {
          version: 1, requestBody: preparedReservation.body, requestPayloadHash: preparedReservation.payloadHash,
          providerConfigurationHash: effectiveProviderConfigurationHash(provider, job), attempt: job.attempts, status: "reserved"
        }
      });
    }
    const capturedPrimary = orchestration.primaryResult;
    if (capturedPrimary && capturedPrimary.providerConfigurationHash !== effectiveProviderConfigurationHash(provider, job)) {
      throw Object.assign(new Error("The captured primary response belongs to another provider configuration."), {
        code: "generation_checkpoint_incompatible"
      });
    }
    const primaryRetryReceipt = structureRetryReceipt;
    const hasDecidedStructureReview = savedReview.success && savedReview.data.state === "decided"
      && savedReview.data.stage === "structure" && savedReview.data.candidateScope === "main";
    if (!capturedPrimary && orchestration.primaryReservation && hasDecidedStructureReview && !primaryRetryReceipt) {
      assertActiveGenerationUpdate(await repository.markRecoverable({
        ...scope,
        providerResponseId: null,
        providerFinishReason: null,
        errorCode: "generation_checkpoint_incompatible",
        errorMessage: "The saved structure retry receipt is incompatible.",
        recoveryMetadata: { retryable: true, stage: "structure", reason: "review_retry_receipt_incompatible" }
      }), "rejecting incompatible structure retry receipt");
      return true;
    }
    let authorizedPrimaryDispatch = false;
    if (!capturedPrimary && orchestration.primaryReservation?.status === "reserved" && primaryRetryReceipt) {
      orchestration = await persistOrchestration(repository, scope, job, {
        primaryReservation: {
          ...orchestration.primaryReservation, status: "dispatched",
          authorizedReviewId: primaryRetryReceipt.reviewId, authorizedRevision: primaryRetryReceipt.revision
        }
      });
      authorizedPrimaryDispatch = true;
    }
    if (!authorizedPrimaryDispatch && !capturedPrimary && orchestration.primaryReservation && (
      orchestration.primaryReservation.status === "dispatched" || job.attempts > orchestration.primaryReservation.attempt
    )) {
      if (!job.world_id) throw Object.assign(new Error("The interrupted primary request cannot be bound to its world."), { code: "generation_checkpoint_incompatible" });
      const reservation = orchestration.primaryReservation;
      const candidate: GenerationReviewCandidate = {
        scope: "main", story: null, storyHash: sha256(canonicalEvidenceJson(null)),
        rawOutputReference: `generation-primary:${job.id}:${reservation.attempt}`,
        producingRequestHash: null, producingResponseId: null, sentFactIds: sentCanonicalFactIds(reservation.requestBody),
        ownerUserId: job.owner_user_id, campaignId: job.campaign_id, worldId: job.world_id, worldVersionId: job.world_version_id || null,
        baseTurnNumber: job.generation_base_identity.baseTurnNumber, expectedTurnNumber: job.expected_turn_number,
        policy: frozenStoryMemoryPolicySnapshot?.policy ?? generationPolicy ?? {},
        policyHash: frozenStoryMemoryPolicySnapshot?.policyHash ?? sha256(stableStringify(generationPolicy ?? {})),
        baseIdentity: job.generation_base_identity,
        protocol: { version: job.prompt_protocol_version, promptHash: promptSnapshot.continuityReview?.review.hash ?? sha256("") },
        provider: { type: provider.providerType, profileId: job.provider_profile_id, configurationHash: reservation.providerConfigurationHash },
        resumeDependencies: {
          generationContext: { contextFingerprint, contextDiagnostics, chronicleRetrieval }, producingProviderResult: null,
          stageState: { primaryReservation: reservation }, frozenCommitInputs: { inputs, fictionAction: safeAction },
          replacementTarget: job.replacement_turn_id ? { id: job.replacement_turn_id } : null
        }
      };
      const gate = prepareGenerationReview({ candidate, stage: "structure", reasons: ["output_incomplete"],
        operationKind: job.operation_kind, replacementTurnId: job.replacement_turn_id,
        eligibility: { complete: false, structurallyValid: false, mechanicsClean: false, authorityValid: true, stageComplete: false, retryAvailable: true } });
      assertActiveGenerationUpdate(await repository.pauseForReview(scope, gate), "pausing interrupted primary request for review");
      return true;
    }
    const dispatchedPrimary = !validatedDraft && !savedChoiceRepair?.originalResponse && !capturedPrimary;
    let result = validatedDraft?.response || savedChoiceRepair?.originalResponse || capturedPrimary?.response || await phase("story_generation", () =>
      callCampaignTextProvider(dependencies, provider, job, "story_generation", primaryRequest));
    if (dispatchedPrimary) {
      const preparedPrimary = preparedRequestForResult(result, provider, primaryRequest);
      orchestration = await persistOrchestration(repository, scope, job, {
        primaryResult: {
          version: 1, requestBody: preparedPrimary.body, requestPayloadHash: preparedPrimary.payloadHash,
          response: result, sentFactIds: sentCanonicalFactIds(preparedPrimary.body),
          rawOutputReference: `generation-primary:${job.id}:${job.attempts}`,
          providerConfigurationHash: effectiveProviderConfigurationHash(provider, job),
          contextFingerprint, contextDiagnostics, chronicleRetrieval
        }
      });
      const finalPartialNarration = extractPartialNarration(result.content);
      // The public preview belongs to the initial primary response. A
      // structure retry is an authorized private replacement attempt; it can
      // become visible only by passing validation and being accepted.
      if (finalPartialNarration && !structureRetryReceipt) {
        assertActiveGenerationUpdate(
          await repository.savePartialNarration(scope, finalPartialNarration),
          "flushing complete primary narration"
        );
      }
    }
    let validation = validatedDraft || resumedChoiceStory
      ? {
          parsed: { ok: true as const, story: validatedDraft?.story || resumedChoiceStory! },
          firstReason: null,
          initialValidationErrors: [] as string[],
          initialAttemptNumber: job.attempts * 2 - 1
        }
      : await phase("story_validation", async () => {
      const parsed = parseStoryOutput(result.content, storyMemoryDefaults);
      const firstReason: "invalid_json" | "invalid_schema" | "mechanics_leak" | null =
        !parsed.ok ? parsed.code : null;
      const validationCode = !parsed.ok && result.outputLimited
        ? "output_limit"
        : firstReason;
      const initialValidationErrors = parsed.ok ? [] : parsed.errors;
      const initialAttemptNumber = job.attempts * 2 - 1;
      logger.info({
        event: "turn_generation_validation_completed",
        ...generationLogContext(job, workerId),
        storyOperation: "story_generation",
        valid: parsed.ok,
        outputLimited: result.outputLimited,
        validationCode,
        validationErrorCount: initialValidationErrors.length,
        attemptNumber: initialAttemptNumber
      });
      await repository.recordAttempt({
        ...scope,
        attemptNumber: initialAttemptNumber,
        recoveryKind: "initial",
        requestMetadata: {
          model: provider.model,
          providerType: provider.providerType,
          contextFingerprint,
          contextDiagnostics
        },
        responseMetadata: {
          usage: result.usage,
          outputLimited: result.outputLimited,
          modelInstanceId: result.modelInstanceId
        },
        providerResponseId: result.responseId || null,
        finishReason: result.finishReason || null,
        rawOutput: result.content || null,
        validationErrors: initialValidationErrors,
        overwrite: true
      });
      return { parsed, firstReason, initialValidationErrors, initialAttemptNumber };
    });
    let { parsed, firstReason, initialValidationErrors, initialAttemptNumber } = validation;
    let recoveryAttempted = false;
    const pauseRejectedMain = async (
      stage: "structure" | "choices",
      reason: "invalid_structure" | "output_incomplete" | "mechanics_contamination" | "invalid_choices"
    ): Promise<true> => {
      if (await reofferFailedAuthorizedRetry(stage, "The authorized retry did not produce a usable complete turn.")) return true;
      if (!job.world_id) {
        throw Object.assign(new Error("The rejected primary response cannot be bound to its world."), {
          code: "generation_checkpoint_incompatible"
        });
      }
      const primary = orchestration.primaryResult;
      const candidate: GenerationReviewCandidate = {
        scope: "main", story: null, storyHash: sha256(canonicalEvidenceJson(null)),
        rawOutputReference: primary?.rawOutputReference ?? `generation-primary:${job.id}:${job.attempts}`,
        producingRequestHash: primary?.requestPayloadHash ?? null,
        producingResponseId: result.responseId || null,
        sentFactIds: [...(primary?.sentFactIds ?? [])],
        ownerUserId: job.owner_user_id, campaignId: job.campaign_id,
        worldId: job.world_id, worldVersionId: job.world_version_id || null,
        baseTurnNumber: job.generation_base_identity.baseTurnNumber,
        expectedTurnNumber: job.expected_turn_number,
        policy: frozenStoryMemoryPolicySnapshot?.policy ?? generationPolicy ?? {},
        policyHash: frozenStoryMemoryPolicySnapshot?.policyHash ?? sha256(stableStringify(generationPolicy ?? {})),
        baseIdentity: job.generation_base_identity,
        protocol: { version: job.prompt_protocol_version, promptHash: promptSnapshot.continuityReview?.review.hash ?? sha256("") },
        provider: { type: provider.providerType, profileId: job.provider_profile_id,
          configurationHash: effectiveProviderConfigurationHash(provider, job) },
        resumeDependencies: {
          generationContext: { contextFingerprint, contextDiagnostics, chronicleRetrieval },
          producingProviderResult: structuredClone(result) as Record<string, unknown>,
          stageState: { primaryResult: primary ?? null },
          frozenCommitInputs: { inputs, fictionAction: safeAction },
          replacementTarget: job.replacement_turn_id ? { id: job.replacement_turn_id } : null
        }
      };
      // A length finish may still contain a complete JSON object. The pure
      // planner proves completeness itself; do not discard that source solely
      // because the provider reported a length finish.
      const proposedRepair = stage === "structure" && primary?.rawOutputReference
        ? prepareFactFormatRepair(result.content, primary.requestBody, primary.sentFactIds) : null;
      const offeredRepair = proposedRepair && (generationPolicy?.playMode !== "story_only"
        || parseStoryOnlyOutput(JSON.stringify(proposedRepair.plan.story)).ok) ? proposedRepair : null;
      const gate = prepareGenerationReview({
        candidate,
        stage,
        reasons: [reason],
        operationKind: job.operation_kind, replacementTurnId: job.replacement_turn_id,
        eligibility: { complete: !result.outputLimited, structurallyValid: false, mechanicsClean: false,
          authorityValid: true, stageComplete: false, retryAvailable: true },
        ...(savedReview.success ? {
          originalCandidate: savedReview.data.originalCandidate,
          originalFindings: savedReview.data.originalFindings,
          decisionJournal: savedReview.data.decisionJournal,
          revision: savedReview.data.revision + 1
        } : {}),
        ...(offeredRepair ? { factFormatRepair: {
          plan: { ...offeredRepair.plan, changes: [...offeredRepair.plan.changes] }, planHash: offeredRepair.planHash, sourceResponseId: result.responseId || null,
          rawOutputReference: candidate.rawOutputReference!, producingRequestHash: primary!.requestPayloadHash,
          ownerUserId: job.owner_user_id, campaignId: job.campaign_id, worldVersionId: job.world_version_id || null,
          baseIdentity: job.generation_base_identity, providerConfigurationHash: effectiveProviderConfigurationHash(provider, job),
          promptProtocolVersion: job.prompt_protocol_version, status: "offered" as const, failureCode: null
        } } : {}) });
      const diagnostic = !result.content.trim()
        ? emptyOutputFailureDiagnostic(initialAttemptNumber)
        : rejectedCandidateFailureDiagnostic(reason, initialAttemptNumber);
      if (diagnostic) {
        orchestration = await persistOrchestration(repository, scope, job, {
          lastFailureDiagnostic: diagnostic
        });
      }
      assertActiveGenerationUpdate(await repository.pauseForReview(scope, gate), "pausing rejected primary candidate for review");
      return true;
    };
    if (generationPolicy?.playMode === "story_only" && validatedDraft && parsed.ok) {
      const checkpointChoices = parseStoryOnlyOutput(JSON.stringify(parsed.story));
      if (!checkpointChoices.ok) {
        assertActiveGenerationUpdate(await repository.markRecoverable({
          ...scope, providerResponseId: null, providerFinishReason: null,
          errorCode: "generation_checkpoint_incompatible",
          errorMessage: "The saved Story Direction draft no longer satisfies choice validation.",
          recoveryMetadata: { retryable: true, stage: "choice_repair", reason: "story_only_choice_checkpoint_invalid" }
        }), "saving incompatible Story Direction validated draft");
        return true;
      }
    }
    if (generationPolicy?.playMode === "story_only" && !validatedDraft) {
      const choiceOnly = parseStoryOnlyOutput(result.content);
      if (!choiceOnly.ok && choiceOnly.kind === "choices") {
        if (!choiceRetryReceipt) return pauseRejectedMain("choices", "invalid_choices");
      }
    }
    if (generationPolicy?.playMode === "story_only" && !validatedDraft
        && (!result.outputLimited || resumingPendingChoiceRepair)) {
      const choiceOnly = parseStoryOnlyOutput(result.content);
      if (!choiceOnly.ok && choiceOnly.kind === "choices") {
        const existing = orchestration.choiceRepair;
        if (existing?.status === "validated") {
          try {
            parsed = { ok: true, story: mergeChoiceRepair(existing.base, existing.fields!) };
            result = existing.originalResponse;
            firstReason = null;
          } catch {
            // The checkpoint is rejected below as a recoverable integrity failure.
          }
        } else if (existing && existing.status !== "pending") {
          assertActiveGenerationUpdate(await repository.markRecoverable({
            ...scope, providerResponseId: null, providerFinishReason: null,
            errorCode: "automatic_repair_consumed",
            errorMessage: "Choice repair is awaiting an explicit retry.",
            recoveryMetadata: { retryable: true, stage: "choice_repair" }
          }), "saving consumed Story Direction choice repair state");
          return true;
        } else {
          const repairRequest = {
            systemPrompt: storyOnlyChoiceRepairSystemPrompt!,
            input: buildStoryOnlyChoiceRepairInput(choiceOnly.base),
            budgetOutput: { kind: "story_choice_repair" as const }
          };
          const initialRepairRequest = choiceRepairPreparedRequest(provider, storyOnlyChoiceRepairSystemPrompt!, choiceOnly.base, "json_object");
          const pendingCheckpoint = existing?.status === "pending" ? existing : null;
          const originalPrepared = pendingCheckpoint
            ? { body: pendingCheckpoint.originalRequestBody, payloadHash: pendingCheckpoint.originalRequestPayloadHash }
            : preparedRequestForResult(result, provider, primaryRequest);
          orchestration = await persistOrchestration(repository, scope, job, {
            ...(pendingCheckpoint && orchestration.logicalAttempt ? { logicalAttempt: orchestration.logicalAttempt } : pendingCheckpoint ? {} : { logicalAttempt: incrementLogicalAllowance(orchestration, "choiceRepairsConsumed") }),
            choiceRepair: {
              version: 1, ownerUserId: job.owner_user_id, campaignId: job.campaign_id, baseIdentity: job.generation_base_identity,
              providerId: provider.id, providerModel: provider.model, providerConfigurationHash: effectiveProviderConfigurationHash(provider, job),
              policyIdentity: frozenGenerationPolicyIdentity!, baseHash: sha256(stableStringify(choiceOnly.base)),
              base: choiceOnly.base, originalRequestBody: originalPrepared.body, originalRequestPayloadHash: originalPrepared.payloadHash,
              originalSentFactIds: pendingCheckpoint?.originalSentFactIds || sentCanonicalFactIds(originalPrepared.body),
              originalResponse: pendingCheckpoint?.originalResponse || result, consumedAttempt: job.attempts,
              repairRequestBody: initialRepairRequest.body, repairRequestPayloadHash: initialRepairRequest.payloadHash,
              repairResponseFormat: "json_object", status: "pending",
              authorizedReviewId: pendingCheckpoint?.authorizedReviewId ?? choiceRetryReceipt!.reviewId,
              authorizedRevision: pendingCheckpoint?.authorizedRevision ?? choiceRetryReceipt!.revision
            }
          });
          try {
            orchestration = await persistOrchestration(repository, scope, job, {
              choiceRepair: { ...orchestration.choiceRepair!, status: "dispatched" }
            });
            const repairResponse = await phase("story_choice_repair", () => callCampaignTextProvider(
              dependencies, provider, job, "story_choice_repair", repairRequest
            ));
            if (repairResponse.outputLimited) throw new Error("Choice repair reached its output limit.");
            const fields = parseChoiceRepair(repairResponse.content);
            const story = mergeChoiceRepair(choiceOnly.base, fields);
            const actualRepairRequest = preparedRequestForResult(repairResponse, provider, repairRequest);
            orchestration = await persistOrchestration(repository, scope, job, {
              choiceRepair: {
                ...orchestration.choiceRepair!, repairRequestBody: actualRepairRequest.body,
                repairRequestPayloadHash: actualRepairRequest.payloadHash,
                repairResponseFormat: repairResponseFormat(actualRepairRequest.body),
                fields, resultHash: sha256(stableStringify(fields)), status: "validated"
              }
            });
            parsed = { ok: true, story };
            firstReason = null;
          } catch (error) {
            if (isRecoverableIntegrityError(error)) throw error;
            if (await reofferFailedAuthorizedRetry("choices", "The authorized choice repair did not produce usable choices.")) return true;
            assertActiveGenerationUpdate(await repository.markRecoverable({
              ...scope, providerResponseId: null, providerFinishReason: null,
              errorCode: "invalid_schema", errorMessage: "Story Direction choices could not be repaired.",
              recoveryMetadata: { retryable: true, stage: "choice_repair" }
            }), "saving invalid Story Direction choice repair state");
            return true;
          }
        }
      }
    }
    // A complete provider response is preserved and offered before any
    // destructive structural recovery.  `outputLimited` alone does not make
    // a parsed structured response incomplete; the parser is authoritative.
    if (firstReason) {
      const reason = result.outputLimited
        ? "output_incomplete" as const
        : firstReason === "mechanics_leak"
          ? "mechanics_contamination" as const
          : "invalid_structure" as const;
      return pauseRejectedMain("structure", reason);
    }
    // A provider can report a length finish after it has delivered a complete
    // structured response.  Accept that response when validation succeeds;
    // an incomplete output remains recoverable rather than being silently
    // replaced with a shorter turn.
    if (firstReason && !result.outputLimited) {
      recoveryAttempted = true;
      const recoveryReason = firstReason;
      const recoveryKind = recoveryReason === "mechanics_leak"
        ? "mechanics_cleanup"
        : "schema_repair";
      const rejectedResponse = result.content;
      logger.warn({
        event: "turn_generation_recovery_started",
        ...generationLogContext(job, workerId),
        firstReason: recoveryReason,
        recoveryKind,
        initialAttemptNumber,
        validationErrorCount: initialValidationErrors.length
      });
      orchestration = await persistOrchestration(repository, scope, job, {
        logicalAttempt: incrementLogicalAllowance(orchestration, "automaticRepairsConsumed"),
        automaticRepair: {
          stage: recoveryKind,
          rejectedDraftHash: sha256(rejectedResponse),
          consumedAttempt: job.attempts
        }
      });
      const recoveryRequest = {
        ...baseRequest,
        recoveryInput: recoveryPromptFromSnapshot(
          collaborators,
          job,
          recoveryReason,
          initialValidationErrors,
          storyLength
        ),
        rejectedResponse
      };
      result = await phase("story_recovery", () => callCampaignTextProvider(
        dependencies,
        provider,
        job,
        "story_recovery",
        recoveryRequest
      ));
      validation = await phase("story_validation", async () => {
        const recoveredParsed = parseStoryOutput(result.content, storyMemoryDefaults);
        logger.info({
          event: "turn_generation_validation_completed",
          ...generationLogContext(job, workerId),
          storyOperation: "story_recovery",
          valid: recoveredParsed.ok && !result.outputLimited,
          outputLimited: result.outputLimited,
          validationCode: result.outputLimited
            ? "output_limit"
            : (recoveredParsed.ok ? null : recoveredParsed.code),
          validationErrorCount: recoveredParsed.ok ? 0 : recoveredParsed.errors.length,
          attemptNumber: initialAttemptNumber + 1
        });
        await repository.recordAttempt({
          ...scope,
          attemptNumber: initialAttemptNumber + 1,
          recoveryKind,
          requestMetadata: {
            model: provider.model,
            providerType: provider.providerType,
            previousResponseIdUsed: provider.providerType === "lmstudio"
              && recoveryReason !== "mechanics_leak",
            rejectedResponseIncluded: Boolean(rejectedResponse)
          },
          responseMetadata: {
            usage: result.usage,
            outputLimited: result.outputLimited,
            modelInstanceId: result.modelInstanceId
          },
          providerResponseId: result.responseId || null,
          finishReason: result.finishReason || null,
          rawOutput: result.content || null,
          validationErrors: recoveredParsed.ok ? [] : recoveredParsed.errors,
          overwrite: false
        });
        return {
          parsed: recoveredParsed,
          firstReason: recoveryReason,
          initialValidationErrors,
          initialAttemptNumber
        };
      });
      ({ parsed, firstReason, initialValidationErrors, initialAttemptNumber } = validation);
      if (generationPolicy?.playMode === "story_only") {
        const recoveredChoiceOnly = parseStoryOnlyOutput(result.content);
        if (!recoveredChoiceOnly.ok && recoveredChoiceOnly.kind === "choices") {
          const preparedRecoveryRequest = preparedRequestForResult(result, provider, recoveryRequest);
          const preparedChoiceRepair = choiceRepairPreparedRequest(
            provider,
            storyOnlyChoiceRepairSystemPrompt!,
            recoveredChoiceOnly.base,
            "json_object"
          );
          orchestration = await persistOrchestration(repository, scope, job, {
            logicalAttempt: incrementLogicalAllowance(orchestration, "choiceRepairsConsumed"),
            choiceRepair: {
              version: 1, ownerUserId: job.owner_user_id, campaignId: job.campaign_id,
              baseIdentity: job.generation_base_identity, providerId: provider.id, providerModel: provider.model,
              providerConfigurationHash: effectiveProviderConfigurationHash(provider, job),
              policyIdentity: frozenGenerationPolicyIdentity!, baseHash: sha256(stableStringify(recoveredChoiceOnly.base)),
              base: recoveredChoiceOnly.base, originalRequestBody: preparedRecoveryRequest.body,
              originalRequestPayloadHash: preparedRecoveryRequest.payloadHash,
              originalSentFactIds: sentCanonicalFactIds(preparedRecoveryRequest.body), originalResponse: result,
              consumedAttempt: job.attempts, repairRequestBody: preparedChoiceRepair.body,
              repairRequestPayloadHash: preparedChoiceRepair.payloadHash, repairResponseFormat: "json_object", status: "pending"
            }
          });
          assertActiveGenerationUpdate(await repository.markRecoverable({
            ...scope, providerResponseId: result.responseId || null, providerFinishReason: result.finishReason || null,
            errorCode: "invalid_schema", errorMessage: "Recovered Story Direction choices require an explicit retry.",
            recoveryMetadata: { retryable: true, stage: "choice_repair", attemptCount: 2 }
          }), "saving recovered Story Direction choice repair state");
          return true;
        }
      }
    }
    const validationFailure = "code" in parsed ? parsed : null;
    if (validationFailure) {
      const code = result.outputLimited
        ? "output_limit"
        : (validationFailure.code || "invalid_schema");
      const messages = validationFailure.errors || ["Story validation failed."];
      assertActiveGenerationUpdate(await repository.markRecoverable({
        ...scope,
        providerResponseId: result.responseId || null,
        providerFinishReason: result.finishReason || null,
        errorCode: code,
        errorMessage: messages.join(" ").slice(0, 4000),
        recoveryMetadata: { retryable: true, attemptCount: recoveryAttempted ? 2 : 1 }
      }), "saving recovery state");
      logger.warn({
        event: "turn_generation_recoverable",
        ...generationLogContext(job, workerId),
        errorCode: code,
        attemptCount: recoveryAttempted ? 2 : 1,
        durationMs: Date.now() - generationStartedAt
      });
      return true;
    }
    if (!parsed.ok) throw new Error("Story validation invariant failed.");
    if (mechanicsLeakFields(parsed.story).length) {
      throw new Error("Mechanics validation invariant failed.");
    }
    const sceneStory = parsed.story;
    const parsedNarration = parsed.story.narration;

    const pauseSceneCoverage = async (): Promise<true> => {
      if (!job.world_id) {
        throw Object.assign(new Error("The rejected scene candidate cannot be bound to its world."), {
          code: "generation_checkpoint_incompatible"
        });
      }
      const prepared = preparedRequestForResult(result, provider, baseRequest);
      if (!validatedDraft) {
        orchestration = await persistOrchestration(repository, scope, job, {
          validatedMainDraft: {
            version: 2, ownerUserId: job.owner_user_id, campaignId: job.campaign_id,
            worldVersionId: job.world_version_id || null, baseIdentity: job.generation_base_identity,
            promptProtocolVersion: job.prompt_protocol_version,
            ...(frozenGenerationPolicyIdentity ? { generationPolicyIdentity: frozenGenerationPolicyIdentity } : {}),
            providerId: provider.id, providerModel: provider.model,
            providerConfigurationHash: effectiveProviderConfigurationHash(provider, job), action: job.action,
            originalInputHash: sha256(storyInput), requestBody: prepared.body, requestPayloadHash: prepared.payloadHash,
            draftHash: sha256(stableStringify(sceneStory)), producingAttempt: job.attempts,
            story: sceneStory, response: result, sentFactIds: sentCanonicalFactIds(prepared.body)
          },
          automaticRepair: undefined
        });
      }
      const candidate: GenerationReviewCandidate = {
        scope: "main", story: sceneStory, storyHash: sha256(canonicalEvidenceJson(sceneStory)),
        rawOutputReference: `generation-primary:${job.id}:${job.attempts}`,
        producingRequestHash: prepared.payloadHash, producingResponseId: result.responseId || null,
        sentFactIds: sentCanonicalFactIds(prepared.body), ownerUserId: job.owner_user_id, campaignId: job.campaign_id,
        worldId: job.world_id, worldVersionId: job.world_version_id || null,
        baseTurnNumber: job.generation_base_identity.baseTurnNumber, expectedTurnNumber: job.expected_turn_number,
        policy: frozenStoryMemoryPolicySnapshot?.policy ?? generationPolicy ?? {},
        policyHash: frozenStoryMemoryPolicySnapshot?.policyHash ?? sha256(stableStringify(generationPolicy ?? {})),
        baseIdentity: job.generation_base_identity,
        protocol: { version: job.prompt_protocol_version, promptHash: promptSnapshot.continuityReview?.review.hash ?? sha256("") },
        provider: { type: provider.providerType, profileId: job.provider_profile_id,
          configurationHash: effectiveProviderConfigurationHash(provider, job) },
        resumeDependencies: {
          generationContext: { contextFingerprint, contextDiagnostics, chronicleRetrieval },
          producingProviderResult: structuredClone(result) as Record<string, unknown>,
          stageState: { primaryResult: orchestration.primaryResult ?? null },
          frozenCommitInputs: { inputs, fictionAction: safeAction },
          replacementTarget: job.replacement_turn_id ? { id: job.replacement_turn_id } : null
        }
      };
      const priorRetry = sceneRetryReceipt && savedReview.success;
      const gate = prepareGenerationReview({
        candidate: priorRetry ? savedReview.data.gateCandidate : candidate,
        stage: "scene_coverage", reasons: priorRetry ? savedReview.data.originalFindings : ["scene_beats_missing"],
        operationKind: job.operation_kind, replacementTurnId: job.replacement_turn_id,
        eligibility: { complete: true, structurallyValid: true, mechanicsClean: true, authorityValid: true, stageComplete: true, retryAvailable: true },
        ...(savedReview.success ? {
          originalCandidate: savedReview.data.originalCandidate, originalFindings: savedReview.data.originalFindings,
          decisionJournal: savedReview.data.decisionJournal, revision: savedReview.data.revision + 1,
          ...(priorRetry ? { retryFailure: "The authorized scene rewrite did not produce a usable complete turn." } : {})
        } : {})
      });
      assertActiveGenerationUpdate(await repository.pauseForReview(scope, gate), "pausing incomplete scene candidate for review");
      return true;
    };

    const activeSceneKeep = Boolean(sceneKeepReceipt && savedReview.success
      && savedReview.data.gateCandidate.storyHash === sha256(canonicalEvidenceJson(sceneStory)));
    const sceneCandidateHash = sha256(canonicalEvidenceJson(sceneStory));
    const reservedSceneRewrite = orchestration.sceneCoverageRepair;
    if (reservedSceneRewrite && sceneRetryReceipt
        && reservedSceneRewrite.rejectedMainStoryHash === sceneCandidateHash
        && reservedSceneRewrite.authorizedReviewId === sceneRetryReceipt.reviewId
        && reservedSceneRewrite.authorizedRevision === sceneRetryReceipt.revision) {
      // A provider may have accepted this rewrite before a worker died. The
      // reservation is the durable consumption record, so reclaim must not
      // send the same user-authorized destructive request again.
      if (await reofferFailedAuthorizedRetry(
        "scene_coverage",
        "The authorized scene rewrite was interrupted before its result could be saved."
      )) return true;
      throw Object.assign(new Error("The saved scene rewrite reservation cannot be re-offered."), {
        code: "generation_checkpoint_incompatible"
      });
    }
    if (stages.allowSceneCoverage && job.resolved_input_mode === "scene" && !activeSceneKeep) {
      let coverage;
      let coverageOutputLimited = true;
      try {
        const coverageResponse = await phase("scene_coverage_validation", () =>
          callCampaignTextProvider(dependencies, provider, job, "scene_coverage_validation", {
            systemPrompt: collaborators.promptFromSnapshot(job.prompt_snapshot, "scene_coverage"),
            input: buildSceneCoveragePrompt(safeAction, parsedNarration)
          }));
        coverageOutputLimited = coverageResponse.outputLimited;
        coverage = coverageResponse.outputLimited
          ? null
          : parseSceneCoverageOutput(coverageResponse.content);
      } catch (error) {
        if (isRecoverableIntegrityError(error)) throw error;
        coverage = null;
      }
      logger.info({
        event: "turn_generation_scene_coverage_completed",
        ...generationLogContext(job, workerId),
        covered: Boolean(coverage?.covered),
        outputLimited: coverageOutputLimited,
        validationCode: coverage?.covered ? null : "scene_coverage",
        missingRequiredBeatCount: coverage?.missing_required_beats.length || 0,
        contradictionCount: coverage?.contradictions.length || 0
      });
      if (!coverage?.covered) {
        const authorizedSceneRetry = Boolean(sceneRetryReceipt && savedReview.success
          && savedReview.data.gateCandidate.storyHash === sha256(canonicalEvidenceJson(sceneStory)));
        if (!authorizedSceneRetry) return pauseSceneCoverage();
        const rejectedResponse = result.content;
        logger.warn({
          event: "turn_generation_recovery_started",
          ...generationLogContext(job, workerId),
          firstReason: "scene_coverage",
          recoveryKind: "scene_coverage_rewrite",
          initialAttemptNumber,
          validationErrorCount: (coverage?.missing_required_beats.length || 0)
            + (coverage?.contradictions.length || 0)
        });
        const sceneRewriteRequest = {
          ...baseRequest,
          recoveryInput: renderPromptTemplate(
            collaborators.promptFromSnapshot(job.prompt_snapshot, "scene_coverage_rewrite"),
            {
              validation: stableStringify({
                missing_required_beats: coverage?.missing_required_beats
                  || ["Coverage could not be verified."],
                contradictions: coverage?.contradictions || []
              })
            }
          ),
          rejectedResponse
        };
        const preparedSceneRewrite = serializeProviderRequest({ ...provider, baseUrl: "" }, {
          systemPrompt: sceneRewriteRequest.systemPrompt,
          input: sceneRewriteRequest.input,
          recoveryInput: sceneRewriteRequest.recoveryInput,
          completeRejectedDraft: { content: rejectedResponse, complete: true as const }
        });
        orchestration = await persistOrchestration(repository, scope, job, {
          sceneCoverageRepair: {
            version: 1,
            rejectedMainStoryHash: sceneCandidateHash,
            repairRequestBody: preparedSceneRewrite.body,
            repairRequestPayloadHash: preparedSceneRewrite.payloadHash,
            status: "reserved",
            authorizedReviewId: sceneRetryReceipt!.reviewId,
            authorizedRevision: sceneRetryReceipt!.revision
          }
        });
        orchestration = await persistOrchestration(repository, scope, job, {
          sceneCoverageRepair: { ...orchestration.sceneCoverageRepair!, status: "dispatched" }
        });
        const sceneRewriteResponse = await phase("scene_coverage_rewrite", () => callCampaignTextProvider(
          dependencies,
          provider,
          job,
          "scene_coverage_rewrite",
          sceneRewriteRequest
        ));
        // The provider can canonicalize the prepared request after the
        // reservation (for example, by retrying without response_format).
        // Retain its returned wire identity before claiming this rewrite has
        // a validated result.
        const actualSceneRewrite = preparedRequestForResult(sceneRewriteResponse, provider, sceneRewriteRequest);
        orchestration = await persistOrchestration(repository, scope, job, {
          sceneCoverageRepair: {
            ...orchestration.sceneCoverageRepair!,
            repairRequestBody: actualSceneRewrite.body,
            repairRequestPayloadHash: actualSceneRewrite.payloadHash,
            status: "validated"
          }
        });
        result = sceneRewriteResponse;
        parsed = parseStoryOutput(result.content, storyMemoryDefaults);
        let repairedCoverage = null;
        let repairedCoverageOutputLimited = true;
        if (parsed.ok && !result.outputLimited) {
          const repairedNarration = parsed.story.narration;
          try {
            const coverageResponse = await phase("scene_coverage_validation", () =>
              callCampaignTextProvider(
                dependencies,
                provider,
                job,
                "scene_coverage_validation",
                {
                  systemPrompt: collaborators.promptFromSnapshot(job.prompt_snapshot, "scene_coverage"),
                  input: buildSceneCoveragePrompt(safeAction, repairedNarration)
                }
              ));
            repairedCoverageOutputLimited = coverageResponse.outputLimited;
            repairedCoverage = coverageResponse.outputLimited
              ? null
              : parseSceneCoverageOutput(coverageResponse.content);
          } catch (error) {
            if (isRecoverableIntegrityError(error)) throw error;
            repairedCoverage = null;
          }
        }
        logger.info({
          event: "turn_generation_scene_coverage_completed",
          ...generationLogContext(job, workerId),
          covered: Boolean(repairedCoverage?.covered),
          outputLimited: repairedCoverageOutputLimited,
          validationCode: repairedCoverage?.covered ? null : "scene_coverage",
          missingRequiredBeatCount: repairedCoverage?.missing_required_beats.length || 0,
          contradictionCount: repairedCoverage?.contradictions.length || 0
        });
        if (!parsed.ok || result.outputLimited || !repairedCoverage?.covered) {
          if (await reofferFailedAuthorizedRetry("scene_coverage", "The authorized scene rewrite did not produce a usable complete turn.")) return true;
          const details = repairedCoverage
            ? [...repairedCoverage.missing_required_beats, ...repairedCoverage.contradictions]
            : ["The required scene beats could not be verified after one rewrite."];
          assertActiveGenerationUpdate(await repository.markRecoverable({
            ...scope,
            providerResponseId: result.responseId || null,
            providerFinishReason: result.finishReason || null,
            errorCode: "scene_coverage",
            errorMessage: details.join(" ").slice(0, 4000),
            recoveryMetadata: { retryable: true, sceneCoverageRewriteAttempted: true }
          }), "saving scene recovery state");
          logger.warn({
            event: "turn_generation_recoverable",
            ...generationLogContext(job, workerId),
            errorCode: "scene_coverage",
            attemptCount: job.attempts,
            durationMs: Date.now() - generationStartedAt
          });
          return true;
        }
      }
    }

    if (!validatedDraft) {
      orchestration = await persistOrchestration(repository, scope, job, {
        validatedMainDraft: {
          version: 2,
          ownerUserId: job.owner_user_id,
          campaignId: job.campaign_id,
          worldVersionId: job.world_version_id || null,
          baseIdentity: job.generation_base_identity,
          promptProtocolVersion: job.prompt_protocol_version,
          ...(frozenGenerationPolicyIdentity ? { generationPolicyIdentity: frozenGenerationPolicyIdentity } : {}),
          providerId: provider.id,
          providerModel: provider.model,
          providerConfigurationHash: effectiveProviderConfigurationHash(provider, job),
          action: job.action,
          originalInputHash: sha256(storyInput),
          requestBody: preparedRequestForResult(result, provider, baseRequest).body,
          requestPayloadHash: preparedRequestForResult(result, provider, baseRequest).payloadHash,
          draftHash: sha256(stableStringify(parsed.story)),
          producingAttempt: job.attempts,
          story: parsed.story,
          response: result,
          sentFactIds: sentCanonicalFactIds(preparedRequestForResult(result, provider, baseRequest).body)
        },
        automaticRepair: undefined
      });
    }
    assertActiveGenerationUpdate(await repository.markValidating(scope), "entering validation");
    const currentMainStory = parsed.ok ? parsed.story : null;
    if (!currentMainStory) throw new Error("Validated main draft was unexpectedly unavailable.");
    if (stages.allowEventEvaluation && orchestration.afterEvents === undefined) {
      await phase("after_event_evaluation", async () => {
        let activated: ActivatedEvent[] = [];
        let triggerError = "";
        if (!inputs.suppressEventTriggers) {
          const pendingTriggerIds = new Set(inputs.pendingEventTriggers.map((event) => event.sourceTriggerId));
          const triggers = inputs.eventTriggers.filter((trigger) => trigger.timing === "after" && !pendingTriggerIds.has(trigger.id));
          try {
            activated = await evaluateTriggers(
              dependencies,
              provider,
              "after",
              promptContext,
              job,
              triggers,
              currentMainStory.narration
            );
          } catch (error) {
            if (isRecoverableIntegrityError(error)) throw error;
            triggerError = error instanceof Error ? error.message : String(error);
          }
        }
        orchestration = await persistOrchestration(repository, scope, job, {
          afterEvents: activated,
          ...(triggerError ? { afterTriggerError: triggerError.slice(0, 2000) } : {})
        });
      });
    }
    const dueBeforeOrPendingEvents = stages.allowEventEvaluation ? orchestration.beforeEvents || [] : [];
    if (stages.allowSceneCoverage && dueBeforeOrPendingEvents.length) {
      let mainEventCoverage: ReturnType<typeof parseSceneCoverageOutput> | null = null;
      try {
        const coverageResponse = await phase("scene_coverage_validation", () =>
          callCampaignTextProvider(dependencies, provider, job, "scene_coverage_validation", {
            systemPrompt: collaborators.promptFromSnapshot(job.prompt_snapshot, "scene_coverage"),
            input: buildEventCoveragePrompt(eventCoverageRequirement(dueBeforeOrPendingEvents), currentMainStory.narration)
          })
        );
        mainEventCoverage = coverageResponse.outputLimited ? null : parseRequiredEventCoverage(coverageResponse.content, dueBeforeOrPendingEvents);
      } catch (error) {
        if (isRecoverableIntegrityError(error)) throw error;
      }
      const eventRetryAuthorized = Boolean(eventRetryReceipt && savedReview.success
        && savedReview.data.candidateScope === "main"
        && savedReview.data.gateCandidate.storyHash === sha256(canonicalEvidenceJson(currentMainStory)));
      if (!coveragePassed(mainEventCoverage) || eventRetryAuthorized) {
        const rejectedMainHash = sha256(stableStringify(currentMainStory));
        if (!eventRetryAuthorized && !orchestration.eventCoverageRepair) {
          if (!job.world_id || !orchestration.validatedMainDraft) {
            throw Object.assign(new Error("The rejected before-event candidate is missing its frozen provenance."), {
              code: "generation_checkpoint_incompatible"
            });
          }
          const prepared = preparedRequestForResult(result, provider, baseRequest);
          const candidate: GenerationReviewCandidate = {
            scope: "main", story: currentMainStory, storyHash: sha256(canonicalEvidenceJson(currentMainStory)),
            rawOutputReference: `generation-primary:${job.id}:${job.attempts}`,
            producingRequestHash: prepared.payloadHash, producingResponseId: result.responseId || null,
            sentFactIds: sentCanonicalFactIds(prepared.body), ownerUserId: job.owner_user_id, campaignId: job.campaign_id,
            worldId: job.world_id, worldVersionId: job.world_version_id || null,
            baseTurnNumber: job.generation_base_identity.baseTurnNumber, expectedTurnNumber: job.expected_turn_number,
            policy: frozenStoryMemoryPolicySnapshot?.policy ?? generationPolicy ?? {},
            policyHash: frozenStoryMemoryPolicySnapshot?.policyHash ?? sha256(stableStringify(generationPolicy ?? {})),
            baseIdentity: job.generation_base_identity,
            protocol: { version: job.prompt_protocol_version, promptHash: promptSnapshot.continuityReview?.review.hash ?? sha256("") },
            provider: { type: provider.providerType, profileId: job.provider_profile_id,
              configurationHash: effectiveProviderConfigurationHash(provider, job) },
            resumeDependencies: {
              generationContext: { contextFingerprint, contextDiagnostics, chronicleRetrieval },
              producingProviderResult: structuredClone(result) as Record<string, unknown>,
              stageState: { validatedMainDraft: orchestration.validatedMainDraft, beforeEvents: dueBeforeOrPendingEvents },
              frozenCommitInputs: { inputs, fictionAction: safeAction },
              replacementTarget: job.replacement_turn_id ? { id: job.replacement_turn_id } : null
            }
          };
          const gate = prepareGenerationReview({
            candidate, stage: "event_coverage", reasons: ["event_coverage_failed"],
            operationKind: job.operation_kind, replacementTurnId: job.replacement_turn_id,
            eligibility: { complete: true, structurallyValid: true, mechanicsClean: true, authorityValid: true, stageComplete: true,
              retryAvailable: (orchestration.logicalAttempt?.eventCoverageRepairsConsumed ?? 0) < 1 },
            ...(savedReview.success ? {
              originalCandidate: savedReview.data.originalCandidate,
              originalFindings: savedReview.data.originalFindings,
              decisionJournal: savedReview.data.decisionJournal,
              revision: savedReview.data.revision + 1
            } : {})
          });
          assertActiveGenerationUpdate(await repository.pauseForReview(scope, gate), "pausing rejected before-event candidate for review");
          return true;
        }
        if (orchestration.eventCoverageRepair?.mainRepairConsumed
          || orchestration.eventCoverageRepair?.extensionFinalStoryHash === null) {
          if (await reofferFailedAuthorizedRetry("event_coverage", "The authorized before-event rewrite did not produce a usable complete turn.")) return true;
          assertActiveGenerationUpdate(await repository.markRecoverable({
            ...scope,
            providerResponseId: result.responseId || null,
            providerFinishReason: result.finishReason || null,
            errorCode: "event_coverage_failed",
            errorMessage: "The before or pending event fiction failed verification after its one permitted rewrite.",
            recoveryMetadata: { retryable: true, stage: "event_coverage", repairAttempted: true }
          }), "saving exhausted main event coverage recovery state");
          return true;
        }
        const repairRequest = {
          ...baseRequest,
          budgetOutput: { kind: "story_replace" as const },
          recoveryInput: renderPromptTemplate(
            collaborators.promptFromSnapshot(job.prompt_snapshot, "scene_coverage_rewrite"),
            { validation: stableStringify({
              missing_required_beats: mainEventCoverage?.missing_required_beats || ["Required event fiction could not be verified."],
              contradictions: mainEventCoverage?.contradictions || []
            }) }
          ),
          rejectedResponse: result.content
        };
        const repairFence = {
          rejectedFinalStoryHash: rejectedMainHash,
          validatedMainDraftHash: orchestration.validatedMainDraft?.draftHash || rejectedMainHash,
          extensionFinalStoryHash: null,
          extensionProducingAttempt: null,
          consumedAttempt: job.attempts,
          ...(eventRetryReceipt ? { authorizedReviewId: eventRetryReceipt.reviewId, authorizedRevision: eventRetryReceipt.revision } : {}),
          mainRepairConsumed: true
        };
        orchestration = await persistOrchestration(repository, scope, job, {
          eventCoverageRepair: repairFence,
          logicalAttempt: incrementLogicalAllowance(orchestration, "eventCoverageRepairsConsumed")
        });
        let repairResult: ProviderResult | null = null;
        let repairedMain: ReturnType<typeof parseStoryOutput>;
        try {
          repairResult = await phase("scene_coverage_rewrite", () => callCampaignTextProvider(
            dependencies, provider, job, "scene_coverage_rewrite", repairRequest
          ));
          repairedMain = (repairResult.outputLimited
            ? { ok: false as const, code: "output_limit", errors: ["The event-coverage rewrite reached its output limit."] }
            : parseStoryOutput(repairResult.content, storyMemoryDefaults)) as ReturnType<typeof parseStoryOutput>;
        } catch (error) {
          if (isRecoverableIntegrityError(error)) throw error;
          repairedMain = { ok: false as const, code: "invalid_schema", errors: ["The event-coverage rewrite could not be validated."] };
        }
        if (!repairedMain.ok) {
          if (await reofferFailedAuthorizedRetry("event_coverage", "The authorized before-event rewrite did not produce a usable complete turn.")) return true;
          assertActiveGenerationUpdate(await repository.markRecoverable({
            ...scope,
            providerResponseId: null,
            providerFinishReason: null,
            errorCode: "event_coverage_failed",
            errorMessage: "The before or pending event fiction rewrite could not be validated.",
            recoveryMetadata: { retryable: true, stage: "event_coverage", repairAttempted: true }
          }), "saving invalid main event rewrite recovery state");
          return true;
        }
        if (!repairResult) {
          assertActiveGenerationUpdate(await repository.markRecoverable({
            ...scope, providerResponseId: null, providerFinishReason: null,
            errorCode: "event_coverage_failed",
            errorMessage: "The before or pending event fiction rewrite did not return a usable result.",
            recoveryMetadata: { retryable: true, stage: "event_coverage", repairAttempted: true }
          }), "saving missing main event rewrite result");
          return true;
        }
        const repairedStory = repairedMain.story;
        let repairedCoverage: ReturnType<typeof parseSceneCoverageOutput> | null = null;
        try {
          const coverageResponse = await phase("scene_coverage_validation", () =>
            callCampaignTextProvider(dependencies, provider, job, "scene_coverage_validation", {
              systemPrompt: collaborators.promptFromSnapshot(job.prompt_snapshot, "scene_coverage"),
              input: buildEventCoveragePrompt(eventCoverageRequirement(dueBeforeOrPendingEvents), repairedStory.narration)
            })
          );
          repairedCoverage = coverageResponse.outputLimited
            ? null
            : parseRequiredEventCoverage(coverageResponse.content, dueBeforeOrPendingEvents);
        } catch (error) {
          if (isRecoverableIntegrityError(error)) throw error;
        }
        if (!coveragePassed(repairedCoverage)) {
          if (await reofferFailedAuthorizedRetry("event_coverage", "The authorized before-event rewrite did not satisfy event coverage.")) return true;
          assertActiveGenerationUpdate(await repository.markRecoverable({
            ...scope,
            providerResponseId: repairResult.responseId || null,
            providerFinishReason: repairResult.finishReason || null,
            errorCode: "event_coverage_failed",
            errorMessage: "The before or pending event fiction rewrite failed event coverage verification.",
            recoveryMetadata: { retryable: true, stage: "event_coverage", repairAttempted: true }
          }), "saving failed main event rewrite coverage");
          return true;
        }
        result = repairResult;
        parsed = repairedMain;
        orchestration = await persistOrchestration(repository, scope, job, {
          validatedMainDraft: {
            version: 2, ownerUserId: job.owner_user_id, campaignId: job.campaign_id,
            worldVersionId: job.world_version_id || null, baseIdentity: job.generation_base_identity,
            promptProtocolVersion: job.prompt_protocol_version, providerId: provider.id, providerModel: provider.model,
            ...(frozenGenerationPolicyIdentity ? { generationPolicyIdentity: frozenGenerationPolicyIdentity } : {}),
            providerConfigurationHash: effectiveProviderConfigurationHash(provider, job),
            action: job.action, originalInputHash: sha256(storyInput),
            requestBody: preparedRequestForResult(repairResult!, provider, repairRequest).body,
            requestPayloadHash: preparedRequestForResult(repairResult!, provider, repairRequest).payloadHash,
            draftHash: sha256(stableStringify(repairedStory)), producingAttempt: job.attempts,
            story: repairedStory, response: repairResult!, sentFactIds: sentCanonicalFactIds(preparedRequestForResult(repairResult!, provider, repairRequest).body)
          },
          afterEvents: undefined, extension: undefined, extensionError: undefined,
          eventCoverageRepair: {
            ...repairFence,
            repairedFinalStoryHash: sha256(stableStringify(repairedStory)),
            repairedMainRequestPayloadHash: preparedRequestForResult(repairResult!, provider, repairRequest).payloadHash
          }
        });
      }
    }
    const immediateEvents = stages.allowEventEvaluation
      ? (orchestration.afterEvents || []).filter((event) => event.addTextAfter)
      : [];
    if (stages.allowSceneCoverage && orchestration.extension) {
      const expectedExtensionInput = immediateEvents.length
        ? buildEventExtensionPrompt(parsed.story, fictionGuidanceForEvents(immediateEvents), promptContext, safeAction)
        : null;
      const extensionMatchesDraft = Boolean(orchestration.validatedMainDraft
        && orchestration.extension.validatedMainDraftHash === orchestration.validatedMainDraft.draftHash
        && orchestration.extension.finalStoryHash === stableStringify(orchestration.extension.story)
        && isStringList(orchestration.extension.sentFactIds)
        && typeof orchestration.extension.producingRequestBody === "string"
        && orchestration.extension.producingRequestPayloadHash === sha256(orchestration.extension.producingRequestBody)
        && sameFactIds(orchestration.extension.sentFactIds, sentCanonicalFactIds(orchestration.extension.producingRequestBody))
        && orchestration.extension.providerConfigurationHash === effectiveProviderConfigurationHash(provider, job)
        && (orchestration.extension.producingOperation === "scene_coverage_rewrite"
          || (orchestration.extension.producingOperation === "event_extension" && expectedExtensionInput)));
      if (!extensionMatchesDraft) {
        assertActiveGenerationUpdate(await repository.markRecoverable({
          ...scope,
          providerResponseId: null,
          providerFinishReason: null,
          errorCode: "generation_checkpoint_incompatible",
          errorMessage: "The saved event extension does not match its validated main draft or producing request.",
          recoveryMetadata: { retryable: true, stage: "event_extension" }
        }), "saving incompatible event extension recovery state");
        return true;
      }
    }
    let extensionFailure: string | null = null;
    if (immediateEvents.length && !orchestration.extension) {
      await phase("event_extension", async () => {
        try {
          const guidance = fictionGuidanceForEvents(immediateEvents);
          if (!guidance.length) {
            throw new Error("Activated extension instructions were not safe for a fiction prompt.");
          }
          const extensionInput = buildEventExtensionPrompt(
            parsed.story,
            guidance,
            promptContext,
            safeAction
          );
          const extensionSentFactIds = sentCanonicalFactIds(stableStringify({
            authoritative_context: promptContext
          }));
          const extensionResponse = await callCampaignTextProvider(
            dependencies,
            provider,
            job,
            "event_extension",
            {
              systemPrompt: collaborators.promptFromSnapshot(job.prompt_snapshot, "event_extension"),
              input: extensionInput,
              budgetOutput: {
                kind: "event_extension",
                protectedStory: {
                  narration: parsed.story.narration,
                  scratchpad: parsed.story.scratchpad,
                  continuitySummary: parsed.story.continuity_summary,
                  openThreads: parsed.story.open_threads
                },
                narrationCharacterLimit: 200_000
              }
            }
          );
          if (extensionResponse.outputLimited) {
            throw new Error("The optional event extension reached its output limit.");
          }
          const extension = parseEventExtension(extensionResponse.content, parsed.story.narration);
          orchestration = await persistOrchestration(repository, scope, job, {
            extension: {
              story: extension,
              finalStoryHash: stableStringify(extension),
              producingAttempt: job.attempts,
              producingOperation: "event_extension",
              validatedMainDraftHash: orchestration.validatedMainDraft?.draftHash || sha256(stableStringify(parsed.story)),
              producingRequestPayloadHash: preparedRequestForResult(extensionResponse, provider, {
                systemPrompt: collaborators.promptFromSnapshot(job.prompt_snapshot, "event_extension"), input: extensionInput
              }).payloadHash,
              producingRequestBody: preparedRequestForResult(extensionResponse, provider, {
                systemPrompt: collaborators.promptFromSnapshot(job.prompt_snapshot, "event_extension"), input: extensionInput
              }).body,
              providerConfigurationHash: effectiveProviderConfigurationHash(provider, job),
              response: extensionResponse,
              sentFactIds: sentCanonicalFactIds(preparedRequestForResult(extensionResponse, provider, {
                systemPrompt: collaborators.promptFromSnapshot(job.prompt_snapshot, "event_extension"), input: extensionInput
              }).body)
            },
            // A previous lease may have recorded a transient extension failure.
            // Successful completion on this lease supersedes that stage outcome.
            extensionError: undefined
          });
        } catch (error) {
          if (isRecoverableIntegrityError(error)) throw error;
          extensionFailure = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
          orchestration = await persistOrchestration(repository, scope, job, {
            extensionError: extensionFailure
          });
        }
      });
    }
    if (extensionFailure) {
      assertActiveGenerationUpdate(await repository.markRecoverable({
        ...scope,
        providerResponseId: result.responseId || null,
        providerFinishReason: result.finishReason || null,
        errorCode: "event_extension",
        errorMessage: "The event extension could not be validated and can be retried.",
        recoveryMetadata: { retryable: true, stage: "event_extension" }
      }), "saving event extension recovery state");
      return true;
    }
    let committedStory: StoryTurnOutput = orchestration.extension?.story || parsed.story;
    let finalSentFactIds = orchestration.extension?.sentFactIds || sentFactIds;
    if (mechanicsLeakFields(committedStory).length) {
      throw new Error("Mechanics validation invariant failed after event extension.");
    }
    if (immediateEvents.length) {
      let eventCoverage: ReturnType<typeof parseSceneCoverageOutput> | null = null;
      try {
        const coverageResponse = await phase("scene_coverage_validation", () =>
          callCampaignTextProvider(dependencies, provider, job, "scene_coverage_validation", {
            systemPrompt: collaborators.promptFromSnapshot(job.prompt_snapshot, "scene_coverage"),
            input: buildEventCoveragePrompt(eventCoverageRequirement(immediateEvents), committedStory.narration)
          })
        );
        eventCoverage = coverageResponse.outputLimited ? null : parseRequiredEventCoverage(coverageResponse.content, immediateEvents);
      } catch (error) {
        if (isRecoverableIntegrityError(error)) throw error;
      }
      if (coveragePassed(eventCoverage) && orchestration.extension) {
        const appendedNarration = formatNarrationParagraphs(committedStory.narration)
          .slice(formatNarrationParagraphs(parsed.story.narration).length).trim();
        try {
          const coverageResponse = await phase("scene_coverage_validation", () =>
            callCampaignTextProvider(dependencies, provider, job, "scene_coverage_validation", {
              systemPrompt: collaborators.promptFromSnapshot(job.prompt_snapshot, "scene_coverage"),
              input: buildEventCoveragePrompt(eventCoverageRequirement(immediateEvents), appendedNarration)
            })
          );
          eventCoverage = coverageResponse.outputLimited ? null : parseRequiredEventCoverage(coverageResponse.content, immediateEvents);
        } catch (error) {
          if (isRecoverableIntegrityError(error)) throw error;
          eventCoverage = null;
        }
      }
      const eventRetryAuthorized = Boolean(eventRetryReceipt && savedReview.success
        && savedReview.data.candidateScope === "final"
        && savedReview.data.gateCandidate.storyHash === sha256(canonicalEvidenceJson(committedStory)));
      if (!coveragePassed(eventCoverage) || eventRetryAuthorized) {
        const rejectedFinalStoryHash = stableStringify(committedStory);
        if (!eventRetryAuthorized && !orchestration.eventCoverageRepair) {
          const producingBody = orchestration.extension?.producingRequestBody ?? orchestration.validatedMainDraft?.requestBody;
          if (!job.world_id || !producingBody || !orchestration.validatedMainDraft) {
            throw Object.assign(new Error("The rejected event candidate is missing its frozen provenance."), {
              code: "generation_checkpoint_incompatible"
            });
          }
          const producingResponse = orchestration.extension?.response ?? result;
          const candidate: GenerationReviewCandidate = {
            scope: "final", story: committedStory, storyHash: sha256(canonicalEvidenceJson(committedStory)), rawOutputReference: null,
            producingRequestHash: sha256(producingBody), producingResponseId: producingResponse.responseId || null,
            sentFactIds: [...finalSentFactIds], ownerUserId: job.owner_user_id, campaignId: job.campaign_id,
            worldId: job.world_id, worldVersionId: job.world_version_id || null,
            baseTurnNumber: job.generation_base_identity.baseTurnNumber, expectedTurnNumber: job.expected_turn_number,
            policy: frozenStoryMemoryPolicySnapshot?.policy ?? generationPolicy ?? {},
            policyHash: frozenStoryMemoryPolicySnapshot?.policyHash ?? sha256(stableStringify(generationPolicy ?? {})),
            baseIdentity: job.generation_base_identity,
            protocol: { version: job.prompt_protocol_version, promptHash: promptSnapshot.continuityReview?.review.hash ?? sha256("") },
            provider: { type: provider.providerType, profileId: job.provider_profile_id, configurationHash: effectiveProviderConfigurationHash(provider, job) },
            resumeDependencies: {
              generationContext: { contextFingerprint, contextDiagnostics, chronicleRetrieval },
              producingProviderResult: structuredClone(producingResponse) as Record<string, unknown>,
              stageState: { validatedMainDraft: orchestration.validatedMainDraft, extension: orchestration.extension ?? null },
              frozenCommitInputs: {
                inputs, fictionAction: safeAction, provider: { id: provider.id, providerType: provider.providerType, model: provider.model },
                orchestration, finalSentFactIds: [...finalSentFactIds]
              },
              replacementTarget: job.replacement_turn_id ? { id: job.replacement_turn_id } : null
            }
          };
          const gate = prepareGenerationReview({ candidate, stage: "event_coverage", reasons: ["event_coverage_failed"],
            operationKind: job.operation_kind, replacementTurnId: job.replacement_turn_id,
            eligibility: { complete: true, structurallyValid: true, mechanicsClean: true, authorityValid: true, stageComplete: true,
              retryAvailable: (orchestration.logicalAttempt?.eventCoverageRepairsConsumed ?? 0) < 1 },
            ...(savedReview.success ? {
              originalCandidate: savedReview.data.originalCandidate,
              originalFindings: savedReview.data.originalFindings,
              decisionJournal: savedReview.data.decisionJournal,
              revision: savedReview.data.revision + 1
            } : {}) });
          assertActiveGenerationUpdate(await repository.pauseForReview(scope, gate), "pausing rejected event candidate for review");
          return true;
        }
        const existingRepair = orchestration.eventCoverageRepair;
        const eventCoverageConsumed = (orchestration.logicalAttempt?.eventCoverageRepairsConsumed ?? 0) >= 1;
        if (eventCoverageConsumed || (existingRepair
          && (existingRepair.rejectedFinalStoryHash === rejectedFinalStoryHash
            || existingRepair.repairedFinalStoryHash === rejectedFinalStoryHash))) {
          assertActiveGenerationUpdate(await repository.markRecoverable({
            ...scope,
            providerResponseId: result.responseId || null,
            providerFinishReason: result.finishReason || null,
            errorCode: "event_coverage_failed",
            errorMessage: "The final event fiction still failed verification after its one permitted rewrite.",
            recoveryMetadata: { retryable: true, stage: "event_coverage", repairConsumed: true }
          }), "saving consumed event coverage repair state");
          return true;
        }
        const repair = {
          rejectedFinalStoryHash,
          validatedMainDraftHash: orchestration.validatedMainDraft?.draftHash || sha256(stableStringify(parsed.story)),
          extensionFinalStoryHash: orchestration.extension?.finalStoryHash || null,
          extensionProducingAttempt: orchestration.extension?.producingAttempt || null,
          consumedAttempt: job.attempts,
          authorizedReviewId: eventRetryReceipt!.reviewId,
          authorizedRevision: eventRetryReceipt!.revision,
          mainRepairConsumed: orchestration.eventCoverageRepair?.mainRepairConsumed === true
            || orchestration.eventCoverageRepair?.extensionFinalStoryHash === null
        };
        orchestration = await persistOrchestration(repository, scope, job, {
          eventCoverageRepair: repair,
          logicalAttempt: incrementLogicalAllowance(orchestration, "eventCoverageRepairsConsumed")
        });
        let repairedStory: StoryTurnOutput | null = null;
        let repairResponse: ProviderResult | null = null;
        const validatedMainStory = orchestration.validatedMainDraft?.story ?? parsed.story;
        const repairRequest = {
          ...baseRequest,
          input: buildEventExtensionPrompt(
            validatedMainStory,
            fictionGuidanceForEvents(immediateEvents),
            promptContext,
            safeAction
          ),
          budgetOutput: {
            kind: "event_extension" as const,
            protectedStory: {
              narration: validatedMainStory.narration,
              scratchpad: validatedMainStory.scratchpad,
              continuitySummary: validatedMainStory.continuity_summary,
              openThreads: validatedMainStory.open_threads
            },
            narrationCharacterLimit: 200_000
          },
          recoveryInput: renderPromptTemplate(
            collaborators.promptFromSnapshot(job.prompt_snapshot, "scene_coverage_rewrite"),
            {
              validation: stableStringify({
                missing_required_beats: eventCoverage?.missing_required_beats || ["Immediate event coverage could not be verified."],
                contradictions: eventCoverage?.contradictions || []
              })
            }
          ),
          rejectedResponse: stableStringify(committedStory)
        };
        try {
          repairResponse = await phase("scene_coverage_rewrite", () => callCampaignTextProvider(
            dependencies,
            provider,
            job,
            "scene_coverage_rewrite",
            repairRequest
          ));
          if (!repairResponse.outputLimited) {
            // A coverage rewrite may replace a rejected extension suffix.  Only the
            // independently validated main draft is immutable across this boundary.
            const repaired = parseEventExtension(
              repairResponse.content,
              validatedMainStory.narration
            );
            if (!mechanicsLeakFields(repaired).length) repairedStory = repaired;
          }
        } catch (error) {
          if (isRecoverableIntegrityError(error)) throw error;
        }
        if (repairedStory) {
          const repairedFinalStoryHash = stableStringify(repairedStory);
          const preparedRepair = preparedRequestForResult(repairResponse!, provider, repairRequest);
          const repairSentFactIds = sentCanonicalFactIds(preparedRepair.body);
          orchestration = await persistOrchestration(repository, scope, job, {
            extension: {
              story: repairedStory,
              finalStoryHash: repairedFinalStoryHash,
              producingAttempt: job.attempts,
              producingOperation: "scene_coverage_rewrite",
              validatedMainDraftHash: orchestration.validatedMainDraft?.draftHash || sha256(stableStringify(parsed.story)),
              producingRequestPayloadHash: preparedRepair.payloadHash,
              producingRequestBody: preparedRepair.body,
              providerConfigurationHash: effectiveProviderConfigurationHash(provider, job),
              ...(repairResponse ? { response: repairResponse } : {}),
              sentFactIds: repairSentFactIds
            },
            eventCoverageRepair: {
              ...repair,
              extensionFinalStoryHash: repairedFinalStoryHash,
              extensionProducingAttempt: job.attempts,
              repairedFinalStoryHash
            },
            extensionError: undefined
          });
          committedStory = repairedStory;
          finalSentFactIds = repairSentFactIds;
          try {
            const coverageResponse = await phase("scene_coverage_validation", () =>
              callCampaignTextProvider(dependencies, provider, job, "scene_coverage_validation", {
                systemPrompt: collaborators.promptFromSnapshot(job.prompt_snapshot, "scene_coverage"),
                input: buildEventCoveragePrompt(eventCoverageRequirement(immediateEvents), repairedStory.narration)
              })
            );
            eventCoverage = coverageResponse.outputLimited ? null : parseRequiredEventCoverage(coverageResponse.content, immediateEvents);
            if (coveragePassed(eventCoverage)) {
              const appendedNarration = formatNarrationParagraphs(repairedStory.narration)
                .slice(formatNarrationParagraphs(parsed.story.narration).length).trim();
              const appendedCoverageResponse = await phase("scene_coverage_validation", () =>
                callCampaignTextProvider(dependencies, provider, job, "scene_coverage_validation", {
                  systemPrompt: collaborators.promptFromSnapshot(job.prompt_snapshot, "scene_coverage"),
                  input: buildEventCoveragePrompt(eventCoverageRequirement(immediateEvents), appendedNarration)
                })
              );
              eventCoverage = appendedCoverageResponse.outputLimited
                ? null
                : parseRequiredEventCoverage(appendedCoverageResponse.content, immediateEvents);
            }
          } catch (error) {
            if (isRecoverableIntegrityError(error)) throw error;
            eventCoverage = null;
          }
        }
        if (repairedStory && coveragePassed(eventCoverage)) {
          // The full replacement was revalidated; commit the durable final story below.
        } else {
          if (await reofferFailedAuthorizedRetry("event_coverage", "The authorized event coverage retry did not produce a usable complete turn.")) return true;
          assertActiveGenerationUpdate(await repository.markRecoverable({
            ...scope,
            providerResponseId: result.responseId || null,
            providerFinishReason: result.finishReason || null,
            errorCode: "event_coverage_failed",
            errorMessage: "The immediate event fiction could not be verified against the final narration.",
            recoveryMetadata: { retryable: true, stage: "event_coverage", repairAttempted: true }
          }), "saving event coverage recovery state");
          return true;
        }
      }
    }
    if (reviewMode !== "off" && frozenStoryMemoryPolicySnapshot) {
      const producingBody = orchestration.extension?.producingRequestBody ?? orchestration.validatedMainDraft?.requestBody;
      let finalManifest: typeof orchestration.sourceEvidenceManifest;
      try {
        if (producingBody && orchestration.sourceEvidenceManifest) finalManifest = bindManifestToProducingRequest(orchestration.sourceEvidenceManifest, producingBody);
      } catch { /* Observe records unavailable source scope; enforce cannot pass it. */ }
      const auxiliaryRequestHashes = validatedChoiceRequestHashes(orchestration.choiceRepair, orchestration.validatedMainDraft?.story, effectiveProviderConfigurationHash(provider, job));
      const binding = {
        draftHash: sha256(stableStringify(committedStory)), producingRequestHash: producingBody ? sha256(producingBody) : null, manifestHash: finalManifest?.manifestHash ?? null, auxiliaryRequestHashes,
        providerConfigurationHash: effectiveProviderConfigurationHash(provider, job), promptHash: promptSnapshot.continuityReview!.review.hash,
        promptProtocol: "story-continuity-review-v1" as const, policyHash: frozenStoryMemoryPolicySnapshot.policyHash
      };
      const bindingHash = reviewBindingHash(binding);
      const continuityRetryReceipt = savedReview.success && savedReview.data.state === "decided"
        && savedReview.data.stage === "continuity" && savedReview.data.candidateScope === "final"
        ? savedReview.data.decisionJournal.find((entry) => entry.decision === "retry"
            && entry.reviewId === savedReview.data.reviewId && entry.revision === savedReview.data.revision - 1
            && entry.nextStage === "continuity"
            && entry.candidateHash === sha256(canonicalEvidenceJson(committedStory)))
        : undefined;
      // An unavailable or uncertain review retry authorizes one new reviewer
      // call only.  It never carries forward a prior non-pass as a repair
      // authorization, and a newly discovered conflict receives its own gate.
      if (continuityRetryReceipt && savedReview.success
          && !savedReview.data.reasons.includes("narrative_conflict")) {
        orchestration = await persistOrchestration(repository, scope, job, { continuityReview: undefined });
      }
      const existing = continuityReviewCheckpointSchema.safeParse(orchestration.continuityReview);
      if (orchestration.continuityReview && (!existing.success || existing.data.bindingHash !== bindingHash || existing.data.mode !== reviewMode)) {
        throw Object.assign(new Error("Saved continuity review belongs to a different final story."), { code: "generation_checkpoint_incompatible" });
      }
      let checkpoint: ContinuityReviewCheckpoint;
      if (existing.success && existing.data.status === "completed") checkpoint = existing.data;
      else if (existing.success) {
        // A prior lease may have dispatched the call. Do not silently duplicate
        // its cost or assume the missing response was a semantic pass.
        checkpoint = { ...existing.data, status: "completed", verdict: "unavailable", result: null };
      } else {
        checkpoint = { version: 1, mode: reviewMode, binding, bindingHash, status: "completed", verdict: "unavailable", result: null, reviewRequestHash: null };
        try {
          if (!finalManifest || !binding.producingRequestHash) throw Object.assign(new Error("Review input unavailable"), { code: "continuity_review_unavailable" });
          const prepared = prepareContinuityReview({ provider, manifest: finalManifest, producingRequestHash: binding.producingRequestHash,
            promptSnapshot: frozenPromptEnvelope, reviewMode, direction: safeAction, draft: committedStory, effectiveContextWindowTokens: effectiveContextWindow });
          const priorLedger = orchestration.logicalAttempt ?? { version: 1 as const, id: job.id, semanticRepairsConsumed: 0,
            reviewsConsumed: 0, automaticRepairsConsumed: orchestration.automaticRepair ? 1 : 0,
            choiceRepairsConsumed: orchestration.choiceRepair ? 1 : 0, eventCoverageRepairsConsumed: orchestration.eventCoverageRepair ? 1 : 0 };
          if (priorLedger.reviewsConsumed >= 2) throw Object.assign(new Error("Continuity review allowance consumed."), { code: "continuity_review_unavailable" });
          checkpoint = { ...checkpoint, status: "dispatched", reviewRequestHash: prepared.requestHash };
          orchestration = await persistOrchestration(repository, scope, job, { continuityReview: checkpoint,
            logicalAttempt: { ...priorLedger, reviewsConsumed: priorLedger.reviewsConsumed + 1 }, sourceEvidenceManifest: finalManifest });
          const reviewed = await phase("story_continuity_review", () => callCampaignTextProvider(dependencies, provider, job, "story_continuity_review", prepared.request));
          const validated = validatePreparedContinuityReviewResult(prepared, reviewed);
          checkpoint = { ...checkpoint, status: "completed", verdict: validated.review.verdict, result: structuredClone(validated.review) as ContinuityReviewCheckpoint["result"] };
        } catch (error) {
          if (["generation_cancelled", "lease_lost"].includes(errorCodeFrom(error) ?? "")) throw error;
          checkpoint = { ...checkpoint, status: "completed", verdict: "unavailable", result: null };
        }
      }
      const reviewDiagnostic = projectSafeGenerationDiagnostic({
        ...(orchestration.contextDiagnostic ?? {}), code: "context_ready", operation: "story_generation", action: "adjust_context",
        review: { status: checkpoint.verdict === "pass" ? "passed" : checkpoint.verdict, automaticRepair: "not_consumed" }
      })!;
      orchestration = await persistOrchestration(repository, scope, job, { continuityReview: checkpoint, ...(finalManifest ? { sourceEvidenceManifest: finalManifest } : {}), contextDiagnostic: reviewDiagnostic });
      if (reviewMode === "enforce" && checkpoint.verdict !== "pass") {
        if (!job.world_id || !producingBody || !orchestration.validatedMainDraft) {
          throw Object.assign(new Error("The rejected final candidate is missing its frozen review binding."), {
            code: "generation_checkpoint_incompatible"
          });
        }
        const producingResponse = orchestration.extension?.response ?? result;
        const reviewReason = checkpoint.verdict === "conflict"
          ? "narrative_conflict" as const
          : checkpoint.verdict === "uncertain"
            ? "review_uncertain" as const
            : "review_unavailable" as const;
        const candidate: GenerationReviewCandidate = {
          scope: "final", story: committedStory, storyHash: sha256(canonicalEvidenceJson(committedStory)), rawOutputReference: null,
          producingRequestHash: sha256(producingBody), producingResponseId: producingResponse.responseId || null,
          sentFactIds: [...finalSentFactIds], ownerUserId: job.owner_user_id, campaignId: job.campaign_id,
          worldId: job.world_id, worldVersionId: job.world_version_id || null,
          baseTurnNumber: job.generation_base_identity.baseTurnNumber, expectedTurnNumber: job.expected_turn_number,
          policy: frozenStoryMemoryPolicySnapshot.policy, policyHash: frozenStoryMemoryPolicySnapshot.policyHash,
          baseIdentity: job.generation_base_identity,
          protocol: { version: job.prompt_protocol_version, promptHash: promptSnapshot.continuityReview!.review.hash },
          provider: { type: provider.providerType, profileId: job.provider_profile_id, configurationHash: effectiveProviderConfigurationHash(provider, job) },
          resumeDependencies: {
            generationContext: { contextFingerprint, contextDiagnostics, chronicleRetrieval },
            producingProviderResult: structuredClone(producingResponse) as Record<string, unknown>,
            stageState: { continuityReview: checkpoint, validatedMainDraft: orchestration.validatedMainDraft, extension: orchestration.extension ?? null },
            frozenCommitInputs: {
              inputs, fictionAction: safeAction, provider: { id: provider.id, providerType: provider.providerType, model: provider.model },
              orchestration, finalSentFactIds: [...finalSentFactIds]
            },
            replacementTarget: job.replacement_turn_id ? { id: job.replacement_turn_id } : null
          }
        };
        const gate = prepareGenerationReview({ candidate, stage: "continuity", reasons: [reviewReason],
          operationKind: job.operation_kind, replacementTurnId: job.replacement_turn_id,
          eligibility: { complete: true, structurallyValid: true, mechanicsClean: true, authorityValid: true, stageComplete: true, retryAvailable: true },
          ...(savedReview.success ? {
            originalCandidate: savedReview.data.originalCandidate,
            originalFindings: savedReview.data.originalFindings,
            decisionJournal: savedReview.data.decisionJournal,
            revision: savedReview.data.revision + 1
          } : {}) });
        const retryAuthorizedRepair = Boolean(continuityRetryReceipt && savedReview.success
          && savedReview.data.reasons.includes("narrative_conflict"));
        if (!retryAuthorizedRepair) {
          assertActiveGenerationUpdate(await repository.pauseForReview(scope, gate), "pausing rejected final candidate for review");
          return true;
        }
        if (checkpoint.verdict === "conflict" && checkpoint.result && finalManifest && producingBody) {
          const rejectedFinalStoryHash = sha256(stableStringify(committedStory));
          const existingRepair = orchestration.semanticRepair;
          if (existingRepair?.rejectedFinalStoryHash === rejectedFinalStoryHash) {
            // A lease reclaim after a dispatch cannot make a second semantic call.
            if (existingRepair.status !== "validated") {
              assertActiveGenerationUpdate(await repository.markRecoverable({ ...scope, providerResponseId: null, providerFinishReason: null,
                errorCode: "continuity_review_conflict", errorMessage: "The reserved semantic repair has no validated response.",
                recoveryMetadata: { retryable: true, stage: "semantic_repair", repairConsumed: true } }), "saving consumed semantic repair");
              return true;
            }
          } else {
            const repairScope = semanticRepairScope({ hasExtension: Boolean(orchestration.extension),
              mainNarration: orchestration.validatedMainDraft?.story.narration ?? parsed.story.narration,
              findings: checkpoint.result.findings });
            const extensionOnly = repairScope === "extension_only";
            let preparedRepair;
            try {
              preparedRepair = prepareContinuityRepair({ provider, manifest: finalManifest, promptSnapshot: frozenPromptEnvelope,
                direction: safeAction, rejectedDraft: committedStory, originalMain: orchestration.validatedMainDraft?.story ?? parsed.story, scope: repairScope, findings: checkpoint.result.findings,
                effectiveContextWindowTokens: effectiveContextWindow });
            } catch (error) {
              if (await reofferFailedAuthorizedRetry("continuity", "The authorized continuity repair request could not be prepared.")) return true;
              assertActiveGenerationUpdate(await repository.markRecoverable({ ...scope, providerResponseId: null, providerFinishReason: null,
                errorCode: "continuity_review_unavailable", errorMessage: "The required continuity repair request cannot fit the frozen provider budget.",
                recoveryMetadata: { retryable: true, stage: "semantic_repair", reason: "repair_request_overflow" } }), "saving semantic repair overflow");
              return true;
            }
            const oldLedger = orchestration.logicalAttempt;
            const ledger = oldLedger ?? { version: 1 as const, id: job.id, semanticRepairsConsumed: 0, reviewsConsumed: 0,
              automaticRepairsConsumed: orchestration.automaticRepair ? 1 : 0, choiceRepairsConsumed: orchestration.choiceRepair ? 1 : 0,
              eventCoverageRepairsConsumed: orchestration.eventCoverageRepair ? 1 : 0 };
            if (ledger.semanticRepairsConsumed >= 1) {
              if (await reofferFailedAuthorizedRetry("continuity", "The authorized continuity repair allowance was already consumed.")) return true;
              assertActiveGenerationUpdate(await repository.markRecoverable({ ...scope, providerResponseId: null, providerFinishReason: null,
                errorCode: "continuity_review_conflict", errorMessage: "The one permitted semantic repair was already consumed.",
                recoveryMetadata: { retryable: true, stage: "semantic_repair", repairConsumed: true } }), "saving exhausted semantic repair");
              return true;
            }
            // The reservation, exact wire body, conflict evidence, and allowance are all durable before dispatch.
            orchestration = await persistOrchestration(repository, scope, job, {
              sourceEvidenceManifest: preparedRepair.manifest,
              logicalAttempt: { ...ledger, semanticRepairsConsumed: ledger.semanticRepairsConsumed + 1 },
              semanticRepair: { version: 1, scope: repairScope, rejectedFinalStoryHash,
                rejectedMainDraftHash: orchestration.validatedMainDraft?.draftHash ?? sha256(stableStringify(parsed.story)),
                repairRequestBody: preparedRepair.body, repairRequestPayloadHash: preparedRepair.requestHash,
                requiredEvidenceIds: preparedRepair.requiredEvidenceIds, status: "dispatched" }
            });
            let repairResponse: ProviderResult;
            let repairedStory: StoryTurnOutput | null = null;
            try {
              repairResponse = await phase("story_continuity_repair", () => callCampaignTextProvider(dependencies, provider, job, "story_continuity_repair", preparedRepair.request));
              if (!repairResponse.outputLimited) {
                if (extensionOnly) repairedStory = parseEventExtension(
                  repairResponse.content,
                  orchestration.validatedMainDraft?.story.narration ?? parsed.story.narration
                );
                else {
                  const parsedRepair = parseStoryOutput(repairResponse.content, storyMemoryDefaults);
                  repairedStory = parsedRepair.ok ? parsedRepair.story : null;
                  const originalMain = orchestration.validatedMainDraft?.story.narration ?? parsed.story.narration;
                  const oldAppend = committedStory.narration.startsWith(originalMain) ? committedStory.narration.slice(originalMain.length).trim() : "";
                  if (oldAppend && repairedStory?.narration.includes(oldAppend)) repairedStory = null;
                }
              }
            } catch (error) {
              if (isRecoverableIntegrityError(error)) throw error;
              repairResponse = null as unknown as ProviderResult;
            }
            if (!repairedStory) {
              if (await reofferFailedAuthorizedRetry("continuity", "The authorized continuity repair did not produce a usable candidate.")) return true;
              assertActiveGenerationUpdate(await repository.markRecoverable({ ...scope, providerResponseId: null, providerFinishReason: null,
                errorCode: "continuity_review_conflict", errorMessage: "The reserved semantic repair was invalid and cannot be repeated.",
                recoveryMetadata: { retryable: true, stage: "semantic_repair", repairConsumed: true } }), "saving invalid semantic repair");
              return true;
            }
            const repairedPrepared = preparedRequestForResult(repairResponse, provider, preparedRepair.request);
            const repairedCheckpoint = { ...orchestration.semanticRepair!, status: "validated" as const, repairedStory,
              repairedStoryHash: sha256(stableStringify(repairedStory)), response: repairResponse };
            const repairRestart = extensionOnly ? {
              semanticRepair: repairedCheckpoint,
              extension: {
                story: repairedStory, finalStoryHash: stableStringify(repairedStory), producingAttempt: job.attempts,
                producingOperation: "event_extension" as const,
                validatedMainDraftHash: orchestration.validatedMainDraft!.draftHash,
                producingRequestPayloadHash: repairedPrepared.payloadHash, producingRequestBody: repairedPrepared.body,
                providerConfigurationHash: effectiveProviderConfigurationHash(provider, job), response: repairResponse,
                sentFactIds: sentCanonicalFactIds(repairedPrepared.body)
              },
              extensionError: undefined, eventCoverageRepair: undefined, continuityReview: undefined,
              ...(savedReview.success ? { generationReview: savedReview.data } : {})
            } : {
              semanticRepair: repairedCheckpoint,
              validatedMainDraft: {
                version: 2 as const, ownerUserId: job.owner_user_id, campaignId: job.campaign_id, worldVersionId: job.world_version_id || null,
                baseIdentity: job.generation_base_identity, promptProtocolVersion: job.prompt_protocol_version, providerId: provider.id, providerModel: provider.model,
                ...(frozenGenerationPolicyIdentity ? { generationPolicyIdentity: frozenGenerationPolicyIdentity } : {}),
                providerConfigurationHash: effectiveProviderConfigurationHash(provider, job), action: job.action, originalInputHash: sha256(storyInput),
                requestBody: repairedPrepared.body, requestPayloadHash: repairedPrepared.payloadHash, draftHash: sha256(stableStringify(repairedStory)),
                producingAttempt: job.attempts, story: repairedStory, response: repairResponse, sentFactIds: sentCanonicalFactIds(repairedPrepared.body)
              },
              afterEvents: undefined, afterTriggerError: "", extension: undefined, extensionError: undefined,
              eventCoverageRepair: undefined, choiceRepair: undefined, continuityReview: undefined,
              ...(savedReview.success ? { generationReview: savedReview.data } : {})
            };
            orchestration = await persistOrchestration(repository, scope, job, repairRestart);
            if (repository.restartAfterSemanticRepair
              && !await repository.restartAfterSemanticRepair(scope)) {
              throw Object.assign(new Error("Semantic repair restart lost its lease."), { code: "lease_lost" });
            }
            // `job.prompt_snapshot` is normalized to templates above for normal
            // prompt lookup; a restart must retain the frozen continuity pair.
            return executeLoadedGeneration(dependencies, workerId, leaseSeconds, { ...job,
              prompt_snapshot: frozenPromptEnvelope as PromptSnapshot,
              orchestration_private: orchestration });
          }
        }
        const code = checkpoint.verdict === "conflict" ? "continuity_review_conflict" : "continuity_review_unavailable";
        assertActiveGenerationUpdate(await repository.markRecoverable({ ...scope, providerResponseId: result.responseId || null, providerFinishReason: result.finishReason || null,
          errorCode: code, errorMessage: "The final story could not pass continuity review.", recoveryMetadata: { diagnostic: { ...reviewDiagnostic, code, action: "discard_and_reenqueue" } }
        }), "saving enforcing review recovery");
        return true;
      }
    }
    assertActiveGenerationUpdate(await repository.markCommitting(scope), "entering commit");
    const acceptedCommitCollaborators: AcceptedGenerationCommitCollaborators = {
      memory: collaborators.memory,
      illustration: collaborators.illustration,
      attributeGenerationCostsToTurn: collaborators.attributeGenerationCostsToTurn
    };
    const { turnId } = await phase("turn_commit", () => repository.commitAcceptedTurn({
      scope,
      job,
      story: committedStory,
      provider,
      response: result,
      contextFingerprint,
      contextDiagnostics,
      sentFactIds: finalSentFactIds,
      chronicleRetrieval,
      inputs,
      orchestration,
      fictionAction: safeAction,
      collaborators: acceptedCommitCollaborators,
      onIllustrationEnqueueError(error, acceptedTurnId) {
        logger.warn({
          event: "accepted_turn_illustration_enqueue_failed",
          generationJobId: job.id,
          campaignId: job.campaign_id,
          turnId: acceptedTurnId,
          errorCode: typeof error === "object" && error !== null && "code" in error
            ? String((error as { code: unknown }).code)
            : undefined,
          errorMessage: error instanceof Error ? error.message : String(error)
        });
      }
    }));
    logger.info({
      event: "turn_generation_completed",
      ...generationLogContext(job, workerId),
      resultTurnId: turnId,
      providerResponseId: result.responseId || null,
      finishReason: result.finishReason || null,
      chronicleRetrieval: {
        configuredImplementation: chronicleRetrieval.configuredImplementation,
        effectiveImplementation: chronicleRetrieval.effectiveImplementation,
        effectiveMode: chronicleRetrieval.effectiveMode,
        providerSource: chronicleRetrieval.provider.resolutionSource,
        providerType: chronicleRetrieval.provider.providerType,
        model: chronicleRetrieval.provider.model,
        queryVectorPath: chronicleRetrieval.queryVectorPath,
        providerCallOutcome: chronicleRetrieval.providerCallOutcome,
        fallbackCode: chronicleRetrieval.fallbackCode
      },
      durationMs: Date.now() - generationStartedAt
    });
  } catch (error) {
    if (isRecoverableIntegrityError(error)) {
      const diagnostic = recoverableIntegrityDiagnostic(error);
      const recovered = await repository.markRecoverable({
        ...scope,
        providerResponseId: null,
        providerFinishReason: null,
        ...diagnostic
      });
      if (recovered) {
        logger.warn({
          event: "turn_generation_recoverable",
          ...generationLogContext(job, workerId),
          errorCode: diagnostic.errorCode,
          durationMs: Date.now() - generationStartedAt
        });
      }
      return true;
    }
    const transportError = providerTransportErrorDetails(error);
    const rawCode = transportError
      ? (transportError.timedOut ? "provider_request_timeout" : "provider_transport_error")
      : errorCodeFrom(error) || "generation_failed";
    const code = safeLogErrorCode(rawCode, "generation_failed");
    const failed = await repository.markFailed({
      ...scope,
      errorCode: PUBLIC_GENERATION_FAILURE_CODE,
      errorMessage: PUBLIC_GENERATION_FAILURE_MESSAGE,
      recoveryMetadata: transportError ? { transportError } : {},
      lastFailureDiagnostic: failureDiagnosticFor(error, job.attempts, activePhase)
    });
    if (failed) {
      logger.error({
        event: "turn_generation_failed",
        ...generationLogContext(job, workerId),
        errorCode: code,
        durationMs: Date.now() - generationStartedAt,
        transportTimedOut: Boolean(transportError?.timedOut)
      });
    }
    if (job.streaming_segments_state?.provisionalSetId) {
      try {
        await collaborators.illustration.orphanProvisionalSet(pool, {
          ownerUserId: job.owner_user_id,
          campaignId: job.campaign_id,
          generationJobId: job.id
        });
      } catch {
        // Provisional cleanup failure cannot replace the generation result.
      }
    }
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}
