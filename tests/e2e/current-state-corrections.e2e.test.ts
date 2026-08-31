import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { currentStateFixture } from "../fixtures/current-state-corrections.js";

const initial = currentStateFixture({ activeTurnNumber: 2, viewedTurnNumber: 2 });
const campaignId = initial.campaignId;
const worldId = "33333333-3333-4333-8333-333333333333";
const worldVersionId = "44444444-4444-4444-8444-444444444444";
const textProviderId = "55555555-5555-4555-8555-555555555555";
const now = initial.updatedAt;
const campaign = {
  id: campaignId, title: "Correction browser fixture", activeTurnNumber: 2, worldVersionId,
  status: "active", createdAt: now, updatedAt: now, selectedCharacterId: null, selectedCharacterName: "",
  characterSnapshot: null, characterProfile: null, characterProfileRevision: 0,
  storyLengthProfile: "standard", storyContextBudgetTokens: 32000, turnControlStyle: "action_only",
  worldId, worldTitle: "Synthetic harbor", worldVersionNumber: 1, latestWorldVersionNumber: 1,
  worldUpdateAvailable: false, textProviderProfileId: textProviderId, imageProviderProfileId: null, costInformation: []
};
const textProvider = {
  id: textProviderId, name: "Browser fixture text provider", providerType: "openai_compatible", providerRole: "text",
  enabled: true, isDefault: true
};
const turns = { campaignId, nextCursor: null, turns: [1, 2].map((turnNumber) => ({
  id: `00000000-0000-4000-8000-${String(turnNumber).padStart(12, "0")}`, turnNumber,
  action: "Look at the harbor.", narration: `The harbor is quiet after turn ${turnNumber}.`,
  inputMode: "action", inputModeSource: "explicit", choices: [], customActionSuggestion: "",
  imagePrompt: "", imageUrl: null, acceptedAt: now, chronicleRetrieval: null, reportedCost: null
})) };

async function installApi(page: Page) {
  let current = structuredClone(initial);
  const writes: Record<string, unknown>[] = [];
  let rejectSave = false;
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const send = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (path === "/api/v1/session") return send({ user: { id: worldId, displayName: "Browser fixture", settings: {} }, authentication: "deferred" });
    if (path === "/api/v1/meta") return send({ application: { name: "Infinite Quest Nexus", version: "test", commit: null, builtAt: null }, capabilities: { systemArchive: false } });
    if (path === "/api/v1/providers") return send({ providers: [textProvider] });
    if (path === "/api/v1/worlds") return send({ worlds: [] });
    if (path === "/api/v1/campaigns") return send({ campaigns: [campaign] });
    if (path.endsWith("/sync-status")) return send({ ...campaign, campaign,
      world: { id: worldId, title: "Synthetic harbor", versionNumber: 1, genre: "test", tone: "quiet", premise: "A synthetic harbor.", backgroundStory: "", character: "", firstAction: "Look.", rules: "", playableCharacters: [] },
      playerConfig: { selectedCharacterId: null, selectedCharacterName: "", characterSnapshot: null, characterProfile: null, characterProfileRevision: 0, rpgStats: [], trackers: [], eventTriggers: [], useRpgStats: false, suppressEventTriggers: false },
      pendingGeneration: null, generationRecovery: null, syncToken: `fixture-${current.revision}`, turnWindowMode: "replace", turns
    });
    if (path.endsWith("/turns")) return send(turns);
    if (path.endsWith("/state")) {
      if (route.request().method() === "PATCH") {
        const body = route.request().postDataJSON();
        writes.push(body);
        if (rejectSave) {
          rejectSave = false;
          current.revision += 1;
          return send({ error: "Current state changed; reload before saving.", code: "state_revision_changed" }, 409);
        }
        current = { ...current, ...body, revision: current.revision + 1 };
      }
      const requested = Number(url.searchParams.get("turnNumber") ?? current.activeTurnNumber);
      return send({ ...current, viewedTurnNumber: requested, isCurrent: requested === current.activeTurnNumber });
    }
    if (path.includes("illustration") && path.endsWith("config")) return send({ enabled: false, sourcePolicy: "off" });
    if (path.endsWith("/segments")) return send({ segments: [] });
    if (path.endsWith("/jobs")) return send({ jobs: [] });
    return send({ error: "Not needed by this browser fixture" }, 404);
  });
  return { writes, rejectNextSave: () => { rejectSave = true; } };
}

