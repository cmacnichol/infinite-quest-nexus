import {
  createBrowserClock,
  createBrowserDelayScheduler,
  createBrowserGenerationSource,
  createBrowserIdFactory,
  createDocumentVisibilitySource,
  createNoopSessionPort,
  createPendingSubmissionStore
} from "@infinite-quest/client-web";
import type {
  BrowserGenerationSourceOptions,
  EventSourceFactory,
  EventSourceLike,
  GenerationApi,
  NexusApiClient,
  NexusHttpClient,
  PendingSubmissionStorage,
  VisibilitySource
} from "@infinite-quest/client-web";
import type {
  AbortSignalLike,
  GenerationSnapshotSource
} from "@infinite-quest/client-core";

declare const api: GenerationApi;
declare const document: Document;
declare const signal: AbortSignalLike;

const session = createNoopSessionPort();
const clock = createBrowserClock();
const delay = createBrowserDelayScheduler();
const ids = createBrowserIdFactory();
const visibility = createDocumentVisibilitySource(document);
const storage: PendingSubmissionStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined
};
const pending = createPendingSubmissionStore(storage);
const eventSourceFactory: EventSourceFactory = (url) => new EventSource(url) as EventSourceLike;
const sourceOptions: BrowserGenerationSourceOptions = {
  api,
  basePath: "/api/v1",
  session,
  clock,
  delay,
  visibility,
  eventSourceFactory,
  random: Math.random
};
const source: GenerationSnapshotSource = createBrowserGenerationSource(sourceOptions);

void ids.create;
void pending.load;
void signal;
void source.watch;

export type {
  NexusApiClient,
  NexusHttpClient,
  VisibilitySource
};
