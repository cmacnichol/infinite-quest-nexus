import type {
  CampaignPlayMode,
  CampaignTurnControlStyle,
  HistoricalCampaignTurnControlStyle
} from "@infinite-quest/contracts";

export function normalizeHistoricalTurnControlStyle(
  style: HistoricalCampaignTurnControlStyle
): CampaignTurnControlStyle {
  return style === "flexible_auto" ? "flexible_action" : style;
}

export function campaignPlayModeForControlStyle(style: CampaignTurnControlStyle): CampaignPlayMode {
  return style === "flexible_scene" ? "story_only" : "legacy";
}

export function generationStagePolicy(mode: CampaignPlayMode): Readonly<{
  allowRpgAssessment: boolean;
  allowEventEvaluation: boolean;
  allowSceneCoverage: boolean;
}> {
  if (mode === "story_only") {
    return Object.freeze({
      allowRpgAssessment: false,
      allowEventEvaluation: false,
      allowSceneCoverage: false
    });
  }

  return Object.freeze({
    allowRpgAssessment: true,
    allowEventEvaluation: true,
    allowSceneCoverage: true
  });
}
