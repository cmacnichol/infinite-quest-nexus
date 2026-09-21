import {
  createAuthoringApplication,
  createAuthoringWorkerApplication,
  type AuthoringApplication,
  type AuthoringExecutionRepository,
  type AuthoringStageOutput,
  type AuthoringWorkerApplication
} from "../../../packages/application/src/index.js";
import { createPostgresAuthoringRepository, createPostgresAuthoringTargetPort } from "../../../packages/database/src/authoring-job-repository.js";
import { createPostgresAuthoringWorldApplyAdapter } from "../../../packages/database/src/authoring-world-apply-adapter.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import type { AuthoringWorkerProviderCollaborators } from "./provider-application-composition.js";
import {
  AUTHORING_EXECUTION_PROTOCOLS,
  createAuthoringExecutionSnapshot,
  createRuntimeAuthoringStageDispatcher,
  executeAuthoringStage,
  type LoadedAuthoringStage
} from "./authoring-stage-adapter.js";
import { buildSourceExtractionPrompt, buildSourceWorldPrompt, effectiveAuthoringPrompt, CHARACTER_AUTHORING_PROMPT_PROTOCOL_VERSION, SOURCE_EXTRACTION_PROMPT_PROTOCOL_VERSION, SOURCE_WORLD_PROMPT_PROTOCOL_VERSION } from "../../../packages/domain/src/authoring-prompts.js";
import type { AuthoringSubmit } from "@infinite-quest/contracts";
import { SourceExtractionSplitNeededError } from "./source-authoring-adapter.js";
import { resolveSourceAuthoringTextExecution } from "./source-authoring-budget.js";
import { prepareAuthoringResponseContractExecution } from "./authoring-text-execution-preparation.js";

type RuntimeRepository = AuthoringExecutionRepository;

/** Provider-free API composition. Execution credentials stay in the worker graph. */
export function createRuntimeAuthoringApplication(
  pool: DatabasePool,
  sha256: (value: string) => string,
  options: Readonly<{ nativePresetPlansEnabled?: boolean }> = {}
): AuthoringApplication {
  return createAuthoringApplication({
    repository: createPostgresAuthoringRepository(pool,
      options.nativePresetPlansEnabled === true ? { textPlanProtocol: 2 } : {}),
    targets: createPostgresAuthoringTargetPort(pool),
    worlds: createPostgresAuthoringWorldApplyAdapter(),
    sha256
  });
}

function heartbeatDelayMilliseconds(leaseSeconds: number, requested?: number): number {
  const safeMaximum = Math.max(1, Math.floor(leaseSeconds * 1000 / 2));
  const defaultDelay = Math.max(1, Math.floor(leaseSeconds * 1000 / 3));
  return Math.min(safeMaximum, Math.max(1, requested ?? defaultDelay));
}

function snapshotPrompts(snapshot: Record<string, unknown>, content: (snapshot: Record<string, unknown>, key: string) => string) {
  return {
    world_generation: content(snapshot, "world_generation"),
    world_generation_recovery: content(snapshot, "world_generation_recovery"),
    world_character_generation: content(snapshot, "world_character_generation"),
    world_character_generation_recovery: content(snapshot, "world_character_generation_recovery"),
    character_generation: content(snapshot, "character_generation"),
    source_extraction: content(snapshot, "source_extraction"),
    source_extraction_recovery: content(snapshot, "source_extraction_recovery"),
    source_world: content(snapshot, "source_world"),
    source_world_recovery: content(snapshot, "source_world_recovery")
  };
}