test("new Campaign State saves individual facts and retains the draft on conflict", async ({ page }) => {
  const api = await installApi(page);
  await page.goto(`http://127.0.0.1:43174/app/campaigns/${campaignId}/state`);
  await page.locator("[data-scratchpad]").fill("The keeper remembers the visitor.");
  await page.locator("[data-continuity-summary]").fill("The corrected current harbor.");
  await page.locator("[data-thread-content]").fill("Find the repaired chart.");
  await page.getByRole("button", { name: "Add canonical fact", exact: true }).click();
  await page.getByRole("textbox", { name: "Canonical fact 2", exact: true }).fill("The bell is silver.\nIt hangs above the harbor.");
  api.rejectNextSave();
  await page.locator("#state-form button[type=submit]").click();
  await expect.poll(() => api.writes.length).toBe(1);
  expect(api.writes[0]).toMatchObject({ expectedTurnNumber: 2, effectiveTurnNumber: 2, expectedRevision: 7,
    canonicalFacts: [initial.canonicalFacts[0], { id: null, content: "The bell is silver.\nIt hangs above the harbor." }] });
  await expect(page.locator("[data-scratchpad]")).toHaveValue("The keeper remembers the visitor.");
  await expect(page.locator("#state-form button[type=submit]")).toBeDisabled();
  await expect(page.getByText(/Reload before saving/)).toBeVisible();
  // Even a synthetic duplicate submit must not issue another stale PATCH.
  await page.locator("#state-form").dispatchEvent("submit");
  expect(api.writes).toHaveLength(1);
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Reload current state", exact: true }).click();
  await expect(page.locator("[data-scratchpad]")).toHaveValue("The keeper remembers the visitor.");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reload current state", exact: true }).click();
  await expect(page.locator("#state-form button[type=submit]")).toBeEnabled();
  await page.locator("[data-continuity-summary]").fill("The corrected current harbor.");
  await page.locator("[data-scratchpad]").fill("The keeper remembers the visitor.");
  await page.locator("[data-thread-content]").fill("Find the repaired chart.");
  await page.locator("[data-fact-content]").fill("The lens is silver glass.");
  await page.locator("#state-form button[type=submit]").click();
  await expect.poll(() => api.writes.length).toBe(2);
  expect(api.writes[1]).toMatchObject({ expectedRevision: 8, continuitySummary: "The corrected current harbor.",
    scratchpad: "The keeper remembers the visitor.", openThreads: ["Find the repaired chart."],
    canonicalFacts: [{ id: initial.canonicalFacts[0]!.id, content: "The lens is silver glass." }] });
  await expect(page.locator("#state-form button[type=submit]")).toBeEnabled();
  await page.reload();
  await expect(page.locator("[data-fact-content]")).toHaveValue("The lens is silver glass.");
  await page.screenshot({ path: "test-results/current-state-campaign.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/current-state-campaign-mobile.png", fullPage: true });
});

