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
  WorldApi
} from "./api-client.js";
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
