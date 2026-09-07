import { describe, expect, it, vi } from "vitest";
import { createAuthoringJobSession } from "../../apps/web-next/src/authoring-job-session.js";
import type { AuthoringJobView } from "../../packages/contracts/src/authoring.js";

const candidate = (title: string) => ({ schemaVersion: 5, world: { title, genre: "fantasy", tone: "bright", premise: "p", backgroundStory: "b", firstAction: "a", rules: "r" }, playableCharacters: [], entities: [], relationships: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], assets: [], defaults: {}, preservedLore: {} });
const job = (revision = 1, result = candidate("Remote")): AuthoringJobView => ({ id: "job-1", revision, status: "awaiting_review", target: { kind: "new_world" }, stages: [], expiresAt: "2026-09-13T00:00:00.000Z", canApply: true, incomplete: false, kind: "world_concept", result });

it("P28-F3 first review selects only current validated generations, even while replacements are pending", async () => {
  const initial: AuthoringJobView = { ...job(), stages: [
    { id: "old-world", key: "world", generation: 1, status: "validated", attemptCount: 1 },
    { id: "current-world", key: "world", generation: 2, status: "validated", attemptCount: 1 },
    { id: "old-child", key: "character:hero", generation: 1, status: "validated", attemptCount: 1 },
    { id: "pending-child", key: "character:hero", generation: 2, status: "queued", attemptCount: 0 }
  ] };
  const saveReview = vi.fn(async (_id, input) => ({ ...initial, revision: 2, reviewedContent: input.content, reviewedStageIds: input.selectedStageIds }));
  const session = createAuthoringJobSession({ job: initial, saveReview });
  try {
    session.edit(candidate("First review")); await session.flush();
    expect(saveReview.mock.calls[0]?.[1].selectedStageIds).toEqual(["current-world"]);
  } finally { session.dispose(); }
});

it("P28-F3 explicit generated-result adoption advances selected generations without adding an unselected sibling", async () => {
  const initial: AuthoringJobView = { ...job(), reviewedContent: candidate("Saved"), reviewedStageIds: ["old-world"], stages: [
    { id: "old-world", key: "world", generation: 1, status: "validated", attemptCount: 1 }
  ] };
  const newer: AuthoringJobView = { ...initial, revision: 2, result: candidate("Regenerated"), stages: [
    ...initial.stages,
    { id: "current-world", key: "world", generation: 2, status: "validated", attemptCount: 1 },
    { id: "unselected-child", key: "character:hero", generation: 1, status: "validated", attemptCount: 1 }
  ] };
  const saveReview = vi.fn(async (_id, input) => ({ ...newer, revision: 3, reviewedContent: input.content, reviewedStageIds: input.selectedStageIds }));
  const session = createAuthoringJobSession({ job: initial, saveReview });
  try {
    session.receive(newer);
    expect(session.currentCandidate()).toEqual(candidate("Saved"));
    expect(session.adoptPendingResult()).toEqual(candidate("Regenerated"));
    session.receive(newer);
    session.receive(newer);
    await session.flush();
    expect(saveReview.mock.calls[0]?.[1].selectedStageIds).toEqual(["current-world"]);
  } finally { session.dispose(); }
});

it.each(["live identical", "resumed identical", "resumed changed"])("P28-F3 fix2 explicit review reconciles %s selected generations independently of pending content", async scenario => {
  vi.useFakeTimers();
  const initial: AuthoringJobView = { ...job(), result: candidate("Generated"), reviewedContent: candidate("Human saved review"), reviewedStageIds: ["old-world"], stages: [
    { id: "old-world", key: "world", generation: 1, status: "validated", attemptCount: 1 }
  ] };
  const replacement: AuthoringJobView = { ...initial, revision: 2, canApply: false, result: candidate(scenario === "resumed changed" ? "Replacement text" : "Generated"), stages: [
    ...initial.stages,
    { id: "current-world", key: "world", generation: 2, status: "validated", attemptCount: 1 },
    { id: "unselected-sibling", key: "character:other", generation: 1, status: "validated", attemptCount: 1 }
  ] };
  const saveReview = vi.fn(async (_id, input) => ({ ...replacement, revision: 3, reviewedContent: input.content, reviewedStageIds: input.selectedStageIds }));
  const session = createAuthoringJobSession({ job: scenario === "live identical" ? initial : replacement, saveReview });
  try {
    session.receive(replacement); session.receive(replacement);
    await vi.advanceTimersByTimeAsync(600);
    expect(session.currentCandidate()).toEqual(candidate("Human saved review"));
    expect(session.hasPendingGeneratedResult()).toBe(false);
    expect(saveReview).not.toHaveBeenCalled();
    expect(session.adoptPendingResult()).toEqual(candidate("Human saved review"));
    session.receive(replacement); session.receive(replacement);
    await vi.advanceTimersByTimeAsync(500);
    expect(saveReview).toHaveBeenCalledOnce();
    expect(saveReview.mock.calls[0]?.[1]).toMatchObject({ content: candidate("Human saved review"), selectedStageIds: ["current-world"] });
    session.edit(candidate("Later human edit")); await session.flush();
    expect(saveReview.mock.calls[1]?.[1]).toMatchObject({ content: candidate("Later human edit"), selectedStageIds: ["current-world"] });
  } finally { session.dispose(); vi.useRealTimers(); }
});

