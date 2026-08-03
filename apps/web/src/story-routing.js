export function storyCampaignPath(campaignId) {
  return `/story/${encodeURIComponent(campaignId)}`;
}

export function navigateToStoryCampaign(campaignId, browserLocation = window.location) {
  browserLocation.assign(storyCampaignPath(campaignId));
}

export async function branchCampaignFromTurn(campaignId, targetTurnNumber, branch, browserLocation = window.location) {
  const newCampaign = await branch(campaignId, { targetTurnNumber });
  navigateToStoryCampaign(newCampaign.id, browserLocation);
  return newCampaign;
}
