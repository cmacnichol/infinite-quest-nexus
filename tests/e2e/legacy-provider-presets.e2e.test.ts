import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { quietLeafApiPayloads } from "../fixtures/quiet-leaf-payloads.js";
import { CURRENT_STORY_RESPONSE_FORMAT_CAPABILITY_IDENTITY } from "../../packages/contracts/src/provider-profile-view.js";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const screenshots = ".superpowers/sdd/2026-09-18-native-openrouter-presets/task-7-screenshots";

type Provider = Record<string, unknown> & {
  id: string;
  name: string;
  providerType: string;
  providerRole: string;
  defaultModel: string;
  configuration: Record<string, unknown>;
};

const now = new Date().toISOString();

function providerFixture(): Provider {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "OpenRouter text",
    providerType: "openrouter",
    providerRole: "text",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "vendor/direct-model",
    textSelection: { kind: "model", modelId: "vendor/direct-model" },
    contextWindowTokens: 32768,
    maxOutputTokens: 4096,
    temperature: 0.8,
    requestTimeoutMs: 300000,
    configuration: {},
    enabled: true,
    isDefault: true,
    healthStatus: "healthy",
    consecutiveFailures: 0,
    lastHealthCheckAt: null,
    lastHealthError: null,
    hasApiKey: true,
    createdAt: now,
    updatedAt: now
  };
}

async function installSettingsApi(page: Page, { nativeSupport = true, metadataGate = null as Promise<void> | null } = {}) {
  const provider = providerFixture();
  const providers = [provider];
  const writes: Record<string, unknown>[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/v1/meta") {
      if (metadataGate) await metadataGate;
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ application: { version: "test" }, capabilities: nativeSupport ? { nativeTextExecutionPlans: true } : {} }) });
    }
    if (url.pathname === "/api/v1/providers" && request.method() === "GET") {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ providers }) });
    }
    if (url.pathname === "/api/v1/providers" && request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push(body);
      const created = { ...providerFixture(), ...body, id: "44444444-4444-4444-8444-444444444444", hasApiKey: Boolean(body.apiKey), createdAt: now, updatedAt: now } as Provider;
      providers.push(created);
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(created) });
    }
    if (url.pathname === `/api/v1/providers/${provider.id}/presets`) {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ presets: [{ slug: "nexus-story", name: "Nexus Story", status: "active", designatedVersionId: "version-1", updatedAt: now }, { slug: "alternate-story", name: "Alternate Story", status: "active", designatedVersionId: "version-2", updatedAt: now }], totalCount: 2, offset: 0, nextOffset: null }) });
    }
    if (url.pathname === `/api/v1/providers/${provider.id}/presets/nexus-story`) {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ slug: "nexus-story", name: "Nexus Story", versionId: "version-1", version: 3, standardPrompt: "Write with restrained tension.", candidateModelIds: ["vendor/primary", "vendor/fallback"], providerPolicy: { order: ["openai", "anthropic"], allow_fallbacks: true }, excludedProviderSlugs: [], parameters: { temperature: 0.55, max_tokens: 2400 }, limits: { configuredMaxTokens: 2400, configuredMaxCompletionTokens: 1800, effectiveMaxOutputTokens: 1600, contextWindowTokens: { status: "unknown", value: null } }, responseFormat: { mode: "json_schema", assurance: "trusted_preset" } }) });
    }
    if (url.pathname === `/api/v1/providers/${provider.id}/presets/alternate-story`) {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ slug: "alternate-story", name: "Alternate Story", versionId: "version-2", version: 1, standardPrompt: "Alternate prompt.", candidateModelIds: ["vendor/alternate"], providerPolicy: {}, excludedProviderSlugs: [], parameters: {}, limits: { configuredMaxTokens: null, configuredMaxCompletionTokens: null, effectiveMaxOutputTokens: null, contextWindowTokens: { status: "unknown", value: null } }, responseFormat: { mode: "json_schema", assurance: "trusted_preset" } }) });
    }
    if (url.pathname === `/api/v1/providers/${provider.id}` && request.method() === "PATCH") {
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push(body);
      Object.assign(provider, body, { updatedAt: new Date(Date.now() + 1000).toISOString() });
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(provider) });
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({}) });
  });
  return { provider, providers, writes };
}

