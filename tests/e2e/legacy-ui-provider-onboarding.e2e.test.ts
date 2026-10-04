import { expect, test, type Page } from "@playwright/test";
import { safeProviderConfigurationSchema, safeProviderProfileViewSchema, type SafeProviderProfileView } from "../../packages/contracts/src/provider-profile-view.js";
import { quietLeafApiPayloads } from "../fixtures/quiet-leaf-payloads.js";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const now = "2026-10-03T12:00:00.000Z";
const textProfileId = "11111111-1111-4111-8111-111111111111";
const imageProfileId = "22222222-2222-4222-8222-222222222222";
const responseFormatCapability: NonNullable<SafeProviderProfileView["responseFormatCapability"]> = {
  version: 1,
  model: "vendor/story-model",
  expectedRegistryDigest: "synthetic-registry-v1",
  advertisedAt: now,
  operations: [{
    operation: "story",
    streaming: false,
    status: "unknown",
    reason: "not_checked",
    schemaVersion: "story-native-v1",
    schemaHash: "10765575fa1c47721ba4f72f81d918edc2dbf6df288e952f84ae4f485bcc55d7",
    verifiedAt: null,
    expiresAt: null
  }]
};

type Provider = SafeProviderProfileView;
function requiredItem<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`Expected item at index ${index}.`);
  return item;
}

function verifiedStoryCapability(verifiedAt: string, expiresAt: string): NonNullable<Provider["responseFormatCapability"]> {
  const storyOperation = responseFormatCapability.operations.find(operation => operation.operation === "story");
  if (!storyOperation?.schemaVersion || !storyOperation.schemaHash) throw new Error("Synthetic story capability fixture is incomplete.");
  return {
    ...responseFormatCapability,
    operations: [{
      operation: "story",
      streaming: false,
      status: "verified",
      reason: null,
      schemaVersion: storyOperation.schemaVersion,
      schemaHash: storyOperation.schemaHash,
      verifiedAt,
      expiresAt
    }]
  };
}
const unexpectedRequestsByPage = new WeakMap<Page, string[]>();
const runtimeErrorsByPage = new WeakMap<Page, string[]>();

function providerConfiguration(value: unknown): Provider["configuration"] {
  const configuration = value && typeof value === "object" ? { ...(value as Record<string, unknown>) } : {};
  if (configuration.textExecutionOverrides === null) delete configuration.textExecutionOverrides;
  return safeProviderConfigurationSchema.parse(configuration);
}

function providerFixture(overrides: Partial<Provider> = {}): Provider {
  return safeProviderProfileViewSchema.parse({
    id: textProfileId,
    name: "Synthetic story endpoint",
    providerType: "openrouter",
    providerRole: "text",
    baseUrl: "https://text.example.test/api/v1",
    defaultModel: "vendor/story-model",
    textSelection: { kind: "model", modelId: "vendor/story-model" },
    contextWindowTokens: 32768,
    maxOutputTokens: 4096,
    temperature: 0.8,
    requestTimeoutMs: 300000,
    configuration: { textResponseFormatPolicy: "required" },
    enabled: true,
    isDefault: true,
    healthStatus: "healthy",
    consecutiveFailures: 0,
    lastHealthCheckAt: now,
    lastHealthError: null,
    responseFormatCapability,
    hasApiKey: true,
    createdAt: now,
    updatedAt: now,
    ...overrides
  });
}

