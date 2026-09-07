import { describe, expect, it, vi } from "vitest";
import { createAuthoringJobSession } from "../../apps/web-next/src/authoring-job-session.js";
import type { AuthoringJobView } from "../../packages/contracts/src/authoring.js";

const candidate = (title: string) => ({ schemaVersion: 5, world: { title, genre: "fantasy", tone: "bright", premise: "p", backgroundStory: "b", firstAction: "a", rules: "r" }, playableCharacters: [], entities: [], relationships: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], assets: [], defaults: {}, preservedLore: {} });
const job = (revision = 1, result = candidate("Remote")): AuthoringJobView => ({ id: "job-1", revision, status: "awaiting_review", target: { kind: "new_world" }, stages: [], expiresAt: "2026-09-13T00:00:00.000Z", canApply: true, incomplete: false, kind: "world_concept", result });

describe("authoring job session", () => {
  it("keeps a local edit when a completed remote result arrives", () => {
    const session = createAuthoringJobSession({ job: job() });
    const local = candidate("Local");
    session.edit(local);
    session.receive(job(2));

    expect(session.currentCandidate()).toEqual(local);
    expect(session.hasPendingGeneratedResult()).toBe(true);
  });

  it("autosaves the current review after 500ms and keeps a conflict local", async () => {
    vi.useFakeTimers();
    const saveReview = vi.fn(async () => { throw Object.assign(new Error("conflict"), { status: 409 }); });
    const session = createAuthoringJobSession({ job: job(), saveReview, setTimeout, clearTimeout });
    const local = candidate("Local");
    session.edit(local);
    await vi.advanceTimersByTimeAsync(500);

    expect(saveReview).toHaveBeenCalledWith("job-1", expect.objectContaining({ expectedRevision: 1, content: local }), expect.any(AbortSignal));
    expect(session.currentCandidate()).toEqual(local);
    expect(session.state().saveState).toBe("conflict");
    vi.useRealTimers();
  });

  it("ignores stale poll results and stops work when disposed", async () => {
    vi.useFakeTimers();
    const loadAuthoringJob = vi.fn(async () => job(1));
    const session = createAuthoringJobSession({ job: job(2), loadAuthoringJob, setTimeout, clearTimeout });
    session.startPolling();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.state().observedRevision).toBe(2);
    session.dispose();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(loadAuthoringJob).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("does not let polling cancel or discard a delayed review save", async () => {
    let resolveSave!: (value: AuthoringJobView) => void;
    const saveReview = vi.fn(() => new Promise<AuthoringJobView>((resolve) => { resolveSave = resolve; }));
    const session = createAuthoringJobSession({ job: job(), saveReview, loadAuthoringJob: async () => job(2), setTimeout, clearTimeout });
    session.edit(candidate("Local"));
    session.startPolling();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await new Promise((resolve) => setTimeout(resolve, 500));
    resolveSave({ ...job(3), reviewedContent: candidate("Local") });
    await Promise.resolve();

    expect(session.state().observedRevision).toBe(3);
    expect(session.state().localDirty).toBe(false);
    session.dispose();
  });

  it("freezes autosave after a conflict until the user explicitly reloads", async () => {
    vi.useFakeTimers();
    const saveReview = vi.fn(async () => { throw Object.assign(new Error("conflict"), { status: 409 }); });
    const session = createAuthoringJobSession({ job: job(), saveReview, loadAuthoringJob: async () => job(2), setTimeout, clearTimeout });
    session.edit(candidate("First"));
    await vi.advanceTimersByTimeAsync(500);
    session.edit(candidate("Second"));
    session.receive(job(2));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(saveReview).toHaveBeenCalledTimes(1);
    expect(session.state().observedRevision).toBe(1);
    await session.reload();
    expect(session.state().observedRevision).toBe(2);
    vi.useRealTimers();
  });

  it("keeps a newly completed generated result pending when an older review exists", () => {
    const oldReview = candidate("Reviewed");
    const session = createAuthoringJobSession({ job: { ...job(1, candidate("Initial")), reviewedContent: oldReview } });
    session.edit(candidate("Local"));
    session.receive({ ...job(2, candidate("New result")), reviewedContent: oldReview });

    expect(session.currentCandidate()).toEqual(candidate("Local"));
    expect(session.hasPendingGeneratedResult()).toBe(true);
    expect(session.state().remoteCandidate).toEqual(candidate("New result"));
  });

  it("does not keep polling a failed job", async () => {
    vi.useFakeTimers();
    const loadAuthoringJob = vi.fn(async () => ({ ...job(2), status: "failed" as const }));
    const session = createAuthoringJobSession({ job: job(), loadAuthoringJob, setTimeout, clearTimeout });
    session.startPolling();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(loadAuthoringJob).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("retains the reviewed buffer across an unchanged poll that includes the older result", () => {
    const reviewed = candidate("Reviewed");
    const initial = { ...job(1, candidate("Generated")), reviewedContent: reviewed };
    const session = createAuthoringJobSession({ job: initial });
    session.receive(initial);
    expect(session.currentCandidate()).toEqual(reviewed);
    expect(session.hasPendingGeneratedResult()).toBe(false);
  });

  it("keeps a saved review active and presents a later result as pending", () => {
    const reviewed = candidate("Reviewed");
    const session = createAuthoringJobSession({ job: { ...job(1, candidate("Generated")), reviewedContent: reviewed } });
    session.receive({ ...job(2, candidate("Later")), reviewedContent: reviewed });
    expect(session.currentCandidate()).toEqual(reviewed);
    expect(session.state().remoteCandidate).toEqual(candidate("Later"));
  });

  it("updates terminal status during a frozen conflict without replacing the local buffer", () => {
    const session = createAuthoringJobSession({ job: job(), saveReview: async () => { throw Object.assign(new Error("conflict"), { status: 409 }); }, setTimeout, clearTimeout });
    const local = candidate("Local");
    session.edit(local);
    // Freeze the controller through the public asynchronous save path.
    return new Promise<void>((resolve) => setTimeout(resolve, 500)).then(() => Promise.resolve()).then(() => {
      session.receive({ ...job(2), status: "cancelled" });
      expect(session.state().job.status).toBe("cancelled");
      expect(session.currentCandidate()).toEqual(local);
    });
  });
});

it("explicit reload replaces the conflicted local review and clears dirty state", async () => {
  const session = createAuthoringJobSession({ job: job(), loadAuthoringJob: async () => ({ ...job(3), reviewedContent: candidate("Other tab") }) });
  session.edit(candidate("Local"));
  await session.reload();
  expect(session.currentCandidate()).toEqual(candidate("Other tab"));
  expect(session.state().localDirty).toBe(false);
  session.dispose();
});

it("a delayed save cannot regress a newer poll revision", async () => {
  vi.useFakeTimers();
  let resolve!: (value: AuthoringJobView) => void;
  const session = createAuthoringJobSession({ job: job(), saveReview: () => new Promise(done => { resolve = done; }) });
  session.edit(candidate("Local"));
  await vi.advanceTimersByTimeAsync(500);
  session.receive(job(4, candidate("Later")));
  resolve({ ...job(2), reviewedContent: candidate("Local") });
  await Promise.resolve();
  expect(session.state().observedRevision).toBe(4);
  session.dispose(); vi.useRealTimers();
});

it("reload cannot replace an edit made while its request is in flight", async () => {
  let resolve!: (value: AuthoringJobView) => void;
  const session = createAuthoringJobSession({ job: job(), loadAuthoringJob: () => new Promise(done => { resolve = done; }) });
  const reload = session.reload();
  session.edit(candidate("Typed during reload"));
  resolve(job(2)); await reload;
  expect(session.currentCandidate()).toEqual(candidate("Typed during reload"));
  expect(session.hasPendingGeneratedResult()).toBe(true);
  session.dispose();
});

it("pauses hidden-page network reads and bounds retry backoff at five seconds", async () => {
  vi.useFakeTimers(); let hidden = true; const calls: number[] = [];
  const session = createAuthoringJobSession({ job: job(), isHidden: () => hidden, loadAuthoringJob: async () => { calls.push(Date.now()); throw new Error("offline"); } });
  session.startPolling(); await vi.advanceTimersByTimeAsync(5000); expect(calls).toHaveLength(0);
  hidden = false; await vi.advanceTimersByTimeAsync(13000);
  expect(calls.slice(1).map((time, index) => time - calls[index]!)).toEqual([2000, 4000, 5000]);
  session.dispose(); vi.useRealTimers();
});

it("retry and cancel own one pending command and disposal aborts its request", async () => {
  let resolve!: (value: AuthoringJobView) => void; let signal: AbortSignal | undefined;
  const retry = vi.fn((_id: string, _input: unknown, passedSignal?: AbortSignal) => { signal = passedSignal; return new Promise<AuthoringJobView>(done => { resolve = done; }); });
  const cancel = vi.fn(async () => ({ ...job(2), status: "cancelled" as const }));
  const session = createAuthoringJobSession({ job: job(), retryStage: retry, cancel });
  const first = session.retry("stage"); await session.retry("stage"); await session.cancel();
  expect(retry).toHaveBeenCalledTimes(1); expect(cancel).not.toHaveBeenCalled(); expect(session.state().commandPending).toBe(true);
  session.dispose(); expect(signal?.aborted).toBe(true); resolve(job(2)); await first; expect(session.state().observedRevision).toBe(1);
});

it("an expired response stops polling and any pending review save", async () => {
  vi.useFakeTimers(); const saveReview = vi.fn(async () => job(3)); const loadAuthoringJob = vi.fn(async () => job(3));
  const session = createAuthoringJobSession({ job: job(), saveReview, loadAuthoringJob });
  session.edit(candidate("Local")); session.startPolling(); session.receive({ ...job(2), status: "expired" });
  await vi.advanceTimersByTimeAsync(10000);
  expect(saveReview).not.toHaveBeenCalled(); expect(loadAuthoringJob).not.toHaveBeenCalled(); expect(session.currentCandidate()).toEqual(candidate("Local")); session.dispose(); vi.useRealTimers();
});

it("serializes review saves while edits arrive during an in-flight save", async () => {
  vi.useFakeTimers(); let resolve!: (value: AuthoringJobView) => void;
  const saveReview = vi.fn(() => new Promise<AuthoringJobView>(done => { resolve = done; }));
  const session = createAuthoringJobSession({ job: job(), saveReview });
  session.edit(candidate("First")); await vi.advanceTimersByTimeAsync(500);
  session.edit(candidate("Second")); await vi.advanceTimersByTimeAsync(1000);
  expect(saveReview).toHaveBeenCalledTimes(1);
  resolve({ ...job(2), reviewedContent: candidate("First") }); await Promise.resolve();
  await vi.advanceTimersByTimeAsync(500);
  expect(saveReview).toHaveBeenLastCalledWith("job-1", expect.objectContaining({ expectedRevision: 2, content: candidate("Second") }), expect.any(AbortSignal));
  session.dispose(); vi.useRealTimers();
});

it("flush waits for the current saved review before a parent handoff", async () => {
  const saveReview = vi.fn(async (_id, input) => ({ ...job(2), reviewedContent: input.content }));
  const session = createAuthoringJobSession({ job: job(), saveReview });
  session.edit(candidate("For parent"));
  expect(typeof session.flush).toBe("function");
  await session.flush();
  expect(session.state().localDirty).toBe(false); expect(session.currentCandidate()).toEqual(candidate("For parent")); expect(saveReview).toHaveBeenCalledTimes(1); session.dispose();
});

it("does not advance review CAS past an unseen edit from another tab", async () => {
  vi.useFakeTimers(); const saveReview = vi.fn(async () => job(4));
  const initial = { ...job(1), reviewedContent: candidate("My saved review") };
  const session = createAuthoringJobSession({ job: initial, saveReview });
  session.receive({ ...job(2), reviewedContent: candidate("Other tab changed a field") });
  expect(session.currentCandidate()).toEqual(candidate("My saved review"));
  expect(session.state().saveState).toBe("conflict");
  session.edit(candidate("My next edit")); await vi.advanceTimersByTimeAsync(500);
  expect(saveReview).not.toHaveBeenCalled(); session.dispose(); vi.useRealTimers();
});

it("recognizes its own in-flight saved review while preserving a newer typed edit", async () => {
  vi.useFakeTimers(); let resolve!: (value: AuthoringJobView) => void;
  const session = createAuthoringJobSession({ job: job(), saveReview: () => new Promise(done => { resolve = done; }) });
  session.edit(candidate("First")); await vi.advanceTimersByTimeAsync(500); session.edit(candidate("Second"));
  session.receive({ ...job(2), reviewedContent: candidate("First") });
  expect(session.state().saveState).not.toBe("conflict"); expect(session.currentCandidate()).toEqual(candidate("Second"));
  resolve({ ...job(2), reviewedContent: candidate("First") }); await Promise.resolve(); session.dispose(); vi.useRealTimers();
});

it("marks a discarded or expired proposal unavailable on 404 and stops stale work", async () => {
  vi.useFakeTimers(); const load = vi.fn(async () => { throw Object.assign(new Error("not found"), { status: 404 }); });
  const session = createAuthoringJobSession({ job: job(), loadAuthoringJob: load });
  session.startPolling(); await vi.advanceTimersByTimeAsync(10000);
  expect(load).toHaveBeenCalledTimes(1); expect(session.state().unavailable).toBe(true);
  session.receive(job(3)); expect(session.state().unavailable).toBe(true); session.dispose(); vi.useRealTimers();
});

it("P27-F1 keeps generated content pending across two identical polls until adoption", () => {
  const initial = { ...job(), reviewedContent: candidate("Saved review") };
  const session = createAuthoringJobSession({ job: initial });
  const later = { ...initial, revision: 2, result: candidate("Later generated") };
  session.receive(later); session.receive(later); session.receive(later);
  expect(session.hasPendingGeneratedResult()).toBe(true);
  expect(session.currentCandidate()).toEqual(candidate("Saved review"));
  expect(session.adoptPendingResult()).toEqual(candidate("Later generated"));
  expect(session.hasPendingGeneratedResult()).toBe(false);
  session.dispose();
});

it("P27-F3 a successful old save cannot conceal a later observed review conflict", async () => {
  let resolve!: (value: AuthoringJobView) => void;
  const session = createAuthoringJobSession({ job: job(), saveReview: () => new Promise(done => { resolve = done; }) });
  session.edit(candidate("Local")); const pending = session.flush();
  session.receive({ ...job(3), reviewedContent: candidate("Other tab") });
  expect(session.state().saveState).toBe("conflict");
  resolve({ ...job(2), reviewedContent: candidate("Local") });
  await expect(pending).rejects.toThrow("Review is not saved");
  session.receive({ ...job(3), reviewedContent: candidate("Other tab") });
  expect(session.state().saveState).toBe("conflict");
  expect(session.currentCandidate()).toEqual(candidate("Local"));
  expect(session.state().remoteCandidate).toEqual(candidate("Other tab"));
  expect(session.state().observedRevision).toBe(3);
  session.dispose();
});