test("provider settings save and reopen a trusted native preset through the typed API contract", async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (response.status() >= 400 && path !== "/vendor/photoswipe/photoswipe.css") runtimeErrors.push(`${response.status()} ${path}`);
  });
  const api = await installSettingsApi(page);
  await page.goto(`${origin}/nexus/index.html#providers`);
  await page.waitForTimeout(500);
  expect(runtimeErrors).toEqual([]);
  await expect(page.locator("#providerProfileList")).toContainText("OpenRouter text");
  await page.locator("#providerProfileList").getByRole("button", { name: "Edit" }).click();

  await expect(page.getByRole("radio", { name: "Model", exact: true })).toBeChecked();
  await expect(page.locator("#providerResponseFormatPolicy")).toHaveValue("required");
  await page.locator("#providerResponseFormatPolicy").selectOption("legacy");
  await expect(page.locator("#providerResponseFormatPolicyNote")).toContainText("explicit historical compatibility override");

  await page.getByRole("radio", { name: "Preset", exact: true }).check();
  await page.getByRole("combobox", { name: "Preset", exact: true }).selectOption("nexus-story");
  await expect(page.getByText("Standard prompt", { exact: true })).toBeVisible();
  await expect(page.getByText("Write with restrained tension.", { exact: true })).toBeVisible();
  await expect(page.getByText("Structured Outputs · Trusted preset", { exact: true })).toBeVisible();
  await page.getByRole("radio", { name: "Preset", exact: true }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("radio", { name: "Model", exact: true })).toBeChecked();
  await expect(page.locator("#providerDialog")).toBeVisible();
  await expect(page.locator("#discardChangesDialog")).toBeHidden();
  await expect(page.locator("#providerDefaultModel")).toHaveValue("vendor/direct-model");
  await expect(page.locator("#providerResponseFormatPolicy")).toHaveValue("legacy");
  await expect(page.locator("#providerResponseFormatPolicyNote")).toContainText("explicit historical compatibility override");
  await page.locator("#providerDefaultModel").click();
  await expect(page.locator("#providerModelPickerStatus")).toContainText("model entries found");
  await page.locator("#providerCustomModel").fill("vendor/custom-model");
  await page.getByRole("button", { name: "Use custom ID" }).click();
  await expect(page.locator("#providerDefaultModel")).toHaveValue("vendor/custom-model");
  await expect(page.locator("#providerResponseFormatPolicy")).toHaveValue("required");
  await page.getByRole("radio", { name: "Preset", exact: true }).check();
  await expect(page.getByRole("radio", { name: "Preset", exact: true })).toBeChecked();
  await expect(page.locator("#providerModelSelectionField")).toBeHidden();
  await expect(page.getByRole("combobox", { name: "Preset", exact: true })).toHaveValue("nexus-story");
  await expect(page.locator("#providerPresetPrompt")).toHaveText("Write with restrained tension.");
  await expect(page.locator("#providerPresetVersion")).toHaveText("3 · version-1");
  await expect(page.locator("#providerPresetLimits")).toContainText("Configured max_tokens: 2,400");
  await expect(page.locator("#providerPresetLimits")).toContainText("configured max_completion_tokens: 1,800");
  await expect(page.locator("#providerPresetLimits")).toContainText("effective max output: 1,600");
  await page.locator("#providerTextOverrideMode").selectOption("explicit");
  await page.locator("#providerOverrideTemperature").fill("0.31");
  await page.locator("#providerOverrideMaxTokens").fill("1800");
  await page.getByRole("combobox", { name: "Preset", exact: true }).selectOption("alternate-story");
  await expect(page.locator("#providerTextOverrideMode")).toHaveValue("inherit");
  await page.getByRole("combobox", { name: "Preset", exact: true }).selectOption("nexus-story");
  await page.locator("#providerTextOverrideMode").selectOption("explicit");
  await page.locator("#providerOverrideTemperature").fill("0.31");
  await page.locator("#providerOverrideMaxTokens").fill("1800");
  await page.locator("#providerPresetDetail").screenshot({ path: `${screenshots}/settings-desktop-preset-detail.png` });
  await page.locator("#providerTextOverrides").screenshot({ path: `${screenshots}/settings-desktop-overrides-explicit.png` });

  await page.locator("#providerForm").evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect.poll(() => api.writes.length).toBe(1);
  expect(api.writes[0]).toMatchObject({
    defaultModel: "@preset/nexus-story",
    textSelection: { kind: "openrouter_preset", slug: "nexus-story" },
    configuration: { textResponseFormatPolicy: "required", textExecutionOverrides: { parameters: { temperature: 0.31, max_tokens: 1800 } } }
  });

  await page.locator("#providerProfileList").getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("radio", { name: "Preset", exact: true })).toBeChecked();
  await expect(page.locator("#providerModelSelectionField")).toBeHidden();
  await expect(page.getByRole("combobox", { name: "Preset", exact: true })).toHaveValue("nexus-story");
  await expect(page.locator("#providerPresetPrompt")).toHaveText("Write with restrained tension.");
  await expect(page.locator("#providerTextOverrideMode")).toHaveValue("preserve");
  await expect(page.locator("#providerOverrideTemperature")).toHaveValue("0.31");
  await page.locator("#providerTextOverrideMode").selectOption("inherit");
  await expect(page.locator("#providerTextOverrideFields")).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#providerPresetDetail").screenshot({ path: `${screenshots}/settings-mobile-preset-detail.png` });
  await page.locator("#providerTextOverrides").screenshot({ path: `${screenshots}/settings-mobile-inherit.png` });
  await page.locator("#providerForm").evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect.poll(() => api.writes.length).toBe(2);
  expect(api.writes[1]).toMatchObject({ configuration: { textResponseFormatPolicy: "required", textExecutionOverrides: null } });

  await page.locator("#providerProfileList").getByRole("button", { name: "Edit" }).click();
  await expect(page.locator("#providerDialog")).toBeVisible();
  await page.locator("#providerDialog").evaluate((dialog: HTMLDialogElement) => {
    const bounds = dialog.getBoundingClientRect();
    dialog.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: bounds.left - 2, clientY: bounds.top - 2 }));
  });
  await expect(page.locator("#providerDialog")).toBeHidden();
});

