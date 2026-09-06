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
  type
  PromptSnapshot,
  PromptTemplateKey
} from "../../../packages/contracts/src/prompt-library.js";
import { renderPromptTemplate } from "../../../packages/contracts/src/prompt-library.js";
import {
  storyLengthProfileFromUnknown,
  storyLengthWordRange,
  type StoryLengthWordRange
} from "../../../packages/contracts/src/story-settings.js";
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
  buildEventTriggerPrompt,
  buildRpgAssessmentPrompt,
  buildSceneCoveragePrompt,
  buildStoryUserPrompt,
  compactStoryLengthWordRange,
  containsMechanicsLanguage,
  extractPartialNarration,
  ContextBudgetError,
  planContext,
  serializeProviderRequest,
  fictionGuidanceForEvents,
  fictionGuidanceForRoll,
  formatNarrationParagraphs,
  isNarrationFieldComplete,
  localRpgAssessment,
  logProviderTransportError,
  mechanicsLanguageMatches,
  mechanicsLeakFields,
  parseEventExtension,
  parseRpgAssessment,
  parseSceneCoverageOutput,
  parseStoryOutput,
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
  estimateTokens,
  isIllustrationSegmentEligible,
  sha256,
  stableStringify
} from "../../../packages/domain/src/index.js";
import { logger } from "../../../packages/logger/src/index.js";

type GenerationTextProvider = RuntimeTextExecution;

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
  | "story_recovery" | "event_trigger_after" | "event_extension"
  | "scene_coverage_validation" | "scene_coverage_rewrite";

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
  | "scene_coverage_validation"
  | "scene_coverage_rewrite"
  | "after_event_evaluation"
  | "event_extension"
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

function budgetTokenEstimate(text: string): number {
  return Math.max(estimateTokens(text), Math.ceil(text.length / 3));
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
  return {
    errorCode: RECOVERABLE_INTEGRITY_ERROR_CODES.has(errorCode || "")
      ? errorCode!
      : "context_budget_exceeded",
    errorMessage: "Generation context could not be safely prepared.",
    recoveryMetadata: {
      retryable: true,
      ...(scope ? { budgetScope: scope } : {})
    }
  };
}

function safeLogErrorCode(value: unknown, fallback = "unclassified_error"): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  return /^[a-z][a-z0-9_]{0,63}$/.test(normalized) ? normalized : fallback;
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

function sentCanonicalFactIds(storyInput: string): string[] {
  let rendered: unknown;
  try {
    rendered = JSON.parse(storyInput);
  } catch {
    return [];
  }
  if (!rendered || typeof rendered !== "object") return [];
  const authority = (rendered as { authoritative_context?: unknown }).authoritative_context;
  if (!authority || typeof authority !== "object") return [];
  const continuity = (authority as { currentContinuity?: unknown }).currentContinuity;
  if (!continuity || typeof continuity !== "object") return [];
  const facts = (continuity as { canonicalFacts?: unknown }).canonicalFacts;
  if (!Array.isArray(facts)) return [];
  return [...new Set(facts.flatMap((fact) => {
    if (!fact || typeof fact !== "object") return [];
    const id = (fact as { id?: unknown }).id;
    return typeof id === "string" ? [id] : [];
  }))];
}