async function installProviderApi(page: Page, options: { providers?: Provider[]; failFirstInventory?: boolean; failFirstListAfterWrite?: boolean; inventoryModelIds?: string[]; holdFirstModelListResponse?: boolean } = {}) {
  const providers = options.providers || [providerFixture()];
  const writes: Array<{ method: string; body: Record<string, unknown> }> = [];
  const discoveries: Record<string, unknown>[] = [];
  const requests: Array<{ method: string; path: string }> = [];
  const inventoryResponses: Array<{ profileId: string; modelIds: string[] }> = [];
  const completedInventoryResponses: Array<{ profileId: string; modelIds: string[] }> = [];
  const unexpectedRequests: string[] = [];
  const runtimeErrors: string[] = [];
  const startup = quietLeafApiPayloads();
  let inventoryCalls = 0;
  let modelListCalls = 0;
  let listCalls = 0;
  let resumeFirstModelListResponse = () => {};
  const firstModelListResponseGate = new Promise<void>(resolve => { resumeFirstModelListResponse = resolve; });
  page.on("pageerror", error => runtimeErrors.push(error.message));
  unexpectedRequestsByPage.set(page, unexpectedRequests);
  runtimeErrorsByPage.set(page, runtimeErrors);

  await page.route("**/api/v1/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    requests.push({ method, path });
    const send = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path === "/api/v1/meta" && method === "GET") return send({ application: { version: "synthetic" }, capabilities: { nativeTextExecutionPlans: true } });
    if (path === "/api/v1/session" && method === "GET") return send(startup.session);
    if (path === "/api/v1/worlds" && method === "GET") return send({ worlds: [] });
    if (path === "/api/v1/campaigns" && method === "GET") return send({ campaigns: [] });
    if (path === "/api/v1/dashboard/stats" && method === "GET") return send({ worlds: { available: 0, total: 0, published: 0 }, campaigns: { open: 0, total: 0 }, turns: { accepted: 0 }, providerCosts: { totals: [] } });
    if (path === "/api/v1/providers" && method === "GET") {
      listCalls += 1;
      if (options.failFirstListAfterWrite && writes.length && listCalls === 2) return send({ code: "synthetic_refresh_failed", message: "Synthetic provider list refresh failed." }, 503);
      return send({ providers });
    }
    if (path === "/api/v1/providers" && method === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({ method, body });
      const created = providerFixture({
        id: body.providerRole === "image" ? imageProfileId : `44444444-4444-4444-8444-${String(writes.length).padStart(12, "0")}`,
        name: String(body.name),
        providerType: body.providerType as Provider["providerType"],
        providerRole: body.providerRole as Provider["providerRole"],
        baseUrl: String(body.baseUrl),
        defaultModel: String(body.defaultModel ?? ""),
        ...(body.textSelection ? { textSelection: body.textSelection as Provider["textSelection"] } : {}),
        contextWindowTokens: Number(body.contextWindowTokens ?? 32768),
        maxOutputTokens: Number(body.maxOutputTokens ?? 4096),
        temperature: Number(body.temperature ?? 0.8),
        requestTimeoutMs: Number(body.requestTimeoutMs ?? 300000),
        configuration: providerConfiguration(body.configuration),
        enabled: Boolean(body.enabled),
        isDefault: Boolean(body.isDefault),
        hasApiKey: Boolean(body.apiKey),
        lastHealthCheckAt: null,
        responseFormatCapability: undefined
      });
      providers.push(created);
      return send(created, 201);
    }
    const profileMatch = path.match(/^\/api\/v1\/providers\/([^/]+)$/u);
    if (profileMatch && method === "PATCH") {
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({ method, body });
      const profile = providers.find(item => item.id === profileMatch[1]);
      if (!profile) {
        unexpectedRequests.push(`${method} ${path} referenced an unknown synthetic profile`);
        return route.abort();
      }
      Object.assign(profile, {
        name: String(body.name),
        baseUrl: String(body.baseUrl),
        defaultModel: String(body.defaultModel ?? ""),
        ...(body.textSelection ? { textSelection: body.textSelection as Provider["textSelection"] } : {}),
        ...(body.contextWindowTokens !== undefined ? { contextWindowTokens: Number(body.contextWindowTokens) } : {}),
        ...(body.maxOutputTokens !== undefined ? { maxOutputTokens: Number(body.maxOutputTokens) } : {}),
        ...(body.temperature !== undefined ? { temperature: Number(body.temperature) } : {}),
        requestTimeoutMs: Number(body.requestTimeoutMs ?? profile.requestTimeoutMs),
        configuration: providerConfiguration(body.configuration),
        enabled: Boolean(body.enabled),
        isDefault: Boolean(body.isDefault),
        hasApiKey: body.apiKey ? true : profile.hasApiKey,
        updatedAt: new Date(Date.now() + 1000).toISOString(),
        responseFormatCapability: undefined
      });
      return send(safeProviderProfileViewSchema.parse(profile));
    }
    if (path === "/api/v1/providers/discover-models" && method === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      discoveries.push(body);
      inventoryCalls += 1;
      if (options.failFirstInventory && inventoryCalls === 1) return send({ code: "provider_unavailable", message: "Synthetic model inventory unavailable." }, 503);
      const image = body.providerRole === "image";
      return send({ models: [{ id: image ? "vendor/synthetic-image" : "vendor/discovered-story", displayName: image ? "Synthetic image model" : "Synthetic story model", loaded: true, instanceId: image ? "vendor/synthetic-image" : "vendor/discovered-story", contextLength: 65536 }] });
    }
    const modelsMatch = path.match(/^\/api\/v1\/providers\/([^/]+)\/models$/u);
    if (modelsMatch && method === "GET") {
      const profileId = modelsMatch[1];
      if (!profileId) {
        unexpectedRequests.push(`${method} ${path} did not include a profile ID`);
        return route.abort();
      }
      inventoryCalls += 1;
      if (options.failFirstInventory && inventoryCalls === 1) return send({ code: "provider_unavailable", message: "Synthetic model inventory unavailable." }, 503);
      const profile = providers.find(item => item.id === profileId);
      const modelIds = options.inventoryModelIds ?? (profile?.defaultModel ? [profile.defaultModel] : []);
      inventoryResponses.push({ profileId, modelIds });
      modelListCalls += 1;
      if (options.holdFirstModelListResponse && modelListCalls === 1) await firstModelListResponseGate;
      completedInventoryResponses.push({ profileId, modelIds });
      return send({ models: modelIds.map(id => ({ id, displayName: "Synthetic inventory model", loaded: true, instanceId: id, contextLength: 65536 })) });
    }
    const presetListMatch = path.match(/^\/api\/v1\/providers\/([^/]+)\/presets$/u);
    if (presetListMatch && method === "GET") return send({ presets: [{ slug: "nexus-story", name: "Nexus Story", status: "active", designatedVersionId: "synthetic-v1", updatedAt: now }], totalCount: 1, offset: 0, nextOffset: null });
    if (/^\/api\/v1\/providers\/[^/]+\/presets\/nexus-story$/u.test(path) && method === "GET") return send({ slug: "nexus-story", name: "Nexus Story", versionId: "synthetic-v1", version: 1, standardPrompt: "Synthetic preset prompt.", candidateModelIds: ["vendor/story-model"], providerPolicy: {}, excludedProviderSlugs: [], parameters: {}, limits: { configuredMaxTokens: null, configuredMaxCompletionTokens: null, effectiveMaxOutputTokens: null, contextWindowTokens: { status: "unknown", value: null } }, responseFormat: { mode: "json_schema", assurance: "trusted_preset" } });

    unexpectedRequests.push(`${method} ${path}`);
    return route.abort();
  });
  return { providers, writes, discoveries, requests, inventoryResponses, completedInventoryResponses, unexpectedRequests, runtimeErrors, getInventoryCalls: () => inventoryCalls, getModelListCalls: () => modelListCalls, releaseFirstModelListResponse: () => resumeFirstModelListResponse() };
}

