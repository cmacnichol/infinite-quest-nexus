import { describe, expect, it } from "vitest";
import type { CampaignSyncStatus, GenerationActionResponse, GenerationEnqueueResponse, GenerationResult, GenerationStreamSnapshot } from "../../../packages/contracts/src/index.js";
import { createGenerationWorkflow, GenerationWorkflowProtocolError } from "../../../packages/client-core/src/index.js";
import type { AbortSignalLike, PendingSubmissionStore } from "../../../packages/client-core/src/ports.js";
import type {
  GenerationApiPort,
  GenerationSnapshotSource,
  GenerationSourceEvent,
  StoredGenerationSubmission
} from "../../../packages/client-core/src/generation/types.js";

const campaignId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const otherJobId = "33333333-3333-4333-8333-333333333333";

function snapshot(overrides: Partial<GenerationStreamSnapshot> = {}): GenerationStreamSnapshot {
  return {
    id: jobId,
    campaignId,
    expectedTurnNumber: 1,
    status: "queued",
    action: "Open the gate",
    operationKind: "append",
    attempts: 1,
    partialNarration: null,
    errorCode: null,
    errorMessage: null,
    resultTurnId: null,
    ...overrides
  };
}

function submission() {
  return {
    operationKind: "append" as const,
    expectedTurnNumber: 1,
    request: {
      action: "Open the gate",
      requestedInputMode: "action" as const,
      resolvedInputMode: "action" as const,
      inputModeSource: "explicit" as const,
      idempotencyKey: "submission-key",
      context: { budgetTokens: 32000, compression: "auto" as const, recentTurns: 8 }
    }
  };
}

function enqueueResponse(id = jobId, status: GenerationEnqueueResponse["status"] = "queued"): GenerationEnqueueResponse {
  return { id, status, duplicate: false };
}

function actionResponse(status: GenerationActionResponse["status"], id = jobId): GenerationActionResponse {
  return { id, status };
}

function completedResult(): GenerationResult {
  return { id: jobId, status: "completed" } as GenerationResult;
}

function sync(pendingId: string | null = null): CampaignSyncStatus {
  return { pendingGeneration: pendingId ? { id: pendingId } : null } as CampaignSyncStatus;
}

function store(initial: StoredGenerationSubmission | null = null): PendingSubmissionStore & { value: StoredGenerationSubmission | null } {
  return {
    value: initial,
    load() { return this.value; },
    save(_campaignId, value) { this.value = value; },
    clear() { this.value = null; }
  };
}

function signal(initiallyAborted = false): AbortSignalLike & { abort(): void } {
  let aborted = initiallyAborted;
  const listeners = new Set<() => void>();
  return {
    get aborted() { return aborted; },
    addEventListener(_type, listener) { listeners.add(listener); },
    removeEventListener(_type, listener) { listeners.delete(listener); },
    abort() {
      aborted = true;
      for (const listener of listeners) listener();
    }
  };
}

function sourceFromSessions(sessions: GenerationSourceEvent[][]): GenerationSnapshotSource & { calls: number } {
  return {
    calls: 0,
    async *watch() {
      const session = sessions[this.calls++] ?? [];
      for (const event of session) yield event;
    }
  };
}

