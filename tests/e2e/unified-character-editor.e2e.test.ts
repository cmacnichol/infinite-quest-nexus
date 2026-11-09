import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { tabTo } from "./helpers/keyboard.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { characterProfileSchema } from "../../packages/contracts/src/world-library.js";
import { installLegacyUiFixture, legacyUiFixture } from "./helpers/legacy-ui-fixtures.js";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? 43173}`;

async function capture(page: Page, info: TestInfo, name: string) {
  const path = process.env.EDITOR_PHASE2_EVIDENCE
    ? resolve(process.env.EDITOR_PHASE2_EVIDENCE, name + ".png") : info.outputPath(name + ".png");
  await page.screenshot({ path });
}

for (const kind of ["main", "supporting"] as const) {
  test(`campaign ${kind} editor checks the generation lock on open and save without idle polling`, async ({ page }, info) => {
    const data = legacyUiFixture({ turnCount: 1, campaignCount: 1, worldCount: 1 });
    const api = await installLegacyUiFixture(page, data);
    const supporting = kind === "supporting";
    const person = { id: "88888888-8888-4888-8888-888888888888", name: "Mara", aliases: [], origin: { kind: "manual" },
      profile: {}, pinned: false, ignored: false, revision: 0, firstObservedTurn: 1, lastObservedTurn: 1 };
    const boundary = { turnNumber: 1, timelineRevision: 0 };
    let castWrites = 0;
    if (supporting) {
      await page.route("**/api/v1/meta", route => route.fulfill({ json: { capabilities: { castEditing: true } } }));
      await page.route("**/cast?*", route => route.fulfill({ json: { revision: person.revision, boundary, characters: [person], nextCursor: null, capabilities: { castEditing: true } } }));
      await page.route(`**/cast/${person.id}`, route => {
        if (route.request().method() !== "GET") {
          castWrites++;
          person.name = route.request().postDataJSON().name;
          person.revision++;
          return route.fulfill({ json: { revision: person.revision, character: person, boundary } });
        }
        return route.fulfill({ json: { revision: person.revision, character: person, boundary, observations: [], overrides: [],
          identityEvents: [], unresolvedCandidateIds: [], editorDestination: null, capabilities: { castEditing: true } } });
      });
    }
    let lockState: "recoverable" | "pending" | "failed" = "recoverable";
    let lockReads = 0;
    await page.route(`**/campaigns/${data.campaignId}/sync-status`, route => {
      lockReads++;
      const job = { id: person.id, expectedTurnNumber: 2, operationKind: "append", replacementTurnId: null };
      return route.fulfill({ json: { ...data.syncStatus,
        pendingGeneration: lockState === "pending" ? { ...job, status: "generating", action: "Look", createdAt: "2026-09-16T12:00:00Z", updatedAt: "2026-09-16T12:00:00Z" } : null,
        generationRecovery: lockState === "pending" ? null : { ...job, status: lockState, attempts: 1, errorCode: null, errorMessage: null, resultTurnId: null }
      } });
    });
    await page.clock.install();
    await page.setViewportSize({ width: supporting ? 390 : 1440, height: supporting ? 844 : 900 });
    await page.goto(`${origin}/nexus/index.html#campaigns`);
    await page.locator(`#campaignList [data-campaign-id="${data.campaignId}"]`).click();
    await page.locator("#editCampaignCharacter").click();
    const dialog = page.locator(supporting ? "#campaignCastDialog" : "#characterDialog");
    if (supporting) {
      await dialog.getByRole("button", { name: "Mara", exact: true }).click();
      await dialog.getByRole("button", { name: "Edit character", exact: true }).click();
    }
    const name = dialog.getByRole("textbox", { name: /^(character )?name$/i });
    const recheck = dialog.getByRole("button", { name: "Check generation status" });
    const save = dialog.getByRole("button", { name: /^Save (character|campaign)/i });
    await expect(name).toBeDisabled();
    await expect(dialog).toContainText(/Finish or resolve/);
    lockState = "failed";
    await recheck.click();
    await expect(name).toBeEnabled();
    await name.fill("Draft companion");
    const readsAfterOpening = lockReads;
    lockState = "pending";
    await page.clock.fastForward(8000);
    await expect(name).toBeEditable();
    expect(lockReads).toBe(readsAfterOpening);
    await save.click();
    await expect(save).toBeDisabled();
    await expect(recheck).toBeVisible();
    await expect(name).toHaveValue("Draft companion");
    expect(lockReads).toBe(readsAfterOpening + 1);
    const profileWrites = () => api.writes.filter(write => write.method === "PUT" && write.path.endsWith("/character-profile"));
    expect(castWrites + profileWrites().length).toBe(0);
    await expect(dialog).toContainText(/Finish or resolve/);
    await recheck.scrollIntoViewIfNeeded();
    const screenshot = `campaign-${kind}-blocked-save.png`;
    await page.screenshot({ path: process.env.EDITOR_FINAL_EVIDENCE ? resolve(process.env.EDITOR_FINAL_EVIDENCE, screenshot) : info.outputPath(screenshot) });
    lockState = "failed";
    await recheck.click();
    await expect(name).toHaveValue("Draft companion");
    await expect(dialog).not.toContainText(/Finish or resolve/);
    await save.click();
    if (supporting) await expect(dialog.getByRole("heading", { name: "Draft companion" })).toBeVisible();
    else await expect(dialog).toBeHidden();
    expect(castWrites + profileWrites().length).toBe(1);
  });
}

