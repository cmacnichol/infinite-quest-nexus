import { expect, test, type Page } from "@playwright/test";

const screenshots = "docs/review/assets/structured-output";

type Provider = {
  id: string;
  name: string;
  providerType: string;
  providerRole: string;
  baseUrl: string;
  defaultModel: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  temperature: number;
  requestTimeoutMs: number;
  configuration: Record<string, unknown>;
  enabled: boolean;
  isDefault: boolean;
  responseFormatCapability?: Record<string, unknown>;
};

function requiredAt<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Expected ${label} at index ${index}.`);
  return value;
}

function relevantRuntimeErrors(errors: readonly string[]) {
  return errors.filter((error) => error !== "Failed to load resource: the server responded with a status of 404 (Not Found)");
}

const capability = (status: "verified" | "advertised" | "unsupported" | "unknown", expiresInMs = 60_000) => ({
  version: 1,
  model: "safe-model",
  expectedRegistryDigest: "bounded-digest",
  advertisedAt: new Date(Date.now() - 1_000).toISOString(),
  operations: [{ operation: "story", streaming: true, status, reason: status === "unsupported" ? "schema_incompatible" : "available", schemaVersion: null, schemaHash: null, verifiedAt: status === "verified" ? new Date(Date.now() - 1_000).toISOString() : null, expiresAt: status === "verified" ? new Date(Date.now() + expiresInMs).toISOString() : null }]
});

async function installProviderApi(page: Page) {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  const providers: Provider[] = [{
    id: "text-a", name: "Text A", providerType: "openrouter", providerRole: "text", baseUrl: "https://provider.invalid", defaultModel: "safe-model", contextWindowTokens: 32768, maxOutputTokens: 4096, temperature: 0.8, requestTimeoutMs: 300000, configuration: {}, enabled: true, isDefault: true
  }];
  const writes: Record<string, unknown>[] = [];
  let modelCapability = capability("verified");
  let heldModelRoute: import("@playwright/test").Route | null = null;
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/v1/providers" && request.method() === "GET") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ providers }) });
    if (url.pathname === "/api/v1/providers/text-a/models" && request.method() === "GET") {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ models: [{ id: "safe-model", displayName: "Safe model", loaded: true, instanceId: "safe-model", contextLength: 32768, responseFormatCapability: modelCapability }] }) });
    }
    if (url.pathname.startsWith("/api/v1/providers/") && request.method() === "PATCH") {
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push(body);
      const provider = providers.find((item) => item.id === url.pathname.split("/").at(-1));
      if (provider) Object.assign(provider, body, { configuration: body.configuration });
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(provider) });
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({}) });
  });
  return {
    providers, writes, runtimeErrors,
    setModelCapability: (value: ReturnType<typeof capability>) => { modelCapability = value; },
    holdNextModelDiscovery: async () => page.route("**/api/v1/providers/text-a/models", async (route) => { heldModelRoute = route; await page.unroute("**/api/v1/providers/text-a/models"); }),
    resolveHeldModelDiscovery: async () => { const route = heldModelRoute; heldModelRoute = null; if (route) await route.fulfill({ contentType: "application/json", body: JSON.stringify({ models: [{ id: "safe-model", displayName: "Safe model", loaded: true, instanceId: "safe-model", contextLength: 32768, responseFormatCapability: modelCapability }] }) }); }
  };
}

test("Nexus saves explicit policy choices while retaining an absent legacy policy", async ({ page }) => {
  const api = await installProviderApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("http://127.0.0.1:43173/nexus/index.html#providers");
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.locator("#providerResponseFormatPolicy")).toHaveValue("legacy");
  await page.locator("#providerForm").evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect.poll(() => api.writes.length).toBe(1);
  expect((requiredAt(api.writes, 0, "legacy provider save").configuration as Record<string, unknown>).textResponseFormatPolicy).toBeUndefined();
  await page.getByRole("button", { name: "Edit" }).click();
  await page.locator("#providerResponseFormatPolicy").selectOption("auto");
  await page.locator("#providerForm").evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect.poll(() => api.writes.length).toBe(2);
  expect((requiredAt(api.writes, 1, "automatic provider save").configuration as Record<string, unknown>).textResponseFormatPolicy).toBe("auto");
  await page.reload();
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.locator("#providerResponseFormatPolicy")).toHaveValue("auto");
  await page.locator("#refreshProviderModels").click();
  await expect(page.locator("#providerResponseFormatCapability")).toContainText("Verified schema coverage");
  await page.screenshot({ path: `${screenshots}/settings-desktop-verified.png`, fullPage: true });
  await page.locator("#providerResponseFormatPolicy").selectOption("required");
  await expect(page.locator("#providerResponseFormatCapability")).toContainText("unknown");
  await page.screenshot({ path: `${screenshots}/settings-desktop-required.png`, fullPage: true });
  await page.locator("#providerForm").evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect.poll(() => api.writes.length).toBe(3);
  expect((requiredAt(api.writes, 2, "required provider save").configuration as Record<string, unknown>).textResponseFormatPolicy).toBe("required");
  await page.reload();
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.locator("#providerResponseFormatPolicy")).toHaveValue("required");
  await page.locator("#providerResponseFormatPolicy").selectOption("legacy");
  await page.locator("#providerForm").evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect.poll(() => api.writes.length).toBe(4);
  expect((requiredAt(api.writes, 3, "explicit legacy provider save").configuration as Record<string, unknown>).textResponseFormatPolicy).toBe("legacy");
  expect(relevantRuntimeErrors(api.runtimeErrors)).toEqual([]);
});

test("Nexus displays only server capability state and hides policy controls for illustrations", async ({ page }) => {
  const api = await installProviderApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("http://127.0.0.1:43173/nexus/index.html#providers");
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.locator("#providerResponseFormatCapability")).toContainText("unknown");
  await expect(page.locator("#providerResponseFormatCapability")).not.toContainText("bounded-digest");
  await page.locator("#providerType").evaluate((control: HTMLSelectElement) => { control.value = "sogni"; control.dispatchEvent(new Event("change", { bubbles: true })); });
  await expect(page.locator("#providerResponseFormatPolicy")).toBeHidden();
  await page.screenshot({ path: `${screenshots}/settings-mobile-illustration.png`, fullPage: true });
  expect(requiredAt(api.providers, 0, "fixture provider").responseFormatCapability).toBeUndefined();
  expect(relevantRuntimeErrors(api.runtimeErrors)).toEqual([]);
});

test("Nexus fences discovery to the current model configuration and presents finite server statuses", async ({ page }) => {
  const api = await installProviderApi(page);
  await page.goto("http://127.0.0.1:43173/nexus/index.html#providers");
  await page.getByRole("button", { name: "Edit" }).click();
  await page.locator("#refreshProviderModels").click();
  await expect(page.locator("#providerResponseFormatCapability")).toContainText("Verified schema coverage");
  api.setModelCapability(capability("advertised"));
  await page.locator("#refreshProviderModelDialog").click();
  await expect(page.locator("#providerResponseFormatCapability")).toContainText("advertised");
  api.setModelCapability(capability("unsupported"));
  await page.locator("#refreshProviderModelDialog").click();
  await expect(page.locator("#providerResponseFormatCapability")).toContainText("tracker schema is incompatible");
  api.setModelCapability({
    ...capability("verified"),
    operations: [
      { operation: "story", streaming: true, status: "unsupported", reason: "schema_incompatible", schemaVersion: null, schemaHash: null, verifiedAt: null, expiresAt: null },
      { operation: "choices", streaming: false, status: "verified", reason: "available", schemaVersion: null, schemaHash: null, verifiedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }
    ]
  });
  await page.locator("#refreshProviderModelDialog").click();
  await expect(page.locator("#providerResponseFormatCapability")).toContainText("Mixed schema coverage");
  await expect(page.locator("#providerResponseFormatCapability")).toContainText("story is unavailable");
  api.setModelCapability(capability("verified", -1));
  await page.locator("#refreshProviderModelDialog").click();
  await expect(page.locator("#providerResponseFormatCapability")).toContainText("unknown");
  await api.holdNextModelDiscovery();
  await page.locator("#refreshProviderModelDialog").click();
  await page.locator("#providerResponseFormatPolicy").selectOption("auto");
  await api.resolveHeldModelDiscovery();
  await expect(page.locator("#providerResponseFormatCapability")).toContainText("unknown");
  expect(relevantRuntimeErrors(api.runtimeErrors)).toEqual([]);
});
