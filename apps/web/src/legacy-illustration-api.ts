import { createIllustrationApi, createNexusHttpClient } from "@infinite-quest/client-web";
import type { IllustrationApi, NexusHttpClientOptions } from "@infinite-quest/client-web";

export type {
  IllustrationConfigResponse,
  IllustrationRematchResponse,
  IllustrationResolutionResponse,
  IllustrationSegmentsResponse,
  ImageJobResponse,
  ImageJobsResponse,
  SegmentGenerationResponse,
  SegmentImageResponse
} from "@infinite-quest/contracts";

export type LegacyIllustrationApi = IllustrationApi;
export type LegacyIllustrationApiOptions = NexusHttpClientOptions;

export function createLegacyIllustrationApi(options: LegacyIllustrationApiOptions): LegacyIllustrationApi {
  return createIllustrationApi(createNexusHttpClient(options));
}