for (const surface of ["Story", "campaign"] as const) for (const width of [1440, 390]) {
  test(`${surface} editor compares and reapplies only the author's changes by keyboard at ${width}px`, async ({ page }, info) => {
    const fixture = legacyUiFixture({ turnCount: 1, campaignCount: 1, worldCount: 1 });
    await installLegacyUiFixture(page, fixture);
    const url = `**/api/v1/campaigns/${fixture.campaignId}/character-profile`;
    const profile = characterProfileSchema.parse({ story: { role: "Scout" }, identity: { pronouns: "they/them" } });
    let latest = { name: "The Observer", profile, revision: 3 };
    let attempts = 0;
    await page.route(url, route => {
      if (route.request().method() === "GET") return route.fulfill({ json: {
        ...latest, campaignId: fixture.campaignId, characterId: "fixture-observer", storedProfile: { name: latest.name, profile: latest.profile },
        inheritedFromSnapshot: false, legacyCharacterText: "", rpgStats: [], defaultTriggers: []
      } });
      const body = route.request().postDataJSON();
      attempts++;
      if (attempts === 1) {
        expect(body.expectedRevision).toBe(3);
        latest = { ...latest, name: "Concurrent rename", revision: 4 };
        return route.fulfill({ status: 409, json: { error: "fixture_error", message: "The campaign state changed.", details: { code: "state_revision_changed" } } });
      }
      expect(body).toMatchObject({ name: "Concurrent rename", expectedRevision: 4, editSource: "manual",
        profile: { identity: { pronouns: "they/them" }, story: { role: "Archivist" } } });
      latest = { name: body.name, profile: body.profile, revision: 5 };
      return route.fulfill({ json: { ...latest, campaignId: fixture.campaignId } });
    });
    await page.setViewportSize({ width, height: 900 });
    const isStory = surface === "Story";
    const opener = page.locator(isStory ? "#btnOpenEditCharacterProfile" : "#editCampaignCharacter");
    if (isStory) {
      const html = (await readFile("apps/web/public/story.html", "utf8")).replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts");
      await page.route(`**/story/${fixture.campaignId}`, route => route.fulfill({ contentType: "text/html", body: html }));
      await page.goto(`${origin}/story/${fixture.campaignId}`);
      await expect(page.locator("#storySyncStatus")).toHaveText("Story synced");
      await page.getByRole("button", { name: "Setup", exact: true }).press("Enter");
    } else {
      await page.goto(`${origin}/nexus/index.html#campaigns`);
      await page.locator(`#campaignList [data-campaign-id="${fixture.campaignId}"]`).press("Enter");
      await expect(page.locator("#campaignTitle")).toHaveValue("Fixture Campaign 1");
    }
    await opener.press("Enter");
    const dialog = page.locator(isStory ? "#editCharacterProfileDialog" : "#characterDialog");
    const name = dialog.getByRole("textbox", { name: /^(character )?name$/i });
    const role = dialog.getByRole("textbox", { name: "Role", exact: true });
    const save = dialog.getByRole("button", { name: /^Save (character|campaign)/i });
    await expect(name).toBeFocused();
    const essentials = dialog.getByRole("group", { name: "Story essentials" });
    await expect(essentials.getByRole("textbox")).toHaveCount(3);
    await expect(essentials.getByRole("textbox").nth(1)).toHaveAccessibleName("Background");
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await capture(page, info, `${surface}-editor-${width}`);
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Backspace");
    await tabTo(page, save);
    await page.keyboard.press("Enter");
    await expect(name).toBeFocused();
    await expect(name).toHaveAttribute("aria-describedby", /\S/);
    const validation = dialog.getByText("Enter a character name.", { exact: true });
    await expect(validation).toBeInViewport();
    await capture(page, info, `${surface}-validation-${width}`);
    await page.keyboard.type("The Observer");
    await tabTo(page, role);
    await page.keyboard.press("Control+a");
    await page.keyboard.type("Archivist");
    await tabTo(page, save);
    await page.keyboard.press("Enter");
    const compare = dialog.getByRole("button", { name: "Compare latest", exact: true });
    await expect(compare).toBeVisible();
    await expect(save).toBeDisabled();
    await expect(role).toHaveValue("Archivist");
    await tabTo(page, compare);
    await page.keyboard.press("Enter");
    await expect(dialog).toContainText("Concurrent rename");
    const reapply = dialog.getByRole("button", { name: "Reapply my changes", exact: true });
    await tabTo(page, reapply);
    await capture(page, info, `${surface}-conflict-${width}`);
    await page.keyboard.press("Enter");
    await expect(save).toBeEnabled();
    await expect(name).toHaveValue("Concurrent rename");
    await expect(role).toHaveValue("Archivist");
    await tabTo(page, save);
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(isStory ? page.getByRole("button", { name: "Setup", exact: true }) : opener).toBeFocused();
    expect(attempts).toBe(2);
  });
}
