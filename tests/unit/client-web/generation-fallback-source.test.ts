import { describe, expect, it, vi } from "vitest";
import {
  createGenerationWorkflow,
  GenerationWorkflowProtocolError
} from "../../../packages/client-core/src/index.js";
import type {
  AbortSignalLike,
  PendingSubmissionStore,
  StoredGenerationSubmission
} from "../../../packages/client-core/src/index.js";
import type { GenerationApiPort } from "../../../packages/client-core/src/generation/types.js";
import type {
  CampaignSyncStatus,
  GenerationActionResponse,
  GenerationJobSnapshot,
  GenerationResult,
  GenerationStreamSnapshot
} from "../../../packages/contracts/src/index.js";
import { createBrowserGenerationSource } from "../../../packages/client-web/src/generation/fallback-source.js";
import type {
  BrowserGenerationSourceOptions,
  EventSourceFactory,
  EventSourceLike
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

function streamSnapshot(overrides: Partial<GenerationStreamSnapshot> = {}): GenerationStreamSnapshot {
  const full = snapshot(overrides);
  return {
    id: full.id,
    campaignId: full.campaignId,
    expectedTurnNumber: full.expectedTurnNumber,
    status: full.status,
    action: full.action,
    operationKind: full.operationKind,
    replacementTurnId: full.replacementTurnId,
    attempts: full.attempts,
    partialNarration: full.partialNarration,
    errorCode: full.errorCode,
    errorMessage: full.errorMessage,
    resultTurnId: full.resultTurnId
  } as GenerationStreamSnapshot;
}

function signal(initiallyAborted = false): AbortSignalLike & {
  abort(): void;
  listenerCount(): number;
  maximumListenerCount(): number;
} {
  let aborted = initiallyAborted;
  const listeners = new Set<() => void>();
  let maximumListeners = 0;
  return {
    get aborted() { return aborted; },
    addEventListener(_type, listener) {
      listeners.add(listener);
      maximumListeners = Math.max(maximumListeners, listeners.size);
    },
    removeEventListener(_type, listener) { listeners.delete(listener); },
    abort() {
      aborted = true;
      for (const listener of [...listeners]) listener();
    },
    listenerCount() { return listeners.size; },
    maximumListenerCount() { return maximumListeners; }
  };
}

class FakeEventSource implements EventSourceLike {
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  closeCalls = 0;

  close(): void {
    this.closed = true;
    this.closeCalls += 1;
  }

  message(value: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(value) }));
  }

  error(): void {
    this.onerror?.(new Event("error"));
  }
}

function eventSources(): {
  factory: EventSourceFactory;
  sources: FakeEventSource[];
  urls: string[];
} {
  const sources: FakeEventSource[] = [];
  const urls: string[] = [];
  return {
    factory(url) {
      urls.push(url);
      const source = new FakeEventSource();
      sources.push(source);
      return source;
    },
    sources,
    urls
  };
}

function apiQueue(
  sources: FakeEventSource[],
  ...values: Array<GenerationJobSnapshot | Error>
): BrowserGenerationSourceOptions["api"] & { calls: number; openedDuringRead: boolean[] } {
  return {
    calls: 0,
    openedDuringRead: [],
    async get() {
      this.calls += 1;
      this.openedDuringRead.push(sources.some((source) => !source.closed));
      const value = values.shift();
      if (!value) throw new Error("Unexpected polling read.");
      if (value instanceof Error) throw value;
      return value;
    }
  };
}