test.afterEach(async ({ page }) => {
  expect(unexpectedRequestsByPage.get(page) || []).toEqual([]);
  expect(runtimeErrorsByPage.get(page) || []).toEqual([]);
});

async function selectDiscoveredModel(page: Page, expectedName: RegExp) {
  await page.locator("#providerDefaultModel").click();
  await page.getByRole("button", { name: expectedName }).click();
}

async function openNewProvider(page: Page) {
  await page.goto(`${origin}/nexus/index.html#providers`);
  await page.getByRole("button", { name: "New provider profile" }).click();
  await expect(page.locator("#providerDialog")).toBeVisible();
}
test("provider profiles keep endpoint credentials scoped to their selected role", async ({ page }) => {
  const api = await installProviderApi(page);
  await openNewProvider(page);
  await page.locator("#providerName").fill("Text role synthetic");
  await page.locator("#providerType").selectOption("openrouter");
  await page.locator("#providerRole").selectOption("text");
  await page.locator("#providerBaseUrl").fill("https://text-role.example.test/v1");
  await page.locator("#providerApiKey").fill("synthetic-text-secret");
  await selectDiscoveredModel(page, /Synthetic story model/);
  await page.locator("#saveProvider").click();
  await expect.poll(() => api.writes.length).toBe(1);

  await page.getByRole("button", { name: "New provider profile" }).click();
  await expect(page.locator("#providerRole")).toHaveValue("text");
  await page.locator("#providerName").fill("Image role synthetic");
  await page.locator("#providerType").selectOption("openai_compatible");
  await page.locator("#providerRole").selectOption("image");
  await page.locator("#providerBaseUrl").fill("https://image-role.example.test/v1");
  await page.locator("#providerApiKey").fill("synthetic-image-secret");

  await page.locator("#saveProvider").click();
  await expect.poll(() => api.writes.length).toBe(2);

  expect(requiredItem(api.writes, 0).body).toMatchObject({ providerRole: "text", baseUrl: "https://text-role.example.test/v1", apiKey: "synthetic-text-secret" });
  expect(requiredItem(api.writes, 1).body).toMatchObject({ providerRole: "image", baseUrl: "https://image-role.example.test/v1", apiKey: "synthetic-image-secret" });
  expect(requiredItem(api.writes, 0).body.apiKey).not.toBe(requiredItem(api.writes, 1).body.apiKey);
  expect(requiredItem(api.writes, 1).body.baseUrl).not.toBe(requiredItem(api.writes, 0).body.baseUrl);
  expect(api.requests.some(({ path }) => /generations|\/turns(?:\/|$)/.test(path))).toBe(false);
});

