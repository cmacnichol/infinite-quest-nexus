import {
  createBrowserClock,
  createBrowserDelayScheduler,
  createBrowserGenerationSource,
  createBrowserIdFactory,
  createDocumentVisibilitySource,
  createNoopSessionPort,
  createNexusApiClient,
  createPendingSubmissionStore
} from "@infinite-quest/client-web";
import { createGenerationWorkflow, type Clock, type DelayScheduler, type GenerationWorkflow, type IdFactory, type PendingSubmissionStore, type SessionPort } from "@infinite-quest/client-core";
import type { EventSourceFactory, NexusApiClient } from "@infinite-quest/client-web";
import { createLegacyIllustrationApi, type LegacyIllustrationApi } from "./legacy-illustration-api.js";

export interface StoryPlayerComposition {
  readonly api: NexusApiClient;
  readonly clock: Clock;
  readonly delay: DelayScheduler;
  readonly idFactory: IdFactory;
  readonly illustrations: LegacyIllustrationApi;
  readonly pendingSubmissions: PendingSubmissionStore;
  readonly session: SessionPort;
  readonly workflow: GenerationWorkflow;
}

export interface StoryPlayerEnvironment {
  readonly document: Document;
  readonly storage: Storage;
  readonly eventSourceFactory: EventSourceFactory | null;
  readonly random: () => number;
}

export interface StoryPlayerCompositionFactories {
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
  createIllustrations: createLegacyIllustrationApi
};

function browserEnvironment(): StoryPlayerEnvironment {
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

  return {
    api,
    clock,
    delay,
    idFactory,
    illustrations: factories.createIllustrations({ basePath: "/api/v1", session }),
    pendingSubmissions,
    session,
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