function options(overrides: Partial<BrowserGenerationSourceOptions> = {}): BrowserGenerationSourceOptions {
  return {
    api: apiQueue([], snapshot({ status: "completed" })),
    basePath: "/api/v1",
    session: { authorization: async () => ({}) },
    clock: { now: () => Date.parse("2026-08-02T00:00:00.000Z") },
    delay: { wait: async () => undefined },
    visibility: { isHidden: () => false, waitUntilVisible: async () => undefined },
    eventSourceFactory: null,
    random: () => 0,
    ...overrides
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe("browser generation fallback source", () => {
  it("rejects an unsafe base path before consulting authorization", () => {
    let authorizationCalls = 0;
    const events = eventSources();
    expect(() => createBrowserGenerationSource(options({
      basePath: "//evil.test/api/v1",
      session: { authorization: async () => {
        authorizationCalls += 1;
        return { authorization: "Bearer secret" };
      } },
      eventSourceFactory: events.factory
    }))).toThrow("Base path must be API-relative");
    expect(authorizationCalls).toBe(0);
    expect(events.sources).toEqual([]);
  });

  it("keeps the validated base path when mutable options are later corrupted", async () => {
    const events = eventSources();
    const sourceOptions = options({ eventSourceFactory: events.factory });
    const source = createBrowserGenerationSource(sourceOptions);
    sourceOptions.basePath = "//evil.test/api/v1";
    const iterator = source.watch(jobId, signal())[Symbol.asyncIterator]();
    const terminal = iterator.next();
    await Promise.resolve();

    expect(events.urls).toEqual(["/api/v1/generation-jobs/22222222-2222-4222-8222-222222222222/stream"]);
    events.sources[0]?.message(streamSnapshot({ status: "completed" }));
    await expect(terminal).resolves.toMatchObject({ done: false, value: { kind: "snapshot" } });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("polls immediately without degradation when EventSource capability is unavailable", async () => {
    const api = apiQueue([], snapshot({ status: "completed" }));
    const source = createBrowserGenerationSource(options({ api, eventSourceFactory: null }));

    await expect(collect(source.watch(jobId, signal()))).resolves.toEqual([
      { kind: "snapshot", snapshot: streamSnapshot({ status: "completed" }) }
    ]);
    expect(api.calls).toBe(1);
  });

  it("uses SSE only with empty authorization and never places credentials in its encoded URL", async () => {
    const events = eventSources();
    const source = createBrowserGenerationSource(options({ eventSourceFactory: events.factory }));
    const iterator = source.watch("job/with?delimiters", signal())[Symbol.asyncIterator]();
    const next = iterator.next();
    await Promise.resolve();

    expect(events.urls).toEqual(["/api/v1/generation-jobs/job%2Fwith%3Fdelimiters/stream"]);
    expect(events.urls[0]).not.toContain("Bearer");
    events.sources[0]?.message(streamSnapshot({ status: "completed" }));
    await expect(next).resolves.toMatchObject({ done: false, value: { kind: "snapshot" } });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("skips EventSource and performs authenticated polling when authorization has any header", async () => {
    const events = eventSources();
    const api = apiQueue(events.sources, snapshot({ status: "completed" }));
    const source = createBrowserGenerationSource(options({
      api,
      eventSourceFactory: events.factory,
      session: { authorization: async () => ({ authorization: "Bearer secret" }) }
    }));

    await collect(source.watch(jobId, signal()));
    expect(events.sources).toEqual([]);
    expect(api.calls).toBe(1);
  });

  it("surfaces authorization failure without opening either transport", async () => {
    const events = eventSources();
    const api = apiQueue(events.sources, snapshot({ status: "completed" }));
    const error = new Error("session unavailable");
    const source = createBrowserGenerationSource(options({
      api,
      eventSourceFactory: events.factory,
      session: { authorization: async () => { throw error; } }
    }));

    await expect(collect(source.watch(jobId, signal()))).rejects.toBe(error);
    expect(events.sources).toEqual([]);
    expect(api.calls).toBe(0);
  });

  it("closes lost SSE before one degradation event and immediate polling reconciliation", async () => {
    const events = eventSources();
    const replacementTurnId = "33333333-3333-4333-8333-333333333333";
    const replacement = snapshot({ operationKind: "replace_latest", replacementTurnId });
    const api = apiQueue(events.sources, replacement, { ...replacement, status: "completed" });
    const source = createBrowserGenerationSource(options({ api, eventSourceFactory: events.factory }));
    const iterator = source.watch(jobId, signal())[Symbol.asyncIterator]();
    const degraded = iterator.next();
    await Promise.resolve();
    events.sources[0]?.error();

    await expect(degraded).resolves.toEqual({
      done: false,
      value: { kind: "degraded", reason: "stream_lost", consecutiveFailures: 1 }
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { kind: "snapshot", snapshot: streamSnapshot({ operationKind: "replace_latest", replacementTurnId }) }
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { kind: "snapshot", snapshot: streamSnapshot({ operationKind: "replace_latest", replacementTurnId, status: "completed" }) }
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(events.sources).toHaveLength(1);
    expect(events.sources[0]?.closeCalls).toBe(1);
    expect(api.openedDuringRead).toEqual([false, false]);
  });

  it("ends on a terminal SSE snapshot without polling", async () => {
    const events = eventSources();
    const api = apiQueue(events.sources, snapshot({ status: "completed" }));
    const source = createBrowserGenerationSource(options({ api, eventSourceFactory: events.factory }));
    const iterator = source.watch(jobId, signal())[Symbol.asyncIterator]();
    const terminal = iterator.next();
    await Promise.resolve();
    events.sources[0]?.message(streamSnapshot({ status: "recoverable" }));

    await expect(terminal).resolves.toMatchObject({ done: false, value: { snapshot: { status: "recoverable" } } });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(api.calls).toBe(0);
  });

  it("does not hide invalid SSE frames behind polling", async () => {
    const events = eventSources();
    const api = apiQueue(events.sources, snapshot({ status: "completed" }));
    const source = createBrowserGenerationSource(options({ api, eventSourceFactory: events.factory }));
    const iterator = source.watch(jobId, signal())[Symbol.asyncIterator]();
    const next = iterator.next();
    await Promise.resolve();
    events.sources[0]?.message({ invalid: true });

    const error = await next.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(GenerationWorkflowProtocolError);
    expect(error).toMatchObject({ kind: "invalid_snapshot" });
    expect(api.calls).toBe(0);
  });

  it("keeps one watch alive through fallback so Task 5 does not report early source end", async () => {
    const events = eventSources();
    const completed = snapshot({ status: "completed" });
    const browserApi = apiQueue(events.sources, completed);
    const source = createBrowserGenerationSource(options({ api: browserApi, eventSourceFactory: events.factory }));
    const pendingStore: PendingSubmissionStore & { value: StoredGenerationSubmission | null } = {
      value: null,
      load() { return this.value; },
      save(_id, value) { this.value = value; },
      clear() { this.value = null; }
    };
    const result = { id: jobId, status: "completed" } as GenerationResult;
    const workflowApi: GenerationApiPort = {
      enqueue: async () => ({ id: jobId, status: "queued", duplicate: false, operationKind: "append", replacementTurnId: null }),
      enqueueReplacement: async () => ({ id: jobId, status: "replacement_queued", duplicate: false, operationKind: "replace_latest", replacementTurnId: "33333333-3333-4333-8333-333333333333" }),
      syncStatus: async () => ({ pendingGeneration: null } as CampaignSyncStatus),
      result: async () => result,
      retry: async () => ({ id: jobId, status: "queued", operationKind: "append", replacementTurnId: null } as GenerationActionResponse),
      cancel: async () => ({ id: jobId, status: "cancelled", operationKind: "append", replacementTurnId: null } as GenerationActionResponse),
      discard: async () => ({ id: jobId, status: "discarded", operationKind: "append", replacementTurnId: null } as GenerationActionResponse)
    };
    const workflow = createGenerationWorkflow({
      api: workflowApi,
      source,
      clock: { now: () => 1_000 },
      pendingSubmissions: pendingStore
    });
    const run = await workflow.submit(campaignId, {
      operationKind: "append",
      expectedTurnNumber: 1,
      request: {
        action: "Open the gate",
        requestedInputMode: "action",
        resolvedInputMode: "action",
        inputModeSource: "explicit",
        idempotencyKey: "submission-key",
        context: { budgetTokens: 32000, compression: "auto", recentTurns: 8 }
      }
    });
    const watched = collect(run.watch(signal()));
    await Promise.resolve();
    events.sources[0]?.error();

    const workflowEvents = await watched;
    expect(workflowEvents).toContainEqual({ type: "degraded", reason: "stream_lost", consecutiveFailures: 1 });
    expect(workflowEvents.at(-1)).toEqual({ type: "settled", outcome: "completed", result });
  });

  it("opens a bounded second browser session on the same signal after Task 5 retries recoverable work", async () => {
    const events = eventSources();
    const browserApi = apiQueue(events.sources);
    const source = createBrowserGenerationSource(options({ api: browserApi, eventSourceFactory: events.factory }));
    const pendingStore: PendingSubmissionStore = {
      load: () => null,
      save: () => undefined,
      clear: () => undefined
    };
    const result = { id: jobId, status: "completed" } as GenerationResult;
    const retry = vi.fn(async () => ({ id: jobId, status: "queued", operationKind: "append", replacementTurnId: null } as GenerationActionResponse));
    const workflow = createGenerationWorkflow({
      api: {
        enqueue: async () => ({ id: jobId, status: "queued", duplicate: false, operationKind: "append", replacementTurnId: null }),
        enqueueReplacement: async () => ({ id: jobId, status: "replacement_queued", duplicate: false, operationKind: "replace_latest", replacementTurnId: "33333333-3333-4333-8333-333333333333" }),
        syncStatus: async () => ({ pendingGeneration: null } as CampaignSyncStatus),
        result: async () => result,
        retry,
        cancel: async () => ({ id: jobId, status: "cancelled", operationKind: "append", replacementTurnId: null } as GenerationActionResponse),
        discard: async () => ({ id: jobId, status: "discarded", operationKind: "append", replacementTurnId: null } as GenerationActionResponse)
      },
      source,
      clock: { now: () => 1_000 },
      pendingSubmissions: pendingStore
    });
    const run = await workflow.submit(campaignId, {
      operationKind: "append",
      expectedTurnNumber: 1,
      request: {
        action: "Open the gate",
        requestedInputMode: "action",
        resolvedInputMode: "action",
        inputModeSource: "explicit",
        idempotencyKey: "retry-session-key",
        context: { budgetTokens: 32000, compression: "auto", recentTurns: 8 }
      }
    });
    const abortSignal = signal();
    const watched = collect(run.watch(abortSignal));
    await vi.waitFor(() => expect(events.sources).toHaveLength(1));
    expect(abortSignal.listenerCount()).toBe(2);

    events.sources[0]?.message(streamSnapshot({ status: "recoverable", attempts: 1 }));
    await vi.waitFor(() => {
      expect(retry).toHaveBeenCalledTimes(1);
      expect(events.sources[0]?.closed).toBe(true);
      expect(events.sources).toHaveLength(2);
    });
    expect(abortSignal.listenerCount()).toBe(2);
    expect(abortSignal.maximumListenerCount()).toBe(2);

    events.sources[1]?.message(streamSnapshot({ status: "queued", attempts: 1 }));
    events.sources[1]?.message(streamSnapshot({ status: "completed", attempts: 1 }));

    const workflowEvents = await watched;
    expect(workflowEvents.at(-1)).toEqual({ type: "settled", outcome: "completed", result });
    expect(events.sources[0]?.closeCalls).toBe(1);
    expect(events.sources[1]?.closeCalls).toBe(1);
    expect(abortSignal.listenerCount()).toBe(0);
    expect(abortSignal.maximumListenerCount()).toBe(2);
  });
});
