export function settingsBookmarkDestination(hash: string): string {
  const [section, query] = hash.slice(1).split("?");
  const params = new URLSearchParams({section: section === "providers" ? "providers" : "prompts"});
  const campaign = new URLSearchParams(query ?? "").get("campaignId");
  if (campaign !== null) params.set("campaignId", campaign);
  return "/app/settings?" + params.toString();
}
