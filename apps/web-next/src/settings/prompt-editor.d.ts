import type { PromptSettingsApi } from "./owner-settings-api.js";
export function mountPromptEditor(root: HTMLElement, ports: PromptSettingsApi, campaignId: string | null, promptKey: string | null, requireCampaign?: boolean): {dispose(): void};