test("a new OpenRouter text profile starts in Required Model mode and saves a typed custom ID", async ({ page }) => {
  const api = await installSettingsApi(page);
  await page.goto(`${origin}/nexus/index.html#providers`);
  await page.getByRole("button", { name: "New provider profile" }).click();
  await page.locator("#providerName").fill("New OpenRouter");
  await page.locator("#providerType").selectOption("openrouter");
  await expect(page.getByRole("radio", { name: "Model", exact: true })).toBeChecked();
  await expect(page.locator("#providerResponseFormatPolicy")).toHaveValue("required");
  await page.locator("#providerDefaultModel").click();
  await expect(page.locator("#providerModelPickerStatus")).toContainText("model entries found");
  await page.locator("#providerCustomModel").fill("vendor/new-custom");
  await page.getByRole("button", { name: "Use custom ID" }).click();
  await expect(page.locator("#providerDefaultModel")).toHaveValue("vendor/new-custom");
  expect(api.writes).toHaveLength(0);
  await page.locator("#providerForm").evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect.poll(() => api.writes.length).toBe(1);
  expect(api.writes[0]).toMatchObject({
    providerType: "openrouter",
    providerRole: "text",
    defaultModel: "vendor/new-custom",
    textSelection: { kind: "model", modelId: "vendor/new-custom" },
    configuration: { textResponseFormatPolicy: "required" }
  });
});

