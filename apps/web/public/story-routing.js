export function storyCampaignPath(campaignId) {
  return `/story/${encodeURIComponent(campaignId)}`;
}

export function navigateToStoryCampaign(campaignId, browserLocation = window.location) {
  browserLocation.assign(storyCampaignPath(campaignId));
}

export async function branchCampaignFromTurn(campaignId, turnIndex, request, browserLocation = window.location) {
  const newCampaign = await request(`/campaigns/${campaignId}/branch`, {
    method: "POST",
    body: JSON.stringify({ targetTurnNumber: turnIndex + 1 })
  });
  navigateToStoryCampaign(newCampaign.id, browserLocation);
  return newCampaign;
}
