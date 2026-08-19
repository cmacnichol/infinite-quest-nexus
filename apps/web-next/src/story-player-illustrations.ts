import type { IllustrationApi } from "@infinite-quest/client-web";
import type {
  IllustrationConfigResponse,
  IllustrationResolutionResponse,
  IllustrationSegment
} from "@infinite-quest/contracts";
import type { Clock, DelayScheduler, IdFactory } from "@infinite-quest/client-core";

export type StoryIllustrationStatus = "idle" | "loading" | "disabled" | "ready" | "unavailable";
type IllustrationVariant = IllustrationSegment["variants"][number];

export interface StoryIllustrationState {
  readonly status: StoryIllustrationStatus;
  readonly campaignId: string | null;
  readonly turnId: string | null;
  readonly config: IllustrationConfigResponse | null;
  readonly segments: readonly IllustrationSegment[];
  readonly selectedSegmentIndex: number;
  readonly selectedVariantIndex: number;
  readonly selectedSegment: IllustrationSegment | null;
  readonly selectedVariant: IllustrationVariant | null;
  readonly prompt: string;
  readonly provenance: IllustrationResolutionResponse | null;
  readonly message: string | null;
}

export interface StoryIllustrationController {
  get(): Readonly<StoryIllustrationState>;
  subscribe(listener: (state: Readonly<StoryIllustrationState>) => void): () => void;
  load(campaignId: string, turnId: string): Promise<void>;
  selectPrevious(): void;
  selectNext(): void;
  editPrompt(prompt: string): Promise<void>;
  regenerate(): Promise<void>;
  retryJob(): Promise<void>;
  generateMissing(): Promise<void>;
  rebuild(): Promise<void>;
  loadProvenance(): Promise<void>;
  rematch(): Promise<void>;
  dispose(): void;
}

export interface StoryIllustrationControllerOptions {
  readonly illustrations: IllustrationApi;
  readonly idFactory: IdFactory;
  readonly clock: Clock;
  readonly delay: DelayScheduler;
}

const INITIAL_STATE: StoryIllustrationState = {
  status: "idle",
  campaignId: null,
  turnId: null,
  config: null,
  segments: [],
  selectedSegmentIndex: 0,
  selectedVariantIndex: 0,
  selectedSegment: null,
  selectedVariant: null,
  prompt: "",
  provenance: null,
  message: null
};

function terminal(status: string | null): boolean {
  return status === null || ["completed", "failed", "cancelled", "canceled", "skipped"].includes(status.toLowerCase());
}

function workIsActive(segments: readonly IllustrationSegment[]): boolean {
  return segments.some((segment) => !terminal(segment.status) || !terminal(segment.imageJobStatus) || !terminal(segment.promptJobStatus));
}

function selected(state: StoryIllustrationState): Pick<StoryIllustrationState, "selectedSegment" | "selectedVariant" | "prompt"> {
  const segment = state.segments[state.selectedSegmentIndex] ?? null;
  const variant = segment?.variants[state.selectedVariantIndex] ?? null;
  return { selectedSegment: segment, selectedVariant: variant, prompt: variant?.prompt ?? segment?.resolvedPrompt ?? "" };
}

function snapshot(state: StoryIllustrationState): StoryIllustrationState {
  return { ...state, segments: [...state.segments] };
}

function unavailable(message: string): Pick<StoryIllustrationState, "status" | "message"> {
  return { status: "unavailable", message: `Illustrations are unavailable. ${message}` };
}

/**
 * Browser-only illustration state. It never reads or writes campaign turns;
 * all image failures remain local presentation/recovery state.
 */
