import { writeCampaignSettings } from "@infinite-quest/client-web";
export interface CampaignSummary {
  id: string; title: string; status: "active" | "archived"; activeTurnNumber: number;
  worldId: string; worldTitle: string; worldVersionId: string; worldVersionNumber: number;
  latestWorldVersionNumber: number; worldUpdateAvailable: boolean; selectedCharacterName: string | null;
  textProviderProfileId: string | null; imageProviderProfileId: string | null;
  turnControlStyle: string; storyLengthProfile: string; storyContextBudgetTokens: number; costInformation?: unknown[];
}

export class CampaignEditorApiError extends Error {
  constructor(message: string, readonly status: number | null, readonly details?: unknown) { super(message); }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try { response = await fetch(path, { headers: { Accept: "application/json", "Content-Type": "application/json", ...init.headers }, ...init }); }
  catch (error) { throw new CampaignEditorApiError(error instanceof Error ? error.message : "Campaign request failed.", null); }
  const value = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const serverMessage = typeof body.message === "string" ? body.message : typeof body.error === "string" ? body.error : null;
    throw new CampaignEditorApiError(serverMessage ?? `Request failed with status ${response.status}.`, response.status, body.details);
  }
  return value as T;
}

export async function loadCampaigns(signal?: AbortSignal): Promise<CampaignSummary[]> {
  const result = await request<{ campaigns: CampaignSummary[] }>("/api/v1/campaigns", { signal: signal ?? null });
  return Array.isArray(result.campaigns) ? result.campaigns : [];
}

export async function loadCampaign(campaignId: string, signal?: AbortSignal): Promise<CampaignSummary> {
  const campaigns = await loadCampaigns(signal);
  const campaign = campaigns.find((candidate) => candidate.id === campaignId);
  if (!campaign) throw new CampaignEditorApiError("Campaign not found.", 404);
  return campaign;
}

export const campaignApi = {
  saveSettings: <T>(id: string, section: Parameters<typeof writeCampaignSettings>[2], payload: unknown, signal?: AbortSignal) =>
    writeCampaignSettings(request<T>, id, section, payload, signal),
  get: <T>(campaignId: string, suffix = "", signal?: AbortSignal) => request<T>(`/api/v1/campaigns/${encodeURIComponent(campaignId)}${suffix}`, { signal: signal ?? null }),
  patch: <T>(campaignId: string, suffix: string, body: unknown, signal?: AbortSignal) => request<T>(`/api/v1/campaigns/${encodeURIComponent(campaignId)}${suffix}`, { signal: signal ?? null, method: "PATCH", body: JSON.stringify(body) }),
  put: <T>(campaignId: string, suffix: string, body: unknown, signal?: AbortSignal) => request<T>(`/api/v1/campaigns/${encodeURIComponent(campaignId)}${suffix}`, { signal: signal ?? null, method: "PUT", body: JSON.stringify(body) }),
  post: <T>(campaignId: string, suffix: string, body: unknown = {}) => request<T>(`/api/v1/campaigns/${encodeURIComponent(campaignId)}${suffix}`, { method: "POST", body: JSON.stringify(body) }),
  delete: (campaignId: string) => request<void>(`/api/v1/campaigns/${encodeURIComponent(campaignId)}`, { method: "DELETE" }),
  general: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal: signal ?? null }),
  generalPost: <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) })
};


export interface CampaignSettingsContext {
  readonly campaignId: string;
  readonly epoch: number;
  readonly signal: AbortSignal;
  current(): boolean;
}

export function createCampaignSettingsScope(campaigns: ReadonlyArray<{id: string}>) {
  let epoch = 0;
  let controller: AbortController | null = null;
  let disposed = false;
  return {
    select(id: string): CampaignSettingsContext | null {
      controller?.abort();
      const selection = ++epoch;
      if (disposed || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ||
          !campaigns.some(campaign => campaign.id === id)) return null;
      controller = new AbortController();
      return {campaignId: id, epoch: selection, signal: controller.signal, current: () => !disposed && selection === epoch};
    },
    dispose() { disposed = true; controller?.abort(); }
  };
}