test("new Story editor targets current state while reading an earlier turn", async ({ page }) => {
  const api = await installApi(page);
  await page.goto(`http://127.0.0.1:43174/app/story/${campaignId}?turn=1`);
  await expect(page.locator("[data-page=story-player]")).toHaveAttribute("aria-busy", "false");
  await page.getByText("Campaign Tools", { exact: true }).click();
  await page.locator("[data-tool-action=edit-campaign-state]").click();
  await expect(page.locator("[data-continuity-summary]")).toHaveValue(initial.continuitySummary);
  await page.screenshot({ path: "test-results/current-state-story-next.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/current-state-story-next-mobile.png", fullPage: true });
  await page.locator("[data-continuity-summary]").fill("The corrected current harbor.");
  api.rejectNextSave();
  await page.locator("[data-action=save-current-state]").click();
  await expect.poll(() => api.writes.length).toBe(1);
  expect(api.writes[0]).toMatchObject({ expectedTurnNumber: 2, effectiveTurnNumber: 2, expectedRevision: 7, canonicalFacts: initial.canonicalFacts });
  await expect(page.locator("[data-action=save-current-state]")).toBeDisabled();
  await expect(page.getByText(/Reload before saving/)).toBeVisible();
  await page.locator("[data-action=save-current-state]").dispatchEvent("click");
  expect(api.writes).toHaveLength(1);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reload current state", exact: true }).click();
  await expect(page.locator("[data-action=save-current-state]")).toBeEnabled();
  await page.locator("[data-continuity-summary]").fill("The corrected current harbor.");
  await page.locator("[data-scratchpad]").fill("The visitor has returned.");
  await page.locator("[data-thread-content]").fill("Repair the silver bell.");
  await page.locator("[data-fact-content]").fill("The bell is silver.");
  await page.locator("[data-action=save-current-state]").click();
  await expect.poll(() => api.writes.length).toBe(2);
  expect(api.writes[1]).toMatchObject({ expectedTurnNumber: 2, effectiveTurnNumber: 2, expectedRevision: 8,
    continuitySummary: "The corrected current harbor.", scratchpad: "The visitor has returned.",
    openThreads: ["Repair the silver bell."], canonicalFacts: [{ id: initial.canonicalFacts[0]!.id, content: "The bell is silver." }] });
  await expect(page.locator("[data-story-tool-dialog]")).not.toBeVisible();
  await page.getByText("Tools", { exact: true }).click();
  await page.locator("[data-tool-action=edit-campaign-state]").click();
  await expect(page.locator("[data-scratchpad]")).toHaveValue("The visitor has returned.");
  await expect(page.locator("[data-fact-content]")).toHaveValue("The bell is silver.");
});

test("legacy Story saves current continuity with retained fact IDs", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  const api = await installApi(page);
  // Production serves the built entry at this URL; Vite smoke testing uses its source entry.
  const html = (await readFile("apps/web/public/story.html", "utf8")).replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
  await page.route(`**/story/${campaignId}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`http://127.0.0.1:43173/story/${campaignId}`);
  await expect(page.locator("#storyTitle")).toHaveText(campaign.title);
  await page.getByRole("button", { name: "Setup", exact: true }).click();
  await expect(page.locator("#storySetupMenu")).toBeVisible();
  await page.locator("#btnOpenEditState").click();
  await expect(page.locator("#editStateContinuitySummary")).toHaveValue(initial.continuitySummary);
  await expect(page.getByRole("textbox", { name: "Open thread", exact: true })).toHaveValue(initial.openThreads[0]!);
  await page.locator("#editStateContinuitySummary").fill("The corrected current harbor.");
  await page.getByRole("textbox", { name: "Open thread", exact: true }).fill("Repair the silver bell.");
  await page.getByRole("textbox", { name: "Canonical fact", exact: true }).fill("The bell is silver.");
  await page.getByRole("button", { name: "Scratchpad", exact: true }).click();
  await expect(page.locator("#discardChangesDialog")).not.toBeVisible();
  await page.locator("#scratchpadEditor").fill("The visitor has returned.");
  await page.getByRole("button", { name: "Current State", exact: true }).click();
  await expect(page.locator("#discardChangesDialog")).not.toBeVisible();
  await page.screenshot({ path: "test-results/current-state-story-legacy.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/current-state-story-legacy-mobile.png", fullPage: true });
  await page.locator("#editStateContinuitySummary").fill("The corrected current harbor.");
  await page.locator("#btnSaveEditState").click();
  await expect.poll(() => api.writes.length).toBe(1);
  expect(api.writes[0]).toMatchObject({ expectedTurnNumber: 2, effectiveTurnNumber: 2, expectedRevision: 7,
    continuitySummary: "The corrected current harbor.", scratchpad: "The visitor has returned.",
    openThreads: ["Repair the silver bell."], canonicalFacts: [{ id: initial.canonicalFacts[0]!.id, content: "The bell is silver." }] });
});