function api(overrides: Partial<GenerationApiPort> = {}): GenerationApiPort & { retries: number } {
  return {
    retries: 0,
    enqueue: async () => enqueueResponse(),
    enqueueReplacement: async () => enqueueResponse(),
    syncStatus: async () => sync(),
    result: async () => completedResult(),
    retry: async () => actionResponse("queued"),
    cancel: async () => actionResponse("cancelled"),
    discard: async () => actionResponse("discarded"),
    ...overrides
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe("generation workflow", () => {
  it("exports a submit handle without starting browser work and resumes an ambiguous server-pending job", async () => {
    const pending = store();
    const source = sourceFromSessions([]);
    const client = api({ syncStatus: async () => sync(otherJobId) });
    const workflow = createGenerationWorkflow({ api: client, source, clock: { now: () => 1_000 }, pendingSubmissions: pending });

    const run = await workflow.submit(campaignId, submission());
    expect(run.jobId).toBe(jobId);
    expect(source.calls).toBe(0);

    const resumed = await workflow.resume(campaignId);
    expect(resumed?.jobId).toBe(otherJobId);
    expect(pending.value).toBeNull();
  });

  it("prefers authoritative recovery over a saved submission without replaying its key", async () => {
    const pending = store({ ...submission(), createdAt: 1_000 });
    const replayedKeys: string[] = [];
    const client = api({
      enqueue: async (_campaignId, request) => {
        replayedKeys.push(request.idempotencyKey);
        return enqueueResponse(otherJobId);
      },
      syncStatus: async () => ({
        pendingGeneration: null,
        generationRecovery: {
          id: otherJobId,
          status: "recoverable",
          operationKind: "append",
          expectedTurnNumber: 1,
          attempts: 1,
          errorCode: "provider_unavailable",
          errorMessage: "Try again.",
          resultTurnId: null
        }
      } as CampaignSyncStatus)
    });
    const workflow = createGenerationWorkflow({ api: client, source: sourceFromSessions([]), clock: { now: () => 1_000 }, pendingSubmissions: pending });

    const resumed = await workflow.resume(campaignId);

    expect(resumed?.jobId).toBe(otherJobId);
    expect(replayedKeys).toEqual([]);
    expect(pending.value).toBeNull();
  });

  it("resumes an authoritative completed recovery outside the returned turn window", async () => {
    const pending = store();
    const resultIds: string[] = [];
    const client = api({
      syncStatus: async () => ({
        pendingGeneration: null,
        turns: { turns: [], nextCursor: null },
        generationRecovery: {
          id: otherJobId,
          status: "completed",
          operationKind: "append",
          expectedTurnNumber: 51,
          attempts: 1,
          errorCode: null,
          errorMessage: null,
          resultTurnId: "44444444-4444-4444-8444-444444444444"
        }
      } as unknown as CampaignSyncStatus),
      result: async (id) => {
        resultIds.push(id);
        return { ...completedResult(), id: otherJobId };
      }
    });
    const workflow = createGenerationWorkflow({ api: client, source: sourceFromSessions([]), clock: { now: () => 1_000 }, pendingSubmissions: pending });

    const resumed = await workflow.resume(campaignId);

    expect(resumed?.jobId).toBe(otherJobId);
    await resumed?.fetchResult();
    expect(resultIds).toEqual([otherJobId]);
  });

  it("auto-retries once through a fresh source session and then settles with the fetched result", async () => {
    const source = sourceFromSessions([
      [{ kind: "snapshot", snapshot: snapshot({ status: "recoverable", attempts: 1 }) }],
      [
        { kind: "snapshot", snapshot: snapshot({ status: "queued", attempts: 1 }) },
        { kind: "snapshot", snapshot: snapshot({ status: "assessing", attempts: 2 }) },
        { kind: "snapshot", snapshot: snapshot({ status: "completed", attempts: 2 }) }
      ]
    ]);
    const client = api({ retry: async () => { client.retries += 1; return actionResponse("queued"); } });
    const workflow = createGenerationWorkflow({ api: client, source, clock: { now: () => 1_000 }, pendingSubmissions: store() });
    const run = await workflow.submit(campaignId, submission());

    const events = await collect(run.watch(signal()));

    expect(client.retries).toBe(1);
    expect(source.calls).toBe(2);
    expect(events.at(-1)).toEqual({ type: "settled", outcome: "completed", result: completedResult() });
  });

  it("does not auto-retry a recovered job after a prior attempt has already advanced", async () => {
    const pending = store({ ...submission(), createdAt: 1_000, jobId });
    const client = api({ syncStatus: async () => sync() });
    const source = sourceFromSessions([[{ kind: "snapshot", snapshot: snapshot({ status: "recoverable", attempts: 2 }) }]]);
    const workflow = createGenerationWorkflow({ api: client, source, clock: { now: () => 1_000 }, pendingSubmissions: pending });
    const run = await workflow.resume(campaignId);

    const events = await collect(run!.watch(signal()));

    expect(client.retries).toBe(0);
    expect(events.at(-1)).toMatchObject({ type: "settled", outcome: "unrecoverable" });
    expect(pending.value?.jobId).toBe(jobId);
  });

  it("detaches on consumer abort and routes explicit cancellation and discard only to their matching remote actions", async () => {
    const client = api();
    const workflow = createGenerationWorkflow({ api: client, source: sourceFromSessions([]), clock: { now: () => 1_000 }, pendingSubmissions: store() });
    const run = await workflow.submit(campaignId, submission());

    await expect(collect(run.watch(signal(true)))).resolves.toEqual([{ type: "detached", jobId }]);
    await expect(run.cancelGeneration()).resolves.toEqual(actionResponse("cancelled"));
    await expect(run.discardGeneration()).resolves.toEqual(actionResponse("discarded"));
  });

  it("closes a stalled source iterator and detaches immediately when the consumer aborts", async () => {
    let close: (() => void) | undefined;
    let closed = false;
    const source: GenerationSnapshotSource = {
      watch() {
        let calls = 0;
        const iterator: AsyncIterableIterator<GenerationSourceEvent> = {
          async next() {
            calls += 1;
            if (calls === 1) return { done: false, value: { kind: "snapshot" as const, snapshot: snapshot() } };
            return new Promise<IteratorResult<GenerationSourceEvent>>((resolve) => { close = () => resolve({ done: true, value: undefined }); });
          },
          async return() {
            closed = true;
            close?.();
            return { done: true, value: undefined };
          },
          [Symbol.asyncIterator]() { return iterator; }
        };
        return iterator;
      }
    };
    const workflow = createGenerationWorkflow({ api: api(), source, clock: { now: () => 1_000 }, pendingSubmissions: store() });
    const run = await workflow.submit(campaignId, submission());
    const consumerSignal = signal();
    const iterator = run.watch(consumerSignal)[Symbol.asyncIterator]();
    await iterator.next();
    const detached = iterator.next();

    consumerSignal.abort();
    expect(await Promise.race([
      detached,
      new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 20))
    ])).toEqual({ done: false, value: { type: "detached", jobId } });
    expect(closed).toBe(true);
  });

  it("reports a completed-result fetch failure without relabeling the durable job and recovers it after reload", async () => {
    const pending = store();
    let shouldFail = true;
    const client = api({
      result: async () => {
        if (shouldFail) throw new Error("temporary result outage");
        return completedResult();
      },
      syncStatus: async () => sync()
    });
    const workflow = createGenerationWorkflow({
      api: client,
      source: sourceFromSessions([[{ kind: "snapshot", snapshot: snapshot({ status: "completed" }) }]]),
      clock: { now: () => 1_000 },
      pendingSubmissions: pending
    });
    const run = await workflow.submit(campaignId, submission());

    await expect(collect(run.watch(signal()))).resolves.toMatchObject([{ type: "status" }, { type: "result_unavailable", jobId }]);
    expect(pending.value?.jobId).toBe(jobId);
    shouldFail = false;
    const resumed = await workflow.resume(campaignId);
    await expect(resumed!.fetchResult()).resolves.toEqual({ type: "settled", outcome: "completed", result: completedResult() });
    expect(pending.value).toBeNull();
  });

  it("forwards degraded transport health and strips full-snapshot timestamps before status events", async () => {
    const fullSnapshot = { ...snapshot({ status: "failed" }), updatedAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" };
    const workflow = createGenerationWorkflow({
      api: api(),
      source: sourceFromSessions([[{ kind: "degraded", reason: "stream_lost", consecutiveFailures: 2 }, { kind: "snapshot", snapshot: fullSnapshot as GenerationStreamSnapshot }]]),
      clock: { now: () => 1_000 },
      pendingSubmissions: store()
    });
    const run = await workflow.submit(campaignId, submission());

    const events = await collect(run.watch(signal()));

    expect(events[0]).toEqual({ type: "degraded", reason: "stream_lost", consecutiveFailures: 2 });
    expect(events[1]).toMatchObject({ type: "status", snapshot: { status: "failed" } });
    expect("updatedAt" in (events[1] as { snapshot: object }).snapshot).toBe(false);
  });

  it("fails protocol-safe on malformed snapshots or a non-terminal source completion", async () => {
    const malformed = createGenerationWorkflow({
      api: api(),
      source: sourceFromSessions([[{ kind: "snapshot", snapshot: { ...snapshot(), status: "not-a-status" } as unknown as GenerationStreamSnapshot }]]),
      clock: { now: () => 1_000 },
      pendingSubmissions: store()
    });
    const malformedRun = await malformed.submit(campaignId, submission());
    await expect(collect(malformedRun.watch(signal()))).rejects.toMatchObject({ kind: "invalid_snapshot" } satisfies Partial<GenerationWorkflowProtocolError>);

    const early = createGenerationWorkflow({ api: api(), source: sourceFromSessions([[{ kind: "snapshot", snapshot: snapshot() }]]), clock: { now: () => 1_000 }, pendingSubmissions: store() });
    const earlyRun = await early.submit(campaignId, submission());
    await expect(collect(earlyRun.watch(signal()))).rejects.toMatchObject({ kind: "source_ended_before_terminal" } satisfies Partial<GenerationWorkflowProtocolError>);
  });

  it("rejects a second concurrent watcher for the same durable job", async () => {
    let release: (() => void) | undefined;
    const source: GenerationSnapshotSource = {
      async *watch() {
        await new Promise<void>((resolve) => { release = resolve; });
        yield { kind: "snapshot", snapshot: snapshot({ status: "cancelled" }) };
      }
    };
    const workflow = createGenerationWorkflow({ api: api(), source, clock: { now: () => 1_000 }, pendingSubmissions: store() });
    const run = await workflow.submit(campaignId, submission());
    const first = run.watch(signal())[Symbol.asyncIterator]();
    const firstNext = first.next();

    await expect(run.watch(signal())[Symbol.asyncIterator]().next()).rejects.toMatchObject({ kind: "watch_already_active" } satisfies Partial<GenerationWorkflowProtocolError>);
    release!();
    await firstNext;
  });

  it("closes each source session before retry restart and terminal settlement", async () => {
    const closeCounts = [0, 0];
    const sessions: GenerationSourceEvent[][] = [
      [{ kind: "snapshot", snapshot: snapshot({ status: "recoverable", attempts: 1 }) }],
      [{ kind: "snapshot", snapshot: snapshot({ status: "completed", attempts: 2 }) }]
    ];
    let sessionIndex = 0;
    const source: GenerationSnapshotSource = {
      watch() {
        const currentIndex = sessionIndex++;
        const events = sessions[currentIndex]!;
        let index = 0;
        const iterator: AsyncIterableIterator<GenerationSourceEvent> = {
          async next() {
            const event = events[index++];
            if (event) return { done: false, value: event };
            return new Promise<IteratorResult<GenerationSourceEvent>>(() => undefined);
          },
          async return() {
            closeCounts[currentIndex] = (closeCounts[currentIndex] ?? 0) + 1;
            return { done: true, value: undefined };
          },
          [Symbol.asyncIterator]() { return iterator; }
        };
        return iterator;
      }
    };
    const workflow = createGenerationWorkflow({ api: api(), source, clock: { now: () => 1_000 }, pendingSubmissions: store() });
    const run = await workflow.submit(campaignId, submission());

    await collect(run.watch(signal()));

    expect(closeCounts).toEqual([1, 1]);
  });

  it("emits unrecoverable for a manual retry transport failure but preserves retry protocol mismatches", async () => {
    const manual = createGenerationWorkflow({
      api: api({ retry: async () => { throw new Error("retry transport failed"); } }),
      source: sourceFromSessions([]),
      clock: { now: () => 1_000 },
      pendingSubmissions: store()
    });
    const manualRun = await manual.submit(campaignId, submission());
    await expect(collect(manualRun.retryGeneration(signal()))).resolves.toMatchObject([
      { type: "settled", outcome: "unrecoverable" }
    ]);

    const mismatch = createGenerationWorkflow({
      api: api({ retry: async () => actionResponse("queued", otherJobId) }),
      source: sourceFromSessions([[{ kind: "snapshot", snapshot: snapshot({ status: "recoverable", attempts: 1 }) }]]),
      clock: { now: () => 1_000 },
      pendingSubmissions: store()
    });
    const mismatchRun = await mismatch.submit(campaignId, submission());
    await expect(collect(mismatchRun.watch(signal()))).rejects.toMatchObject({ kind: "action_response_mismatch" } satisfies Partial<GenerationWorkflowProtocolError>);
  });

  it("buffers active watcher cancel and discard terminal frames until their commands validate", async () => {
    for (const [operation, terminalStatus] of [["cancel", "cancelled"], ["discard", "discarded"]] as const) {
      let resolveCommand: ((response: GenerationActionResponse) => void) | undefined;
      const commandResponse = new Promise<GenerationActionResponse>((resolve) => { resolveCommand = resolve; });
      const pending = store();
      const client = api({
        cancel: async () => operation === "cancel" ? commandResponse : actionResponse("cancelled"),
        discard: async () => operation === "discard" ? commandResponse : actionResponse("discarded")
      });
      const workflow = createGenerationWorkflow({
        api: client,
        source: sourceFromSessions([[
          { kind: "snapshot", snapshot: snapshot({ status: "failed" }) },
          { kind: "snapshot", snapshot: snapshot({ status: terminalStatus }) }
        ]]),
        clock: { now: () => 1_000 },
        pendingSubmissions: pending
      });
      const run = await workflow.submit(campaignId, submission());
      const iterator = run.watch(signal())[Symbol.asyncIterator]();
      await iterator.next();
      const command = operation === "cancel" ? run.cancelGeneration() : run.discardGeneration();
      const terminal = iterator.next();
      let terminalResolved = false;
      void terminal.then(() => { terminalResolved = true; });

      await Promise.resolve();
      await Promise.resolve();
      expect(terminalResolved).toBe(false);

      resolveCommand!(actionResponse(terminalStatus));
      await expect(command).resolves.toEqual(actionResponse(terminalStatus));
      await expect(terminal).resolves.toMatchObject({ value: { type: "status", snapshot: { status: terminalStatus } } });
      await expect(iterator.next()).resolves.toMatchObject({ value: { type: "settled", outcome: terminalStatus } });
      expect(pending.value).toBeNull();
    }
  });

  it("settles the authoritative failed terminal once when a pending cancel command outlives the source", async () => {
    let resolveCancel: ((response: GenerationActionResponse) => void) | undefined;
    const cancelResponse = new Promise<GenerationActionResponse>((resolve) => { resolveCancel = resolve; });
    const pending = store();
    const workflow = createGenerationWorkflow({
      api: api({ cancel: async () => cancelResponse }),
      source: sourceFromSessions([[
        { kind: "snapshot", snapshot: snapshot({ status: "failed" }) }
      ]]),
      clock: { now: () => 1_000 },
      pendingSubmissions: pending
    });
    const run = await workflow.submit(campaignId, submission());
    const iterator = run.watch(signal())[Symbol.asyncIterator]();

    await iterator.next();
    const command = run.cancelGeneration();

    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "settled", outcome: "failed" } });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    expect(pending.value?.jobId).toBe(jobId);

    resolveCancel!(actionResponse("cancelled"));
    await expect(command).resolves.toEqual(actionResponse("cancelled"));
    expect(pending.value?.jobId).toBe(jobId);
  });

  it("replays an ambiguous saved submission with the original key and attaches to the duplicate durable job", async () => {
    const pending = store({ ...submission(), createdAt: 1_000 });
    const replayedKeys: string[] = [];
    const workflow = createGenerationWorkflow({
      api: api({
        enqueue: async (_campaignId, request) => {
          replayedKeys.push(request.idempotencyKey);
          return { ...enqueueResponse(otherJobId), duplicate: true };
        },
        syncStatus: async () => sync()
      }),
      source: sourceFromSessions([]),
      clock: { now: () => 1_000 },
      pendingSubmissions: pending
    });

    const resumed = await workflow.resume(campaignId);

    expect(replayedKeys).toEqual(["submission-key"]);
    expect(resumed?.jobId).toBe(otherJobId);
    expect(pending.value?.jobId).toBe(otherJobId);
  });

  it("rejects a mismatched terminal command response without clearing durable recovery", async () => {
    const pending = store();
    const workflow = createGenerationWorkflow({
      api: api({ cancel: async () => actionResponse("cancelled", otherJobId) }),
      source: sourceFromSessions([]),
      clock: { now: () => 1_000 },
      pendingSubmissions: pending
    });
    const run = await workflow.submit(campaignId, submission());

    await expect(run.cancelGeneration()).rejects.toMatchObject({ kind: "action_response_mismatch" } satisfies Partial<GenerationWorkflowProtocolError>);
    expect(pending.value?.jobId).toBe(jobId);
  });
});
