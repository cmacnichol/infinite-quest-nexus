export interface StoryLocation {
  assign(path: string): void;
}

export interface CampaignBranch {
  id: string;
}

export function storyCampaignPath(campaignId: string): string;

export function navigateToStoryCampaign(campaignId: string, browserLocation?: StoryLocation): void;

export function branchCampaignFromTurn(
  campaignId: string,
  targetTurnNumber: number,
  branch: (campaignId: string, request: { targetTurnNumber: number }) => Promise<CampaignBranch>,
  browserLocation?: StoryLocation
): Promise<CampaignBranch>;