test("explicit model inventory retry preserves the unsaved provider draft", async ({ page }) => {
  const api = await installProviderApi(page, { failFirstInventory: true });
  await openNewProvider(page);
  await page.locator("#providerName").fill("Retryable text draft");
  await page.locator("#providerType").selectOption("openrouter");
  await page.locator("#providerRole").selectOption("text");
  await page.locator("#providerBaseUrl").fill("https://draft.example.test/v1");
  await page.locator("#providerApiKey").fill("synthetic-retry-secret");
  await page.locator("#providerAdvancedSettings").locator("summary").click();
  await page.locator("#providerContextTokens").fill("49152");

  await page.locator("#providerDefaultModel").click();
  await expect(page.locator("#providerModelPickerStatus")).toContainText("unavailable");
  await expect(page.locator("#providerName")).toHaveValue("Retryable text draft");
  await expect(page.locator("#providerRole")).toHaveValue("text");
  await expect(page.locator("#providerBaseUrl")).toHaveValue("https://draft.example.test/v1");
  await expect(page.locator("#providerApiKey")).toHaveValue("synthetic-retry-secret");
  await expect(page.locator("#providerContextTokens")).toHaveValue("49152");
  await expect(page.locator("#providerModelPickerStatus")).not.toContainText("synthetic-retry-secret");
  expect(api.writes).toHaveLength(0);

  await page.locator("#refreshProviderModelDialog").click();
  await expect(page.locator("#providerModelPickerStatus")).toContainText("1 model entry found");
  await expect(page.locator("#providerDefaultModel")).toHaveValue("vendor/discovered-story");
  expect(api.getInventoryCalls()).toBe(2);
  expect(requiredItem(api.discoveries, 1)).toMatchObject({ providerRole: "text", baseUrl: "https://draft.example.test/v1", apiKey: "synthetic-retry-secret" });
  expect(api.writes).toHaveLength(0);
});

test("role readiness uses explicit inventory checks and preserves independent provider setup", async ({ page }) => {
  const verifiedCapability = verifiedStoryCapability(now, "2026-10-04T12:00:00.000Z");
  const api = await installProviderApi(page, { providers: [providerFixture({ responseFormatCapability: verifiedCapability })], failFirstInventory: true });
  await page.clock.install({ time: new Date(now) });
  await page.goto(`${origin}/nexus/index.html#providers`);
  const text = page.locator('[data-provider-readiness="text"]');
  const image = page.locator('[data-provider-readiness="image"]');
  await expect(text).toHaveAttribute("data-readiness-state", "unavailable");
  await expect(text.locator("[data-readiness-inventory]")).toHaveText("unknown");
  await expect(image).toHaveAttribute("data-readiness-state", "not-configured");
  await expect(image.locator("[data-readiness-check]")).toBeHidden();
  expect(api.getInventoryCalls()).toBe(0);

  await text.getByRole("button", { name: "Check model inventory" }).click();
  await expect(text.locator("[data-readiness-inventory]")).toHaveText("unavailable");
  await text.getByRole("button", { name: "Check model inventory" }).click();
  await expect(text).toHaveAttribute("data-readiness-state", "ready");
  await expect(text.locator("[data-readiness-health]")).toHaveText("healthy");
  await expect(text.locator("[data-readiness-inventory]")).toHaveText("available");
  await expect(text.locator("[data-readiness-capability]")).toHaveText("Verified for current schema");
  expect(api.getInventoryCalls()).toBe(2);
  await page.screenshot({ path: ".superpowers/sdd/legacy-ui-2026-10-03/T23-provider-readiness.png", fullPage: true });
  expect(api.requests.filter(({ path, method }) => method === "GET" && path === `/api/v1/providers/${textProfileId}/models`)).toHaveLength(2);
  expect(api.requests.some(({ path }) => /generations|\/turns(?:\/|$)/.test(path))).toBe(false);
});
test("opening and saving a provider profile never probes story generation", async ({ page }) => {
  const api = await installProviderApi(page);
  await page.goto(`${origin}/nexus/index.html#providers`);
  await page.locator("#providerProfileList").getByRole("button", { name: "Edit" }).first().click();
  await expect(page.locator("#providerDialog")).toBeVisible();
  expect(api.getInventoryCalls()).toBe(0);
  expect(api.requests.some(({ path }) => /generations|\/turns(?:\/|$)/.test(path))).toBe(false);

  await page.locator("#providerName").fill("Edited without provider probing");
  await page.locator("#saveProvider").click();
  await expect.poll(() => api.writes.length).toBe(1);
  expect(api.getInventoryCalls()).toBe(0);
  expect(api.requests.some(({ path }) => /generations|\/turns(?:\/|$)/.test(path))).toBe(false);
});

