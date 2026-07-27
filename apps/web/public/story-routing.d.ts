export interface StoryLocation {
  assign(path: string): void;
}

export interface CampaignBranch {
  id: string;
}

export interface BranchRequestOptions {
  method: string;
  body: string;
}

export function storyCampaignPath(campaignId: string): string;

export function navigateToStoryCampaign(campaignId: string, browserLocation?: StoryLocation): void;

export function branchCampaignFromTurn(
  campaignId: string,
  turnIndex: number,
  request: (path: string, options: BranchRequestOptions) => Promise<CampaignBranch>,
  browserLocation?: StoryLocation
): Promise<CampaignBranch>;
