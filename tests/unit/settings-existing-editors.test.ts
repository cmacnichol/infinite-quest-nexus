import { expect, it, vi } from "vitest";
import { createOwnerSettingsApis } from "../../apps/web-next/src/settings/owner-settings-api.js";

it("lists account profiles without discovering models", async () => {
  const transport = vi.fn().mockResolvedValue(Response.json({ providers: [] }));
  const api = createOwnerSettingsApis(transport);
  expect(await api.providers.list(new AbortController().signal)).toEqual({providers: []});
  expect(transport.mock.calls.map(call => call[0])).toEqual(["/api/v1/providers"]);
});

it("omits blank credentials and untouched policy fields and rejects unsafe profile responses", async () => {
  const calls: Record<string, unknown>[] = [];
  const transport: typeof fetch = async (_url, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return Response.json({
      id: "11111111-1111-4111-8111-111111111111", name: "Edited", providerRole: "text", providerType: "lmstudio",
      baseUrl: "https://fixture.invalid", defaultModel: "fixture", contextWindowTokens: 32768, maxOutputTokens: 4096,
      temperature: 0.7, requestTimeoutMs: 300000, configuration: {}, enabled: true, isDefault: true,
      hasApiKey: true, healthStatus: "unknown", consecutiveFailures: 0, lastHealthCheckAt: null, lastHealthError: null,
      createdAt: "2026-11-06T00:00:00Z", updatedAt: "2026-11-06T00:00:00Z", apiKey: "synthetic-unsafe-field"
    });
  };
  const api = createOwnerSettingsApis(transport);
  await expect(api.providers.save("11111111-1111-4111-8111-111111111111", {name: "Edited", apiKey: ""}, new AbortController().signal)).rejects.toThrow();
  expect(calls).toEqual([{name:"Edited"}]);
});
