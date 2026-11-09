/** Decision shared by discovery and reviewed first-appearance publication.
 * Call with current owner-scoped campaign/world authority while holding its write lock.
 * Missing historical permission must be supplied as false.
 */
export function firstAppearanceDecision(input: {
  firstAppearanceEligible: boolean;
  frozenPermission: boolean;
  livePermission: boolean;
  pinnedWorldId: string;
  sourceWorldId: string;
  selectedCharacterId: string | null;
  selectedCharacterWorldId: string | null;
  rosterCharacterId: string;
  campaignUse: "playable" | "supporting" | "both";
  identityStillSupported: boolean;
  unique: boolean;
  detached: boolean;
}): "seed" | "plain" | "review" | "protagonist" {
  if (input.selectedCharacterId === input.rosterCharacterId && (input.selectedCharacterWorldId === null || input.selectedCharacterWorldId === input.pinnedWorldId)) return "protagonist";
  if (!input.firstAppearanceEligible || !input.frozenPermission || !input.livePermission || input.campaignUse === "playable") return "plain";
  if (input.sourceWorldId !== input.pinnedWorldId || !input.identityStillSupported || !input.unique || input.detached) return "review";
  return "seed";
}
