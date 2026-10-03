import { describe, expect, it, vi } from "vitest";
import type { ActivityControllerDependencies } from "../../packages/client-core/src/activity/types.js";
import { createActivityController } from "../../packages/client-core/src/activity/controller.js";
import { createMemoryActivityCache } from "../../packages/client-core/src/activity/cache.js";
import { event, observation, page, scope, now } from "../fixtures/activity-client.js";
function setup(list = vi.fn<(_id: string, query: ActivityPageQuery) => Promise<ActivityPage>>(async () => page([event(1)])), overrides: Partial<ActivityControllerDependencies> = {}) {
  const cache = createMemoryActivityCache({ now: () => now, isoAt: (value) => new Date(value).toISOString() });
  const verifyAccess = vi.fn(async () => true);
  const controller = createActivityController({ api: { list }, cache, verifyAccess, clock: { now: () => now, isoAt: (value) => new Date(value).toISOString() }, createAbortController: () => new AbortController(), scheduler: { wait: (_ms, signal) => new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })) }, visibility: { current: () => true, subscribe: () => () => {} }, connectivity: { current: () => true, subscribe: () => () => {} }, notifyTabs: { publish: () => {}, subscribe: () => () => {} }, random: () => 0.5, ...overrides });
  let state: ReturnType<typeof controller.getState>;
  controller.subscribe(value => { state = value; });
  return { controller, cache, verifyAccess, list, state: () => state! };
}
describe("activity controller", () => {
  it("verifies access before reading cache and clears denied scope", async () => {
    const f = setup(); await f.cache.merge(scope, { events: [event(1)] });
    f.verifyAccess.mockResolvedValue(false);
    await f.controller.open(scope);
    expect(f.state().scope).toBeNull(); expect(f.state().events).toEqual([]); expect(f.list).not.toHaveBeenCalled(); f.controller.dispose();
  });
  it("drains 205 publications using delivered cursor independently of older cursor", async () => {
    const list = vi.fn(async (_id, query) => query.after === "after:100" ? page(Array.from({length:100},(_,i)=>event(i+101)),true,"205") : query.after === "after:200" ? page(Array.from({length:5},(_,i)=>event(i+201)),false,"205") : page(Array.from({length:100},(_,i)=>event(i+1)),true,"205"));
    const f = setup(list); await f.controller.open(scope); await f.controller.refresh();
    expect(f.state().events).toHaveLength(205); expect(f.state().snapshot.nextAfter).toBe("after:205"); expect(f.state().snapshot.nextBefore).toBe("before:1"); f.controller.dispose();
  });
  it("suppresses late scope responses and disposal", async () => {
    let finish!: (v: ReturnType<typeof page>) => void;
    const f = setup(vi.fn(() => new Promise(resolve => { finish = resolve; })));
    const first = f.controller.open(scope); await new Promise(resolve => setTimeout(resolve,0));
    f.controller.close(); finish(page([event(1)])); await first;
    expect(f.state().events).toEqual([]); expect(f.state().scope).toBeNull(); f.controller.dispose();
  });
  it("keeps hide reversible with future publications visible", async () => {
    const f = setup(); await f.controller.open(scope); await f.controller.recordObservation(observation(1)); await f.controller.hidePrevious();
    expect(f.state().events).toEqual([]); expect(f.state().observations).toEqual([]);
    f.list.mockResolvedValue(page([event(2)])); await f.controller.refresh();
    expect(f.state().events.map(e=>e.sequence)).toEqual(["2"]); await f.controller.showPrevious(); expect(f.state().events).toHaveLength(2); f.controller.dispose();
  });
});


import type { ActivityPage, ActivityPageQuery } from "@infinite-quest/contracts";