export function createStoryIllustrationController(options: StoryIllustrationControllerOptions): StoryIllustrationController {
  const listeners = new Set<(state: Readonly<StoryIllustrationState>) => void>();
  let state = INITIAL_STATE;
  let disposed = false;
  let epoch = 0;
  let requestController: AbortController | null = null;
  let pollingController: AbortController | null = null;

  const publish = (next: StoryIllustrationState) => {
    if (disposed) return;
    state = next;
    for (const listener of [...listeners]) listener(snapshot(state));
  };
  const currentSignal = () => requestController?.signal;
  const isCurrent = (requestEpoch: number, campaignId: string, turnId: string) => !disposed
    && requestEpoch === epoch && state.campaignId === campaignId && state.turnId === turnId;
  const stopPolling = () => {
    pollingController?.abort();
    pollingController = null;
  };
  const startPolling = (campaignId: string, turnId: string, requestEpoch: number) => {
    if (pollingController || !workIsActive(state.segments)) return;
    const controller = new AbortController();
    pollingController = controller;
    void (async () => {
      while (!controller.signal.aborted && isCurrent(requestEpoch, campaignId, turnId)) {
        await options.delay.wait(2_000, controller.signal);
        if (controller.signal.aborted || !isCurrent(requestEpoch, campaignId, turnId)) break;
        try {
          const response = await options.illustrations.segments(campaignId, controller.signal);
          if (!isCurrent(requestEpoch, campaignId, turnId)) break;
          const segments = response.segments.filter((segment) => segment.turnId === turnId);
          const next = { ...state, segments };
          publish({ ...next, ...selected(next) });
          if (!workIsActive(segments)) break;
        } catch {
          if (controller.signal.aborted || !isCurrent(requestEpoch, campaignId, turnId)) break;
          publish({ ...state, ...unavailable("Image status could not be refreshed.") });
          break;
        }
      }
      if (pollingController === controller) pollingController = null;
    })();
  };

  const load = async (campaignId: string, turnId: string): Promise<void> => {
    if (disposed) return;
    const previousSegmentId = state.selectedSegment?.id ?? null;
    const previousVariantIndex = state.selectedVariant?.variantIndex ?? 0;
    epoch += 1;
    const requestEpoch = epoch;
    requestController?.abort();
    stopPolling();
    const controller = new AbortController();
    requestController = controller;
    publish({ ...INITIAL_STATE, status: "loading", campaignId, turnId });
    try {
      const config = await options.illustrations.config(campaignId, controller.signal);
      if (!isCurrent(requestEpoch, campaignId, turnId)) return;
      if (!config.enabled || config.sourcePolicy === "off") {
        publish({ ...state, config, status: "disabled", message: "Illustrations are disabled for this campaign." });
        return;
      }
      const response = await options.illustrations.segments(campaignId, controller.signal);
      if (!isCurrent(requestEpoch, campaignId, turnId)) return;
      const segments = response.segments.filter((segment) => segment.turnId === turnId);
      const selectedSegmentIndex = Math.max(0, segments.findIndex((segment) => segment.id === previousSegmentId));
      const selectedSegment = segments[selectedSegmentIndex] ?? null;
      const selectedVariantIndex = Math.max(0, selectedSegment?.variants.findIndex((variant) => variant.variantIndex === previousVariantIndex) ?? 0);
      const next = { ...state, config, status: "ready" as const, segments, selectedSegmentIndex, selectedVariantIndex };
      publish({ ...next, ...selected(next) });
      startPolling(campaignId, turnId, requestEpoch);
    } catch {
      if (controller.signal.aborted || !isCurrent(requestEpoch, campaignId, turnId)) return;
      publish({ ...state, ...unavailable("The image service could not be reached.") });
    }
  };

  const changeSelection = (direction: -1 | 1) => {
    if (!state.segments.length) return;
    const currentSegment = state.segments[state.selectedSegmentIndex] ?? state.segments[0]!;
    const variantCount = currentSegment.variants.length;
    let selectedSegmentIndex = state.selectedSegmentIndex;
    let selectedVariantIndex = state.selectedVariantIndex + direction;
    if (variantCount && selectedVariantIndex >= 0 && selectedVariantIndex < variantCount) {
      const next = { ...state, selectedVariantIndex };
      publish({ ...next, ...selected(next) });
      return;
    }
    selectedSegmentIndex = (selectedSegmentIndex + direction + state.segments.length) % state.segments.length;
    const nextSegment = state.segments[selectedSegmentIndex]!;
    selectedVariantIndex = direction > 0 ? 0 : Math.max(0, nextSegment.variants.length - 1);
    const next = { ...state, selectedSegmentIndex, selectedVariantIndex };
    publish({ ...next, ...selected(next) });
  };

  const actionScope = () => {
    const signal = currentSignal();
    if (
      disposed
      || state.campaignId === null
      || state.turnId === null
      || signal === undefined
      || signal.aborted
      || state.config === null
      || !state.config.enabled
      || state.config.sourcePolicy === "off"
    ) return null;
    return { campaignId: state.campaignId, turnId: state.turnId, epoch, signal };
  };
  const afterAction = async (action: (scope: NonNullable<ReturnType<typeof actionScope>>) => Promise<unknown>, refresh = true) => {
    const scope = actionScope();
    if (scope === null) return;
    try {
      await action(scope);
      if (!isCurrent(scope.epoch, scope.campaignId, scope.turnId)) return;
      if (refresh) await load(scope.campaignId, scope.turnId);
    } catch {
      if (isCurrent(scope.epoch, scope.campaignId, scope.turnId)) {
        publish({ ...state, ...unavailable("The requested image operation could not be completed.") });
      }
    }
  };

  return {
    get: () => snapshot(state),
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load,
    selectPrevious: () => changeSelection(-1),
    selectNext: () => changeSelection(1),
    editPrompt: async (prompt) => {
      if (disposed) return;
      const next = { ...state, prompt };
      publish(next);
    },
    regenerate: async () => afterAction(async (scope) => {
      const segment = state.selectedSegment;
      if (!segment) return;
      await options.illustrations.regenerateSegmentImage(segment.id, { prompt: state.prompt, variantIndex: state.selectedVariant?.variantIndex ?? 0 }, scope.signal);
    }),
    retryJob: async () => afterAction(async (scope) => {
      const jobId = state.selectedSegment?.imageJobId;
      if (!jobId) return;
      await options.illustrations.retryImageJob(jobId, scope.signal);
    }),
    generateMissing: async () => afterAction(async (scope) => {
      await options.illustrations.generateTurnSegments(scope.turnId, { mode: "missing", idempotencyKey: options.idFactory.create() }, scope.signal);
    }),
    rebuild: async () => afterAction(async (scope) => {
      await options.illustrations.generateTurnSegments(scope.turnId, { mode: "rebuild", idempotencyKey: options.idFactory.create() }, scope.signal);
    }),
    loadProvenance: async () => afterAction(async (scope) => {
      const provenance = await options.illustrations.resolution(scope.turnId, scope.signal);
      if (isCurrent(scope.epoch, scope.campaignId, scope.turnId)) publish({ ...state, provenance });
    }, false),
    rematch: async () => afterAction(async (scope) => {
      await options.illustrations.rematch(scope.turnId, scope.signal);
    }),
    dispose() {
      if (disposed) return;
      disposed = true;
      epoch += 1;
      requestController?.abort();
      stopPolling();
      listeners.clear();
    }
  };
}
