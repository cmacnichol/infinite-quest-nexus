import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { installLegacyUiFixture, legacyUiFixture } from "./helpers/legacy-ui-fixtures.js";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const entryPath = "/nexus/src/legacy-client-entry.ts";
const typedText = "Synthetic early input must survive this campaign load.";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const input = document.querySelector<HTMLTextAreaElement>("#freeAction");
    const action = document.querySelector<HTMLButtonElement>("#btnTakeAction");
    return {
      at: performance.now(), readyState: document.readyState,
      path: location.pathname, value: input?.value ?? null,
      disabled: input?.disabled ?? null, inert: Boolean(input?.closest("[inert]")),
      actionDisabled: action?.disabled ?? null,
      activeId: document.activeElement?.id ?? "",
      sync: document.querySelector("#storySyncStatus")?.textContent ?? null,
      draft: document.querySelector("#autosaveStatus")?.textContent ?? null,
      modal: document.querySelector("dialog[open]")?.id ?? null,
      inputEvents: (window as Window & { __coldInputEvents?: unknown[] }).__coldInputEvents ?? []
    };
  });
}

async function readDraft(page: Page, userId: string, campaignId: string): Promise<unknown> {
  return page.evaluate(async ({ userId, campaignId }) => {
    const name = "infiniteQuest-reader-local-v1";
    if (!(await indexedDB.databases()).some(database => database.name === name)) return null;
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error("Unexpected diagnostic database creation")); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (!database.objectStoreNames.contains("actionDrafts")) return null;
      return await new Promise<unknown>((resolve, reject) => {
        const transaction = database.transaction("actionDrafts", "readonly");
        const request = transaction.objectStore("actionDrafts").get(`draft:${userId}:${campaignId}`);
        let value: unknown = null;
        request.onsuccess = () => { value = request.result?.value ?? null; };
        transaction.oncomplete = () => resolve(typeof value === "string" ? JSON.parse(value) : value);
        transaction.onabort = () => reject(transaction.error);
        transaction.onerror = () => reject(transaction.error);
      });
    } finally { database.close(); }
  }, { userId, campaignId });
}

async function capture(page: Page, testInfo: TestInfo, label: string, evidence: Record<string, unknown>) {
  evidence[label] = await snapshot(page);
  await page.screenshot({ path: testInfo.outputPath(`${label}.png`), fullPage: false });
  await writeFile(testInfo.outputPath("cold-input-evidence.json"), JSON.stringify(evidence, null, 2));
}

