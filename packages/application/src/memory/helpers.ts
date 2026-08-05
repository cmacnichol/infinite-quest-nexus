import { memoryPublicFailure, type CampaignWorldVersionMemoryScope, type MemoryPublicFailure } from "./types.js";

type ScopedCampaignRow = Readonly<{
  id: string;
  world_version_id: string;
}>;

/** Validates a row already loaded through an owner-scoped query for direct-port callers. */
export function requireCampaignWorldVersionScope<T extends ScopedCampaignRow>(
  scope: CampaignWorldVersionMemoryScope,
  campaign: T | undefined
): T {
  if (!campaign || campaign.id !== scope.campaignId || campaign.world_version_id !== scope.worldVersionId) {
    throw Object.assign(new Error("Campaign not found."), { statusCode: 404 });
  }
  return campaign;
}

/** Discards adapter diagnostics so public memory reads never expose provider details. */
export function projectChroniclePublicError(_error: unknown): MemoryPublicFailure {
  return memoryPublicFailure();
}
