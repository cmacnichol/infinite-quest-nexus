import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const USER_ID = "4d7c311a-ecf2-4eeb-8c27-1aaaf13af931";
const CAMPAIGN_ID = "53675828-1fb0-42ef-aaf1-33e5e4885586";
const DRAFT_MODULE_URL = `/nexus/@fs/${fileURLToPath(new URL("../../packages/client-web/src/storage/story-action-drafts.ts", import.meta.url)).replaceAll("\\", "/")}`;
const EVIDENCE_SCREENSHOT = fileURLToPath(new URL("../../.superpowers/sdd/legacy-ui-2026-10-03/evidence/T07/two-page-indexeddb.png", import.meta.url));
const EVIDENCE_RESULTS = fileURLToPath(new URL("../../.superpowers/sdd/legacy-ui-2026-10-03/evidence/T07/browser-results.json", import.meta.url));

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

async function clearDraftIfRevision(page: Page, expectedRevision: string) {
  return page.evaluate(async ({ moduleUrl, expectedRevision, userId, campaignId }) => {
    const storage = await import(moduleUrl);
    const store = storage.createStoryActionDraftStore(
      storage.createIndexedDbDraftDatabase(),
      () => new Date("2026-10-03T12:00:00.000Z"),
      () => "00000000-0000-4000-8000-000000000005"
    );
    return store.removeIfRevision({ userId, campaignId }, expectedRevision);
  }, { moduleUrl: DRAFT_MODULE_URL, expectedRevision, userId: USER_ID, campaignId: CAMPAIGN_ID });
}

async function readDraft(page: Page) {
  return page.evaluate(async ({ moduleUrl, userId, campaignId }) => {
    const storage = await import(moduleUrl);
    const store = storage.createStoryActionDraftStore(
      storage.createIndexedDbDraftDatabase(),
      () => new Date("2026-10-03T12:00:00.000Z"),
      () => "00000000-0000-4000-8000-000000000006"
    );
    return store.read({ userId, campaignId });
  }, { moduleUrl: DRAFT_MODULE_URL, userId: USER_ID, campaignId: CAMPAIGN_ID });
}

test("two pages compare and clear revisions in real IndexedDB transactions", async ({ page }, testInfo) => {
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
  const winner = race.find((result) => result.outcome === "saved");
  if (winner?.outcome !== "saved") throw new Error("The IndexedDB race had no successful writer.");
  const winnerText = race[0]?.outcome === "saved" ? "First page edit" : "Second page edit";

  const duplicateRevision = await writeDraft(otherPage, winnerText, winner.currentRevision, winner.currentRevision);
  expect(duplicateRevision).toEqual({ outcome: "conflict", currentRevision: winner.currentRevision });
  expect(await readDraft(page)).toMatchObject({
    draftRevision: winner.currentRevision,
    text: winnerText
  });
  const sameTextUpdate = await writeDraft(
    otherPage,
    winnerText,
    "00000000-0000-4000-8000-000000000004",
    winner.currentRevision
  );
  expect(sameTextUpdate.outcome).toBe("saved");
  if (sameTextUpdate.outcome !== "saved") throw new Error("Same-text draft update failed.");
  expect(sameTextUpdate.currentRevision).not.toBe(winner.currentRevision);

  const staleClear = await clearDraftIfRevision(page, winner.currentRevision);
  expect(staleClear).toEqual({ outcome: "conflict" });
  expect(await readDraft(otherPage)).toMatchObject({
    draftRevision: sameTextUpdate.currentRevision,
    text: winnerText
  });
  const matchingClear = await clearDraftIfRevision(otherPage, sameTextUpdate.currentRevision);
  expect(matchingClear).toEqual({ outcome: "removed" });
  expect(await readDraft(page)).toBeNull();

  const evidence = {
    pages: 2,
    database: "infiniteQuest-reader-local-v1",
    raceOutcomes: race.map((result) => result.outcome),
    duplicateRevision: duplicateRevision.outcome,
    sameTextUpdate: sameTextUpdate.outcome,
    staleClear: staleClear.outcome,
    matchingClear: matchingClear.outcome,
    finalRead: "absent"
  };
  await mkdir(dirname(EVIDENCE_SCREENSHOT), { recursive: true });
  await writeFile(EVIDENCE_RESULTS, `${JSON.stringify(evidence, null, 2)}\n`);
  await page.evaluate((proof) => {
    const main = document.createElement("main");
    const heading = document.createElement("h1");
    heading.textContent = "T07 IndexedDB transaction proof";
    const details = document.createElement("pre");
    details.textContent = proof;
    main.append(heading, details);
    document.body.replaceChildren(main);
  }, JSON.stringify(evidence, null, 2));
  const screenshot = await page.screenshot({ fullPage: true });
  await writeFile(EVIDENCE_SCREENSHOT, screenshot);
  await testInfo.attach("T07 two-page IndexedDB transaction proof", { body: screenshot, contentType: "image/png" });
  await testInfo.attach("T07 IndexedDB transaction results", { body: Buffer.from(JSON.stringify(evidence, null, 2)), contentType: "application/json" });
  await otherPage.close();
});