test("text profile setup succeeds while illustration provider is absent", async ({ page }) => {
  const api = await installProviderApi(page, { providers: [] });
  await openNewProvider(page);
  await page.locator("#providerName").fill("Text only profile");
  await page.locator("#providerType").selectOption("openai_compatible");
  await page.locator("#providerRole").selectOption("text");
  await page.locator("#providerBaseUrl").fill("https://text-only.example.test/v1");
  await page.locator("#providerApiKey").fill("synthetic-text-only-secret");
  await selectDiscoveredModel(page, /Synthetic story model/);
  await page.locator("#saveProvider").click();
  await expect.poll(() => api.writes.length).toBe(1);
  expect(requiredItem(api.writes, 0).body).toMatchObject({ providerRole: "text", baseUrl: "https://text-only.example.test/v1", apiKey: "synthetic-text-only-secret" });
  expect(api.providers.some(({ providerRole }) => providerRole === "image")).toBe(false);
  expect(api.requests.some(({ path }) => /generations|\/turns(?:\/|$)/.test(path))).toBe(false);
});

test("Model-mode Advanced structured settings are visible by keyboard and round-trip", async ({ page }) => {
  const api = await installProviderApi(page, { providers: [providerFixture({ configuration: { textResponseFormatPolicy: "legacy" } })] });
  await page.goto(`${origin}/nexus/index.html#providers`);
  await page.locator("#providerProfileList").getByRole("button", { name: "Edit" }).first().click();
  await page.screenshot({ path: ".superpowers/sdd/legacy-ui-2026-10-03/T23-provider-basic.png", fullPage: true });
  const advanced = page.locator("#providerAdvancedSettings");
  await expect(advanced).not.toHaveAttribute("open", "");
  const summary = advanced.locator("summary");
  await summary.focus();
  await summary.press("Enter");
  await expect(advanced).toHaveAttribute("open", "");
  await expect(advanced.locator("#providerResponseFormatPolicy")).toBeVisible();
  await expect(advanced.locator("#providerTextOverrideMode")).toBeVisible();
  await page.screenshot({ path: ".superpowers/sdd/legacy-ui-2026-10-03/T23-provider-advanced.png", fullPage: true });
  await page.locator("#providerContextTokens").fill("57344");
  await page.locator("#providerOutputTokens").fill("6144");
  await page.locator("#providerTemperature").fill("0.55");
  await page.locator("#providerResponseFormatPolicy").selectOption("auto");
  await page.locator("#providerTextOverrideMode").selectOption("explicit");
  await page.locator("#providerOverrideTemperature").fill("0.27");
  await page.locator("#saveProvider").click();
  await expect.poll(() => api.writes.length).toBe(1);
  expect(requiredItem(api.writes, 0).method).toBe("PATCH");
  expect(requiredItem(api.writes, 0).body).toMatchObject({
    contextWindowTokens: "57344",
    maxOutputTokens: "6144",
    temperature: "0.55",
    configuration: {
      textResponseFormatPolicy: "auto",
      textExecutionOverrides: { parameters: { temperature: 0.27 } }
    }
  });
  await page.locator("#providerProfileList").getByRole("button", { name: "Edit" }).first().click();
  await expect(page.locator("#providerAdvancedSettings")).not.toHaveAttribute("open", "");
  await page.locator("#providerAdvancedSettings").locator("summary").click();
  await expect(page.locator("#providerContextTokens")).toHaveValue("57344");
  await expect(page.locator("#providerOutputTokens")).toHaveValue("6144");
  await expect(page.locator("#providerTemperature")).toHaveValue("0.55");
  await expect(page.locator("#providerResponseFormatPolicy")).toHaveValue("auto");
  await expect(page.locator("#providerOverrideTemperature")).toHaveValue("0.27");
  expect(api.requests.some(({ path }) => /generations|\/turns(?:\/|$)/.test(path))).toBe(false);
});
test("a successful inventory listing without the selected model remains not ready", async ({ page }) => {
  const api = await installProviderApi(page, { inventoryModelIds: ["vendor/other-model"] });
  await page.goto(`${origin}/nexus/index.html#providers`);
  const text = page.locator('[data-provider-readiness="text"]');
  await expect(text).toHaveAttribute("data-readiness-state", "unavailable");
  await text.getByRole("button", { name: "Check model inventory" }).click();
  await expect.poll(() => api.inventoryResponses.length).toBe(1);
  await expect(text.locator("[data-readiness-inventory]")).toHaveText("unavailable");
  await expect(text).toHaveAttribute("data-readiness-state", "unavailable");
  expect(api.inventoryResponses).toEqual([{ profileId: textProfileId, modelIds: ["vendor/other-model"] }]);
  expect(api.getInventoryCalls()).toBe(1);
});

