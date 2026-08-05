import {
  WorldCampaignApplicationError,
  type CampaignScope,
  type PortableWorldApplicationPort,
  type WorldCampaignApplication,
  type WorldImportRequest,
  type WorldScope,
  type WorldVersionScope
} from "../../../packages/application/src/world-campaign/index.js";
import type { OwnerScope } from "../../../packages/application/src/index.js";

export type WorldCampaignHttpError = Error & {
  statusCode: number;
  details: Readonly<Record<string, unknown>>;
};

export type WorldCampaignApplicationAdapter = Readonly<{
  application: WorldCampaignApplication;
  ownerScope(ownerUserId: string): OwnerScope;
  worldScope(ownerUserId: string, worldId: string): WorldScope;
  worldVersionScope(ownerUserId: string, worldId: string, worldVersionId: string): WorldVersionScope;
  campaignScope(ownerUserId: string, campaignId: string): CampaignScope;
  run<T>(operation: () => Promise<T>): Promise<T>;
}>;

function applicationErrorMessage(error: WorldCampaignApplicationError): string {
  switch (error.reason) {
    case "world_not_found":
      return "World not found.";
    case "world_version_not_found":
      return "World version not found.";
    case "campaign_not_found":
      return "Campaign not found.";
    case "published_version_immutable":
      return "Published world versions are immutable.";
    case "draft_revision_changed":
      return "The world draft changed. Reload it before saving.";
    case "world_version_changed":
      return "The campaign world version changed. Reload it before continuing.";
    case "active_turn_changed":
      return "The campaign turn changed. Reload it before continuing.";
    case "state_revision_changed":
      return "The campaign state changed. Reload it before continuing.";
    case "deletion_blocked":
      return "The resource cannot be deleted while dependent records remain.";
    case "generation_collaborator_unavailable":
      return "The requested generation provider is unavailable.";
    default:
      return "The world or campaign operation could not be completed.";
  }
}

export function mapWorldCampaignApplicationError(
  error: WorldCampaignApplicationError,
): WorldCampaignHttpError {
  const statusCode = error.kind === "not_found"
    ? 404
    : error.kind === "invalid_request"
      ? 400
      : error.kind === "unavailable"
        ? 503
        : 409;
  return Object.assign(new Error(applicationErrorMessage(error)), {
    name: "WorldCampaignHttpError",
    statusCode,
    details: { code: error.reason, ...error.details }
  });
}

export function createWorldCampaignApplicationAdapter(
  application: WorldCampaignApplication,
): WorldCampaignApplicationAdapter {
  return Object.freeze({
    application,
    ownerScope: (ownerUserId) => Object.freeze({ ownerUserId }),
    worldScope: (ownerUserId, worldId) => Object.freeze({ ownerUserId, worldId }),
    worldVersionScope: (ownerUserId, worldId, worldVersionId) => Object.freeze({ ownerUserId, worldId, worldVersionId }),
    campaignScope: (ownerUserId, campaignId) => Object.freeze({ ownerUserId, campaignId }),
    async run<T>(operation: () => Promise<T>): Promise<T> {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof WorldCampaignApplicationError) {
          throw mapWorldCampaignApplicationError(error);
        }
        throw error;
      }
    }
  });
}

export function createOwnerBoundPortableWorldApplicationPort(
  adapter: WorldCampaignApplicationAdapter,
  resolveOwnerScope: () => Promise<OwnerScope>,
): PortableWorldApplicationPort {
  return Object.freeze({
    previewWorldImport: async (request: WorldImportRequest) => adapter.run(async () => (
      adapter.application.previewWorldImport(await resolveOwnerScope(), request)
    )),
    importWorld: async (request: WorldImportRequest) => adapter.run(async () => (
      adapter.application.importWorld(await resolveOwnerScope(), request)
    ))
  });
}