for (const phase of ["cold-entry", "held-sync"] as const) {
  test(`${phase}: composer stays disabled until draft handlers are ready and preserves later input`, async ({ page }, testInfo) => {
    test.setTimeout(35_000);
    const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
    // Keep all related identities coherent; this is a local synthetic response override.
    fixture.syncStatus.id = fixture.campaignId;
    const instrumentation = await installLegacyUiFixture(page, fixture);
    const userId = String((fixture.session.user as Record<string, unknown>).id);
    const gate = deferred();
    let gateHits = 0;
    let released = false;
    let completedRoutes = 0;
    const release = () => { if (!released) { released = true; gate.resolve(); } };
    const errors: string[] = [];
    const navigationDialogs: string[] = [];
    const evidence: Record<string, unknown> = {
      evidenceClass: "Mocked browser regression with native keyboard and IndexedDB",
      phase, campaignId: fixture.campaignId, userId,
      expectedBaseTurn: { id: fixture.turns[0]?.id, turnNumber: fixture.turns[0]?.turnNumber },
      typedText, errors, navigationDialogs
    };
    page.on("pageerror", error => errors.push(error.message));
    page.on("dialog", async dialog => { navigationDialogs.push(`${dialog.type()}: ${dialog.message()}`); await dialog.accept(); });
    await page.addInitScript(() => {
      const events: unknown[] = [];
      (window as Window & { __coldInputEvents?: unknown[] }).__coldInputEvents = events;
      // Observation only: never modifies the field or invokes an application listener.
      document.addEventListener("input", event => {
        const target = event.target;
        if (target instanceof HTMLTextAreaElement && target.id === "freeAction") {
          events.push({ at: performance.now(), trusted: event.isTrusted, value: target.value, readyState: document.readyState });
        }
      }, true);
    });
    const html = await readFile("apps/web/public/story.html", "utf8");
    expect(html.split("/nexus/legacy-client.js")).toHaveLength(2);
    await page.route(`${origin}/story/${fixture.campaignId}`, route => route.fulfill({
      contentType: "text/html", body: html.replace("/nexus/legacy-client.js", entryPath)
    }));
    const targetPath = phase === "cold-entry" ? entryPath : `/api/v1/campaigns/${fixture.campaignId}/sync-status`;
    await page.route(url => url.origin === origin && url.pathname === targetPath, async route => {
      gateHits += 1;
      if (gateHits === 1) await gate.promise;
      try { await route.fallback(); } finally { completedRoutes += 1; }
    });
    try {
      await page.goto(`${origin}/story/${fixture.campaignId}`, { waitUntil: "commit" });
      await expect.poll(() => gateHits).toBe(1);
      const field = page.locator("#freeAction");
      await expect(field).toBeVisible();
      await capture(page, testInfo, "before-input-held", evidence);
      const before = await snapshot(page);
      const blocked = before.disabled === true || before.inert;
      expect.soft(before.disabled, "Composer must block input before draft handlers are ready").toBe(true);
      expect.soft(before.actionDisabled, "Submit must wait for campaign initialization").toBe(true);
      evidence.initiallyBlocked = blocked;
      if (phase === "cold-entry") expect(instrumentation.requests).toHaveLength(0);
      if (!blocked) {
        await field.click();
        await page.keyboard.type(typedText);
        await expect(field).toHaveValue(typedText);
      }
      await capture(page, testInfo, "input-while-held", evidence);
      evidence.gateHitsBeforeRelease = gateHits;
      release();
      await expect(page.locator("#storySyncStatus")).toHaveText("Story synced");
      await expect(page.locator("#scene-1 .scene-narration")).toBeVisible();
      await expect(field).toBeEnabled();
      if (blocked) {
        // A correctly blocked initial surface must become usable after authoritative load.
        await field.click();
        await page.keyboard.type(typedText);
      }
      const statusReachedSaved = await expect(page.locator("#autosaveStatus")).toHaveText("Draft saved", { timeout: 2_000 })
        .then(() => true, () => false);
      evidence.statusReachedSaved = statusReachedSaved;
      await capture(page, testInfo, "after-load", evidence);
      evidence.persistedBeforeReload = await readDraft(page, userId, fixture.campaignId);
      const afterLoad = await snapshot(page);
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.locator("#storySyncStatus")).toHaveText("Story synced");
      await expect(field).toBeEnabled();
      const restored = await expect(field).toHaveValue(typedText, { timeout: 2_000 }).then(() => true, () => false);
      evidence.restoredAfterReload = restored;
      evidence.persistedAfterReload = await readDraft(page, userId, fixture.campaignId);
      await capture(page, testInfo, "after-reload", evidence);
      evidence.writes = instrumentation.writes;
      expect(instrumentation.writes).toEqual([]);
      expect.soft(afterLoad.value, "An editable early field must retain exactly what native input accepted").toBe(typedText);
      expect.soft(statusReachedSaved, "Accepted text must become a durable local draft").toBe(true);
      expect.soft(evidence.persistedBeforeReload).toMatchObject({ userId, campaignId: fixture.campaignId, draft: {
        text: typedText, baseTurnId: fixture.turns[0]?.id, baseTurnNumber: 1
      } });
      expect.soft(restored, "The same user/campaign must restore accepted draft text on reload").toBe(true);
      expect(errors).toEqual([]);
    } finally {
      release();
      evidence.gateHits = gateHits;
      evidence.completedRoutes = completedRoutes;
      evidence.requests = instrumentation.requests;
      evidence.writes = instrumentation.writes;
      evidence.finalSnapshot = await snapshot(page).catch(error => ({ unavailable: String(error) }));
      await writeFile(testInfo.outputPath("cold-input-evidence.json"), JSON.stringify(evidence, null, 2));
    }
  });
}