function authoringOperationPrompts(prompts: ReturnType<typeof snapshotPrompts>, input: AuthoringSubmit) {
  const mode = input.kind === "story_source" ? input.mode : "faithful";
  const extraction = (repair: boolean) => buildSourceExtractionPrompt({ instructions: "", sourceText: "", mode, chunk: { sourceRange: { start: 0, end: 0 }, paragraphSpans: [] }, repair }).systemPrompt;
  const sourceWorld = (repair: boolean) => buildSourceWorldPrompt({ instructions: "", reviewGeneration: 0, selection: { source: { id: "snapshot", name: "snapshot", sha256: "0".repeat(64) }, boundaryParagraphId: "snapshot", acceptedFacts: [], selectedCharacterFactIds: [], characterIdentityGroups: [], mode }, repair }).systemPrompt;
  const standalone = effectiveAuthoringPrompt("character", prompts.character_generation.replaceAll("{{protocol}}", CHARACTER_AUTHORING_PROMPT_PROTOCOL_VERSION)).content;
  return {
    worldOutline: effectiveAuthoringPrompt("world", prompts.world_generation).content,
    worldOutlineRepair: effectiveAuthoringPrompt("world", prompts.world_generation_recovery).content,
    seedCharacter: effectiveAuthoringPrompt("world_character", prompts.world_character_generation).content,
    seedCharacterRepair: effectiveAuthoringPrompt("world_character", prompts.world_character_generation_recovery).content,
    standaloneCharacter: standalone,
    standaloneCharacterRepair: standalone,
    sourceExtraction: extraction(false),
    sourceExtractionRepair: extraction(true),
    sourceSynthesis: sourceWorld(false),
    sourceSynthesisRepair: sourceWorld(true),
    sourceCharacter: sourceWorld(false),
    sourceCharacterRepair: sourceWorld(true)
  };
}

