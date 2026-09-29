import {
  WorldCampaignApplicationError,
  type CampaignScope,
  type PortableWorldExportScope,
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
  if (error.reason === "invalid_transition") {
    const issue = error.details.issues?.[0];
    const index = typeof issue?.characterIndex === "number" && issue.characterIndex >= 0 && issue.characterIndex < 10_000
      ? issue.characterIndex + 1 : null;
    const eventIndex = typeof issue?.eventIndex === "number" && issue.eventIndex >= 0 && issue.eventIndex < 200
      ? issue.eventIndex + 1 : null;
    if (issue?.code === "no-playable-characters") return "This world version has no playable characters.";
    if (issue?.code === "missing-character-id" && index) return `Playable character ${index} is missing an ID.`;
    if (issue?.code === "duplicate-character-id" && index) return `Playable character ${index} has a duplicate ID.`;
    if (issue?.code === "missing-character-name" && index) return `Playable character ${index} is missing a name.`;
    if (issue?.code === "missing-character-text" && index) return `Playable character ${index} is missing character guidance.`;
    if (issue?.code === "invalid-event-rule") {
      if (eventIndex) {
        const field = ["id", "label", "timing", "condition", "effect", "addTextAfter", "triggeredCount", "lastTriggeredTurn", "lastTriggeredAt"].includes(issue.field ?? "")
          ? issue.field : null;
        return `Event rule ${eventIndex}${field ? ` needs a valid ${field}` : " is invalid"}.`;
      }
      return "This world version has too many event rules (maximum 200).";
    }
    if (error.details.selectionIssue === "required") return "Select a playable character for this campaign.";
    if (error.details.selectionIssue === "unknown") return "The selected playable character does not belong to this world version.";
  }
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
    case "turn_control_style_fence_required":
      return "Reload the campaign before changing Story Direction.";
    case "turn_control_style_changed":
      return "The campaign setting changed. Reload it before saving.";
    case "generation_in_progress":
      return "Wait for the current generation to finish before changing Story Direction.";
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
  const safeIssues = error.details.issues?.slice(0, 5).flatMap((issue) => {
    const codes = ["no-playable-characters", "missing-character-id", "duplicate-character-id", "missing-character-name", "missing-character-text", "invalid-event-rule"];
    if (!codes.includes(issue.code)) return [];
    const fields = ["id", "label", "timing", "condition", "effect", "addTextAfter", "triggeredCount", "lastTriggeredTurn", "lastTriggeredAt"];
    return [{
      code: issue.code,
      ...(typeof issue.characterIndex === "number" && issue.characterIndex >= 0 && issue.characterIndex < 10_000 ? { characterIndex: issue.characterIndex } : {}),
      ...(typeof issue.eventIndex === "number" && issue.eventIndex >= 0 && issue.eventIndex < 200 ? { eventIndex: issue.eventIndex } : {}),
      ...(fields.includes(issue.field ?? "") ? { field: issue.field } : {})
    }];
  });
  return Object.assign(new Error(applicationErrorMessage(error)), {
    name: "WorldCampaignHttpError",
    statusCode,
    details: error.reason === "invalid_transition"
      ? { code: error.reason, issues: safeIssues,
        ...(["required", "unknown"].includes(error.details.selectionIssue ?? "") ? { selectionIssue: error.details.selectionIssue } : {}) }
      : { code: error.reason, ...error.details }
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
    exportWorld: async (scope: PortableWorldExportScope) => adapter.run(async () => {
      const ownerScope = await resolveOwnerScope();
      const applicationScope = scope.worldVersionId === undefined
        ? adapter.worldScope(ownerScope.ownerUserId, scope.worldId)
        : adapter.worldVersionScope(ownerScope.ownerUserId, scope.worldId, scope.worldVersionId);
      return adapter.application.exportWorld(applicationScope);
    }),
    previewWorldImport: async (request: WorldImportRequest) => adapter.run(async () => (
      adapter.application.previewWorldImport(await resolveOwnerScope(), request)
    )),
    importWorld: async (request: WorldImportRequest) => adapter.run(async () => (
      adapter.application.importWorld(await resolveOwnerScope(), request)
    ))
  });
}