test("settings retain unavailable saved presets and explain an older server", async ({ page }) => {
  const api = await installSettingsApi(page);
  Object.assign(api.provider, {
    defaultModel: "@preset/retired-story",
    textSelection: { kind: "openrouter_preset", slug: "retired-story" }
  });
  await page.goto(`${origin}/nexus/index.html#providers`);
  await page.locator("#providerProfileList").getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("radio", { name: "Preset", exact: true })).toBeChecked();
  await expect(page.getByRole("combobox", { name: "Preset", exact: true })).toHaveValue("retired-story");
  await expect(page.locator("#providerPresetStatus")).toContainText("Saved preset retired-story is unavailable");
  await expect(page.getByRole("combobox", { name: "Preset", exact: true }).locator("option:checked")).toContainText("unavailable");
  await expect(page.locator("#providerModelSelectionField")).toBeHidden();
  expect(api.writes).toHaveLength(0);

  await page.unrouteAll({ behavior: "wait" });
  const downlevel = await installSettingsApi(page, { nativeSupport: false });
  Object.assign(downlevel.provider, {
    defaultModel: "@preset/retired-story",
    textSelection: { kind: "openrouter_preset", slug: "retired-story" }
  });
  await page.reload();
  await page.locator("#providerProfileList").getByRole("button", { name: "Edit" }).click();
  await expect(page.locator("#providerTextSelectionMode")).toBeHidden();
  await expect(page.locator("#providerTextSelectionSupport")).toBeVisible();
  await expect(page.locator("#providerTextSelectionSupport")).toContainText("does not advertise native text execution plans");
  await expect(page.locator("#providerModelSelectionField")).toBeHidden();
  await page.locator("#providerForm").evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect.poll(() => downlevel.writes.length).toBe(1);
  expect(downlevel.writes[0]).toMatchObject({ defaultModel: "@preset/retired-story" });
  expect(downlevel.writes[0]).not.toHaveProperty("textSelection");
});

test("settings preserve a saved preset while native capability metadata is still loading", async ({ page }) => {
  let releaseMetadata!: () => void;
  const metadataGate = new Promise<void>((resolve) => { releaseMetadata = resolve; });
  const api = await installSettingsApi(page, { metadataGate });
  Object.assign(api.provider, { defaultModel: "@preset/loading-story", textSelection: { kind: "openrouter_preset", slug: "loading-story" } });
  await page.goto(`${origin}/nexus/index.html#providers`);
  await page.locator("#providerProfileList").getByRole("button", { name: "Edit" }).click();
  await expect(page.locator("#providerTextSelectionSupport")).toContainText("Checking whether");
  await expect(page.locator("#providerModelSelectionField")).toBeHidden();
  await page.locator("#providerForm").evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect.poll(() => api.writes.length).toBe(1);
  expect(api.writes[0]).toMatchObject({ defaultModel: "@preset/loading-story" });
  expect(api.writes[0]).not.toHaveProperty("textSelection");
  releaseMetadata();
});

