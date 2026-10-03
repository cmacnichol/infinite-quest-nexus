import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { quietLeafApiPayloads } from "../fixtures/quiet-leaf-payloads.js";
import { installLegacyUiFixture, legacyUiFixture } from "./helpers/legacy-ui-fixtures.js";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const evidenceDirectory = resolve(".superpowers/sdd/legacy-ui-2026-10-03/evidence/T04-fix1");
const fixture = quietLeafApiPayloads();

function response(body: unknown, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

async function installApi(page: Page, options: {
  failProviderSave?: boolean;
  holdProviderSave?: () => Promise<void>;
  holdWorldSave?: () => Promise<void>;
  writes: string[];
  worldFixture?: ReturnType<typeof legacyUiFixture>;
  worldDraftBodies?: unknown[];
}) {
  await page.route("**/api/v1/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api\/v1/u, "");
    if (request.method() !== "GET") options.writes.push(`${request.method()} ${path}`);
    if (path === "/meta") return route.fulfill(response({ application: { version: "synthetic" }, capabilities: {} }));
    if (path === "/session") return route.fulfill(response(fixture.session));
    if (path === "/providers" && request.method() === "POST" && options.failProviderSave) {
      await options.holdProviderSave?.();
      return route.fulfill(response({ message: "Synthetic provider save failure" }, 500));
    }
    if (path === "/providers") return route.fulfill(response({ providers: [] }));
    if (path === "/worlds" && request.method() === "POST") {
      await options.holdWorldSave?.();
      return route.fulfill(response({ id: "synthetic-world" }, 201));
    }
    if (path === "/worlds" && request.method() === "GET") return route.fulfill(response({ worlds: options.worldFixture?.worlds ?? [] }));
    if (/^\/worlds\/[^/]+\/draft$/u.test(path) && request.method() === "PUT") {
      options.worldDraftBodies?.push(request.postDataJSON());
      return route.fulfill(response({}));
    }
    if (/^\/worlds\/[^/]+$/u.test(path) && request.method() === "GET") {
      const id = path.split("/").at(-1) ?? "";
      return route.fulfill(response(options.worldFixture?.worldDetails.get(id) ?? {}));
    }
    if (path === "/campaigns") return route.fulfill(response({ campaigns: [] }));
    if (path === "/dashboard/stats") return route.fulfill(response({ worlds: { total: 0 }, campaigns: { total: 0 }, turns: { total: 0 }, costs: { totalUsd: 0, byProvider: [] } }));
    return route.fulfill(response({}));
  });
}

test("provider Escape, Cancel, and backdrop share guarded dismissal and failed saves retain edits", async ({ page }) => {
  const writes: string[] = [];
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolveHeld) => { release = resolveHeld; });
  const saveStarted = new Promise<void>((resolveStarted) => { started = resolveStarted; });
  await installApi(page, { failProviderSave: true, holdProviderSave: async () => { started(); await held; }, writes });
  await page.setViewportSize({ width: 1280, height: 800 });
  mkdirSync(evidenceDirectory, { recursive: true });
  await page.goto(`${origin}/nexus/index.html#providers`);
  await page.locator("#newProviderButton").click();
  await page.locator("#providerName").fill("Synthetic unsaved profile");
  await page.keyboard.press("Escape");
  await expect(page.locator("#discardChangesDialog")).toBeVisible();
  await expect(page.locator("#saveCampaignEditsDecision")).toBeHidden();
  await page.screenshot({ path: resolve(evidenceDirectory, "provider-dismissal-decision.png") });
  await page.locator('#discardChangesDialog button[value="keep"]').click();
  await expect(page.locator("#providerDialog")).toBeVisible();
  await expect(page.locator("#providerName")).toHaveValue("Synthetic unsaved profile");

  await page.locator("#cancelProviderEdit").click();
  await expect(page.locator("#discardChangesDialog")).toBeVisible();
  await page.locator('#discardChangesDialog button[value="discard"]').click();
  await expect(page.locator("#providerDialog")).toBeHidden();
  expect(writes).toEqual([]);
  await expect(page.locator("#newProviderButton")).toBeFocused();

  await page.locator("#newProviderButton").click();
  await page.locator("#providerName").fill("Synthetic backdrop profile");
  await page.mouse.click(3, 3);
  await expect(page.locator("#discardChangesDialog")).toBeVisible();
  await page.locator('#discardChangesDialog button[value="discard"]').click();
  await expect(page.locator("#providerDialog")).toBeHidden();

  await page.locator("#newProviderButton").click();
  await page.locator("#providerName").fill("Synthetic failed save profile");
  await page.locator("#saveProvider").click();
  await saveStarted;
  await expect(page.locator("#providerName")).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.locator("#discardChangesDialog")).toBeHidden();
  await expect(page.locator("#providerDialog")).toBeVisible();
  release();
  await expect(page.locator("#providerStatus")).toContainText("Synthetic provider save failure");
  await expect(page.locator("#providerName")).toBeEnabled();
  await expect(page.locator("#providerName")).toHaveValue("Synthetic failed save profile");
  await page.locator("#cancelProviderEdit").click();
  await expect(page.locator("#discardChangesDialog")).toBeVisible();
  await page.locator('#discardChangesDialog button[value="discard"]').click();
  expect(writes.filter((write) => write === "POST /providers")).toHaveLength(1);
});

