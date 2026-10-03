import {
  createIndexedDbActivityCache,
  canonicalActivityApiBase,
  createActivityVisibilitySource,
  createActivityConnectivitySource,
  createActivityTabNotifications,
  createBrowserClock,
  createBrowserDelayScheduler,
  createBrowserGenerationSource,
  createBrowserIdFactory,
  createStoryMemoryApi,
  createCampaignCastApi,
  createDocumentVisibilitySource,
  createNoopSessionPort,
  createNexusApiClient,
  createPendingSubmissionStore,
  createFailedTurnPromptStore
} from "@infinite-quest/client-web";
import { createActivityController, createGenerationWorkflow, type AbortSignalLike, type ActivityCacheScope, type Clock, type DelayScheduler, type GenerationWorkflow, type IdFactory, type PendingSubmissionStore, type SessionPort } from "@infinite-quest/client-core";
import type { EventSourceFactory, FailedTurnPromptStore, NexusApiClient, StoryMemoryApi } from "@infinite-quest/client-web";
import { createLegacyIllustrationApi, type LegacyIllustrationApi } from "./legacy-illustration-api.js";

export interface StoryPlayerComposition {
  readonly activity: ReturnType<typeof createActivityController>;
  readonly activityApiBase: string;
  readonly copyText: (text: string) => Promise<void>;
  readonly downloadDiagnostics: (text: string, filename: string) => void;
  readonly disposeActivity: () => void;
  readonly api: NexusApiClient;
  readonly clock: Clock;
  readonly delay: DelayScheduler;
  readonly idFactory: IdFactory;
  readonly illustrations: LegacyIllustrationApi;
  readonly pendingSubmissions: PendingSubmissionStore;
  readonly failedTurnPrompts: FailedTurnPromptStore;
  readonly session: SessionPort;
  readonly storyMemory: StoryMemoryApi;
  readonly cast: ReturnType<typeof createCampaignCastApi>;
  readonly workflow: GenerationWorkflow;
}

export interface StoryPlayerEnvironment {
  readonly document: Document;
  readonly storage: Storage;
  readonly eventSourceFactory: EventSourceFactory | null;
  readonly random: () => number;
  readonly window?: Window;
  readonly indexedDB?: IDBFactory | null;
  readonly channelFactory?: ((name: string) => BroadcastChannel) | null;
  readonly copyText?: (text: string) => Promise<void>;
  readonly downloadDiagnostics?: (text: string, filename: string) => void;
}

export interface StoryPlayerCompositionFactories {
  readonly createActivity?: typeof createActivityController;
  readonly createActivityCache?: typeof createIndexedDbActivityCache;
  readonly createActivityVisibility?: typeof createActivityVisibilitySource;
  readonly createActivityConnectivity?: typeof createActivityConnectivitySource;
  readonly createActivityNotifications?: typeof createActivityTabNotifications;
  readonly createSession: typeof createNoopSessionPort;
  readonly createClock: typeof createBrowserClock;
  readonly createDelay: typeof createBrowserDelayScheduler;
  readonly createVisibility: typeof createDocumentVisibilitySource;
  readonly createIdFactory: typeof createBrowserIdFactory;
  readonly createApi: typeof createNexusApiClient;
  readonly createPendingSubmissions: typeof createPendingSubmissionStore;
  readonly createSource: typeof createBrowserGenerationSource;
  readonly createWorkflow: typeof createGenerationWorkflow;
  readonly createIllustrations: typeof createLegacyIllustrationApi;
  readonly createStoryMemory: typeof createStoryMemoryApi;
}

const defaultFactories: StoryPlayerCompositionFactories = {
  createSession: createNoopSessionPort,
  createClock: createBrowserClock,
  createDelay: createBrowserDelayScheduler,
  createVisibility: createDocumentVisibilitySource,
  createIdFactory: createBrowserIdFactory,
  createApi: createNexusApiClient,
  createPendingSubmissions: createPendingSubmissionStore,
  createSource: createBrowserGenerationSource,
  createWorkflow: createGenerationWorkflow,
  createIllustrations: createLegacyIllustrationApi,
  createStoryMemory: createStoryMemoryApi
};

function browserEnvironment(): StoryPlayerEnvironment {
  return {
    document: window.document,
    window,
    storage: window.localStorage,
    eventSourceFactory: typeof window.EventSource === "function"
      ? (url) => new window.EventSource(url)
      : null,
    random: Math.random
  };
}

