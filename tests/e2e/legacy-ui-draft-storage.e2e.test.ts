import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const USER_ID = "4d7c311a-ecf2-4eeb-8c27-1aaaf13af931";
const CAMPAIGN_ID = "53675828-1fb0-42ef-aaf1-33e5e4885586";
const DRAFT_MODULE_URL = `/nexus/@fs/${fileURLToPath(new URL("../../packages/client-web/src/storage/story-action-drafts.ts", import.meta.url)).replaceAll("\\", "/")}`;

async function clearDraftDatabase(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("infiniteQuest-reader-local-v1");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Draft database cleanup was blocked."));
  }));
}

async function writeDraft(page: Page, text: string, revision: string, expectedRevision: string | null) {
  return page.evaluate(async ({ moduleUrl, text, revision, expectedRevision, userId, campaignId }) => {
    const storage = await import(moduleUrl);
    const store = storage.createStoryActionDraftStore(
      storage.createIndexedDbDraftDatabase(),
      () => new Date("2026-10-03T12:00:00.000Z"),
      () => revision
    );
    return store.write({ userId, campaignId }, {
      schemaVersion: 1,
      draftRevision: "00000000-0000-4000-8000-999999999999",
      text,
      inputMode: "action",
      baseTurnId: null,
      baseTurnNumber: 0,
      updatedAt: "2026-10-03T12:00:00.000Z"
    }, { expectedRevision });
  }, { moduleUrl: DRAFT_MODULE_URL, text, revision, expectedRevision, userId: USER_ID, campaignId: CAMPAIGN_ID });
}

test("two pages compare and write a scoped draft in real IndexedDB transactions", async ({ page }) => {
  const port = Number(process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173");
  await page.goto(`http://127.0.0.1:${port}/nexus/`);
  await clearDraftDatabase(page);
  const otherPage = await page.context().newPage();
  await otherPage.goto(`http://127.0.0.1:${port}/nexus/`);

  const initial = await writeDraft(
    page,
    "Starting draft",
    "00000000-0000-4000-8000-000000000001",
    null
  );
  expect(initial.outcome).toBe("saved");
  if (initial.outcome !== "saved") throw new Error("Initial browser draft save failed.");

  const race = await Promise.all([
    writeDraft(page, "First page edit", "00000000-0000-4000-8000-000000000002", initial.currentRevision),
    writeDraft(otherPage, "Second page edit", "00000000-0000-4000-8000-000000000003", initial.currentRevision)
  ]);

  expect(race.map((result) => result.outcome).sort()).toEqual(["conflict", "saved"]);
  const finalDraft = await page.evaluate(async ({ moduleUrl, userId, campaignId }) => {
    const storage = await import(moduleUrl);
    const store = storage.createStoryActionDraftStore(
      storage.createIndexedDbDraftDatabase(),
      () => new Date("2026-10-03T12:00:00.000Z"),
      () => "00000000-0000-4000-8000-000000000004"
    );
    return store.read({ userId, campaignId });
  }, { moduleUrl: DRAFT_MODULE_URL, userId: USER_ID, campaignId: CAMPAIGN_ID });
  expect(["First page edit", "Second page edit"]).toContain(finalDraft?.text);
  await otherPage.close();
});
