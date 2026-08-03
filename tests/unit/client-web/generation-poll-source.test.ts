import { describe, expect, it } from "vitest";
import {
  ApiContractError,
  GenerationWorkflowProtocolError,
  NexusApiError
} from "../../../packages/client-core/src/index.js";
import type {
  AbortSignalLike,
  Clock,
  DelayScheduler
} from "../../../packages/client-core/src/index.js";
import type {
  GenerationJobSnapshot,
  GenerationStreamSnapshot
} from "../../../packages/contracts/src/index.js";
import { createPollSession } from "../../../packages/client-web/src/generation/poll-source.js";
import type {
  PollSessionOptions,
  VisibilitySource
} from "../../../packages/client-web/src/generation/types.js";

const campaignId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";

function snapshot(overrides: Partial<GenerationJobSnapshot> = {}): GenerationJobSnapshot {
  return {
    id: jobId,
    campaignId,
    expectedTurnNumber: 1,
    status: "queued",
    action: "Open the gate",
    requestedInputMode: "action",
    resolvedInputMode: "action",
    inputModeSource: "explicit",
    operationKind: "append",
    replacementTurnId: null,
    attempts: 1,
    partialNarration: null,
    errorCode: null,
    errorMessage: null,
    resultTurnId: null,
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:01.000Z",
    completedAt: null,
    ...overrides
  } as GenerationJobSnapshot;
}

function projected(overrides: Partial<GenerationStreamSnapshot> = {}): GenerationStreamSnapshot {
  return {
    id: jobId,
    campaignId,
    expectedTurnNumber: 1,
    status: "queued",
    action: "Open the gate",
    operationKind: "append",
    replacementTurnId: null,
    attempts: 1,
    partialNarration: null,
    errorCode: null,
    errorMessage: null,
    resultTurnId: null,
    ...overrides
  } as GenerationStreamSnapshot;
}

function signal(initiallyAborted = false): AbortSignalLike & {
  abort(): void;
  listenerCount(): number;
} {
  let aborted = initiallyAborted;
  const listeners = new Set<() => void>();
  return {
    get aborted() { return aborted; },
    addEventListener(_type, listener) { listeners.add(listener); },
    removeEventListener(_type, listener) { listeners.delete(listener); },
    abort() {
      aborted = true;
      for (const listener of [...listeners]) listener();
    },
    listenerCount() { return listeners.size; }
  };
}

function immediateDelay(): DelayScheduler & { waits: number[] } {
  return {
    waits: [],
    async wait(milliseconds) { this.waits.push(milliseconds); }
  };
}

function controlledDelay(): DelayScheduler & {
  waits: Array<{ milliseconds: number; signal: AbortSignalLike; resolve(): void }>;
} {
  return {
    waits: [],
    wait(milliseconds, waitSignal) {
      return new Promise<void>((resolve) => {
        const onAbort = () => {
          waitSignal.removeEventListener("abort", onAbort);
          resolve();
        };
        waitSignal.addEventListener("abort", onAbort, { once: true });
        this.waits.push({
          milliseconds,
          signal: waitSignal,
          resolve() {
            waitSignal.removeEventListener("abort", onAbort);
            resolve();
          }
        });
      });
    }
  };
}

function visibility(hidden = false): VisibilitySource & {
  hidden: boolean;
  waits: number;
  show(): void;
} {
  let resolveVisible: (() => void) | null = null;
  return {
    hidden,
    waits: 0,
    isHidden() { return this.hidden; },
    waitUntilVisible(waitSignal) {
      this.waits += 1;
      if (!this.hidden || waitSignal.aborted) return Promise.resolve();
      return new Promise((resolve) => {
        const onAbort = () => {
          waitSignal.removeEventListener("abort", onAbort);
          resolve();
        };
        waitSignal.addEventListener("abort", onAbort, { once: true });
        resolveVisible = () => {
          waitSignal.removeEventListener("abort", onAbort);
          resolve();
        };
      });
    },
    show() {
      this.hidden = false;
      resolveVisible?.();
      resolveVisible = null;
    }
  };
}

function apiQueue(...values: Array<GenerationJobSnapshot | Error>): {
  get: PollSessionOptions["api"]["get"];
  calls: number;
  active: number;
  maximumActive: number;
  signals: AbortSignal[];
} {
  const state = {
    calls: 0,
    active: 0,
    maximumActive: 0,
    signals: [] as AbortSignal[],
    async get(_requestedJobId: string, requestSignal?: AbortSignal) {
      state.calls += 1;
      state.active += 1;
      state.maximumActive = Math.max(state.maximumActive, state.active);
      if (requestSignal) state.signals.push(requestSignal);
      try {
        const value = values.shift();
        if (!value) throw new Error("Unexpected polling read.");
        if (value instanceof Error) throw value;
        return value;
      } finally {
        state.active -= 1;
      }
    }
  };
  return state;
}

function options(overrides: Partial<PollSessionOptions> = {}): PollSessionOptions {
  return {
    api: apiQueue(snapshot({ status: "completed" })),
    clock: { now: () => Date.parse("2026-08-02T00:00:00.000Z") },
    delay: immediateDelay(),
    visibility: visibility(),
    random: () => 0,
    ...overrides
  };
}