/** Runtime-only authoring graph. It owns default resolution, credentials and heartbeat state. */
export function createRuntimeAuthoringWorkerApplication(options: Readonly<{
  pool?: DatabasePool;
  repository?: RuntimeRepository;
  providers: AuthoringWorkerProviderCollaborators;
  sha256: (value: string) => string;
  signal?: AbortSignal;
  heartbeatMilliseconds?: number;
  /** Task 5 admission stays off until its route transport is available. */
  nativePresetPlansEnabled?: boolean;
  dispatch?: (stage: LoadedAuthoringStage) => Promise<AuthoringStageOutput>;
}>): AuthoringWorkerApplication {
  const repository = options.repository ?? createPostgresAuthoringRepository(
    options.pool!, options.nativePresetPlansEnabled === true ? { textPlanProtocol: 2 } : {}
  );
  const dispatch = options.dispatch ?? createRuntimeAuthoringStageDispatcher({
    execution: options.providers.execution,
    sha256: options.sha256,
    ...(options.providers.authoringTextPlans?.preparedExecutor === undefined
      ? {}
      : { preparedExecutor: options.providers.authoringTextPlans.preparedExecutor })
  });
  const application = createAuthoringWorkerApplication({
    repository,
    execute: async (claim, worker) => {
      let stale = options.signal?.aborted === true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let ticking = false;
      const heartbeatDelay = heartbeatDelayMilliseconds(worker.leaseSeconds, options.heartbeatMilliseconds);
      const stop = () => { stale = true; if (timer) clearTimeout(timer); };
      const heartbeat = async (): Promise<void> => {
        if (stale || ticking) return;
        ticking = true;
        try {
          if (!await repository.heartbeat(claim, worker.leaseSeconds)) stop();
        } catch { stop(); }
        finally { ticking = false; if (!stale) timer = setTimeout(() => void heartbeat(), heartbeatDelay); }
      };
      const onAbort = () => stop();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => void heartbeat(), heartbeatDelay);
      const currentClaim = async () => {
        if (stale || Boolean(options.signal?.aborted)) return false;
        const loaded = await repository.loadClaim(claim);
        return !stale && !Boolean(options.signal?.aborted) && loaded !== null;
      };
      try {
        let output: AuthoringStageOutput | null;
        try {
          output = await executeAuthoringStage({
          claim, repository,
          currentClaim,
          resolveSnapshot: async (input) => {
            const resolution = await options.providers.resolution.resolveDirect({ ownerUserId: claim.ownerUserId, providerRole: "text" });
            if (resolution.status !== "resolved") throw Object.assign(new Error("authoring provider unavailable"), { authoringFailure: { code: "authoring_provider_unavailable", stage: input.kind === "world_concept" ? "world" : input.kind === "story_source" ? "source" : "character", retryable: true, issues: [] } });
            const provider = input.kind === "story_source"
              ? (await resolveSourceAuthoringTextExecution({
                execution: options.providers.execution,
                inventory: options.providers.inventory,
                scope: { ownerUserId: claim.ownerUserId },
                providerProfileId: resolution.providerProfileId,
                model: resolution.model
              })).execution
              : await options.providers.execution.text({ ownerUserId: claim.ownerUserId }, resolution.providerProfileId, "text", resolution.model);
            const prompt = await options.providers.prompts.loadWorldGenerationPromptSnapshot({ ownerUserId: claim.ownerUserId, worldId: claim.jobId });
            const prompts = snapshotPrompts(prompt.snapshot as Record<string, unknown>, options.providers.promptTools.content as never);
            // Historical direct-model authoring remains v1. Native preset
            // adoption is explicit, so ordinary callers do not gain remote
            // inventory work or a changed retry contract.
            const planOptions = options.providers.authoringTextPlans;
            if (options.nativePresetPlansEnabled !== true || planOptions?.nativePresetPlansEnabled !== true) {
              return createAuthoringExecutionSnapshot(provider, prompts, input.kind === "story_source"
                ? { ...AUTHORING_EXECUTION_PROTOCOLS, source: SOURCE_EXTRACTION_PROMPT_PROTOCOL_VERSION, sourceWorld: SOURCE_WORLD_PROMPT_PROTOCOL_VERSION }
                : AUTHORING_EXECUTION_PROTOCOLS, options.sha256);
            }
            const prepared = await prepareAuthoringResponseContractExecution({
              ownerUserId: claim.ownerUserId,
              execution: provider,
              operationPrompts: authoringOperationPrompts(prompts, input),
              ports: planOptions.ports,
              ...(planOptions.responseFormatCapabilities === undefined ? {} : { responseFormatCapabilities: planOptions.responseFormatCapabilities })
            });
            return createAuthoringExecutionSnapshot(provider, prompts, input.kind === "story_source"
              ? { ...AUTHORING_EXECUTION_PROTOCOLS, source: SOURCE_EXTRACTION_PROMPT_PROTOCOL_VERSION, sourceWorld: SOURCE_WORLD_PROMPT_PROTOCOL_VERSION }
              : AUTHORING_EXECUTION_PROTOCOLS, options.sha256, prepared);
          },
            dispatch: async (stage) => dispatch(stage)
          });
        } catch (error) {
          if (error instanceof SourceExtractionSplitNeededError && repository.splitSourceChunk) {
            if (await repository.splitSourceChunk(claim, error.chunkId)) return null;
            throw Object.assign(new Error("Source extraction split limit reached."), {
              authoringFailure: { code: "source_requires_larger_context", stage: "source", retryable: false, issues: [] }
            });
          }
          throw error;
        }
        return stale || Boolean(options.signal?.aborted) ? null : output;
      } catch (error) {
        // A local heartbeat/abort can precede database expiry. It is neither a
        // user cancellation nor a provider failure, so leave the live claim
        // resumable instead of terminally failing it.
        if (stale || Boolean(options.signal?.aborted)) return null;
        throw error;
      } finally {
        stop();
        options.signal?.removeEventListener("abort", onAbort);
      }
    }
  });
  return {
    runNext: (input) => options.signal?.aborted === true ? Promise.resolve(false) : application.runNext(input),
    cleanup: () => typeof repository.cleanupAuthoring === "function" ? application.cleanup() : Promise.resolve(0)
  };
}