describe("activity synchronization edge cases", () => {
  it("serializes overlapping refresh and older reads without rewinding live cursor", async () => {
    const f=setup(); f.list.mockResolvedValue(page([event(1)],true)); await f.controller.open(scope);
    f.list.mockImplementation(async (_id,query) => query.before ? page([event(0)],false,"2") : page([event(2)]));
    await Promise.all([f.controller.refresh(),f.controller.refresh(),f.controller.loadOlder()]);
    expect(f.state().snapshot.nextAfter).toBe("after:2"); expect(f.state().events.map(e=>e.sequence)).toEqual(["2","1","0"]); f.controller.dispose();
  });
  it.each([401,403])("clears selected scope immediately for status %s", async status => {
    const f=setup(); await f.controller.open(scope); f.list.mockRejectedValue({statusCode:status}); await f.controller.refresh();
    expect(f.state().scope).toBeNull(); expect(f.state().events).toEqual([]); f.controller.dispose();
  });
  it("revalidates access on route404 and never opens a deleted campaign cache", async () => {
    const f=setup(); await f.controller.open(scope); f.list.mockRejectedValue({statusCode:404}); f.verifyAccess.mockResolvedValue(false);
    await f.controller.refresh(); expect(f.state().scope).toBeNull(); expect(f.state().unsupported).toBe(false); f.controller.dispose();
  });
  it("uses unsupported fallback only after independent current access succeeds", async () => {
    const f=setup(); f.list.mockRejectedValue({statusCode:404}); await f.controller.open(scope);
    expect(f.state().unsupported).toBe(true); expect(f.state().scope).toEqual(scope); await f.controller.recordObservation(observation(1)); expect(f.state().observations).toHaveLength(1); f.controller.dispose();
  });
  it("malformed responses are delayed, never unsupported or terminal generation facts", async () => {
    const f=setup(); f.list.mockResolvedValue({ raw:"PRIVATE" } as never); await f.controller.open(scope);
    expect(f.state().delayed).toBe(true); expect(f.state().unsupported).toBe(false); expect(f.state().events).toEqual([]); expect(f.state().observations).toEqual([]); f.controller.dispose();
  });
  it.each(["retention","restore"] as const)("resets %s coverage and retains local observations", async reason => {
    const f=setup(); f.list.mockResolvedValue(page([event(10)])); await f.controller.open(scope); await f.controller.recordObservation(observation(1)); await f.controller.hidePrevious();
    let calls=0; f.list.mockImplementation(async () => ++calls === 1 ? { ...page([],false, reason === "restore" ? "2" : "10"), coverage:{...page([],false,reason === "restore" ? "2" : "10").coverage,resetRequired:reason==="retention"} } : page([event(2)]));
    await f.controller.refresh();
    expect(f.state().gap).toBe(reason); expect(f.state().snapshot.observations).toHaveLength(1); expect(f.state().events.map(e=>e.sequence)).toEqual(["2"]); expect(f.state().snapshot.nextAfter).toBe("after:2"); f.controller.dispose();
  });
  it("older pages remain visible beyond the 1000-entry cap", async () => {
    const f=setup(); await f.cache.merge(scope,{events:Array.from({length:1000},(_,i)=>event(i+101)),page:page([event(1100)],true),direction:"initial",expectedCursor:null});
    f.list.mockResolvedValue({...page([],false,"1100"),nextAfter:"after:1100"}); await f.controller.open(scope);
    f.list.mockResolvedValue(page(Array.from({length:100},(_,i)=>event(i+1)),false,"1100")); await f.controller.loadOlder();
    expect(f.state().events.some(e=>e.sequence==="1")).toBe(true); expect(f.state().events).toHaveLength(1000); expect(f.state().snapshot.nextAfter).toBe("after:1100"); f.controller.dispose();
  });
});