async function collect(optionsValue: PollSessionOptions) {
  const abortSignal = signal();
  const values = [];
  for await (const value of createPollSession(optionsValue, jobId, abortSignal)) values.push(value);
  return values;
}

function httpError(statusCode: number, retryAfter?: string): NexusApiError {
  return new NexusApiError("Polling failed.", {
    statusCode,
    ...(retryAfter === undefined ? {} : { retryAfter })
  });
}

describe("generation polling session", () => {
  it("polls immediately, strips durable timestamps, waits 1500 ms, and never overlaps reads", async () => {
    const api = apiQueue(snapshot(), snapshot({ status: "completed" }));
    const delay = immediateDelay();

    await expect(collect(options({ api, delay }))).resolves.toEqual([
      { kind: "snapshot", snapshot: projected() },
      { kind: "snapshot", snapshot: projected({ status: "completed" }) }
    ]);
    expect(delay.waits).toEqual([1500]);
    expect(api.maximumActive).toBe(1);
    expect(api.signals).toHaveLength(2);
    expect(api.signals.every((item) => item instanceof AbortSignal)).toBe(true);
  });

  it.each([
    [0, [1500, 3000]],
    [0.999999, [1799, 3599]]
  ])("uses deterministic exponential jitter for random %s", async (random, expectedWaits) => {
    const api = apiQueue(new TypeError("offline"), new TypeError("offline"), snapshot({ status: "completed" }));
    const delay = immediateDelay();

    await expect(collect(options({ api, delay, random: () => random }))).resolves.toEqual([
      { kind: "degraded", reason: "poll_failed", consecutiveFailures: 2 },
      { kind: "snapshot", snapshot: projected({ status: "completed" }) }
    ]);
    expect(delay.waits).toEqual(expectedWaits);
  });

  it("caps ordinary backoff at 5000 ms and resets degradation counting after success", async () => {
    const api = apiQueue(
      new TypeError("one"),
      new TypeError("two"),
      snapshot(),
      new TypeError("one-again"),
      new TypeError("two-again"),
      new TypeError("three-again"),
      snapshot({ status: "completed" })
    );
    const delay = immediateDelay();

    const events = await collect(options({ api, delay, random: () => 0.999999 }));

    expect(events).toEqual([
      { kind: "degraded", reason: "poll_failed", consecutiveFailures: 2 },
      { kind: "snapshot", snapshot: projected() },
      { kind: "degraded", reason: "poll_failed", consecutiveFailures: 2 },
      { kind: "degraded", reason: "poll_failed", consecutiveFailures: 3 },
      { kind: "snapshot", snapshot: projected({ status: "completed" }) }
    ]);
    expect(delay.waits).toEqual([1799, 3599, 1500, 1799, 3599, 5000]);
  });

  it.each([Number.NaN, -0.1, 1, Number.POSITIVE_INFINITY])(
    "rejects invalid jitter value %s",
    async (random) => {
      await expect(collect(options({
        api: apiQueue(new TypeError("offline")),
        random: () => random
      }))).rejects.toBeInstanceOf(RangeError);
    }
  );

  it.each([
    ["12", 12_000],
    ["Sun, 02 Aug 2026 00:00:08 GMT", 8_000],
    ["120", 60_000]
  ])("honors and bounds Retry-After %s", async (retryAfter, expectedWait) => {
    const delay = immediateDelay();
    await collect(options({
      api: apiQueue(httpError(429, retryAfter), snapshot({ status: "completed" })),
      delay
    }));
    expect(delay.waits).toEqual([expectedWait]);
  });

  it.each(["nonsense", "0", "Sat, 01 Aug 2026 23:59:59 GMT"])(
    "ignores malformed or past Retry-After %s",
    async (retryAfter) => {
      const delay = immediateDelay();
      await collect(options({
        api: apiQueue(httpError(503, retryAfter), snapshot({ status: "completed" })),
        delay
      }));
      expect(delay.waits).toEqual([1500]);
    }
  );

  it.each([408, 425, 429, 500, 503, 599])("retries transient HTTP %i", async (statusCode) => {
    await expect(collect(options({
      api: apiQueue(httpError(statusCode), snapshot({ status: "completed" }))
    }))).resolves.toEqual([
      { kind: "snapshot", snapshot: projected({ status: "completed" }) }
    ]);
  });

  it.each([400, 401, 403, 404, 409, 422, 600])("rethrows non-retryable HTTP %i", async (statusCode) => {
    const error = httpError(statusCode);
    await expect(collect(options({ api: apiQueue(error) }))).rejects.toBe(error);
  });

  it("rethrows unknown programming errors", async () => {
    const error = new Error("programming error");
    await expect(collect(options({ api: apiQueue(error) }))).rejects.toBe(error);
  });

  it("maps API contract errors and invalid projections to invalid-snapshot protocol errors", async () => {
    const contractError = new ApiContractError("schema mismatch", {
      phase: "response",
      kind: "response_schema_mismatch",
      method: "GET",
      path: "/generation-jobs/job"
    });
    const contractFailure = collect(options({ api: apiQueue(contractError) }));
    const projectionFailure = collect(options({
      api: apiQueue({ ...snapshot(), expectedTurnNumber: 0 } as GenerationJobSnapshot)
    }));

    for (const result of [contractFailure, projectionFailure]) {
      const error = await result.catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(GenerationWorkflowProtocolError);
      expect(error).toMatchObject({ kind: "invalid_snapshot" });
    }
  });

  it("rethrows an existing workflow protocol error unchanged", async () => {
    const error = new GenerationWorkflowProtocolError("invalid_snapshot");
    await expect(collect(options({ api: apiQueue(error) }))).rejects.toBe(error);
  });

  it("ends without reading when already aborted and removes every request bridge listener", async () => {
    const abortSignal = signal(true);
    const api = apiQueue(snapshot());
    const iterator = createPollSession(options({ api }), jobId, abortSignal);

    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(api.calls).toBe(0);
    expect(abortSignal.listenerCount()).toBe(0);
  });

  it("removes the parent abort listener when returned before iteration starts", async () => {
    const abortSignal = signal();
    const api = apiQueue(snapshot());
    const iterator = createPollSession(options({ api }), jobId, abortSignal);

    expect(abortSignal.listenerCount()).toBe(0);
    await expect(iterator.return(undefined)).resolves.toEqual({ done: true, value: undefined });
    expect(abortSignal.listenerCount()).toBe(0);
    expect(api.calls).toBe(0);
  });

  it("ends without degradation when aborted during a pending request", async () => {
    const abortSignal = signal();
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    const api = {
      get: async (_id: string, requestSignal?: AbortSignal) => {
        requestStarted();
        return new Promise<GenerationJobSnapshot>((_resolve, reject) => {
          requestSignal?.addEventListener("abort", () => reject(new TypeError("aborted")), { once: true });
        });
      }
    };
    const iterator = createPollSession(options({ api }), jobId, abortSignal);
    const next = iterator.next();
    await started;
    abortSignal.abort();

    await expect(next).resolves.toEqual({ done: true, value: undefined });
    expect(abortSignal.listenerCount()).toBe(0);
  });

  it("ends promptly when aborted during a cadence delay", async () => {
    const abortSignal = signal();
    const delay = controlledDelay();
    const api = apiQueue(snapshot(), snapshot({ status: "completed" }));
    const iterator = createPollSession(options({ api, delay }), jobId, abortSignal);

    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    const next = iterator.next();
    await Promise.resolve();
    expect(delay.waits[0]?.milliseconds).toBe(1500);
    abortSignal.abort();

    await expect(next).resolves.toEqual({ done: true, value: undefined });
    expect(api.calls).toBe(1);
    expect(abortSignal.listenerCount()).toBe(0);
  });

  it("aborts a pending cadence wait when the consumer returns the iterator", async () => {
    const abortSignal = signal();
    const delay = controlledDelay();
    const api = apiQueue(snapshot(), snapshot({ status: "completed" }));
    const iterator = createPollSession(options({ api, delay }), jobId, abortSignal);

    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    const pendingRead = iterator.next();
    await Promise.resolve();
    const returned = iterator.return(undefined);
    await Promise.resolve();

    expect(delay.waits[0]?.signal.aborted).toBe(true);
    await expect(pendingRead).resolves.toEqual({ done: true, value: undefined });
    await expect(returned).resolves.toEqual({ done: true, value: undefined });
    expect(abortSignal.listenerCount()).toBe(0);
    expect(api.calls).toBe(1);
  });

  it("uses a 5000 ms hidden minimum and polls immediately when visibility returns", async () => {
    const abortSignal = signal();
    const delay = controlledDelay();
    const pageVisibility = visibility(true);
    const api = apiQueue(snapshot(), snapshot({ status: "completed" }));
    const iterator = createPollSession(options({ api, delay, visibility: pageVisibility }), jobId, abortSignal);

    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    const terminal = iterator.next();
    await Promise.resolve();
    expect(delay.waits[0]?.milliseconds).toBe(5000);
    expect(pageVisibility.waits).toBe(1);
    pageVisibility.show();

    await expect(terminal).resolves.toEqual({
      done: false,
      value: { kind: "snapshot", snapshot: projected({ status: "completed" }) }
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(delay.waits[0]?.signal.aborted).toBe(true);
    expect(api.maximumActive).toBe(1);
  });

  it("cleans up both hidden delay and visibility waits when the caller aborts", async () => {
    const abortSignal = signal();
    const delay = controlledDelay();
    const pageVisibility = visibility(true);
    const api = apiQueue(snapshot(), snapshot({ status: "completed" }));
    const iterator = createPollSession(options({ api, delay, visibility: pageVisibility }), jobId, abortSignal);

    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    const next = iterator.next();
    await Promise.resolve();
    abortSignal.abort();

    await expect(next).resolves.toEqual({ done: true, value: undefined });
    expect(delay.waits[0]?.signal.aborted).toBe(true);
    expect(abortSignal.listenerCount()).toBe(0);
    expect(api.calls).toBe(1);
  });
});