/** Current server proof is repeated before opening a cache and on older-server fallback. */
export function createStoryActivityAccessVerifier(api: Pick<NexusApiClient, "session" | "generation">) {
  return async (scope: ActivityCacheScope, signal: AbortSignalLike): Promise<boolean> => {
    try {
      const currentSession = await api.session.get();
      if (signal.aborted || currentSession.user.id !== scope.ownerUserId) return false;
      await api.generation.syncStatus(scope.campaignId);
      return !signal.aborted;
    } catch (error) {
      const status = error && typeof error === "object" && "statusCode" in error ? error.statusCode : null;
      if (status === 401 || status === 403 || status === 404) return false;
      throw error;
    }
  };
}

export function createStoryPlayerComposition(
  environment: StoryPlayerEnvironment = browserEnvironment(),
  factories: StoryPlayerCompositionFactories = defaultFactories
): StoryPlayerComposition {
  const session = factories.createSession();
  const clock = factories.createClock();
  const delay = factories.createDelay();
  const visibility = factories.createVisibility(environment.document);
  const idFactory = factories.createIdFactory();
  const api = factories.createApi({ basePath: "/api/v1", session });
  const pendingSubmissions = factories.createPendingSubmissions(environment.storage);
  const failedTurnPrompts = createFailedTurnPromptStore(environment.storage);
  const source = factories.createSource({
    api: api.generation,
    basePath: "/api/v1",
    session,
    clock,
    delay,
    visibility,
    eventSourceFactory: environment.eventSourceFactory,
    random: environment.random
  });
  const workflow = factories.createWorkflow({
    api: api.generation,
    clock,
    pendingSubmissions,
    source
  });

  const windowImpl = environment.window ?? environment.document.defaultView;
  const cache = (factories.createActivityCache ?? createIndexedDbActivityCache)({ ...(environment.indexedDB === undefined ? {} : { indexedDB: environment.indexedDB }), clock: { now: () => clock.now(), isoAt: milliseconds => new Date(milliseconds).toISOString() } });
  const notifications = (factories.createActivityNotifications ?? createActivityTabNotifications)(environment.channelFactory === undefined ? (windowImpl && typeof BroadcastChannel === "function" ? name => new BroadcastChannel(name) : null) : environment.channelFactory);
  const activityApiBase = canonicalActivityApiBase("/api/v1", windowImpl?.location?.origin ?? "http://localhost");
  const activity = (factories.createActivity ?? createActivityController)({
    api: api.activity,
    cache,
    verifyAccess: createStoryActivityAccessVerifier(api),
    clock: { now: () => clock.now(), isoAt: milliseconds => new Date(milliseconds).toISOString() },
    scheduler: delay,
    createAbortController: () => new AbortController(),
    visibility: (factories.createActivityVisibility ?? createActivityVisibilitySource)(environment.document),
    connectivity: windowImpl ? (factories.createActivityConnectivity ?? createActivityConnectivitySource)(windowImpl) : { current: () => true, subscribe: () => () => {} },
    notifyTabs: notifications,
    random: environment.random
  });
  const copyText = environment.copyText ?? (text => windowImpl?.navigator.clipboard?.writeText(text) ?? Promise.reject(new Error("Clipboard unavailable")));
  const downloadDiagnostics = environment.downloadDiagnostics ?? ((text, filename) => {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const anchor = environment.document.createElement("a"); anchor.href = url; anchor.download = filename;
    anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 100);
  });

  return {
    activity, activityApiBase, copyText, downloadDiagnostics,
    disposeActivity: () => { activity.dispose(); cache.dispose?.(); notifications.dispose(); },
    api,
    clock,
    delay,
    idFactory,
    illustrations: factories.createIllustrations({ basePath: "/api/v1", session }),
    pendingSubmissions,
    failedTurnPrompts,
    session,
    storyMemory: factories.createStoryMemory({ basePath: "/api/v1", session }),
    cast: createCampaignCastApi({ basePath: "/api/v1", session }),
    workflow
  };
}

export function bootstrapStoryPlayer(
  createComposition: () => StoryPlayerComposition,
  initialize: (composition: StoryPlayerComposition) => void
): StoryPlayerComposition {
  const composition = createComposition();
  initialize(composition);
  return composition;
}