test("stale inventory results cannot lock or overwrite readiness after the profile model changes", async ({ page }) => {
  const textProfile = providerFixture();
  const imageDefault = providerFixture({ id: imageProfileId, name: "Synthetic image default", providerRole: "image", baseUrl: "https://image-default.example.test/v1", defaultModel: "vendor/image-default", responseFormatCapability: undefined });
  const imageOther = providerFixture({ id: "33333333-3333-4333-8333-333333333333", name: "Synthetic other image", providerRole: "image", baseUrl: "https://image-other.example.test/v1", defaultModel: "vendor/image-other", isDefault: false, responseFormatCapability: undefined });
  const api = await installProviderApi(page, { providers: [textProfile, imageDefault, imageOther], failFirstListAfterWrite: true, holdFirstModelListResponse: true });
  await page.goto(`${origin}/nexus/index.html#providers`);
  const text = page.locator('[data-provider-readiness="text"]');
  const inventoryCheck = text.locator("[data-readiness-check]");
  await expect(inventoryCheck).toHaveCount(1);
  await inventoryCheck.click();
  await expect.poll(() => api.getModelListCalls()).toBe(1);
  await expect(text.locator("[data-readiness-inventory]")).toHaveText("checking");

  try {
    await openNewProvider(page);
    await page.locator("#providerName").fill("Synthetic image added during inventory check");
    await page.locator("#providerType").selectOption("openai_compatible");
    await page.locator("#providerRole").selectOption("image");
    await page.locator("#providerBaseUrl").fill("https://new-image.example.test/v1");
    await page.locator("#providerApiKey").fill("synthetic-new-image-secret");
    await selectDiscoveredModel(page, /Synthetic image model/);
    await page.locator("#saveProvider").click();
    await expect.poll(() => api.writes.length).toBe(1);
    const retryProfiles = page.getByRole("button", { name: "Retry provider profiles" });
    await expect(retryProfiles).toBeVisible();

    const profileIndex = api.providers.findIndex(item => item.id === textProfileId);
    if (profileIndex < 0) throw new Error("Synthetic text profile is missing.");
    const currentTextProfile = requiredItem(api.providers, profileIndex);
    api.providers[profileIndex] = safeProviderProfileViewSchema.parse({
      ...currentTextProfile,
      defaultModel: "vendor/story-model-v2",
      textSelection: { kind: "model", modelId: "vendor/story-model-v2" }
    });
    await retryProfiles.click();
    await expect(page.locator("#providerProfileList")).toContainText("vendor/story-model-v2");

    await expect(inventoryCheck).toHaveAccessibleName("Check model inventory");
    await expect(inventoryCheck).toBeEnabled();
    await inventoryCheck.click();
    await expect.poll(() => api.getModelListCalls()).toBe(2);
    await expect(text.locator("[data-readiness-inventory]")).toHaveText("available");
    await expect(text.locator("[data-readiness-capability]")).toHaveText("Does not match current model/schema");
    await expect(text).toHaveAttribute("data-readiness-state", "unavailable");

    api.releaseFirstModelListResponse();
    await expect.poll(() => api.completedInventoryResponses.length).toBe(2);
    await expect(text.locator("[data-readiness-inventory]")).toHaveText("available");
    await expect(text).toHaveAttribute("data-readiness-state", "unavailable");
    await expect(inventoryCheck).toBeEnabled();
    expect(api.inventoryResponses).toEqual([
      { profileId: textProfileId, modelIds: ["vendor/story-model"] },
      { profileId: textProfileId, modelIds: ["vendor/story-model-v2"] }
    ]);
  } finally {
    api.releaseFirstModelListResponse();
  }
});

test("unknown structured-output capability remains not ready", async ({ page }) => {
  const api = await installProviderApi(page, { providers: [providerFixture({ responseFormatCapability: undefined })] });
  await page.goto(`${origin}/nexus/index.html#providers`);
  await page.locator("#providerProfileList").getByRole("button", { name: "Edit" }).first().click();
  const capability = page.locator("#providerResponseFormatCapability");
  await expect(capability).toContainText("unknown");
  await expect(capability).not.toContainText("ready");
  await expect(capability).not.toContainText("verified");
  expect(api.getInventoryCalls()).toBe(0);
});

