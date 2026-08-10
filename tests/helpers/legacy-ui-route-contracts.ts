export type LegacyUiHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface LegacyUiRouteContract {
  readonly surface: "dashboard" | "story";
  readonly method: LegacyUiHttpMethod;
  readonly url: string;
  readonly owner: "direct" | "typed-client" | "illustration-adapter" | "asset-url";
}

function dashboard(
  method: LegacyUiHttpMethod,
  url: string,
  owner: LegacyUiRouteContract["owner"] = "direct"
): LegacyUiRouteContract {
  return { surface: "dashboard", method, url, owner };
}

function story(
  method: LegacyUiHttpMethod,
  url: string,
  owner: LegacyUiRouteContract["owner"] = "typed-client"
): LegacyUiRouteContract {
  return { surface: "story", method, url, owner };
}

export const legacyDashboardRouteContracts = [
  dashboard("GET", "/api/v1/meta"),
  dashboard("GET", "/api/v1/session"),
  dashboard("PATCH", "/api/v1/users/me/profile"),
  dashboard("GET", "/api/v1/dashboard/stats"),

  dashboard("GET", "/api/v1/prompt-library"),
  dashboard("POST", "/api/v1/prompt-library/preview"),
  dashboard("PUT", "/api/v1/prompt-library/overrides"),
  dashboard("DELETE", "/api/v1/prompt-library/overrides"),

  dashboard("GET", "/api/v1/providers"),
  dashboard("POST", "/api/v1/providers"),
  dashboard("PATCH", "/api/v1/providers/:providerId"),
  dashboard("DELETE", "/api/v1/providers/:providerId"),
  dashboard("PUT", "/api/v1/providers/:providerId/default"),
  dashboard("GET", "/api/v1/providers/:providerId/models"),
  dashboard("POST", "/api/v1/providers/discover-models"),

  dashboard("GET", "/api/v1/worlds"),
  dashboard("POST", "/api/v1/worlds"),
  dashboard("GET", "/api/v1/worlds/:worldId"),
  dashboard("PUT", "/api/v1/worlds/:worldId/draft"),
  dashboard("PATCH", "/api/v1/worlds/:worldId"),
  dashboard("DELETE", "/api/v1/worlds/:worldId"),
  dashboard("POST", "/api/v1/worlds/generate-preview"),
  dashboard("GET", "/api/v1/worlds/generate-progress"),
  dashboard("POST", "/api/v1/worlds/playable-characters/generate-preview"),
  dashboard("POST", "/api/v1/worlds/:worldId/draft/playable-characters/organize"),
  dashboard("POST", "/api/v1/worlds/:worldId/publish"),
  dashboard("POST", "/api/v1/worlds/:worldId/fork"),
  dashboard("DELETE", "/api/v1/worlds/:worldId/versions/:worldVersionId"),
  dashboard("GET", "/api/v1/worlds/:worldId/export"),
  dashboard("GET", "/api/v1/world-versions/:worldVersionId/playable-characters"),
  dashboard("GET", "/api/v1/worlds/:worldId/cover-job"),
  dashboard("POST", "/api/v1/worlds/:worldId/cover"),
  dashboard("PUT", "/api/v1/worlds/:worldId/cover-asset"),

  dashboard("GET", "/api/v1/campaigns"),
  dashboard("POST", "/api/v1/campaigns"),
  dashboard("PATCH", "/api/v1/campaigns/:campaignId"),
  dashboard("DELETE", "/api/v1/campaigns/:campaignId"),
  dashboard("GET", "/api/v1/campaigns/:campaignId/character-profile"),
  dashboard("PUT", "/api/v1/campaigns/:campaignId/character-profile"),
  dashboard("POST", "/api/v1/campaigns/:campaignId/character-profile/organize"),
  dashboard("POST", "/api/v1/campaigns/:campaignId/migrate-world"),
  dashboard("POST", "/api/v1/campaigns/:campaignId/transfer-world/preview"),
  dashboard("POST", "/api/v1/campaigns/:campaignId/transfer-world"),
  dashboard("GET", "/api/v1/campaigns/:campaignId/export"),
  dashboard("GET", "/api/v1/campaigns/:campaignId/turns"),
  dashboard("GET", "/api/v1/campaigns/:campaignId/cost-summary"),
  dashboard("GET", "/api/v1/campaigns/:campaignId/memory/metrics"),
  dashboard("GET", "/api/v1/campaigns/:campaignId/memory/context-preview"),
  dashboard("GET", "/api/v1/campaigns/:campaignId/memory/embedding-config"),
  dashboard("PUT", "/api/v1/campaigns/:campaignId/memory/embedding-config"),
  dashboard("POST", "/api/v1/campaigns/:campaignId/memory/reindex"),
  dashboard("GET", "/api/v1/jobs/:jobId"),

  dashboard("GET", "/api/v1/campaigns/:campaignId/illustration-config"),
  dashboard("PUT", "/api/v1/campaigns/:campaignId/illustration-config"),
  dashboard("GET", "/api/v1/campaigns/:campaignId/image-jobs"),
  dashboard("POST", "/api/v1/campaigns/:campaignId/illustration-backfill/preview"),
  dashboard("POST", "/api/v1/campaigns/:campaignId/illustration-backfill"),
  dashboard("GET", "/api/v1/image-jobs/:jobId"),
  dashboard("POST", "/api/v1/image-jobs/:jobId/retry"),
  dashboard("POST", "/api/v1/turns/:turnId/illustrations"),
  dashboard("GET", "/api/v1/assets"),
  dashboard("PATCH", "/api/v1/assets/:assetId/library-metadata"),

  dashboard("POST", "/api/v1/imports/legacy-story/preview"),
  dashboard("POST", "/api/v1/imports/legacy-story"),
  dashboard("POST", "/api/v1/imports/world/preview"),
  dashboard("POST", "/api/v1/imports/world"),
  dashboard("POST", "/api/v1/imports/infinite-worlds/preview"),
  dashboard("POST", "/api/v1/imports/infinite-worlds"),
  dashboard("GET", "/api/v1/imports/progress"),
  dashboard("POST", "/api/v1/imports/campaign-archive/preview"),
  dashboard("POST", "/api/v1/imports/campaign-archive")
] as const satisfies readonly LegacyUiRouteContract[];

