import { describe, expect, it } from "vitest";
import { createMemoryActivityCache } from "../../packages/client-core/src/activity/cache.js";
import { event, observation, scope, now, page } from "../fixtures/activity-client.js";

describe("activity cache", () => {
  it("deduplicates immutable events, isolates namespaces and commits cursors with records", async () => {
    const cache = createMemoryActivityCache({ now: () => now, isoAt: (value) => new Date(value).toISOString() });
    await cache.merge(scope, { page: page([event(2), event(1)]), direction: "initial", expectedCursor: null, syncedAt: now });
    await cache.merge(scope, { page: page([event(2), event(3)]), direction: "after", expectedCursor: "after:2", syncedAt: now });
    const snapshot = await cache.read(scope);
    expect(snapshot.events.map(e => e.sequence)).toEqual(["3", "2", "1"]);
    expect(snapshot.nextAfter).toBe("after:3");
    expect(snapshot.nextBefore).toBe("before:1");
    expect((await cache.read({ ...scope, apiBase: "https://other/api/v1" })).events).toEqual([]);
    expect((await cache.read({ ...scope, ownerUserId: "33333333-3333-4333-8333-333333333333" })).events).toEqual([]);
  });
  it("prunes 1001 events and 201 observations and expires at seven days", async () => {
    let time = now;
    const cache = createMemoryActivityCache({ now: () => time, isoAt: (value) => new Date(value).toISOString() });
    await cache.merge(scope, { events: Array.from({length:1001}, (_,i)=>event(i+1)) });
    for (let i = 1; i <= 201; i++) await cache.merge(scope, { observation: observation(i) });
    const snapshot = await cache.read(scope);
    expect(snapshot.events).toHaveLength(1000); expect(snapshot.events.at(-1)?.sequence).toBe("2");
    expect(snapshot.observations).toHaveLength(200); expect(snapshot.localSequence).toBe("201");
    time += 7 * 86400000;
    expect((await cache.read(scope)).observations).toHaveLength(0);
  });
  it("rejects unsafe records without advancing cursor and bounds scopes to ten", async () => {
    const cache = createMemoryActivityCache({ now: () => now, isoAt: (value) => new Date(value).toISOString() });
    await expect(cache.merge(scope, { page: page([{ ...event(1), raw: "PRIVATE" } as never]), direction: "initial", expectedCursor: null, syncedAt: now })).rejects.toThrow();
    expect((await cache.read(scope)).nextAfter).toBeNull();
    for (let i = 1; i <= 11; i++) await cache.merge({ ...scope, apiBase: `https://api${i}/api/v1` }, { events: [event(i)] });
    expect((await cache.read({ ...scope, apiBase: "https://api1/api/v1" })).events).toEqual([]);
  });
  it("hides only observed server/local sequences and restores without deletion", async () => {
    const cache = createMemoryActivityCache({ now: () => now, isoAt: (value) => new Date(value).toISOString() });
    await cache.merge(scope, { events: [event(1)], observation: observation(1) });
    await cache.setHiddenThrough(scope, { server: "1", browser: "1" });
    await cache.merge(scope, { events: [event(2)], observation: observation(2) });
    expect((await cache.read(scope)).hiddenThrough).toEqual({ server: "1", browser: "1" });
    await cache.setHiddenThrough(scope, null);
    expect((await cache.read(scope)).events).toHaveLength(2);
  });
});


it("protects an active scope while pruning the least recently used inactive scope", async () => {
  const cache = createMemoryActivityCache({now:()=>now,isoAt:value=>new Date(value).toISOString()});
  await cache.merge(scope,{events:[event(1)]}); await cache.setActive!(scope,true);
  for(let i=1;i<=11;i++) await cache.merge({...scope,apiBase:`https://active${i}/api/v1`},{events:[event(i)]});
  expect((await cache.read(scope)).events).toHaveLength(1);
  expect((await cache.read({...scope,apiBase:"https://active1/api/v1"})).events).toHaveLength(0);
});


