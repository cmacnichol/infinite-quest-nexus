import type { SessionPort } from "@infinite-quest/client-core";

export {
  createNexusHttpClient
} from "./http-client.js";
export type {
  BaseRequestSpec,
  BlobRequestSpec,
  EmptyRequestSpec,
  JsonRequestSpec,
  NexusHttpClient,
  NexusHttpClientOptions,
  RequestBody,
  RequestSpec
} from "./http-client.js";
export {
  createNexusApiClient
} from "./api-client.js";
export type {
  CampaignApi,
  GenerationApi,
  NexusApiClient,
  ProviderApi,
  SessionApi,
  ShellApi,
  WorldApi
} from "./api-client.js";
export {
  createIllustrationApi
} from "./illustration-api.js";
export type {
  IllustrationApi
} from "./illustration-api.js";
export {
  createBrowserGenerationSource
} from "./generation/fallback-source.js";
export type {
  BrowserGenerationSourceOptions,
  EventSourceFactory,
  EventSourceLike,
  VisibilitySource
} from "./generation/types.js";
export {
  createPendingSubmissionStore
} from "./storage/pending-submissions.js";
export type {
  PendingSubmissionStorage
} from "./storage/pending-submissions.js";
export {
  createBrowserClock
} from "./platform/clock.js";
export {
  createBrowserDelayScheduler
} from "./platform/delay.js";
export {
  createBrowserIdFactory
} from "./platform/ids.js";
export {
  createDocumentVisibilitySource
} from "./platform/visibility.js";
export {
  ApiContractError,
  NexusApiError
} from "@infinite-quest/client-core";
export type {
  ApiContractErrorKind,
  ApiContractErrorPhase,
  HttpMethod
} from "@infinite-quest/client-core";

const noOpSessionPort: SessionPort = {
  authorization: async () => ({}),
  onUnauthorized: async () => false
};

export function createNoopSessionPort(): SessionPort {
  return noOpSessionPort;
}
