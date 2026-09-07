import { expect, test } from "@playwright/test";

test("world creation retains its prompt and renders a safe authoring error", async ({ page }, testInfo) => {
  await page.route("**/api/v1/authoring/capabilities", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ enabled: false, supportedKinds: ["world_concept", "character"], limits: { activeJobsPerOwner: 5, maximumInputBytes: 2 * 1024 * 1024, listPageSize: 20 } })
  }));
  const marker = "https://private-provider.example/v1?token=SECRET";
  await page.route("**/api/v1/worlds/generate-preview", (route) => route.fulfill({
    status: 502, contentType: "application/json", body: JSON.stringify({
      error: "Authoring request failed", message: marker, correlationId: "fixture-correlation",
      details: { code: "invalid_authoring_output", stage: "world", retryable: true,
        issues: [{ path: "world.premise", code: "missing", message: "World premise is required." }], correlationId: "fixture-correlation" }
    })
  }));
  await page.goto("http://127.0.0.1:43174/app/worlds/new");
  await page.locator('[name="creationMethod"][value="ai"]').check();
  await page.locator('[data-concept-prompt="compact"]').fill("Keep this world concept");
  await page.getByRole("button", { name: "Generate world draft" }).click();
  const status = page.locator("[data-generation-status]");
  await expect(status).toHaveAttribute("role", "alert");
  await expect(status).toContainText("world.premise");
  await expect(status).toContainText("fixture-correlation");
  await expect(page.locator('[data-concept-prompt="compact"]')).toHaveValue("Keep this world concept");
  await expect(status).not.toContainText(marker);
  await page.screenshot({ path: testInfo.outputPath("world-authoring-error.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("world-authoring-error-narrow.png"), fullPage: true });
});

test("character workspace retains its prompt and renders a safe provider recovery", async ({ page }, testInfo) => {
  await page.route("**/api/v1/authoring/capabilities", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ enabled: false, supportedKinds: ["world_concept", "character"], limits: { activeJobsPerOwner: 5, maximumInputBytes: 2 * 1024 * 1024, listPageSize: 20 } })
  }));
  const draft = { schemaVersion: 5, world: { title: "Glass Atlas", genre: "", tone: "", premise: "", backgroundStory: "", firstAction: "", rules: "" },
    playableCharacters: [], entities: [], relationships: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], assets: [], defaults: {}, preservedLore: { cartographer: "Ilyra" } };
  await page.addInitScript((session) => {
    sessionStorage.setItem("iqn:character-workspace:session:opaque-key", JSON.stringify(session));
  }, { version: 1, key: "opaque-key", origin: "world-editor", mode: "create", workflowId: "workflow-1",
    parentRoute: "/app/worlds/world-1?tab=characters", expectedWorldRevision: 4, parentDraft: draft, worldContext: draft,
    rosterSummaries: [{ id: "existing", name: "Existing Hero" }], candidate: null, expiresAt: Date.now() + 60_000 });
  await page.route("**/api/v1/worlds/playable-characters/generate-preview", (route) => route.fulfill({
    status: 503, contentType: "application/json", body: JSON.stringify({
      error: "Authoring request failed", message: "https://private-provider.example/v1?token=SECRET", correlationId: "character-correlation",
      details: { code: "authoring_provider_unavailable", stage: "character", retryable: true, issues: [], correlationId: "character-correlation" }
    })
  }));
  await page.route("**/api/v1/worlds/generate-progress?*", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ status: "processing", phase: "generating", progressPercent: 10, message: "Generating" })
  }));
  await page.goto("http://127.0.0.1:43174/app/characters/opaque-key");
  await page.locator('[name="characterMethod"][value="ai"]').check();
  await page.locator('[data-character-prompt="compact"]').fill("Keep this character concept");
  await expect(page.getByRole("button", { name: "Generate character" })).toBeEnabled();
  const response = page.waitForResponse("**/api/v1/worlds/playable-characters/generate-preview");
  await page.getByRole("button", { name: "Generate character" }).click();
  expect((await response).status()).toBe(503);
  const status = page.locator("[data-character-generation-status]");
  await expect(status).toHaveAttribute("role", "alert");
  await expect(status).toContainText("Provider Setup");
  await expect(status.locator('a[href="/nexus/#providers"]')).toBeVisible();
  await expect(status).toContainText("character-correlation");
  await expect(page.locator('[data-character-prompt="compact"]')).toHaveValue("Keep this character concept");
  await expect(status).not.toContainText("private-provider.example");
  await page.screenshot({ path: testInfo.outputPath("character-authoring-error.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("character-authoring-error-narrow.png"), fullPage: true });
});
