import type {
  GenerationExecutor,
  IllustrationGenerationTransactionPort,
  MemoryGenerationTransactionPort,
  StreamingIllustrationConfig
} from "../../../packages/application/src/index.js";
import {
  PUBLIC_GENERATION_FAILURE_CODE,
  PUBLIC_GENERATION_FAILURE_MESSAGE,
  type PlayerEventTrigger,
  type StoryTurnOutput
} from "../../../packages/contracts/src/generation.js";
import type { MemoryContextQuery } from "../../../packages/contracts/src/memory.js";
import type {
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
  callTextProvider,
  compactStoryLengthWordRange,
  containsMechanicsLanguage,
  extractPartialNarration,
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
import {
  StreamingSegmentTracker,
  characterVisualReference,
  estimateTokens,
  isIllustrationSegmentEligible,
  sha256,
  stableStringify
} from "../../../packages/domain/src/index.js";
import { logger } from "../../../packages/logger/src/index.js";

type GenerationTextProvider = TextProviderProfile & {
  id: string;
  name: string;
};

type GenerationContextPreview = {
  campaign: {
    id: string;
    worldVersionId: string;
    selectedCharacterId: string | null;
    characterProfileRevision: number;
  };
  selectedCompression: unknown;
  retrieval: unknown;
  scopes: Record<string, unknown> & {
    chronicle: Array<{
      id: string;
      content: string;
      reason: string;
    }>;
  };
};

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
  loadTextProvider(
    pool: DatabasePool,
    ownerUserId: string,
    providerProfileId: string,
    credentialSecret: string,
    model?: string
  ): Promise<GenerationTextProvider>;
  resolvePromptSnapshot(
    database: DatabaseClient | DatabasePool,
    ownerUserId: string,
    campaignId?: string
  ): Promise<PromptSnapshot>;
  promptFromSnapshot(
    snapshot: PromptSnapshot | Record<string, unknown> | undefined,
    key: PromptTemplateKey
  ): string;
  promptProtocolVersion(snapshot: PromptSnapshot | Record<string, unknown> | undefined): string;
  recordProfileCost(
    database: DatabaseClient | DatabasePool,
    profile: GenerationTextProvider,
    attribution: GenerationCostAttribution,
    result: ProviderResult
  ): Promise<string | null>;
  turnReportedCosts(
    database: DatabaseClient | DatabasePool,
    ownerUserId: string,
    turnIds: string[]
  ): Promise<Map<string, unknown>>;
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
  credentialSecret: string;
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
    emitDiagnostic(() => logger.error({
      event: "turn_generation_phase_failed",
      ...base,
      errorName: diagnosticErrorName(error),
      errorCode: diagnosticErrorCode(error),
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
    const result = await callTextProvider(provider, request);
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
    const rawErrorCode = transportError?.transportCode || errorCodeFrom(error);
    const errorCode = rawErrorCode ? safeLogErrorCode(rawErrorCode) : null;
    logger.warn({
      event: "turn_generation_provider_failed",
      ...generationLogContext(job),
      storyOperation: operation,
      providerType: provider.providerType,
      requestedModel: provider.model,
      streaming: typeof request.onChunk === "function",
      recovery: Boolean(request.recoveryInput),
      errorName: error instanceof Error ? error.name : "Error",
      ...(errorCode ? { errorCode } : {}),
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
  const { repository, collaborators, pool, credentialSecret } = dependencies;
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
  logger.info({
    event: "turn_generation_started",
    ...generationLogContext(job, workerId)
  });
  const heartbeat = setInterval(() => {
    void repository.renewLease(scope, leaseSeconds).catch(() => undefined);
  }, Math.max(5000, Math.floor(leaseSeconds * 1000 / 3)));

  try {
    const provider = await phase("provider_loading", () => collaborators.loadTextProvider(
      pool,
      job.owner_user_id,
      job.provider_profile_id,
      credentialSecret,
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

    const context = (await phase("context_retrieval", () => collaborators.memory.buildContextPreview(
      pool,
      {
        ownerUserId: job.owner_user_id,
        campaignId: job.campaign_id,
        worldVersionId: job.world_version_id ?? "",
        request: { ...job.context_options, budgetTokens: safeContextBudget, query: safeAction },
        costAttribution: { generationJobId: job.id, operation: "retrieval_embedding" },
        ...(job.operation_kind === "replace_latest"
          ? {
              throughTurnNumber: job.base_turn_number ?? 0,
              stateOverride: job.base_state_private,
              scratchpadSafeForPrompt: job.base_scratchpad_safe_for_prompt
            }
          : {})
      }
    ))) as GenerationContextPreview;
    const promptContext = context.scopes;
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
      let storyInput = buildStoryUserPrompt(
        promptContext,
        safeAction,
        false,
        safeGuidance,
        storyLength,
        job.resolved_input_mode
      );
      const removalPriority = ["chronological", "relevant", "summary_checkpoint", "recent", "open_threads"];
      while (budgetTokenEstimate(storySystemPrompt) + budgetTokenEstimate(storyInput) > inputTokenLimit
          && promptContext.chronicle.length) {
        let removalIndex = -1;
        for (const reason of removalPriority) {
          removalIndex = promptContext.chronicle.findIndex((memory) => memory.reason === reason);
          if (removalIndex >= 0) break;
        }
        promptContext.chronicle.splice(removalIndex >= 0 ? removalIndex : 0, 1);
        storyInput = buildStoryUserPrompt(
          promptContext,
          safeAction,
          false,
          safeGuidance,
          storyLength,
          job.resolved_input_mode
        );
      }
      const estimatedPromptTokens = budgetTokenEstimate(storySystemPrompt)
        + budgetTokenEstimate(storyInput);
      if (estimatedPromptTokens > inputTokenLimit) {
        throw Object.assign(new Error(
          `The fixed authoritative story context requires about ${estimatedPromptTokens} input tokens but only ${inputTokenLimit} are available.`
        ), { code: "context_budget_exceeded" });
      }
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
        estimatedPromptTokens,
        campaignId: context.campaign.id,
        worldVersionId: context.campaign.worldVersionId,
        selectedCharacterId: context.campaign.selectedCharacterId,
        characterProfileRevision: context.campaign.characterProfileRevision,
        promptProtocolVersion: job.prompt_protocol_version,
        storyLength,
        selectedMemoryIds: promptContext.chronicle.map((memory) => memory.id),
        selectedMemoryHashes: promptContext.chronicle.map((memory) => sha256(memory.content)),
        selectedCompression: context.selectedCompression,
        retrieval: context.retrieval
      };
      const storyMemoryDefaults = {
        ...storyMemoryDefaultsFromContext(promptContext),
        ...inputs.storyMemoryDefaults
      };
      return { storyInput, contextFingerprint, contextDiagnostics, storyMemoryDefaults };
    });
    const { storyInput, contextFingerprint, contextDiagnostics, storyMemoryDefaults } = promptPreparation;

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
    let result = await phase("story_generation", () =>
      callCampaignTextProvider(dependencies, provider, job, "story_generation", primaryRequest));
    let validation = await phase("story_validation", async () => {
      const parsed = parseStoryOutput(result.content, storyMemoryDefaults);
      const firstReason: "output_limit" | "invalid_json" | "invalid_schema" | "mechanics_leak" | null =
        result.outputLimited ? "output_limit" : (!parsed.ok ? parsed.code : null);
      const initialValidationErrors = parsed.ok ? [] : parsed.errors;
      const initialAttemptNumber = job.attempts * 2 - 1;
      logger.info({
        event: "turn_generation_validation_completed",
        ...generationLogContext(job, workerId),
        storyOperation: "story_generation",
        valid: parsed.ok && !result.outputLimited,
        outputLimited: result.outputLimited,
        validationCode: firstReason,
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
    if (firstReason) {
      const recoveryReason = firstReason;
      const recoveryKind = recoveryReason === "mechanics_leak"
        ? "mechanics_cleanup"
        : recoveryReason === "output_limit" ? "compact_completion" : "schema_repair";
      const rejectedResponse = result.content;
      logger.warn({
        event: "turn_generation_recovery_started",
        ...generationLogContext(job, workerId),
        firstReason: recoveryReason,
        recoveryKind,
        initialAttemptNumber,
        validationErrorCount: initialValidationErrors.length
      });
      result = await phase("story_recovery", () => callCampaignTextProvider(
        dependencies,
        provider,
        job,
        "story_recovery",
        {
          ...baseRequest,
          ...(provider.providerType === "lmstudio" && result.responseId
              && recoveryReason !== "mechanics_leak"
            ? { previousResponseId: result.responseId }
            : {}),
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
    if (result.outputLimited || validationFailure) {
      const code = result.outputLimited
        ? "output_limit"
        : validationFailure?.code || "invalid_schema";
      const messages = result.outputLimited
        ? ["The provider stopped before a complete story object was available."]
        : validationFailure?.errors || ["Story validation failed."];
      assertActiveGenerationUpdate(await repository.markRecoverable({
        ...scope,
        providerResponseId: result.responseId || null,
        providerFinishReason: result.finishReason || null,
        errorCode: code,
        errorMessage: messages.join(" ").slice(0, 4000),
        recoveryMetadata: { retryable: true, attemptCount: firstReason ? 2 : 1 }
      }), "saving recovery state");
      logger.warn({
        event: "turn_generation_recoverable",
        ...generationLogContext(job, workerId),
        errorCode: code,
        attemptCount: firstReason ? 2 : 1,
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
      } catch {
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
          } catch {
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
    if (immediateEvents.length && !orchestration.extension && !orchestration.extensionError) {
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
              input: buildEventExtensionPrompt(parsed.story.narration, guidance)
            }
          );
          if (extensionResponse.outputLimited) {
            throw new Error("The optional event extension reached its output limit.");
          }
          const extension = parseEventExtension(extensionResponse.content);
          orchestration = await persistOrchestration(repository, scope, job, {
            extension: {
              additionalText: extension.additional_text,
              ...(extension.scratchpad !== undefined
                ? { scratchpad: extension.scratchpad }
                : {}),
              trackerUpdates: extension.tracker_updates
            }
          });
        } catch (error) {
          orchestration = await persistOrchestration(repository, scope, job, {
            extensionError: (error instanceof Error ? error.message : String(error)).slice(0, 2000)
          });
        }
      });
    }
    const committedStory: StoryTurnOutput = orchestration.extension
      ? {
          ...parsed.story,
          narration: formatNarrationParagraphs(
            `${parsed.story.narration}\n\n${orchestration.extension.additionalText}`
          ),
          scratchpad: orchestration.extension.scratchpad ?? parsed.story.scratchpad,
          tracker_updates: [
            ...parsed.story.tracker_updates,
            ...orchestration.extension.trackerUpdates
          ]
        }
      : parsed.story;
    if (mechanicsLeakFields(committedStory).length) {
      throw new Error("Mechanics validation invariant failed after event extension.");
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
      durationMs: Date.now() - generationStartedAt
    });
  } catch (error) {
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
