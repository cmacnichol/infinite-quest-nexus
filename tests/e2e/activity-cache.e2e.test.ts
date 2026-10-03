import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
const fixture = fileURLToPath(new URL("./fixtures/activity-cache.html", import.meta.url)).replaceAll("\\", "/");
const url = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? 43173}/nexus/@fs/${fixture}`;
async function visit(page: Page, db: string, suffix = "") { await page.goto(`${url}?db=${db}${suffix}`); await page.waitForFunction(() => Boolean(window.activity)); }
test("real IndexedDB survives reload and isolates owner, campaign and API namespace", async ({ page }) => {
  await visit(page, "activity-reload");
  await page.evaluate(async () => { const h = window.activity; await h.cache.merge(h.scope, { events: [h.event(1)], observation: h.observation(1) }); });
  await page.reload(); await page.waitForFunction(() => Boolean(window.activity));
  const results = await page.evaluate(async () => { const h = window.activity; return Promise.all([h.scope, { ...h.scope, ownerUserId:"33333333-3333-4333-8333-333333333333" }, { ...h.scope, campaignId:"44444444-4444-4444-8444-444444444444" }, { ...h.scope, apiBase:"https://other/api/v1" }].map(scope => h.cache.read(scope))); });
  expect(results[0]!.events).toHaveLength(1); expect(results[0]!.observations).toHaveLength(1);
  expect(results.slice(1).every(snapshot => snapshot.events.length === 0 && snapshot.observations.length === 0)).toBe(true);
});
test("two tabs allocate distinct local sequences atomically and reread invalidations", async ({ context, page }) => {
  const second = await context.newPage();
  await visit(page, "activity-tabs"); await visit(second, "activity-tabs");
  await Promise.all([page, second].map(tab => tab.evaluate(() => window.activity.controller.open(window.activity.scope))));
  await Promise.all([page.evaluate(() => window.activity.controller.recordObservation(window.activity.observation(1))), second.evaluate(() => window.activity.controller.recordObservation(window.activity.observation(2)))]);
  for (const tab of [page, second]) await expect.poll(() => tab.evaluate(() => window.activity.controller.getState().observations.map(entry=>entry.sequence))).toEqual(["2","1"]);
  await page.evaluate(() => window.activity.controller.hidePrevious());
  await expect.poll(() => second.evaluate(() => window.activity.controller.getState().observations.length)).toBe(0);
  await second.evaluate(() => window.activity.controller.recordObservation(window.activity.observation(3)));
  await expect.poll(() => page.evaluate(() => window.activity.controller.getState().observations.map(entry=>entry.sequence))).toEqual(["3"]);
  // An injected channel payload cannot supply a trusted event.
  await second.evaluate(() => new BroadcastChannel("infinite-quest-activity-v1").postMessage({ type:"invalidate", scopeKey:JSON.stringify([window.activity.scope.apiBase, window.activity.scope.ownerUserId, window.activity.scope.campaignId]), events:[{ private:"CANARY" }] }));
  await page.reload(); await page.waitForFunction(() => Boolean(window.activity));
  expect(await page.evaluate(async () => (await window.activity.cache.read(window.activity.scope)).observations.map(entry=>entry.sequence))).toEqual(["3","2","1"]);
  await page.screenshot({ path: "test-results/activity-cache-two-tabs.png" });
});
test("storage denial remains usable in memory with an explicit notice", async ({ page }) => {
  await visit(page, "activity-denied", "&denied");
  await page.evaluate(async () => { const h=window.activity; await h.controller.open(h.scope); await h.controller.recordObservation(h.observation(1)); });
  await expect(page.locator("#state")).toContainText('"storageUnavailable":true');
  expect(await page.evaluate(() => window.activity.controller.getState().observations.length)).toBe(1);
});
test("corrupt stored schema is discarded and failed transaction cannot persist a cursor", async ({ page }) => {
  await visit(page, "activity-corrupt");
  await page.evaluate(async () => {
    const h=window.activity; await h.cache.merge(h.scope, { page:h.page([h.event(1)]), direction:"initial", expectedCursor:null });
    await new Promise<void>((resolve,reject) => { const open=indexedDB.open("activity-corrupt",1); open.onsuccess=()=>{ const db=open.result; const tx=db.transaction("events","readwrite"); tx.objectStore("events").put({scopeKey:JSON.stringify([h.scope.apiBase,h.scope.ownerUserId,h.scope.campaignId]),id:h.event(1).eventId,value:{...h.event(1),raw:"PRIVATE"}});tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(); }; });
  });
  const snapshot = await page.evaluate(() => window.activity.cache.read(window.activity.scope));
  expect(snapshot.events).toEqual([]); expect(snapshot.nextAfter).toBeNull();
  // Abort the real IndexedDB transaction after request dispatch; adapter must fall back atomically.
  await page.evaluate(async () => { const original=IDBDatabase.prototype.transaction; IDBDatabase.prototype.transaction=function(...args: Parameters<typeof original>) { const tx=original.apply(this,args); queueMicrotask(()=>tx.abort()); return tx; }; await window.activity.cache.merge(window.activity.scope, { page:window.activity.page([window.activity.event(2)]), direction:"initial", expectedCursor:null }); IDBDatabase.prototype.transaction=original; });
  const memory = await page.evaluate(() => window.activity.cache.read(window.activity.scope)); expect(memory.events.map(e=>e.sequence)).toEqual(["2"]); expect(memory.nextAfter).toBe("after:2");
  await page.reload(); await page.waitForFunction(() => Boolean(window.activity));
  expect((await page.evaluate(() => window.activity.cache.read(window.activity.scope))).nextAfter).toBeNull();
});

test("quota failure falls back atomically and version change releases the native connection", async ({ page }) => {
  await visit(page,"activity-quota");
  await page.evaluate(async () => { const h=window.activity; await h.cache.read(h.scope); const original=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(){throw new DOMException("full","QuotaExceededError");}; await h.cache.merge(h.scope,{page:h.page([h.event(1)]),direction:"initial",expectedCursor:null});IDBObjectStore.prototype.put=original; });
  expect(await page.evaluate(()=>window.activity.cache.storageUnavailable?.())).toBe(true);
  expect((await page.evaluate(()=>window.activity.cache.read(window.activity.scope))).nextAfter).toBe("after:1");
  await page.reload();await page.waitForFunction(()=>Boolean(window.activity));
  expect((await page.evaluate(()=>window.activity.cache.read(window.activity.scope))).nextAfter).toBeNull();
  await page.evaluate(()=>new Promise<void>((resolve,reject)=>{const request=indexedDB.open("activity-quota",2);request.onsuccess=()=>{request.result.close();resolve();};request.onerror=()=>reject();}));
  expect(await page.evaluate(()=>window.activity.cache.storageUnavailable?.())).toBe(true);
  await page.evaluate(()=>window.activity.cache.merge(window.activity.scope,{observation:window.activity.observation(1)}));
  expect((await page.evaluate(()=>window.activity.cache.read(window.activity.scope))).observations).toHaveLength(1);
});
test("native pruning bounds records and scopes while preserving a scope active in another tab", async ({ context, page }) => {
  await visit(page,"activity-limits");const second=await context.newPage();await visit(second,"activity-limits");
  await page.evaluate(async()=>{const h=window.activity;await h.controller.open(h.scope);await h.cache.merge(h.scope,{events:Array.from({length:1001},(_,i)=>h.event(i+1))});for(let i=1;i<=201;i++)await h.cache.merge(h.scope,{observation:h.observation(i)});});
  await second.evaluate(async()=>{const h=window.activity;for(let i=1;i<=11;i++)await h.cache.merge({...h.scope,apiBase:`https://scope${i}/api/v1`},{events:[h.event(i)]});});
  const snapshot=await page.evaluate(()=>window.activity.cache.read(window.activity.scope));expect(snapshot.events).toHaveLength(1000);expect(snapshot.observations).toHaveLength(200);expect(snapshot.localSequence).toBe("201");
  const counts=await second.evaluate(()=>new Promise<{scopes:number;events:number;observations:number}>((resolve,reject)=>{const request=indexedDB.open("activity-limits",1);request.onsuccess=()=>{const db=request.result;const tx=db.transaction(["scopes","events","observations"]);const scopes=tx.objectStore("scopes").count();const events=tx.objectStore("events").count();const observations=tx.objectStore("observations").count();tx.oncomplete=()=>{db.close();resolve({scopes:scopes.result,events:events.result,observations:observations.result});};tx.onabort=()=>reject();};}));
  expect(counts).toEqual({scopes:10,events:1009,observations:200});
});
