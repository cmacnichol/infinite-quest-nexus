import { expect, test, type Page, type Route } from "@playwright/test";

const screenshots = "docs/review/assets/illustration-accuracy-2026-10-13";
const worldId = "33333333-3333-4333-8333-333333333333";
const worldVersionId = "44444444-4444-4444-8444-444444444444";
const campaignId = "11111111-1111-4111-8111-111111111111";
const imageProviderId = "66666666-6666-4666-8666-666666666666";

const campaign = {
  id: campaignId, title: "Lantern Coast", status: "active", activeTurnNumber: 1, createdAt: "2026-10-13T12:00:00.000Z",
  updatedAt: "2026-10-13T12:00:00.000Z", worldId, worldTitle: "Fixture world", worldVersionId, worldVersionNumber: 1,
  latestWorldVersionNumber: 1, worldUpdateAvailable: false, selectedCharacterId: null, selectedCharacterName: "",
  characterSnapshot: null, characterProfile: null, characterProfileRevision: 0, storyLengthProfile: "standard",
  storyContextBudgetTokens: 32000, turnControlStyle: "flexible_action", textProviderProfileId: null,
  imageProviderProfileId: imageProviderId, costInformation: []
};

async function installApi(page: Page) {
  let config: Record<string, unknown> = {
    enabled: true, sourcePolicy: "generate_only", matchingScope: "world", confidenceProfile: "balanced", repetitionWindow: 5,
    providerProfileId: imageProviderId, model: "fixture-image", size: "1024x1024", aspectRatio: "1:1", quality: "auto",
    outputFormat: "png", maxAttempts: 3, segmentWordCount: 500, imagesPerSegment: 1, segmentPromptMode: "ai_refined",
    refinementPrompt: "Fixture refinement prompt.", defaultRefinementPrompt: "Fixture refinement prompt.",
    artStyle: "Ink and watercolor storybook, muted palette",
    negativePrompt: "text, captions, watermark", defaultNegativePrompt: "text, captions, watermark",
    updatedAt: "2026-10-13T12:00:00.000Z"
  };
  const writes: Record<string, unknown>[] = [];
  const send = (route: Route, value: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/illustration-config")) {
      if (request.method() === "PUT") {
        const body = request.postDataJSON() as Record<string, unknown>;
        writes.push(body);
        config = { ...config, ...body };
      }
      return send(route, config);
    }
    if (path === "/api/v1/session") return send(route, { user: { id: worldId, displayName: "Fixture owner", settings: { autoSubmitTurnChoices: true, continuousReading: false, defaultTurnControlStyle: "flexible_action" } }, authentication: "deferred" });
    if (path === "/api/v1/meta") return send(route, { application: { name: "Nexus", version: "test", commit: null, builtAt: null }, capabilities: { systemArchive: false } });
    if (path === "/api/v1/providers") return send(route, { providers: [
      { id: "44444444-4444-4444-8444-444444444444", name: "Fixture text", providerType: "openai_compatible", providerRole: "text", enabled: true, isDefault: true },
      { id: imageProviderId, name: "Fixture images", providerType: "openai_compatible", providerRole: "image", enabled: true, isDefault: true, configuration: {} }
    ] });
    if (path === "/api/v1/worlds") return send(route, { worlds: [] });
    if (path === "/api/v1/campaigns") return send(route, { campaigns: [campaign] });
    if (path === `/api/v1/campaigns/${campaignId}` && request.method() === "PATCH") return send(route, campaign);
    if (path.match(/^\/api\/v1\/worlds\//u)) return send(route, { id: worldId, versions: [{ id: worldVersionId, versionNumber: 1 }] });
    if (path.endsWith("/memory/metrics")) return send(route, { turns: 1, estimatedCompleteHistoryTokens: 10, memoryCount: 0, embeddedMemories: 0, semanticHealth: { indexedMemories: 0, jobStatus: "idle" } });
    if (path.endsWith("/cost-summary")) return send(route, { hasReportedCosts: false, totals: [] });
    if (path.endsWith("/memory/embedding-config")) return send(route, { enabled: false, retrievalImplementation: "disabled", retrievalShadowEnabled: false, model: null, documentPrefix: null, queryPrefix: null, batchSize: 1 });
    if (path.endsWith("/story-memory")) return send(route, { level: "standard", reviewMode: "off", availableLevels: ["off", "standard"] });
    if (path.endsWith("/illustrations/segments")) return send(route, { segments: [] });
    if (path.endsWith("/image-jobs")) return send(route, { jobs: [] });
    return send(route, {});
  });
  return { writes };
}

async function openIllustrationSettings(page: Page) {
  await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}/nexus/index.html#campaigns`);
  await page.locator(`#campaignList [data-campaign-id="${campaignId}"]`).click();
  await expect(page.locator("#campaignTabIllustrations")).toBeEnabled();
  await page.locator("#campaignTabIllustrations").click();
  await expect(page.locator("#illustrationArtStyle")).toHaveValue("Ink and watercolor storybook, muted palette");
}

test("legacy illustration settings edit the art style and exclusions and send both on save", async ({ page }) => {
  const api = await installApi(page);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await openIllustrationSettings(page);
  await expect(page.locator("#illustrationStyleSettings")).toBeVisible();
  await expect(page.locator("#illustrationNegativePrompt")).toHaveValue("text, captions, watermark");

  await page.locator("#illustrationNegativePrompt").fill("text, captions, watermark, picture frame");
  await page.locator("#campaignPanelIllustrations").screenshot({ path: `${screenshots}/legacy-illustration-style-desktop.png` });
  await page.locator("#saveIllustrationConfig").click();

  await expect.poll(() => api.writes.length).toBe(1);
  expect(api.writes[0]).toMatchObject({
    artStyle: "Ink and watercolor storybook, muted palette",
    negativePrompt: "text, captions, watermark, picture frame"
  });

  // Library-only matching reuses existing images, so style controls do not apply.
  await page.locator("#illustrationSourcePolicy").selectOption("library_only");
  await expect(page.locator("#illustrationStyleSettings")).toBeHidden();
});

test("legacy illustration style settings fit a phone-width panel", async ({ page }) => {
  await installApi(page);
  await page.setViewportSize({ width: 390, height: 900 });
  await openIllustrationSettings(page);
  const group = page.locator("#illustrationStyleSettings");
  await group.scrollIntoViewIfNeeded();
  const box = await group.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(390);
  await group.screenshot({ path: `${screenshots}/legacy-illustration-style-mobile.png` });
});