test("nested world character Cancel preserves parent edits and Apply changes only the parent draft", async ({ page }) => {
  const writes: string[] = [];
  await installApi(page, { writes });
  await page.setViewportSize({ width: 1280, height: 800 });
  mkdirSync(evidenceDirectory, { recursive: true });
  await page.goto(`${origin}/nexus/index.html#world-library`);
  await page.locator("#newWorld").click();
  await page.locator("#worldTitle").fill("Synthetic draft title");
  await page.locator('[data-tab-target="world-author-mechanics"]').click();

  await page.locator("#addPlayableCharacter").click();
  await page.locator("#characterName").fill("Discarded child character");
  await page.locator("#cancelCharacter").click();
  await expect(page.locator("#discardChangesDialog")).toBeVisible();
  await page.locator('#discardChangesDialog button[value="discard"]').click();
  await expect(page.locator("#characterDialog")).toBeHidden();
  await expect(page.locator("#worldTitle")).toHaveValue("Synthetic draft title");
  await expect(page.locator("#playableCharacterRoster")).not.toContainText("Discarded child character");

  await page.locator("#addPlayableCharacter").click();
  await expect(page.locator("#saveCharacter")).toHaveText("Apply to world draft");
  await page.locator("#characterName").fill("Applied child character");
  await page.locator("#characterRole").fill("Synthetic guide");
  await page.locator("#saveCharacter").click();
  await expect(page.locator("#characterDialog")).toBeHidden();
  await expect(page.locator("#worldTitle")).toHaveValue("Synthetic draft title");
  await expect(page.locator("#playableCharacterRoster")).toContainText("Applied child character");
  await expect(page.locator("#worldAuthorStatus")).toContainText("Save the world form to persist this change");
  await page.screenshot({ path: resolve(evidenceDirectory, "world-draft-after-character-apply.png") });
  await page.locator("#cancelWorldAuthor").click();
  await expect(page.locator("#discardChangesDialog")).toBeVisible();
  await expect(page.locator("#saveCampaignEditsDecision")).toBeHidden();
  expect(writes).toEqual([]);
});

test("applying a child character alone dirties an existing world draft and saves it with the parent", async ({ page }) => {
  const fixtureWorld = legacyUiFixture({ turnCount: 0, worldCount: 1, campaignCount: 0 });
  const worldDraftBodies: unknown[] = [];
  const writes: string[] = [];
  await installApi(page, { writes, worldFixture: fixtureWorld, worldDraftBodies });
  await page.setViewportSize({ width: 1280, height: 800 });
  mkdirSync(evidenceDirectory, { recursive: true });
  await page.goto(`${origin}/nexus/index.html#world-library`);
  await page.locator("#worldManagementCarousel").getByText("Fixture World 1", { exact: true }).click();
  await page.locator("#editWorldDraft").click();
  await expect(page.locator("#worldTitle")).toHaveValue("Fixture World 1");
  await page.locator('[data-tab-target="world-author-mechanics"]').click();
  await page.locator("#addPlayableCharacter").click();
  await page.locator("#characterName").fill("Applied child only");
  await page.locator("#characterRole").fill("Synthetic observer");
  await page.locator("#saveCharacter").click();
  await expect(page.locator("#characterDialog")).toBeHidden();
  await expect(page.locator("#addPlayableCharacter")).toBeFocused();
  await page.screenshot({ path: resolve(evidenceDirectory, "existing-world-after-child-apply.png") });

  await page.locator("#cancelWorldAuthor").click();
  await expect(page.locator("#discardChangesDialog")).toBeVisible();
  await expect(page.locator("#saveCampaignEditsDecision")).toBeHidden();
  await page.locator('#discardChangesDialog button[value="keep"]').click();
  await expect(page.locator("#worldTitle")).toHaveValue("Fixture World 1");
  await page.locator("#saveWorldDraft").click();
  await expect(page.locator("#worldAuthorDialog")).toBeHidden();
  expect(worldDraftBodies).toHaveLength(1);
  expect(worldDraftBodies[0]).toMatchObject({ expectedRevision: 1, title: "Fixture World 1" });
  expect(JSON.stringify(worldDraftBodies[0])).toContain("Applied child only");
  expect(writes.filter((write) => write.endsWith("/draft"))).toEqual(["PUT /worlds/10000000-0000-4000-8000-000000000064/draft"]);
  expect(writes.some((write) => write.includes("character"))).toBe(false);
});

