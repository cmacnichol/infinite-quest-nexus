import { instanceSettingsViewSchema, instanceSettingsPatchSchema, settingsOperatorStatusSchema, settingsOperatorSessionResponseSchema, settingsOperatorSessionRequestSchema } from "@infinite-quest/contracts";
import type { InstanceSettingsApi } from "@infinite-quest/client-core";
export class SettingsApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
/** Cookie authority stays in the browser; CSRF and the submitted key are never stored. */
export function createInstanceSettingsApi(fetcher: typeof fetch = fetch): InstanceSettingsApi {
  async function request(path: string, method = "GET", body?: unknown, csrf?: string): Promise<unknown> {
    const response = await fetcher(`/api/v1/settings/${path}`, {
      method, credentials: "same-origin", cache: "no-store",
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(csrf ? { "X-Settings-CSRF": csrf } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    if (!response.ok) {
      const value = await response.json().catch(() => ({})) as { code?: unknown };
      throw new SettingsApiError(response.status, typeof value.code === "string" && /^settings_[a-z_]+$/.test(value.code) ? value.code : "settings_unavailable");
    }
    return response.status === 204 ? null : response.json();
  }
  return {
    status: async () => settingsOperatorStatusSchema.parse(await request("operator-session")),
    unlock: async (managementKey) => settingsOperatorSessionResponseSchema.parse(await request("operator-session", "POST", settingsOperatorSessionRequestSchema.parse({ managementKey }))),
    logout: async (csrf) => { await request("operator-session", "DELETE", undefined, csrf); },
    get: async () => instanceSettingsViewSchema.parse(await request("instance")),
    patch: async (patch, csrf) => instanceSettingsViewSchema.parse(await request("instance", "PATCH", instanceSettingsPatchSchema.parse(patch), csrf))
  };
}