test("stale preset list and detail completions cannot replace newer credential or profile state", async ({ page }) => {
  const api = await installSettingsApi(page);
  const second = { ...providerFixture(), id: "33333333-3333-4333-8333-333333333333", name: "Second OpenRouter" };
  api.providers.push(second);
  let releaseList!: () => void;
  const listGate = new Promise<void>((resolve) => { releaseList = resolve; });
  const listPattern = `**/api/v1/providers/${api.provider.id}/presets?*`;
  const delayedList = async (route: import("@playwright/test").Route) => {
    await listGate;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ presets: [{ slug: "stale-list", name: "Stale", status: "active", designatedVersionId: "old", updatedAt: now }], totalCount: 1, offset: 0, nextOffset: null }) });
  };
  await page.route(listPattern, delayedList);
  await page.goto(`${origin}/nexus/index.html#providers`);
  await page.locator("#providerProfileList").getByRole("button", { name: "Edit" }).first().click();
  await page.getByRole("radio", { name: "Preset", exact: true }).check();
  await expect(page.locator("#providerPresetStatus")).toContainText("Loading OpenRouter presets");
  await page.getByRole("radio", { name: "Model", exact: true }).check();
  releaseList();
  await page.unroute(listPattern, delayedList);
  await page.getByRole("radio", { name: "Preset", exact: true }).check();
  await expect(page.getByRole("combobox", { name: "Preset", exact: true })).toContainText("Nexus Story");
  await expect(page.getByRole("combobox", { name: "Preset", exact: true })).not.toContainText("Stale");
  let releaseDetail!: () => void;
  const detailGate = new Promise<void>((resolve) => { releaseDetail = resolve; });
  const detailPattern = `**/api/v1/providers/${api.provider.id}/presets/nexus-story`;
  const delayedDetail = async (route: import("@playwright/test").Route) => {
    await detailGate;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "private upstream detail" }) });
  };
  await page.route(detailPattern, delayedDetail);
  await page.getByRole("combobox", { name: "Preset", exact: true }).selectOption("nexus-story");
  await expect(page.locator("#providerPresetPrompt")).toContainText("Loading preset details");
  await page.locator("#providerDialog").evaluate((dialog: HTMLDialogElement) => dialog.close());
  await page.locator("#providerProfileList .provider-profile").filter({ hasText: "Second OpenRouter" }).getByRole("button", { name: "Edit" }).click();
  await expect(page.locator("#providerName")).toHaveValue("Second OpenRouter");
  await expect(page.getByRole("radio", { name: "Model", exact: true })).toBeChecked();
  releaseDetail();
  await page.waitForTimeout(50);
  await expect(page.locator("#providerName")).toHaveValue("Second OpenRouter");
  await expect(page.getByRole("radio", { name: "Model", exact: true })).toBeChecked();
  await expect(page.locator("#providerPresetDetail")).toBeHidden();
});

