import {
  createBrowserClock,
  createBrowserDelayScheduler,
  createBrowserGenerationSource,
  createBrowserIdFactory,
  createDocumentVisibilitySource,
  createNoopSessionPort,
  createNexusApiClient,
  createPendingSubmissionStore,
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

export interface StoryPlayerComposition {
  readonly api: NexusApiClient;
  readonly campaignStore: CampaignStoreController;
  readonly workflow: GenerationWorkflow;
  readonly illustrations: IllustrationApi;
  readonly idFactory: IdFactory;
  readonly clock: Clock;
  readonly delay: DelayScheduler;
}

export interface StoryPlayerEnvironment {
  readonly document: Document;
  readonly storage: Storage;
  readonly eventSourceFactory: EventSourceFactory | null;
  readonly random: () => number;
}

function browserStoryEnvironment(): StoryPlayerEnvironment {
  return {
    document: window.document,
    storage: window.localStorage,
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

  return {
    api,
    campaignStore: createCampaignStore(),
    workflow: createGenerationWorkflow({
      api: api.generation,
      clock,
      pendingSubmissions: createPendingSubmissionStore(environment.storage),
      source
    }),
    illustrations: api.illustrations,
    idFactory: createBrowserIdFactory(),
    clock,
    delay
  };
}
