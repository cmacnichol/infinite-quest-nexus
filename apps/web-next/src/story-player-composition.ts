import {
  createBrowserClock,
  createBrowserDelayScheduler,
  createBrowserGenerationSource,
  createBrowserIdFactory,
  createDocumentVisibilitySource,
  createNoopSessionPort,
  createNexusApiClient,
  createPendingSubmissionStore,
  createFailedTurnPromptStore,
  type FailedTurnPromptStore,
  type EventSourceFactory,
  type IllustrationApi,
  type NexusApiClient
} from "@infinite-quest/client-web";
import {
  createCampaignStore,
  createGenerationWorkflow,
  type CampaignStoreController,
  type Clock,
  type DelayScheduler,
  type GenerationWorkflow,
  type IdFactory
} from "@infinite-quest/client-core";
import type { PendingSubmissionStore } from "@infinite-quest/client-core";

export interface StoryPlayerComposition {
  readonly api: NexusApiClient;
  readonly campaignStore: CampaignStoreController;
  readonly workflow: GenerationWorkflow;
  readonly pendingSubmissions: PendingSubmissionStore;
  readonly failedTurnPrompts: FailedTurnPromptStore;
  readonly illustrations: IllustrationApi;
  readonly idFactory: IdFactory;
  readonly clock: Clock;
  readonly delay: DelayScheduler;
}

export interface StoryPlayerEnvironment {
  readonly document: Document;
  readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  readonly eventSourceFactory: EventSourceFactory | null;
  readonly random: () => number;
}

function browserStoryEnvironment(): StoryPlayerEnvironment {
  let storage: StoryPlayerEnvironment["storage"];
  try { storage = window.localStorage; } catch {
    const memory = new Map<string, string>();
    storage = {getItem: key => memory.get(key) ?? null, setItem: (key, value) => { memory.set(key, value); }, removeItem: key => { memory.delete(key); }};
  }
  return {
    document: window.document,
    storage,
    eventSourceFactory: typeof window.EventSource === "function"
      ? (url) => new window.EventSource(url)
      : null,
    random: Math.random
  };
}

export function createStoryPlayerComposition(
  environment: StoryPlayerEnvironment = browserStoryEnvironment()
): StoryPlayerComposition {
  const session = createNoopSessionPort();
  const clock = createBrowserClock();
  const delay = createBrowserDelayScheduler();
  const api = createNexusApiClient({ basePath: "/api/v1", session });
  const source = createBrowserGenerationSource({
    api: api.generation,
    basePath: "/api/v1",
    session,
    clock,
    delay,
    visibility: createDocumentVisibilitySource(environment.document),
    eventSourceFactory: environment.eventSourceFactory,
    random: environment.random
  });
  const pendingSubmissions = createPendingSubmissionStore(environment.storage);
  const failedTurnPrompts = createFailedTurnPromptStore(environment.storage);

  return {
    api,
    campaignStore: createCampaignStore(),
    workflow: createGenerationWorkflow({
      api: api.generation,
      clock,
      pendingSubmissions,
      source
    }),
    pendingSubmissions,
    failedTurnPrompts,
    illustrations: api.illustrations,
    idFactory: createBrowserIdFactory(),
    clock,
    delay
  };
}
