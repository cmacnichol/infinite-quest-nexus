import { expect, it, vi } from "vitest";
import { createInstanceSettingsApi } from "../../packages/client-web/src/instance-settings-api.js";
it("uses same-origin cookies and memory CSRF with schema validation", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00Z" }))).mockResolvedValueOnce(new Response(null, { status: 204 }));
  const api = createInstanceSettingsApi(fetcher);
  await api.unlock("private-key"); await api.logout("csrf");
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: "same-origin", cache: "no-store", body: JSON.stringify({ managementKey: "private-key" }) });
  expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE", credentials: "same-origin", headers: { "X-Settings-CSRF": "csrf" } });
  expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/settings/operator-session");
});
it("does not reflect untrusted error content or accept malformed protected responses", async () => {
  const api = createInstanceSettingsApi(vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "secret planted private path" }), { status: 503 })));
  await expect(api.get()).rejects.toMatchObject({ status: 503, code: "settings_unavailable", message: "settings_unavailable" });
  const malformed = createInstanceSettingsApi(vi.fn().mockResolvedValue(new Response(JSON.stringify({ unlocked: true, apiKey: "private" }))));
  await expect(malformed.status()).rejects.toThrow();
});

it("sends the local restart marker and validates operation responses", async () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const operation = { operationId: id, revision: "2", status: "draining" };
  const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify(operation)));
  const api = createInstanceSettingsApi(fetcher);
  expect(await api.restart!("2", id)).toEqual(operation);
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json", "X-Settings-Local": "1" }, body: JSON.stringify({ expectedRequestedRevision: "2", operationId: id }) });
  expect(await api.restartStatus!(id)).toEqual(operation);
});
