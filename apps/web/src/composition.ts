import {
  createBrowserClock,
  createBrowserDelayScheduler,
  createBrowserGenerationSource,
  createBrowserIdFactory,
  createStoryMemoryApi,
  createCampaignCastApi,
  createDocumentVisibilitySource,
  createNoopSessionPort,
  createNexusApiClient,
  createNexusHttpClient,
  createReaderHistoryApi,
  createIndexedDbReaderPositionDatabase,
  createReaderPositionStore,
  createPendingSubmissionStore,
  createFailedTurnPromptStore,
  createIndexedDbDraftDatabase,
  createStoryActionDraftStore
} from "@infinite-quest/client-web";
import { createGenerationWorkflow, type Clock, type DelayScheduler, type GenerationWorkflow, type IdFactory, type PendingSubmissionStore, type SessionPort } from "@infinite-quest/client-core";
import type {
  DraftDatabasePort,
  EventSourceFactory,
  FailedTurnPromptStore,
  NexusApiClient,
  ReaderHistoryApi,
  ReaderPositionDatabasePort,
  ReaderPositionStore,
  StoryActionDraftStore,
  StoryMemoryApi,
  NexusHttpClientOptions
} from "@infinite-quest/client-web";
import { createLegacyIllustrationApi, type LegacyIllustrationApi } from "./legacy-illustration-api.js";

export interface StoryPlayerComposition {
  readonly api: NexusApiClient;
  readonly actionDrafts: StoryActionDraftStore;
  readonly clock: Clock;
  readonly delay: DelayScheduler;
  readonly idFactory: IdFactory;
  readonly illustrations: LegacyIllustrationApi;
  readonly pendingSubmissions: PendingSubmissionStore;
  readonly readerHistory: ReaderHistoryApi;
  readonly readerPositions: ReaderPositionStore;
  readonly failedTurnPrompts: FailedTurnPromptStore;
  readonly session: SessionPort;
  readonly storyMemory: StoryMemoryApi;
  readonly cast: ReturnType<typeof createCampaignCastApi>;
  readonly workflow: GenerationWorkflow;
}

export interface StoryPlayerEnvironment {
  readonly document: Document;
  readonly storage: Storage;
  readonly draftDatabase?: DraftDatabasePort;
  readonly readerPositionDatabase?: ReaderPositionDatabasePort;
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
  readonly createDraftDatabase: typeof createIndexedDbDraftDatabase;
  readonly createActionDrafts: typeof createStoryActionDraftStore;
  readonly createSource: typeof createBrowserGenerationSource;
  readonly createWorkflow: typeof createGenerationWorkflow;
  readonly createIllustrations: typeof createLegacyIllustrationApi;
  readonly createStoryMemory: typeof createStoryMemoryApi;
  readonly createReaderHistory: (options: NexusHttpClientOptions) => ReaderHistoryApi;
  readonly createReaderPositionDatabase: typeof createIndexedDbReaderPositionDatabase;
  readonly createReaderPositions: typeof createReaderPositionStore;
}

const defaultFactories: StoryPlayerCompositionFactories = {
  createSession: createNoopSessionPort,
  createClock: createBrowserClock,
  createDelay: createBrowserDelayScheduler,
  createVisibility: createDocumentVisibilitySource,
  createIdFactory: createBrowserIdFactory,
  createApi: createNexusApiClient,
  createPendingSubmissions: createPendingSubmissionStore,
  createDraftDatabase: createIndexedDbDraftDatabase,
  createActionDrafts: createStoryActionDraftStore,
  createSource: createBrowserGenerationSource,
  createWorkflow: createGenerationWorkflow,
  createIllustrations: createLegacyIllustrationApi,
  createStoryMemory: createStoryMemoryApi,
  createReaderHistory: (options) => createReaderHistoryApi(createNexusHttpClient(options)),
  createReaderPositionDatabase: createIndexedDbReaderPositionDatabase,
  createReaderPositions: createReaderPositionStore
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
  const actionDraftDatabase = environment.draftDatabase ?? factories.createDraftDatabase();
  const actionDrafts = factories.createActionDrafts(
    actionDraftDatabase,
    () => new Date(clock.now()),
    () => idFactory.create()
  );
  const readerPositionDatabase = environment.readerPositionDatabase ?? factories.createReaderPositionDatabase();
  const readerPositions = factories.createReaderPositions(readerPositionDatabase, () => new Date(clock.now()));
  const api = factories.createApi({ basePath: "/api/v1", session });
  const readerHistory = factories.createReaderHistory({ basePath: "/api/v1", session });
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

  return {
    api,
    actionDrafts,
    clock,
    delay,
    idFactory,
    illustrations: factories.createIllustrations({ basePath: "/api/v1", session }),
    pendingSubmissions,
    readerHistory,
    readerPositions,
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