test("expired schema capability stays not ready for a healthy text provider", async ({ page }) => {
  const expiredCapability = verifiedStoryCapability("2026-10-01T12:00:00.000Z", "2026-10-02T12:00:00.000Z");
  const provider = providerFixture({ responseFormatCapability: expiredCapability });
  expect(provider.healthStatus).toBe("healthy");
  const api = await installProviderApi(page, { providers: [provider] });
  await page.goto(`${origin}/nexus/index.html#providers`);
  await page.locator("#providerProfileList").getByRole("button", { name: "Edit" }).first().click();
  const capability = page.locator("#providerResponseFormatCapability");
  await expect(capability).not.toContainText("verified");
  await expect(capability).not.toContainText("ready");
  expect(api.getInventoryCalls()).toBe(0);
});
test("preset Advanced override edits are saved and Inherit clears the saved override", async ({ page }) => {
  const text = providerFixture({
    configuration: {
      textResponseFormatPolicy: "auto",
      textExecutionOverrides: { parameters: { temperature: 0.31, max_tokens: 1800 }, conservativeContextWindowTokens: 24000 }
    },
    textSelection: { kind: "openrouter_preset", slug: "nexus-story" },
    defaultModel: "@preset/nexus-story"
  });
  const api = await installProviderApi(page, { providers: [text] });
  await page.goto(`${origin}/nexus/index.html#providers`);
  await page.locator("#providerProfileList").getByRole("button", { name: "Edit" }).first().click();
  const advanced = page.locator("#providerAdvancedSettings");
  await advanced.locator("summary").click();
  const overrideMode = page.locator("#providerTextOverrideMode");
  await expect(overrideMode).toBeVisible();
  await overrideMode.selectOption("explicit");
  const temperature = page.locator("#providerOverrideTemperature");
  await expect(temperature).toBeVisible();
  await expect(temperature).toHaveValue("0.31");
  await temperature.fill("0.47");
  await page.locator("#saveProvider").click();
  await expect.poll(() => api.writes.length).toBe(1);
  expect(requiredItem(api.writes, 0).method).toBe("PATCH");
  expect(requiredItem(api.writes, 0).body.configuration).toMatchObject({
    textResponseFormatPolicy: "auto",
    textExecutionOverrides: { parameters: { temperature: 0.47, max_tokens: 1800 }, conservativeContextWindowTokens: 24000 }
  });

  await page.locator("#providerProfileList").getByRole("button", { name: "Edit" }).first().click();
  await page.locator("#providerAdvancedSettings").locator("summary").click();
  await expect(page.locator("#providerOverrideTemperature")).toHaveValue("0.47");
  await page.locator("#providerTextOverrideMode").selectOption("inherit");
  await page.locator("#saveProvider").click();
  await expect.poll(() => api.writes.length).toBe(2);
  expect(requiredItem(api.writes, 1).method).toBe("PATCH");
  expect(requiredItem(api.writes, 1).body.configuration).toMatchObject({
    textResponseFormatPolicy: "auto",
    textExecutionOverrides: null
  });
  expect(requiredItem(api.providers, 0).configuration).not.toHaveProperty("textExecutionOverrides");
  expect(api.requests.some(({ path }) => /generations|\/turns(?:\/|$)/.test(path))).toBe(false);
});
test("provider tuning stays advanced and round-trips text and Sogni profile values", async ({ page }) => {
  const text = providerFixture({
    configuration: {
      textResponseFormatPolicy: "auto",
      textExecutionOverrides: { parameters: { temperature: 0.31, max_tokens: 1800 }, conservativeContextWindowTokens: 24000 }
    },
    textSelection: { kind: "openrouter_preset", slug: "nexus-story" },
    defaultModel: "@preset/nexus-story"
  });
  const sogni = providerFixture({ id: imageProfileId, name: "Sogni image profile", providerType: "sogni_sdk", providerRole: "image", baseUrl: "https://image.example.test/v1", defaultModel: "synthetic/image-model", isDefault: false, configuration: { defaultWidth: 1536, defaultHeight: 1024, defaultAspectRatio: "3:2", defaultImageCount: 2, defaultOutputFormat: "webp", defaultQuality: "high", generationTimeoutMs: 240000, network: "relaxed", tokenType: "spark", contentFilter: "enabled", defaultSizePreset: "landscape", defaultSteps: 32, defaultGuidance: 6.5, defaultSeed: 12345, defaultSampler: "dpmpp_2m", defaultScheduler: "karras", defaultPreviewCount: 3 } });
  const api = await installProviderApi(page, { providers: [text, sogni] });
  await page.goto(`${origin}/nexus/index.html#providers`);
  await page.locator("#providerProfileList").getByRole("button", { name: "Edit" }).first().click();
  const advanced = page.locator("#providerAdvancedSettings");
  await expect(page.locator("#providerName")).toBeVisible();
  await expect(page.locator("#providerRole")).toBeVisible();
  await expect(page.locator("#providerBaseUrl")).toBeVisible();
  await expect(page.locator("#providerApiKey")).toBeVisible();
  await expect(advanced).not.toHaveAttribute("open", "");
  await advanced.locator("summary").click();
  await expect(advanced.locator("#providerContextTokens")).toBeVisible();
  await expect(advanced.locator("#providerOutputTokens")).toBeVisible();
  await expect(advanced.locator("#providerTemperature")).toBeVisible();
  await expect(advanced.locator("#providerPresetDetail")).toBeVisible();
  await expect(advanced.locator("#providerTextOverrideMode")).toBeVisible();

  await page.locator("#providerContextTokens").fill("49152");
  await page.locator("#providerOutputTokens").fill("3072");
  await page.locator("#providerTemperature").fill("0.45");
  await page.locator("#saveProvider").click();
  await expect.poll(() => api.writes.length).toBe(1);
  expect(requiredItem(api.writes, 0).body).toMatchObject({
    contextWindowTokens: "49152",
    maxOutputTokens: "3072",
    temperature: "0.45",
    textSelection: { kind: "openrouter_preset", slug: "nexus-story" },
    configuration: {
      textResponseFormatPolicy: "auto",
      textExecutionOverrides: { parameters: { temperature: 0.31, max_tokens: 1800 }, conservativeContextWindowTokens: 24000 }
    }
  });
  await page.locator("#providerProfileList").getByRole("button", { name: "Edit" }).first().click();
  await page.locator("#providerAdvancedSettings").locator("summary").click();
  await expect(page.locator("#providerContextTokens")).toHaveValue("49152");
  await expect(page.locator("#providerOutputTokens")).toHaveValue("3072");
  await expect(page.locator("#providerTemperature")).toHaveValue("0.45");
  await expect(page.locator("#providerContextTokens")).toHaveValue("49152");
  await expect(page.locator("#cancelProviderEdit")).toBeVisible();
  await page.locator("#cancelProviderEdit").click();
  await page.locator("#providerProfileList").getByRole("button", { name: "Edit" }).last().click();
  await expect(page.locator("#providerAdvancedSettings")).not.toHaveAttribute("open", "");
  await page.locator("#providerAdvancedSettings").locator("summary").click();
  await expect(page.locator("#providerRole")).toHaveValue("image");
  await expect(page.locator("#providerSogniWidth")).toHaveValue("1536");
  await expect(page.locator("#providerSogniHeight")).toHaveValue("1024");
  await expect(page.locator("#providerSogniImageCount")).toHaveValue("2");
  await expect(page.locator("#providerSogniQuality")).toHaveValue("high");
  await expect(page.locator("#providerSogniSteps")).toHaveValue("32");
  await expect(page.locator("#providerSogniGuidance")).toHaveValue("6.5");
  await expect(page.locator("#providerSogniNetwork")).toHaveValue("relaxed");
  await expect(page.locator("#providerSogniTokenType")).toHaveValue("spark");
  await expect(page.locator("#providerSogniSampler")).toHaveValue("dpmpp_2m");
  await expect(page.locator("#providerSogniScheduler")).toHaveValue("karras");
  await page.locator("#saveProvider").click();
  await expect.poll(() => api.writes.length).toBe(2);
  expect(requiredItem(api.writes, 1).body.configuration).toMatchObject(sogni.configuration);
  await page.locator("#providerProfileList").getByRole("button", { name: "Edit" }).last().click();
  await expect(page.locator("#providerSogniWidth")).toHaveValue("1536");
  await expect(page.locator("#providerSogniHeight")).toHaveValue("1024");
  await expect(page.locator("#providerSogniAspectRatio")).toHaveValue("3:2");
  await expect(page.locator("#providerSogniImageCount")).toHaveValue("2");
  await expect(page.locator("#providerSogniOutputFormat")).toHaveValue("webp");
  await expect(page.locator("#providerSogniQuality")).toHaveValue("high");
  await expect(page.locator("#providerSogniSteps")).toHaveValue("32");
  await expect(page.locator("#providerSogniGuidance")).toHaveValue("6.5");
  await expect(page.locator("#providerSogniSeed")).toHaveValue("12345");
});