it("blocked IndexedDB open degrades without hanging or losing local observations", async () => {
  const { createIndexedDbActivityCache } = await import("../../packages/client-web/src/activity/indexeddb-cache.js");
  const request = { onblocked: null as (()=>void)|null };
  const factory = { open: () => { queueMicrotask(()=>request.onblocked?.()); return request; } } as unknown as IDBFactory;
  const cache=createIndexedDbActivityCache({indexedDB:factory,clock:{now:()=>now,isoAt:value=>new Date(value).toISOString()}});
  await cache.merge(scope,{observation:observation(1)});
  expect(cache.storageUnavailable?.()).toBe(true);expect((await cache.read(scope)).observations).toHaveLength(1);cache.dispose?.();
});
it("failed persistence keeps records and cursor together in memory without exposing private observation fields", async () => {
  const { createIndexedDbActivityCache } = await import("../../packages/client-web/src/activity/indexeddb-cache.js");
  const cache=createIndexedDbActivityCache({indexedDB:null,clock:{now:()=>now,isoAt:value=>new Date(value).toISOString()}});
  await cache.merge(scope,{page:page([event(1)]),direction:"initial",expectedCursor:null});
  await expect(cache.merge(scope,{observation:{...observation(1),message:"PRIVATE"} as never})).rejects.toThrow();
  const snapshot=await cache.read(scope);expect(snapshot.events).toHaveLength(1);expect(snapshot.nextAfter).toBe("after:1");expect(snapshot.observations).toEqual([]);cache.dispose?.();
});
it("stale cross-tab page cannot rewind a live cursor or hide watermark", async () => {
  const cache=createMemoryActivityCache({now:()=>now,isoAt:value=>new Date(value).toISOString()});
  await cache.merge(scope,{page:page([event(1)]),direction:"initial",expectedCursor:null});
  await cache.merge(scope,{page:page([event(2)]),direction:"after",expectedCursor:"after:1"});
  await cache.setHiddenThrough(scope,{server:"2",browser:"0"});
  await cache.merge(scope,{page:page([event(1)]),direction:"after",expectedCursor:"after:1"});
  const snapshot=await cache.read(scope);expect(snapshot.nextAfter).toBe("after:2");expect(snapshot.hiddenThrough).toEqual({server:"2",browser:"0"});
});
it("live eviction leaves an older-page route back to records evicted by the cache cap", async () => {
  const cache=createMemoryActivityCache({now:()=>now,isoAt:value=>new Date(value).toISOString()});
  await cache.merge(scope,{events:Array.from({length:1000},(_,i)=>event(i+1)),page:page([event(1000)]),direction:"initial",expectedCursor:null});
  await cache.merge(scope,{page:page([event(1001)]),direction:"after",expectedCursor:"after:1000"});
  const snapshot=await cache.read(scope);expect(snapshot.hasOlder).toBe(true);expect(snapshot.nextBefore).toBe("before:1001");expect(snapshot.nextAfter).toBe("after:1001");
});
it("expires seven-day-old observations even when their timestamp omits fractional seconds", async () => {
  let time=now;const cache=createMemoryActivityCache({now:()=>time,isoAt:value=>new Date(value).toISOString()});
  await cache.merge(scope,{observation:{...observation(1),observedAt:new Date(now).toISOString().replace(".000Z","Z")}});
  time+=7*86400000;expect((await cache.read(scope)).observations).toEqual([]);
});

it("replacing a browsing window preserves observations and hide watermarks atomically", async () => {
  const cache = createMemoryActivityCache({ now: () => now, isoAt: value => new Date(value).toISOString() });
  await cache.merge(scope, { events: Array.from({ length: 1000 }, (_, i) => event(i + 101)), page: page([event(1100)], true), direction: "initial", expectedCursor: null, observation: observation(1) });
  await cache.setHiddenThrough(scope, { server: "500", browser: "0" });
  await cache.merge(scope, { page: page([event(1)], false, "1100"), direction: "before", expectedCursor: "before:1100" });
  await cache.merge(scope, { page: page([event(1100)], true), direction: "initial", expectedCursor: "after:1100", replaceWindow: true });
  const snapshot = await cache.read(scope);
  expect(snapshot.events.map(entry => entry.sequence)).toEqual(["1100"]);
  expect(snapshot).toMatchObject({ browsingOlder: false, hiddenThrough: { server: "500", browser: "0" }, localSequence: "1", hasOlder: true });
  expect(snapshot.observations).toHaveLength(1);
});
