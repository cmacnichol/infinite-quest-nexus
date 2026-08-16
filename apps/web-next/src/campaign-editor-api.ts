export interface CampaignSummary {
  id: string; title: string; status: "active" | "archived"; activeTurnNumber: number;
  worldId: string; worldTitle: string; worldVersionId: string; worldVersionNumber: number;
  latestWorldVersionNumber: number; worldUpdateAvailable: boolean; selectedCharacterName: string | null;
  textProviderProfileId: string | null; imageProviderProfileId: string | null;
  turnControlStyle: string; storyLengthProfile: string; costInformation?: unknown[];
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
  const result = await request<{ campaigns: CampaignSummary[] }>("/api/v1/campaigns", { signal });
  return Array.isArray(result.campaigns) ? result.campaigns : [];
}

export async function loadCampaign(campaignId: string, signal?: AbortSignal): Promise<CampaignSummary> {
  const campaigns = await loadCampaigns(signal);
  const campaign = campaigns.find((candidate) => candidate.id === campaignId);
  if (!campaign) throw new CampaignEditorApiError("Campaign not found.", 404);
  return campaign;
}

export const campaignApi = {
  get: <T>(campaignId: string, suffix = "", signal?: AbortSignal) => request<T>(`/api/v1/campaigns/${encodeURIComponent(campaignId)}${suffix}`, { signal }),
  patch: <T>(campaignId: string, suffix: string, body: unknown) => request<T>(`/api/v1/campaigns/${encodeURIComponent(campaignId)}${suffix}`, { method: "PATCH", body: JSON.stringify(body) }),
  put: <T>(campaignId: string, suffix: string, body: unknown) => request<T>(`/api/v1/campaigns/${encodeURIComponent(campaignId)}${suffix}`, { method: "PUT", body: JSON.stringify(body) }),
  post: <T>(campaignId: string, suffix: string, body: unknown = {}) => request<T>(`/api/v1/campaigns/${encodeURIComponent(campaignId)}${suffix}`, { method: "POST", body: JSON.stringify(body) }),
  delete: (campaignId: string) => request<void>(`/api/v1/campaigns/${encodeURIComponent(campaignId)}`, { method: "DELETE" }),
  general: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  generalPost: <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) })
};