test("Story per-request selection keeps Use profile separate and submits a typed native preset", async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  const fixture = quietLeafApiPayloads({ turnControlStyle: "flexible_action" });
  const provider = providerFixture();
  provider.configuration = { textResponseFormatPolicy: "auto" };
  const writes: Record<string, unknown>[] = [];
  const jobId = "22222222-2222-4222-8222-222222222222";
  let exactCapability = false;
  let delayPresetList = false;
  let releasePresetList!: () => void;
  const presetListGate = new Promise<void>((resolve) => { releasePresetList = resolve; });
  await page.addInitScript(() => Object.defineProperty(window, "EventSource", { configurable: true, value: undefined }));
  await page.route("**/vendor/photoswipe/photoswipe.css", (route) => route.fulfill({ contentType: "text/css", body: "" }));
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const send = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/v1/session") return send(fixture.session);
    if (path === "/api/v1/meta") return send({ application: { name: "Infinite Quest Nexus", version: "test", commit: null, builtAt: null }, capabilities: { systemArchive: false, nativeTextExecutionPlans: true } });
    if (path === "/api/v1/providers") return send({ providers: [provider] });
    if (path === `/api/v1/providers/${provider.id}/presets`) {
      if (delayPresetList) {
        await presetListGate;
        return send({ error: "stale discovery failure" }, 503);
      }
      return send({ presets: [{ slug: "nexus-story", name: "Nexus Story", status: "active", designatedVersionId: "version-1", updatedAt: now }], totalCount: 1, offset: 0, nextOffset: null });
    }
    if (path === `/api/v1/providers/${provider.id}/presets/nexus-story`) return send({ slug: "nexus-story", name: "Nexus Story", versionId: "version-1", version: 3, standardPrompt: "Write with restrained tension.", candidateModelIds: ["vendor/primary"], providerPolicy: {}, excludedProviderSlugs: [], parameters: {}, limits: { configuredMaxTokens: 2400, configuredMaxCompletionTokens: 1800, effectiveMaxOutputTokens: 1600, contextWindowTokens: { status: "unknown", value: null } }, responseFormat: { mode: "json_schema", assurance: "trusted_preset" } });
    if (path === `/api/v1/providers/${provider.id}/models`) return send({ models: [{ id: "vendor/direct-model", displayName: "Direct model", loaded: true, instanceId: "vendor/direct-model", contextLength: 32768, responseFormatCapability: { version: 1, model: "vendor/direct-model", expectedRegistryDigest: "fixture-digest", advertisedAt: now, operations: [{ operation: "story", streaming: false, status: "verified", reason: "available", schemaVersion: exactCapability ? CURRENT_STORY_RESPONSE_FORMAT_CAPABILITY_IDENTITY.schemaVersion : "story-v1", schemaHash: exactCapability ? CURRENT_STORY_RESPONSE_FORMAT_CAPABILITY_IDENTITY.schemaHash : "a".repeat(64), verifiedAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() }] } }] });
    if (path === `/api/v1/campaigns/${fixture.campaignId}/sync-status`) return send({ ...fixture.syncStatus, campaign: { ...fixture.syncStatus.campaign, textProviderProfileId: provider.id }, pendingGeneration: null, generationRecovery: null });
    if (path === `/api/v1/campaigns/${fixture.campaignId}/turns`) return send(fixture.turns);
    if (path === `/api/v1/campaigns/${fixture.campaignId}/state`) return send(fixture.runtimeState);
    if (path === `/api/v1/campaigns/${fixture.campaignId}/story-memory`) return send({ level: "off", reviewMode: "off", availableLevels: ["off"] });
    if (path === `/api/v1/campaigns/${fixture.campaignId}/illustration-config`) return send(fixture.illustrationConfig);
    if (path === `/api/v1/campaigns/${fixture.campaignId}/illustration-segments`) return send(fixture.illustrationSegments);
    if (path === `/api/v1/campaigns/${fixture.campaignId}/image-jobs`) return send({ jobs: [] });
    if (path === `/api/v1/campaigns/${fixture.campaignId}/generations` && request.method() === "POST") {
      writes.push(request.postDataJSON() as Record<string, unknown>);
      return send({ id: jobId, status: "queued", duplicate: false, operationKind: "append", replacementTurnId: null }, 202);
    }
    if (path === `/api/v1/generation-jobs/${jobId}`) {
      const selection = writes.at(-1)?.textSelection as { kind?: string; slug?: string; modelId?: string } | undefined;
      const preset = selection?.kind === "openrouter_preset";
      return send({ id: jobId, campaignId: fixture.campaignId, expectedTurnNumber: 2, action: "Continue.", requestedInputMode: "action", resolvedInputMode: "action", inputModeSource: "explicit", operationKind: "append", replacementTurnId: null, status: "recoverable", attempts: 1, resultTurnId: null, errorCode: "generation_failed", errorMessage: "Generation could not be completed.", createdAt: now, updatedAt: now, partialNarration: null, responseFormat: { version: 2, savedPolicy: preset ? "required" : "auto", effectiveMode: "json_schema", schemaVersion: CURRENT_STORY_RESPONSE_FORMAT_CAPABILITY_IDENTITY.schemaVersion, schemaHash: CURRENT_STORY_RESPONSE_FORMAT_CAPABILITY_IDENTITY.schemaHash, operation: "story", streaming: false, preflight: "selected", preflightDiagnostic: null, diagnosticCode: null, requestedSelection: selection || null, assurance: preset ? "trusted_preset" : "verified_model", actualServedIdentity: preset ? { status: "known", model: "served-preset-model", providerRoute: null } : { status: "unknown", model: null, providerRoute: null } } });
    }
    if (path === `/api/v1/generation-jobs/${jobId}/discard` && request.method() === "POST") return send({ id: jobId, status: "discarded", duplicate: false, operationKind: "append", replacementTurnId: null }, 202);
    return send({});
  });
  const html = (await readFile("apps/web/public/story.html", "utf8")).replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
  await page.route(`**/story/${fixture.campaignId}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`${origin}/story/${fixture.campaignId}`);
  await page.waitForTimeout(500);
  expect(runtimeErrors).toEqual([]);
  await expect(page.locator("#storyTitle")).toHaveText(fixture.syncStatus.campaign.title);
  await expect(page.locator("#turnTextSelectionPanel")).toHaveCount(1);
  await expect(page.getByRole("combobox", { name: "Text selection" })).toHaveValue("profile");
  await expect(page.getByRole("combobox", { name: "Text selection" }).locator("option:checked")).toContainText("Model vendor/direct-model · Auto schema");
  await page.locator("#freeAction").fill("Use the profile selection.");
  await page.locator("#btnTakeAction").click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).not.toHaveProperty("model");
  expect(writes[0]).not.toHaveProperty("textSelection");
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Text selection" })).toHaveValue("profile");

  delayPresetList = true;
  await page.getByRole("combobox", { name: "Text selection" }).selectOption("preset");
  await expect(page.locator("#turnPresetStatus")).toContainText("Loading OpenRouter presets");
  await page.getByRole("combobox", { name: "Text selection" }).selectOption("model");
  releasePresetList();
  delayPresetList = false;
  await page.getByRole("combobox", { name: "Text selection" }).selectOption("preset");
  await expect(page.getByRole("combobox", { name: "Preset", exact: true })).toContainText("Nexus Story");
  await expect(page.locator("#turnPresetStatus")).not.toContainText("failed");

  await page.getByRole("combobox", { name: "Preset", exact: true }).selectOption("nexus-story");
  await expect(page.locator("#turnPresetPrompt")).toHaveText("Write with restrained tension.");
  await expect(page.locator("#turnPresetVersion")).toHaveText("3 · version-1");
  await expect(page.locator("#turnPresetLimits")).toContainText("Configured max_tokens: 2400");
  await expect(page.locator("#turnPresetLimits")).toContainText("configured max_completion_tokens: 1800");
  await expect(page.locator("#turnPresetLimits")).toContainText("effective max output: 1600");
  await page.locator("#turnPresetDetail").evaluate((details: HTMLDetailsElement) => { details.open = true; });
  await page.locator("#turnTextSelectionPanel").screenshot({ path: `${screenshots}/story-desktop-preset-detail.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  const presetSelect = page.getByRole("combobox", { name: "Preset", exact: true });
  await presetSelect.focus();
  await presetSelect.scrollIntoViewIfNeeded();
  const presetSelectBounds = await presetSelect.boundingBox();
  expect(presetSelectBounds).not.toBeNull();
  expect(presetSelectBounds!.y).toBeGreaterThanOrEqual(0);
  expect(presetSelectBounds!.y + presetSelectBounds!.height).toBeLessThanOrEqual(844);
  expect(await presetSelect.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2) === element;
  })).toBe(true);
  await page.locator("#turnTextSelectionPanel").screenshot({ path: `${screenshots}/story-mobile-preset-detail.png` });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.locator("#turnTextOverrideMode").selectOption("explicit");
  await page.locator("#turnOverrideTemperature").fill("0.31");
  await page.locator("#turnOverrideMaxTokens").fill("654");
  await page.getByRole("combobox", { name: "Text selection" }).selectOption("model");
  await page.getByRole("combobox", { name: "Text selection" }).selectOption("preset");
  await expect(page.locator("#turnTextOverrideMode")).toHaveValue("explicit");
  await expect(page.locator("#turnOverrideTemperature")).toHaveValue("0.31");
  await expect(page.locator("#turnOverrideMaxTokens")).toHaveValue("654");
  await page.locator("#freeAction").fill("Continue.");
  await page.locator("#btnTakeAction").click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toMatchObject({ model: "@preset/nexus-story", textSelection: { kind: "openrouter_preset", slug: "nexus-story" }, textExecutionOverrides: { parameters: { temperature: 0.31, max_tokens: 654 } } });
  await expect(page.locator("#toast")).toContainText("Generation could not be completed");
  await expect(page.locator("#generationResponseFormatDetails")).toContainText("Trusted preset schema");
  await expect(page.locator("#generationResponseFormatDetails")).toContainText("Requested selection: Preset nexus-story");
  await expect(page.locator("#generationResponseFormatDetails")).toContainText("Actual served model: served-preset-model");
  await expect(page.locator("#generationResponseFormatDetails")).toContainText("Actual provider route: Unknown");
  await page.locator("#generationResponseFormatPanel").screenshot({ path: `${screenshots}/story-desktop-trusted-preset-diagnostics.png` });
  expect(writes).toHaveLength(2);
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Text selection" })).toHaveValue("profile");

  await page.getByRole("combobox", { name: "Text selection" }).selectOption("model");
  await page.locator("#turnModelId").fill("vendor/direct-model");
  await page.getByRole("button", { name: "Verify model capability" }).click();
  await expect(page.locator("#turnModelCapability")).toContainText("blocked until exact current Story capability evidence");
  await page.locator("#freeAction").fill("Mismatched schema must remain local.");
  await page.locator("#btnTakeAction").click();
  await expect(page.locator("#toast")).toContainText("exact current Story capability evidence");
  expect(writes).toHaveLength(2);
  exactCapability = true;
  await page.getByRole("button", { name: "Verify model capability" }).click();
  await expect(page.locator("#turnModelCapability")).toContainText("exact capability verified");
  await page.locator("#freeAction").fill("Use the direct model.");
  await page.locator("#btnTakeAction").click();
  await expect.poll(() => writes.length).toBe(3);
  expect(writes[2]).toMatchObject({ model: "vendor/direct-model", textSelection: { kind: "model", modelId: "vendor/direct-model" }, textExecutionOverrides: null });
  await expect(page.locator("#generationResponseFormatDetails")).toContainText("Verified Model schema");
  await expect(page.locator("#generationResponseFormatDetails")).toContainText("Requested selection: Model vendor/direct-model");
  await expect(page.locator("#generationResponseFormatDetails")).toContainText("Actual served model: Unknown");
  await page.locator("#generationResponseFormatPanel").screenshot({ path: `${screenshots}/story-desktop-verified-model-diagnostics.png` });
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Text selection" })).toHaveValue("profile");
  await page.getByRole("combobox", { name: "Text selection" }).selectOption("model");

  await page.locator("#turnModelId").fill("vendor/unknown-model");
  await page.locator("#freeAction").fill("This must remain local.");
  await page.locator("#btnTakeAction").click();
  await expect(page.locator("#toast")).toContainText("exact current Story capability evidence");
  expect(writes).toHaveLength(3);
  expect(provider.textSelection).toEqual({ kind: "model", modelId: "vendor/direct-model" });
  await page.screenshot({ path: `${screenshots}/story-desktop-model-blocked.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("combobox", { name: "Text selection" }).focus();
  await page.keyboard.press("Home");
  await expect(page.getByRole("combobox", { name: "Text selection" })).toHaveValue("profile");
  await page.screenshot({ path: `${screenshots}/story-mobile-profile.png`, fullPage: true });

  await page.route("**/api/v1/meta", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ application: { version: "test" }, capabilities: {} }) }));
  await page.reload();
  await expect(page.locator("#turnTextSelectionPanel")).toBeVisible();
  await expect(page.locator("#turnTextSelectionSupport")).toContainText("does not advertise native text execution plans");
  await expect(page.getByRole("combobox", { name: "Text selection" })).toBeHidden();
});