it.each(["older response", "same revision response", "cancelled", "conflict"])("P28-F3 fix3 preserves explicit selection while a historical save is pending: %s", async scenario => {
  vi.useFakeTimers();
  const initial: AuthoringJobView = { ...job(), reviewedContent: candidate("Saved"), reviewedStageIds: ["old-world"], stages: [
    { id: "old-world", key: "world", generation: 1, status: "validated", attemptCount: 1 }
  ] };
  const local = candidate("Human edit");
  const historical: AuthoringJobView = { ...initial, revision: 2, reviewedContent: local };
  const replacement: AuthoringJobView = { ...historical, result: local, revision: scenario === "same revision response" ? 2 : 3, canApply: false, stages: [
    ...initial.stages,
    { id: "current-world", key: "world", generation: 2, status: "validated", attemptCount: 1 },
    { id: "unselected-sibling", key: "character:other", generation: 1, status: "validated", attemptCount: 1 }
  ] };
  let release!: (value: AuthoringJobView) => void;
  const pending = new Promise<AuthoringJobView>(resolve => { release = resolve; });
  const saveReview = vi.fn(async (_id, input) => saveReview.mock.calls.length === 1 ? pending : ({ ...replacement, revision: 4, canApply: true, reviewedContent: input.content, reviewedStageIds: input.selectedStageIds }));
  const session = createAuthoringJobSession({ job: initial, saveReview });
  try {
    session.edit(local); await vi.advanceTimersByTimeAsync(500);
    expect(saveReview.mock.calls[0]?.[1]).toMatchObject({ content: local, selectedStageIds: ["old-world"] });
    session.receive(replacement); session.receive(replacement);
    expect(session.adoptPendingResult()).toEqual(local);
    session.receive(replacement); session.receive(replacement);
    await vi.advanceTimersByTimeAsync(600);
    expect(saveReview).toHaveBeenCalledOnce();
    if (scenario === "cancelled") session.receive({ ...replacement, revision: 5, status: "cancelled" });
    if (scenario === "conflict") session.receive({ ...replacement, revision: 5, reviewedContent: candidate("Other tab") });
    release(scenario === "same revision response" ? replacement : historical); await vi.advanceTimersByTimeAsync(1500);
    if (scenario === "cancelled" || scenario === "conflict") {
      expect(saveReview).toHaveBeenCalledOnce();
      expect(session.state()).toMatchObject(scenario === "cancelled" ? { job: { status: "cancelled" } } : { saveState: "conflict" });
      await expect(session.flush()).rejects.toThrow("Review is not saved");
    } else {
      expect(saveReview).toHaveBeenCalledTimes(2);
      expect(saveReview.mock.calls[1]?.[1]).toEqual({ expectedRevision: replacement.revision, content: local, selectedStageIds: ["current-world"] });
      expect(session.state()).toMatchObject({ localDirty: false, saveState: "saved", job: { canApply: true, reviewedStageIds: ["current-world"] } });
      await session.flush();
      expect(session.currentCandidate()).toEqual(local);
    }
  } finally { session.dispose(); vi.useRealTimers(); }
});

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

it("P28 reuses the exact saved selection after a regenerated sibling stage", async () => {
  const initial = {
    ...job(),
    reviewedContent: candidate("Saved"),
    reviewedStageIds: ["stage"],
    stages: [{ id: "stage", key: "world", generation: 1, status: "validated" as const, attemptCount: 1 }]
  };
  const regenerated = {
    ...initial,
    revision: 2,
    stages: [
      ...initial.stages,
      { id: "replacement", key: initial.stages[0]!.key, generation: 2, status: "validated" as const, attemptCount: 1 }
    ]
  };
  const saveReview = vi.fn(async (_id, input) => ({ ...regenerated, revision: 3, reviewedContent: input.content, reviewedStageIds: input.selectedStageIds }));
  const session = createAuthoringJobSession({ job: initial, saveReview });
  session.receive(regenerated); session.edit(candidate("Edited")); await session.flush();
  expect(saveReview).toHaveBeenCalledWith("job-1", expect.objectContaining({ selectedStageIds: ["stage"] }), expect.any(AbortSignal));
  session.dispose();
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