test("busy world save cannot be dismissed", async ({ page }) => {
  const writes: string[] = [];
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const saveStarted = new Promise<void>((resolve) => { started = resolve; });
  await installApi(page, { writes, holdWorldSave: async () => { started(); await held; } });
  await page.goto(`${origin}/nexus/index.html#world-library`);
  await page.locator("#newWorld").click();
  await page.locator("#worldTitle").fill("Busy synthetic world");
  await page.locator("#saveWorldDraft").click();
  await saveStarted;
  await page.keyboard.press("Escape");
  await expect(page.locator("#worldAuthorDialog")).toBeVisible();
  await expect(page.locator("#discardChangesDialog")).toBeHidden();
  release();
  await expect(page.locator("#worldAuthorDialog")).toBeHidden();
  expect(writes).toContain("POST /worlds");
});

test("campaign character Save keeps its immediate server-authoritative meaning while busy", async ({ page }) => {
  const fixtureCampaign = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
  const path = `/api/v1/campaigns/${fixtureCampaign.campaignId}/character-profile`;
  const instrumentation = await installLegacyUiFixture(page, fixtureCampaign, { delays: { [`PUT ${path}`]: 1000 } });
  await page.goto(`${origin}/nexus/index.html#campaigns`);
  await page.locator(`#campaignList [data-campaign-id="${fixtureCampaign.campaignId}"]`).click();
  await expect(page.locator("#campaignTitle")).toHaveValue("Fixture Campaign 1");
  await page.locator("#editCampaignCharacter").click();
  await expect(page.locator("#characterDialog")).toBeVisible();
  await page.locator("#characterName").fill("Synthetic campaign character");
  await page.locator("#characterRole").fill("Synthetic role");
  const saveRequest = page.waitForRequest(request => request.method() === "PUT" && new URL(request.url()).pathname === path);
  await page.keyboard.press("Escape");
  await expect(page.locator("#discardChangesDialog")).toBeVisible();
  await expect(page.locator("#saveCampaignEditsDecision")).toBeVisible();
  await page.locator("#saveCampaignEditsDecision").click();
  await saveRequest;
  await page.keyboard.press("Escape");
  await expect(page.locator("#characterDialog")).toBeVisible();
  await expect(page.locator("#discardChangesDialog")).toBeHidden();
  instrumentation.releaseDelayedRoute();
  await expect(page.locator("#characterDialog")).toBeHidden();
  expect(instrumentation.writes.filter(write => write.path === path)).toHaveLength(1);
});

test("provider and world dismissal hide Save, then campaign metadata Save remains available", async ({ page }) => {
  const fixtureCampaigns = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 2 });
  const instrumentation = await installLegacyUiFixture(page, fixtureCampaigns);
  mkdirSync(evidenceDirectory, { recursive: true });
  await page.goto(`${origin}/nexus/index.html#providers`);

  await page.locator("#newProviderButton").click();
  await page.locator("#providerName").fill("Synthetic provider profile");
  await page.keyboard.press("Escape");
  await expect(page.locator("#discardChangesDialog")).toBeVisible();
  await expect(page.locator("#saveCampaignEditsDecision")).toBeHidden();
  await page.locator('#discardChangesDialog button[value="discard"]').click();

  await page.locator("#navSetup").click();
  await page.locator("#navWorlds").click();
  await page.locator("#newWorld").click();
  await page.locator("#worldTitle").fill("Synthetic staged world");
  await page.locator("#cancelWorldAuthor").click();
  await expect(page.locator("#discardChangesDialog")).toBeVisible();
  await expect(page.locator("#saveCampaignEditsDecision")).toBeHidden();
  await page.locator('#discardChangesDialog button[value="discard"]').click();

  await page.locator("#navSetup").click();
  await page.locator("#navCampaigns").click();
  const firstCampaign = fixtureCampaigns.campaigns[0];
  const nextCampaign = fixtureCampaigns.campaigns[1];
  if (!firstCampaign || !nextCampaign) throw new Error("Two synthetic campaigns are required for the cross-flow check.");
  await page.locator(`#campaignList [data-campaign-id="${firstCampaign.id}"]`).click();
  await expect(page.locator("#campaignTitle")).toHaveValue("Fixture Campaign 1");
  await page.locator("#campaignTitle").fill("Synthetic campaign change");
  await page.locator(`#campaignList [data-campaign-id="${nextCampaign.id}"]`).click();
  await expect(page.locator("#discardChangesDialog")).toBeVisible();
  await expect(page.locator("#saveCampaignEditsDecision")).toBeVisible();
  await page.screenshot({ path: resolve(evidenceDirectory, "campaign-metadata-save-after-staged-dismissal.png") });
  await page.locator("#saveCampaignEditsDecision").click();
  await expect(page.locator("#campaignTitle")).toHaveValue("Fixture Campaign 2");
  expect(instrumentation.writes.filter(write => write.method === "PATCH" && write.path.endsWith(`/${firstCampaign.id}`))).toHaveLength(1);
});