export const legacyStoryRouteContracts = [
  story("GET", "/api/v1/meta"),
  story("GET", "/api/v1/session"),
  story("PATCH", "/api/v1/users/me/profile"),
  story("GET", "/api/v1/providers"),
  story("GET", "/api/v1/campaigns/:campaignId/sync-status"),
  story("GET", "/api/v1/campaigns/:campaignId/turns"),
  story("GET", "/api/v1/campaigns/:campaignId/state"),
  story("PATCH", "/api/v1/campaigns/:campaignId/state"),
  story("POST", "/api/v1/campaigns/:campaignId/turn-input/classify"),
  story("POST", "/api/v1/campaigns/:campaignId/rewind"),
  story("POST", "/api/v1/campaigns/:campaignId/branch"),
  story("POST", "/api/v1/campaigns/:campaignId/generations"),
  story("POST", "/api/v1/campaigns/:campaignId/generations/retry-latest"),
  story("GET", "/api/v1/generation-jobs/:jobId"),
  story("GET", "/api/v1/generation-jobs/:jobId/stream"),
  story("GET", "/api/v1/generation-jobs/:jobId/result"),
  story("POST", "/api/v1/generation-jobs/:jobId/retry"),
  story("POST", "/api/v1/generation-jobs/:jobId/cancel"),
  story("POST", "/api/v1/generation-jobs/:jobId/discard"),

  story("GET", "/api/v1/campaigns/:campaignId/illustration-config", "illustration-adapter"),
  story("GET", "/api/v1/campaigns/:campaignId/illustration-segments", "illustration-adapter"),
  story("GET", "/api/v1/campaigns/:campaignId/image-jobs", "illustration-adapter"),
  story("POST", "/api/v1/image-jobs/:jobId/retry", "illustration-adapter"),
  story("POST", "/api/v1/illustration-segments/:segmentId/images", "illustration-adapter"),
  story("POST", "/api/v1/turns/:turnId/illustration-segments", "illustration-adapter"),
  story("GET", "/api/v1/turns/:turnId/illustration-resolution", "illustration-adapter"),
  story("POST", "/api/v1/turns/:turnId/illustration-match", "illustration-adapter"),
  story("GET", "/api/v1/assets/:assetId", "asset-url")
] as const satisfies readonly LegacyUiRouteContract[];
