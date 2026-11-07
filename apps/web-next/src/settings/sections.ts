export const SETTINGS_SECTIONS = [
  ["providers", "Providers"], ["prompts", "Prompts"], ["campaign", "Campaign"],
  ["characters", "Characters and AI Authoring"], ["sharing", "Sharing and Data Transfer"],
  ["performance", "Performance and Requests"], ["diagnostics", "Diagnostics and Deployment"]
] as const;
export type SettingsSection = typeof SETTINGS_SECTIONS[number][0];
export interface SettingsRoute { readonly section: SettingsSection; readonly campaignId: string | null; readonly campaignSelectionRequired?: true }
export function parseSettingsRoute(url: URL): SettingsRoute | null {
  if (!/^\/app\/settings\/?$/.test(url.pathname)) return null;
  const section = url.searchParams.get("section");
  const campaignId = url.searchParams.get("campaignId");
  const validCampaign = campaignId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(campaignId) ? campaignId : null;
  return {
    section: SETTINGS_SECTIONS.some(([key]) => key === section) ? section as SettingsSection : "providers",
    campaignId: validCampaign,
    ...(section === "prompts" && campaignId !== null && !validCampaign ? {campaignSelectionRequired: true} : {})
  };
}
