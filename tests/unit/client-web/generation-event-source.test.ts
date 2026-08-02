import { describe, expect, it } from "vitest";
import { GenerationWorkflowProtocolError } from "../../../packages/client-core/src/index.js";
import type { AbortSignalLike } from "../../../packages/client-core/src/ports.js";
import type { GenerationStreamSnapshot } from "../../../packages/contracts/src/index.js";
import {
  createEventSourceSession,
  generationStreamUrl
} from "../../../packages/client-web/src/generation/event-source.js";
import type {
  EventSourceFactory,
  EventSourceLike
} from "../../../packages/client-web/src/generation/types.js";

const campaignId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";

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

class FakeEventSource implements EventSourceLike {
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closeCalls = 0;

  close(): void {
    this.closeCalls += 1;
  }

  message(value: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(value) }));
  }

  rawMessage(value: string): void {
    this.onmessage?.(new MessageEvent("message", { data: value }));
  }

  error(): void {
    this.onerror?.(new Event("error"));
  }
}

function factory(): {
  create: EventSourceFactory;
  sources: FakeEventSource[];
  urls: string[];
} {
  const sources: FakeEventSource[] = [];
  const urls: string[] = [];
  return {
    create(url) {
      urls.push(url);
      const source = new FakeEventSource();
      sources.push(source);
      return source;
    },
    sources,
    urls
  };
}

async function openedSession(initiallyAborted = false) {
  const abortSignal = signal(initiallyAborted);
  const eventSources = factory();
  const iterator = createEventSourceSession({
    url: "/api/v1/generation-jobs/job/stream",
    signal: abortSignal,
    eventSourceFactory: eventSources.create
  });
  const first = iterator.next();
  await Promise.resolve();
  return { abortSignal, eventSources, first, iterator };
}

describe("generation EventSource session", () => {
  it.each([
    "https://evil.test/api/v1",
    "//evil.test/api/v1",
    "api/v1",
    "/\\evil.test/api/v1",
    "/\t/evil.test/api/v1",
    "/api/v1/..",
    "/api/v1/%2e%2e"
  ])("rejects unsafe base path %s before constructing a stream URL", (basePath) => {
    expect(() => generationStreamUrl(basePath, jobId)).toThrow("Base path must be API-relative");
  });

  it("constructs a guarded API-relative stream URL with an encoded job ID", () => {
    expect(generationStreamUrl("/api/v1///", "job/with?delimiters"))
      .toBe("/api/v1/generation-jobs/job%2Fwith%3Fdelimiters/stream");
  });

  it("yields progressive snapshots and reports clean non-terminal closure as stream loss", async () => {
    const opened = await openedSession();
    opened.eventSources.sources[0]?.message(snapshot({ status: "generating", partialNarration: "The gate" }));

    await expect(opened.first).resolves.toEqual({
      done: false,
      value: { kind: "snapshot", snapshot: snapshot({ status: "generating", partialNarration: "The gate" }) }
    });

    const closed = opened.iterator.next();
    opened.eventSources.sources[0]?.error();
    await expect(closed).resolves.toEqual({ done: true, value: "stream_lost" });
    expect(opened.eventSources.sources[0]?.closeCalls).toBe(1);
    expect(opened.abortSignal.listenerCount()).toBe(0);
  });

  it.each(["completed", "failed", "discarded", "cancelled", "recoverable"] as const)(
    "treats %s as terminal and ignores a later error callback",
    async (status) => {
      const opened = await openedSession();
      opened.eventSources.sources[0]?.message(snapshot({ status }));
      opened.eventSources.sources[0]?.error();

      await expect(opened.first).resolves.toEqual({
        done: false,
        value: { kind: "snapshot", snapshot: snapshot({ status }) }
      });
      await expect(opened.iterator.next()).resolves.toEqual({ done: true, value: "terminal" });
      expect(opened.eventSources.sources[0]?.closeCalls).toBe(1);
      expect(opened.abortSignal.listenerCount()).toBe(0);
    }
  );

  it.each([
    ["malformed JSON", "{"],
    ["schema drift", JSON.stringify({ ...snapshot(), expectedTurnNumber: 0 })]
  ])("maps %s to the core invalid-snapshot protocol error", async (_label, data) => {
    const opened = await openedSession();
    opened.eventSources.sources[0]?.rawMessage(data);

    const error = await opened.first.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(GenerationWorkflowProtocolError);
    expect(error).toMatchObject({ kind: "invalid_snapshot" });
    expect(opened.eventSources.sources[0]?.closeCalls).toBe(1);
    expect(opened.abortSignal.listenerCount()).toBe(0);
  });

  it("does not construct EventSource for an already-aborted signal", async () => {
    const opened = await openedSession(true);

    await expect(opened.first).resolves.toEqual({ done: true, value: "aborted" });
    expect(opened.eventSources.sources).toEqual([]);
    expect(opened.abortSignal.listenerCount()).toBe(0);
  });

  it("closes and settles a pending read when aborted after construction", async () => {
    const opened = await openedSession();
    opened.abortSignal.abort();

    await expect(opened.first).resolves.toEqual({ done: true, value: "aborted" });
    expect(opened.eventSources.sources[0]?.closeCalls).toBe(1);
    expect(opened.abortSignal.listenerCount()).toBe(0);
  });

  it("closes and removes handlers and listeners when the consumer returns", async () => {
    const opened = await openedSession();
    const source = opened.eventSources.sources[0];

    await expect(opened.iterator.return("aborted")).resolves.toEqual({ done: true, value: "aborted" });
    expect(source?.closeCalls).toBe(1);
    expect(source?.onmessage).toBeNull();
    expect(source?.onerror).toBeNull();
    expect(opened.abortSignal.listenerCount()).toBe(0);
    await expect(opened.first).resolves.toEqual({ done: true, value: "aborted" });
  });
});
