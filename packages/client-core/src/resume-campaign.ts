/** Campaign-list fields used for selection; updatedAt follows the API's UTC ISO timestamp contract. */
export interface ResumeCampaign {
  readonly id: string;
  readonly status: "active" | "archived";
  readonly updatedAt: string;
}

function compareUtcTimestamps(left: string, right: string): number {
  const pattern = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/u;
  const leftParts = pattern.exec(left);
  const rightParts = pattern.exec(right);
  if (!leftParts || !rightParts) return Number(Boolean(leftParts)) - Number(Boolean(rightParts));
  if (leftParts[1] !== rightParts[1]) return leftParts[1]! > rightParts[1]! ? 1 : -1;
  const leftFraction = leftParts[2] ?? "";
  const rightFraction = rightParts[2] ?? "";
  const precision = Math.max(leftFraction.length, rightFraction.length);
  for (let index = 0; index < precision; index += 1) {
    const leftDigit = leftFraction.charCodeAt(index) || 48;
    const rightDigit = rightFraction.charCodeAt(index) || 48;
    if (leftDigit !== rightDigit) return leftDigit > rightDigit ? 1 : -1;
  }
  return 0;
}

export function resolveResumeCampaign<T extends ResumeCampaign>(
  campaigns: readonly T[],
  rememberedId: string | null | undefined,
  selectedId: string | null | undefined
): T | null {
  if (selectedId) {
    const selected = campaigns.find((campaign) => campaign.id === selectedId);
    if (selected) return selected;
  }

  if (rememberedId) {
    const remembered = campaigns.find((campaign) => campaign.id === rememberedId && campaign.status === "active");
    if (remembered) return remembered;
  }

  return campaigns
    .filter((campaign) => campaign.status === "active")
    .reduce<T | null>((mostRecent, campaign) => {
      if (!mostRecent) return campaign;
      return compareUtcTimestamps(campaign.updatedAt, mostRecent.updatedAt) > 0 ? campaign : mostRecent;
    }, null);
}