test("a committed profile remains saved when refreshing the provider list fails", async ({ page }) => {
  const api = await installProviderApi(page, { providers: [], failFirstListAfterWrite: true });
  await openNewProvider(page);
  await page.locator("#providerName").fill("Committed before list failure");
  await page.locator("#providerType").selectOption("openai_compatible");
  await page.locator("#providerRole").selectOption("text");
  await page.locator("#providerBaseUrl").fill("https://committed.example.test/v1");
  await page.locator("#providerApiKey").fill("synthetic-committed-secret");
  await page.locator("#saveProvider").click();
  await expect.poll(() => api.writes.length).toBe(1);
  await expect(page.locator("#providerStatus")).toContainText("Committed before list failure was saved.");
  await expect(page.locator("#providerStatus")).toContainText(/provider list could not be refreshed/i);
  await expect(page.locator("#providerStatus")).not.toContainText(/could not be saved/i);
  const committedMessage = await page.locator("#providerStatus").innerText();
  expect(committedMessage.match(/Committed before list failure was saved\./g)).toHaveLength(1);
  expect(committedMessage.match(/The provider list could not be refreshed\./g)).toHaveLength(1);
  expect(api.writes).toHaveLength(1);
  expect(requiredItem(api.writes, 0).body.apiKey).toBe("synthetic-committed-secret");
  await page.getByRole("button", { name: "Retry provider profiles" }).click();
  await expect(page.locator("#providerProfileList")).toContainText("Committed before list failure");
  expect(api.writes).toHaveLength(1);
});
