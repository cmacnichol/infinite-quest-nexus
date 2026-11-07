/** Both campaign management clients use these existing, owner-scoped mutation routes. */
const routes = {
  behavior: ["PATCH",""],
  chronicle: ["PUT","/memory/embedding-config"],
  illustrations: ["PUT","/illustration-config"]
} as const;

export function writeCampaignSettings<T>(
  request: (path: string, init: RequestInit) => Promise<T>,
  campaignId: string, section: keyof typeof routes, payload: unknown, signal?: AbortSignal
): Promise<T> {
  if (!campaignId) throw new Error("Choose a campaign before saving.");
  const [method,suffix] = routes[section];
  return request("/api/v1/campaigns/" + encodeURIComponent(campaignId) + suffix, {
    method, body:JSON.stringify(payload), ...(signal ? {signal} : {})
  });
}