it("yields after ten incremental pages and resumes from the last delivered cursor", async () => {
  const waits: {ms:number; signal:{readonly aborted:boolean}; done:()=>void}[]=[];
  const f=setup(undefined,{scheduler:{wait:(ms,signal)=>new Promise(resolve=>{waits.push({ms,signal,done:resolve});signal.addEventListener("abort",()=>resolve(),{once:true});})}});
  await f.controller.open(scope);
  let delivered=1;
  f.list.mockImplementation(async (_id,query)=>{ expect(query.after).toBe(`after:${delivered}`); delivered++; return page([event(delivered)],delivered<12,"12"); });
  await f.controller.refresh(); expect(f.state().snapshot.nextAfter).toBe("after:11"); expect(waits.at(-1)?.ms).toBe(0);
  waits.at(-1)!.done(); await new Promise(resolve=>setTimeout(resolve,0));
  expect(f.state().snapshot.nextAfter).toBe("after:12"); expect(waits.at(-1)?.ms).toBe(30000); f.controller.dispose();
});
it("backs off at 5/10/20/30 seconds without recursive failure observations and resumes cadence", async () => {
  const waits:number[]=[];
  const f=setup(undefined,{scheduler:{wait:(ms,signal)=>{waits.push(ms);return new Promise(resolve=>signal.addEventListener("abort",()=>resolve(),{once:true}));}}});
  f.list.mockRejectedValue({statusCode:500}); await f.controller.open(scope);
  await f.controller.refresh(); await f.controller.refresh(); await f.controller.refresh();
  expect(waits).toEqual([5000,10000,20000,30000]); expect(f.state().observations).toEqual([]);
  f.list.mockResolvedValue(page([event(1)])); await f.controller.refresh(); expect(waits.at(-1)).toBe(30000);
  f.controller.setDialogOpen(true); await f.controller.refresh(); expect(waits.at(-1)).toBe(5000); f.controller.dispose();
});
it("pauses hidden/offline and refreshes on visibility, online and terminal signals", async () => {
  let visible=true,online=true; let visibilityChanged=()=>{};let connectivityChanged=()=>{};
  const f=setup(undefined,{visibility:{current:()=>visible,subscribe:listener=>{visibilityChanged=listener;return()=>{};}},connectivity:{current:()=>online,subscribe:listener=>{connectivityChanged=listener;return()=>{};}}});
  await f.controller.open(scope); visible=false; visibilityChanged(); f.list.mockResolvedValue(page([event(2)])); await f.controller.refresh(); expect(f.state().events).toHaveLength(1);
  visible=true; visibilityChanged(); await f.controller.refresh(); expect(f.state().events).toHaveLength(2);
  online=false; connectivityChanged(); f.list.mockResolvedValue(page([event(3)])); await f.controller.refresh(); expect(f.state().events).toHaveLength(2);
  online=true; connectivityChanged(); await f.controller.refresh(); expect(f.state().events).toHaveLength(3);
  f.controller.setJobActive(true); await f.controller.refresh(); f.list.mockResolvedValue(page([event(4)]));f.controller.setJobActive(false);await f.controller.refresh();expect(f.state().events).toHaveLength(4); f.controller.dispose();
});
it("a delayed owner-A verification cannot activate its cache after owner-B opens", async () => {
  let finish!:(value:boolean)=>void;
  const f=setup(); f.verifyAccess.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const first=f.controller.open(scope);
  await f.controller.open({...scope,ownerUserId:"33333333-3333-4333-8333-333333333333"}); finish(true); await first;
  expect(f.state().scope?.ownerUserId).toBe("33333333-3333-4333-8333-333333333333"); f.controller.dispose();
});

it("an injected cache failure preserves hidden view and local sequence in the memory fallback", async () => {
  const f=setup(); await f.controller.open(scope);await f.controller.recordObservation(observation(1));await f.controller.hidePrevious();
  f.cache.merge=async()=>{throw new Error("storage");};
  await f.controller.recordObservation(observation(2));
  expect(f.state().events).toEqual([]);expect(f.state().observations.map(entry=>entry.sequence)).toEqual(["2"]);expect(f.state().storageUnavailable).toBe(true);f.controller.dispose();
});
