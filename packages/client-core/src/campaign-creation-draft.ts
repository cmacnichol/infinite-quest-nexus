import {
  campaignCreateSchema,
  normalizeHistoricalDefaultTurnControlStyle,
  playableCharacterSchema,
  type CampaignCreateRequest,
  type CampaignTurnControlStyle,
  type HistoricalCampaignTurnControlStyle
} from "@infinite-quest/contracts";

export type CampaignCreationDraft = {
  worldId: string;
  worldVersionId: string;
  title: string;
  selectedCharacterId: string | null;
  turnControlStyle: CampaignTurnControlStyle;
  startAfterCreate: boolean;
};

/** Server-provided summary of the selected immutable version and its playable characters. */
export type CampaignCreationWorld = {
  id: string;
  worldVersionId: string;
  title: string;
  playableCharacters: readonly { id: string; name: string }[];
};

export type CampaignCreationUserSettings = {
  defaultTurnControlStyle?: HistoricalCampaignTurnControlStyle;
};

export function createCampaignCreationDraft(input: {
  world: CampaignCreationWorld;
  userSettings?: CampaignCreationUserSettings;
}): CampaignCreationDraft {
  const worldId = campaignCreateSchema.shape.worldVersionId.parse(input.world.id);
  const worldVersionId = campaignCreateSchema.shape.worldVersionId.parse(input.world.worldVersionId);
  const playableCharacters = playableCharacterSchema.array().parse(input.world.playableCharacters);
  const selectedCharacterId = playableCharacters[0]?.id ?? null;

  if (!selectedCharacterId) {
    throw new Error("This world version has no available playable character for a campaign.");
  }

  return {
    worldId,
    worldVersionId,
    title: "",
    selectedCharacterId,
    turnControlStyle: normalizeHistoricalDefaultTurnControlStyle(input.userSettings?.defaultTurnControlStyle),
    startAfterCreate: true
  };
}

export function buildCampaignCreateRequest(draft: CampaignCreationDraft): CampaignCreateRequest {
  if (!draft.selectedCharacterId) {
    throw new Error("Select an available playable character before creating the campaign.");
  }

  return campaignCreateSchema.parse({
    worldVersionId: draft.worldVersionId,
    title: draft.title,
    selectedCharacterId: draft.selectedCharacterId,
    turnControlStyle: draft.turnControlStyle
  });
}