function compatibleValidatedMainDraft(
  value: GenerationOrchestrationState["validatedMainDraft"] | undefined,
  job: GenerationExecutionPayload,
  provider: GenerationTextProvider,
  storyInput: string
) {
  if (!value) return null;
  const validResponse = value.response && typeof value.response.content === "string"
    && typeof value.response.outputLimited === "boolean";
  const parsedStory = storyTurnOutputSchema.safeParse(value.story);
  if (!validResponse || !parsedStory.success) {
    throw Object.assign(new Error("The persisted validated draft checkpoint is malformed."), {
      code: "generation_checkpoint_incompatible"
    });
  }
  if (value.version !== 1
      || value.ownerUserId !== job.owner_user_id
      || value.campaignId !== job.campaign_id
      || value.worldVersionId !== (job.world_version_id || null)
      || stableStringify(value.baseIdentity) !== stableStringify(job.generation_base_identity)
      || value.promptProtocolVersion !== job.prompt_protocol_version
      || value.providerId !== provider.id
      || value.providerModel !== provider.model
      || value.action !== job.action
      || value.requestPayloadHash !== sha256(storyInput)
      || value.draftHash !== sha256(stableStringify(parsedStory.data))) {
    throw Object.assign(new Error("The persisted validated draft does not match this generation input."), {
      code: "generation_checkpoint_incompatible"
    });
  }
  return { ...value, story: parsedStory.data };
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

type PromptCandidate = Readonly<{ id: string; turnId: string | null; ordinal: number; kind: string; content: string; estimatedTokens: number; rank: number }>;

function candidateRecord(candidate: Readonly<Record<string, unknown>>): PromptCandidate {
  return {
    id: String(candidate.id || ""),
    turnId: typeof candidate.turnId === "string" ? candidate.turnId : null,
    ordinal: Number(candidate.ordinal || 0),
    kind: String(candidate.kind || "turn_fiction"),
    content: String(candidate.content || ""),
    estimatedTokens: Number(candidate.tokenEstimate || 0),
    rank: Number(candidate.rank || 0)
  };
}

/** Builds the one private context representation used for selection and the sent story body. */
function planGenerationPromptContext(
  context: MemoryGenerationAuthorityContext,
  provider: GenerationTextProvider,
  systemPrompt: string,
  action: string,
  guidance: string[],
  storyLength: StoryLengthWordRange,
  inputMode: "action" | "scene",
  contextLimit: number,
  inputLimit: number
) {
  const authority = context.authority;
  const authorityContext = {
    authoritativeRules: Array.isArray(authority.rules) ? authority.rules : [],
    worldCanon: authority.worldCanon ?? {},
    selectedCharacterId: authority.selectedCharacterId ?? null,
    currentContinuity: authority.currentContinuity ?? {},
    currentScene: authority.latestTurn ?? null,
    chronicle: [] as readonly PromptCandidate[]
  };
  const candidates = context.candidates.map(candidateRecord).filter((candidate) => candidate.id && candidate.content);
  const serializationProfile: TextProviderProfile = {
    ...provider,
    // Serialization needs the provider wire shape only; the live execution
    // binding retains its credential and destination outside this planner.
    baseUrl: ""
  };
  const authorityRevision = sha256(stableStringify({ baseIdentity: context.baseIdentity, authority }));
  const blocks = [
    { id: "authority", revision: authorityRevision, content: stableStringify(authorityContext), protected: true, priority: 0, ordinal: 0, scope: "authority" },
    ...candidates.map((candidate) => ({
      id: candidate.id,
      revision: sha256(stableStringify(candidate)),
      content: candidate.content,
      protected: false,
      priority: Number.isFinite(Number(candidate.rank)) ? Number(candidate.rank) : Number.MAX_SAFE_INTEGER,
      ordinal: Number(candidate.ordinal || 0),
      scope: "chronicle"
    }))
  ];
  const promptContext = (selected: readonly Readonly<{ id: string }>[]) => ({
    ...authorityContext,
    chronicle: selected.filter((block) => block.id !== "authority")
      .map((block) => candidates.find((candidate) => candidate.id === block.id))
      .filter((candidate): candidate is PromptCandidate => Boolean(candidate))
  });
  const plan = planContext({
    blocks,
    contextLimit: Math.min(contextLimit, inputLimit),
    inputLimit,
    count: (value) => value.length,
    serializeContext: (selected) => stableStringify(promptContext(selected)),
    contextValue: promptContext,
    serializeRequest: (selected) => serializeProviderRequest(serializationProfile, {
      systemPrompt,
      input: buildStoryUserPrompt(selected, action, false, guidance, storyLength, inputMode)
    }).body,
    protectedScope: "campaign_context"
  });
  const selectedContext = promptContext(plan.selected);
  return {
    promptContext: selectedContext,
    storyInput: buildStoryUserPrompt(selectedContext, action, false, guidance, storyLength, inputMode),
    contextPlan: plan
  };
}

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
    const result = await provider.execute({
      ...request,
      // Every generation operation is serialized and checked before transport.
      // The transport adapter sends these prepared bytes without rebuilding them.
      canonicalBudgeting: true
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
  const phase = <T>(phaseName: TurnGenerationPhase, operation: () => Promise<T>) =>
    runTurnGenerationPhase(diagnosticContext, phaseName, generationStartedAt, operation);
  if (!promptSnapshotSchema.safeParse(job.prompt_snapshot).success) {
    assertActiveGenerationUpdate(await repository.markRecoverable({
      jobId: job.id,
      ownerUserId: job.owner_user_id,
      workerId,
      providerResponseId: null,
      providerFinishReason: null,
      errorCode: "generation_prompt_snapshot_invalid",
      errorMessage: "Saved generation instructions are invalid.",
      recoveryMetadata: { reason: "generation_prompt_snapshot_invalid" }
    }), "saving invalid prompt snapshot recovery state");
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
    const provider = await phase("provider_loading", () => collaborators.loadTextExecution(
      job.owner_user_id,
      job.provider_profile_id,
      job.requested_model
    ));

    const preparedInput = await phase("input_preparation", async () => {
      const safeAction = safeTurnInput(job.action);
      const storyLength = snapshottedStoryLength(job.context_options);
      const requestedContextWindow = Number(
        job.context_options.modelContextWindowTokens || provider.contextWindowTokens
      );
      const effectiveContextWindow = Math.min(provider.contextWindowTokens, requestedContextWindow);
      const inputTokenLimit = effectiveContextWindow - provider.maxOutputTokens;
      const emptyPromptContext = { worldCanon: {}, campaignCanon: {}, chronicle: [], currentScene: null };
      const storySystemPrompt = collaborators.promptFromSnapshot(job.prompt_snapshot, "story_system");
      const fixedPromptEnvelope = budgetTokenEstimate(storySystemPrompt)
        + budgetTokenEstimate(buildStoryUserPrompt(
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
      const safeContextBudget = Math.max(512, Math.min(
        Number(job.context_options.budgetTokens || 32000),
        inputTokenLimit - fixedPromptEnvelope
      ));
      return {
        safeAction,
        storyLength,
        effectiveContextWindow,
        inputTokenLimit,
        storySystemPrompt,
        safeContextBudget
      };
    });
    const {
      safeAction,
      storyLength,
      effectiveContextWindow,
      inputTokenLimit,
      storySystemPrompt,
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
        expectedBaseIdentity: job.generation_base_identity
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

    if (orchestration.roll === undefined) {
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
    if (orchestration.beforeEvents === undefined) {
      await phase("before_event_evaluation", async () => {
        let activated: ActivatedEvent[] = [];
        let triggerError = "";
        if (!inputs.suppressEventTriggers) {
          const triggers = inputs.eventTriggers.filter((trigger) => trigger.timing === "before");
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
        ...fictionGuidanceForRoll(orchestration.roll || null),
        ...fictionGuidanceForEvents(orchestration.beforeEvents || [])
      ].filter((entry) => entry && !containsMechanicsLanguage(entry));
      assertActiveGenerationUpdate(await repository.markGenerating(scope), "entering generation");
      const planned = planGenerationPromptContext(
        generationContext, provider, storySystemPrompt, safeAction, safeGuidance,
        storyLength, job.resolved_input_mode, safeContextBudget, inputTokenLimit
      );
      promptContext = planned.promptContext;
      const { storyInput, contextPlan } = planned;
      const contextFingerprint = sha256(stableStringify({
        provider: provider.id,
        model: provider.model,
        protocol: job.prompt_protocol_version,
        expectedTurnNumber: job.expected_turn_number,
        action: safeAction,
        inputMode: job.resolved_input_mode,
        storyLength,
        context: promptContext
      }));
      const contextDiagnostics = {
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
      return { storyInput, contextFingerprint, contextDiagnostics, storyMemoryDefaults };
    });
    const { storyInput, contextFingerprint, contextDiagnostics, storyMemoryDefaults } = promptPreparation;
    const plannedSentFactIds = sentCanonicalFactIds(storyInput);
    const validatedDraft = compatibleValidatedMainDraft(
      orchestration.validatedMainDraft,
      job,
      provider,
      storyInput
    );
    const sentFactIds = validatedDraft?.sentFactIds || plannedSentFactIds;

    const streamingIllustration = await phase("streaming_illustration_setup", async () => {
      const illustrationConfig = await collaborators.illustration.loadStreamingIllustrationConfig(
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
    if (!validatedDraft && orchestration.automaticRepair) {
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
    let result = validatedDraft?.response || await phase("story_generation", () =>
      callCampaignTextProvider(dependencies, provider, job, "story_generation", primaryRequest));
    let validation = validatedDraft
      ? {
          parsed: { ok: true as const, story: validatedDraft.story },
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
        automaticRepair: {
          stage: recoveryKind,
          rejectedDraftHash: sha256(rejectedResponse),
          consumedAttempt: job.attempts
        }
      });
      result = await phase("story_recovery", () => callCampaignTextProvider(
        dependencies,
        provider,
        job,
        "story_recovery",
        {
          ...baseRequest,
          recoveryInput: recoveryPromptFromSnapshot(
            collaborators,
            job,
            recoveryReason,
            initialValidationErrors,
            storyLength
          ),
          rejectedResponse
        }
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
    const parsedNarration = parsed.story.narration;

    if (job.resolved_input_mode === "scene") {
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
        result = await phase("scene_coverage_rewrite", () => callCampaignTextProvider(
          dependencies,
          provider,
          job,
          "scene_coverage_rewrite",
          {
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
          }
        ));
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
          version: 1,
          ownerUserId: job.owner_user_id,
          campaignId: job.campaign_id,
          worldVersionId: job.world_version_id || null,
          baseIdentity: job.generation_base_identity,
          promptProtocolVersion: job.prompt_protocol_version,
          providerId: provider.id,
          providerModel: provider.model,
          action: job.action,
          requestPayloadHash: sha256(storyInput),
          draftHash: sha256(stableStringify(parsed.story)),
          producingAttempt: job.attempts,
          story: parsed.story,
          response: result,
          sentFactIds: plannedSentFactIds
        },
        automaticRepair: undefined
      });
    }
    assertActiveGenerationUpdate(await repository.markValidating(scope), "entering validation");
    if (orchestration.afterEvents === undefined) {
      await phase("after_event_evaluation", async () => {
        let activated: ActivatedEvent[] = [];
        let triggerError = "";
        if (!inputs.suppressEventTriggers) {
          const triggers = inputs.eventTriggers.filter((trigger) => trigger.timing === "after");
          try {
            activated = await evaluateTriggers(
              dependencies,
              provider,
              "after",
              promptContext,
              job,
              triggers,
              parsed.story.narration
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
    const immediateEvents = (orchestration.afterEvents || []).filter((event) => event.addTextAfter);
    let extensionFailure: string | null = null;
    if (immediateEvents.length && !orchestration.extension) {
      await phase("event_extension", async () => {
        try {
          const guidance = fictionGuidanceForEvents(immediateEvents);
          if (!guidance.length) {
            throw new Error("Activated extension instructions were not safe for a fiction prompt.");
          }
          const extensionResponse = await callCampaignTextProvider(
            dependencies,
            provider,
            job,
            "event_extension",
            {
              systemPrompt: collaborators.promptFromSnapshot(job.prompt_snapshot, "event_extension"),
              input: buildEventExtensionPrompt(parsed.story, guidance),
              budgetOutput: {
                kind: "event_extension",
                preservedNarration: parsed.story.narration,
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
              producingAttempt: job.attempts
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
    if (mechanicsLeakFields(committedStory).length) {
      throw new Error("Mechanics validation invariant failed after event extension.");
    }
    if (immediateEvents.length) {
      let eventCoverage: ReturnType<typeof parseSceneCoverageOutput> | null = null;
      try {
        const coverageResponse = await phase("scene_coverage_validation", () =>
          callCampaignTextProvider(dependencies, provider, job, "scene_coverage_validation", {
            systemPrompt: collaborators.promptFromSnapshot(job.prompt_snapshot, "scene_coverage"),
            input: buildSceneCoveragePrompt(
              fictionGuidanceForEvents(immediateEvents).join("\n"),
              committedStory.narration
            )
          })
        );
        eventCoverage = coverageResponse.outputLimited ? null : parseSceneCoverageOutput(coverageResponse.content);
      } catch (error) {
        if (isRecoverableIntegrityError(error)) throw error;
      }
      if (!eventCoverage?.covered) {
        const rejectedFinalStoryHash = stableStringify(committedStory);
        const existingRepair = orchestration.eventCoverageRepair;
        if (existingRepair
          && (existingRepair.rejectedFinalStoryHash === rejectedFinalStoryHash
            || existingRepair.repairedFinalStoryHash === rejectedFinalStoryHash)) {
          assertActiveGenerationUpdate(await repository.markRecoverable({
            ...scope,
            providerResponseId: result.responseId || null,
            providerFinishReason: result.finishReason || null,
            errorCode: "event_coverage_repair_consumed",
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
          consumedAttempt: job.attempts
        };
        orchestration = await persistOrchestration(repository, scope, job, { eventCoverageRepair: repair });
        let repairedStory: StoryTurnOutput | null = null;
        try {
          const repairResponse = await phase("scene_coverage_rewrite", () => callCampaignTextProvider(
            dependencies,
            provider,
            job,
            "scene_coverage_rewrite",
            {
              ...baseRequest,
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
            }
          ));
          if (!repairResponse.outputLimited) {
            const repaired = parseStoryOutput(repairResponse.content, storyMemoryDefaults);
            if (repaired.ok && !mechanicsLeakFields(repaired.story).length) repairedStory = repaired.story;
          }
        } catch (error) {
          if (isRecoverableIntegrityError(error)) throw error;
        }
        if (repairedStory) {
          const repairedFinalStoryHash = stableStringify(repairedStory);
          orchestration = await persistOrchestration(repository, scope, job, {
            extension: {
              story: repairedStory,
              finalStoryHash: repairedFinalStoryHash,
              producingAttempt: job.attempts
            },
            eventCoverageRepair: { ...repair, repairedFinalStoryHash },
            extensionError: undefined
          });
          committedStory = repairedStory;
          try {
            const coverageResponse = await phase("scene_coverage_validation", () =>
              callCampaignTextProvider(dependencies, provider, job, "scene_coverage_validation", {
                systemPrompt: collaborators.promptFromSnapshot(job.prompt_snapshot, "scene_coverage"),
                input: buildSceneCoveragePrompt(
                  fictionGuidanceForEvents(immediateEvents).join("\n"),
                  repairedStory.narration
                )
              })
            );
            eventCoverage = coverageResponse.outputLimited ? null : parseSceneCoverageOutput(coverageResponse.content);
          } catch (error) {
            if (isRecoverableIntegrityError(error)) throw error;
            eventCoverage = null;
          }
        }
        if (repairedStory && eventCoverage?.covered) {
          // The full replacement was revalidated; commit the durable final story below.
        } else {
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
      sentFactIds,
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
      recoveryMetadata: transportError ? { transportError } : {}
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
