import type { SafeProviderProfileView } from "@infinite-quest/contracts";
import { CURRENT_STORY_RESPONSE_FORMAT_CAPABILITY_IDENTITY } from "@infinite-quest/contracts";

export type ProviderTimestampParser = (value: string) => number;

export type ProviderReadinessRole = "text" | "image" | "embedding";
export type ProviderInventoryStatus = "unknown" | "checking" | "available" | "unavailable";

export interface ProviderInventoryObservation {
  readonly profileId: string;
  readonly role: ProviderReadinessRole;
  readonly providerType: SafeProviderProfileView["providerType"];
  readonly baseUrl: string;
  readonly modelId: string;
  readonly status: ProviderInventoryStatus;
  readonly modelIds: readonly string[];
  readonly checkedAt: string | null;
}

export type ProviderReadinessState = "not-configured" | "checking" | "ready" | "unavailable";
export type ProviderReadinessCapabilityState = "not-applicable" | "unknown" | "advertised" | "expired" | "malformed" | "identity-mismatch" | "unsupported" | "verified";

export interface ProviderReadinessResult {
  readonly role: ProviderReadinessRole;
  readonly state: ProviderReadinessState;
  readonly profileId: string | null;
  readonly health: "not-configured" | "unknown" | "healthy" | "unavailable";
  readonly inventory: "not-configured" | "unknown" | "checking" | "available" | "unavailable";
  readonly capability: ProviderReadinessCapabilityState;
}

function validTimestamp(value: unknown, parseTimestamp: ProviderTimestampParser): number | null {
  if (typeof value !== "string") return null;
  const timestamp = parseTimestamp(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function capabilityState(profile: SafeProviderProfileView, now: number, parseTimestamp: ProviderTimestampParser): ProviderReadinessCapabilityState {
  if (profile.providerRole !== "text") return "not-applicable";
  const capability: unknown = profile.responseFormatCapability;
  if (capability === undefined || capability === null) return "unknown";
  if (typeof capability !== "object" || Array.isArray(capability)) return "malformed";
  const value = capability as Record<string, unknown>;
  if (value.version !== 1 || typeof value.model !== "string" || !Array.isArray(value.operations) || typeof value.expectedRegistryDigest !== "string" || !value.expectedRegistryDigest.trim()) return "malformed";
  if (value.model !== profile.defaultModel) return "identity-mismatch";
  const operations = value.operations.filter((operation): operation is Record<string, unknown> => Boolean(operation) && typeof operation === "object" && !Array.isArray(operation));
  if (operations.length !== value.operations.length) return "malformed";
  const story = operations.filter((operation) => operation.operation === "story" && operation.streaming === Boolean(profile.configuration.streaming || profile.configuration.streamingSupport));
  if (!story.length) return operations.some((operation) => operation.operation === "story") ? "identity-mismatch" : "unknown";
  const exact = story.find((operation) => operation.schemaVersion === CURRENT_STORY_RESPONSE_FORMAT_CAPABILITY_IDENTITY.schemaVersion && operation.schemaHash === CURRENT_STORY_RESPONSE_FORMAT_CAPABILITY_IDENTITY.schemaHash);
  if (!exact) return "identity-mismatch";
  if (exact.status === "advertised") return "malformed";
  if (exact.status === "unsupported") return "unsupported";
  if (exact.status === "unknown") {
    const advertisedAt = validTimestamp(value.advertisedAt, parseTimestamp);
    return advertisedAt !== null && advertisedAt <= now ? "advertised" : "unknown";
  }
  if (exact.status !== "verified") return "unknown";
  const verifiedAt = validTimestamp(exact.verifiedAt, parseTimestamp);
  const expiresAt = validTimestamp(exact.expiresAt, parseTimestamp);
  if (verifiedAt === null || expiresAt === null) return "malformed";
  if (verifiedAt > now || expiresAt <= verifiedAt) return "malformed";
  if (!Number.isFinite(now)) return "malformed";
  if (expiresAt <= now) return "expired";
  return "verified";
}

function matchingInventory(profile: SafeProviderProfileView, inventories: readonly ProviderInventoryObservation[]): ProviderInventoryObservation | undefined {
  // Observations are ordered oldest-to-newest; the last matching refresh is authoritative.
  for (let index = inventories.length - 1; index >= 0; index -= 1) {
    const item = inventories[index];
    if (item?.profileId === profile.id
      && item.role === profile.providerRole
      && item.providerType === profile.providerType
      && item.baseUrl === profile.baseUrl
      && item.modelId === profile.defaultModel) return item;
  }
  return undefined;
}

export function providerReadinessForRole(
  role: ProviderReadinessRole,
  profiles: readonly SafeProviderProfileView[],
  inventories: readonly ProviderInventoryObservation[],
  now: number,
  parseTimestamp: ProviderTimestampParser
): ProviderReadinessResult {
  if (!Number.isFinite(now)) return { role, state: "unavailable", profileId: null, health: "unknown", inventory: "unknown", capability: role === "text" ? "unknown" : "not-applicable" };
  const configured = profiles.filter((profile) => profile.providerRole === role);
  if (!configured.length) return { role, state: "not-configured", profileId: null, health: "not-configured", inventory: "not-configured", capability: role === "text" ? "unknown" : "not-applicable" };
  const profile = configured.find((candidate) => candidate.enabled && candidate.isDefault) || configured.find((candidate) => candidate.enabled);
  if (!profile) return { role, state: "unavailable", profileId: configured[0]?.id ?? null, health: "unavailable", inventory: "unavailable", capability: role === "text" ? "unknown" : "not-applicable" };

  const healthCheckedAt = profile.healthStatus === "healthy" ? validTimestamp(profile.lastHealthCheckAt, parseTimestamp) : null;
  const health = profile.healthStatus === "healthy" && healthCheckedAt !== null && healthCheckedAt <= now
    ? "healthy"
    : profile.healthStatus === "unavailable" || profile.healthStatus === "degraded" ? "unavailable" : "unknown";
  const inventory = matchingInventory(profile, inventories);
  let inventoryState: ProviderReadinessResult["inventory"] = "unknown";
  if (!profile.defaultModel.trim()) inventoryState = "unavailable";
  else if (inventory?.status === "checking") inventoryState = "checking";
  else if (inventory?.status === "unavailable") inventoryState = "unavailable";
  else if (inventory?.status === "available") {
    const checkedAt = validTimestamp(inventory.checkedAt, parseTimestamp);
    inventoryState = checkedAt !== null && checkedAt <= now && inventory.modelIds.includes(profile.defaultModel) ? "available" : "unavailable";
  }
  const capability = capabilityState(profile, now, parseTimestamp);
  const capabilityReady = role !== "text" || capability === "verified";
  const allReady = health === "healthy" && inventoryState === "available" && capabilityReady;
  const hasFailure = health === "unavailable" || inventoryState === "unavailable" || (role === "text" && ["advertised", "expired", "malformed", "identity-mismatch", "unsupported"].includes(capability));
  const state: ProviderReadinessState = allReady ? "ready" : !hasFailure && inventoryState === "checking" ? "checking" : "unavailable";
  return { role, state, profileId: profile.id, health, inventory: inventoryState, capability };
}
