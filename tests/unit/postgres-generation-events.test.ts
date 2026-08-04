import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../../packages/database/src/pool.js";
import {
  GENERATION_CHANGED_CHANNEL,
  createPostgresGenerationEventSource
} from "../../packages/database/src/postgres-generation-events.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const campaignId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";

class FakeListenerClient extends EventEmitter {
  readonly connect = vi.fn(async () => undefined);
  readonly query = vi.fn(async () => ({ rows: [] }));
  readonly end = vi.fn(async () => undefined);
}

function authorizedPool(): DatabasePool & { connect: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn> } {
  const connect = vi.fn();
  const query = vi.fn(async (_sql: string, values: unknown[]) => ({
    rows: values[0] === jobId && values[1] === ownerUserId && values[2] === campaignId
      ? [{ id: jobId }]
      : []
  }));
  return { connect, query } as unknown as DatabasePool & {
    connect: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
  };
}

function nextHint(subscription: AsyncIterable<{ jobId: string; version: string }>) {
  return subscription[Symbol.asyncIterator]().next();
}

describe("PostgreSQL generation event source", () => {
  it("starts one dedicated listener idempotently and fans validated hints only to an authorized tuple", async () => {
    const pool = authorizedPool();
    const listener = new FakeListenerClient();
    const source = createPostgresGenerationEventSource(pool, "postgresql://events.example/nexus", {
      createClient: () => listener as never
    });

    await Promise.all([source.start(), source.start()]);
    expect(listener.connect).toHaveBeenCalledOnce();
    expect(listener.query).toHaveBeenCalledWith(`LISTEN ${GENERATION_CHANGED_CHANNEL}`);

    const subscription = await source.subscribe({ ownerUserId, campaignId, jobId });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("owner_user_id = $2 AND campaign_id = $3"),
      [jobId, ownerUserId, campaignId]
    );
    expect(pool.connect).not.toHaveBeenCalled();

    const pending = nextHint(subscription);
    listener.emit("notification", {
      channel: GENERATION_CHANGED_CHANNEL,
      payload: JSON.stringify({ jobId, version: "7:completed" })
    });
    await expect(pending).resolves.toEqual({
      done: false,
      value: { jobId, version: "7:completed" }
    });

    await subscription.close();
    await subscription.close();
    await source.close();
    await source.close();
    expect(listener.end).toHaveBeenCalledOnce();
  });

  it("does not register unauthorized tuples or let a same-ID hint cross owner/campaign scope", async () => {
    const pool = authorizedPool();
    const listener = new FakeListenerClient();
    const source = createPostgresGenerationEventSource(pool, "postgresql://events.example/nexus", {
      createClient: () => listener as never
    });
    await source.start();

    await expect(source.subscribe({ ownerUserId, campaignId: "44444444-4444-4444-8444-444444444444", jobId }))
      .rejects.toThrow("Generation job was not found in the requested event scope");
    const subscription = await source.subscribe({ ownerUserId, campaignId, jobId });
    const pending = nextHint(subscription);
    listener.emit("notification", {
      channel: GENERATION_CHANGED_CHANNEL,
      payload: JSON.stringify({ jobId, version: "8:validating" })
    });
    await expect(pending).resolves.toMatchObject({ value: { jobId, version: "8:validating" } });

    await subscription.close();
    await source.close();
  });

  it("ignores wrong-channel, malformed, invalid-UUID, and oversized/version-unbounded payloads without logging raw data", async () => {
    const pool = authorizedPool();
    const listener = new FakeListenerClient();
    const warn = vi.fn();
    const source = createPostgresGenerationEventSource(pool, "postgresql://events.example/nexus", {
      createClient: () => listener as never,
      logger: { info: vi.fn(), warn }
    });
    await source.start();
    const subscription = await source.subscribe({ ownerUserId, campaignId, jobId });

    listener.emit("notification", { channel: "another_channel", payload: JSON.stringify({ jobId, version: "1" }) });
    listener.emit("notification", { channel: GENERATION_CHANGED_CHANNEL, payload: "PRIVATE malformed payload" });
    listener.emit("notification", { channel: GENERATION_CHANGED_CHANNEL, payload: JSON.stringify({ jobId: "not-a-uuid", version: "1" }) });
    listener.emit("notification", { channel: GENERATION_CHANGED_CHANNEL, payload: JSON.stringify({ jobId, version: "x".repeat(129) }) });
    listener.emit("notification", { channel: GENERATION_CHANGED_CHANNEL, payload: "x".repeat(513) });

    expect(warn).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE malformed payload");

    await subscription.close();
    await source.close();
  });

  it("reconnects with bounded backoff, reissues LISTEN, and keeps existing subscriptions alive", async () => {
    vi.useFakeTimers();
    try {
      const pool = authorizedPool();
      const first = new FakeListenerClient();
      const second = new FakeListenerClient();
      const clients = [first, second];
      const source = createPostgresGenerationEventSource(pool, "postgresql://events.example/nexus", {
        createClient: () => clients.shift() as never,
        reconnectBaseDelayMs: 25,
        reconnectMaxDelayMs: 100,
        random: () => 0.5
      });
      await source.start();
      const subscription = await source.subscribe({ ownerUserId, campaignId, jobId });
      const pending = nextHint(subscription);

      first.emit("error", new Error("listener connection lost"));
      await vi.advanceTimersByTimeAsync(25);
      expect(second.connect).toHaveBeenCalledOnce();
      expect(second.query).toHaveBeenCalledWith(`LISTEN ${GENERATION_CHANGED_CHANNEL}`);

      second.emit("notification", {
        channel: GENERATION_CHANGED_CHANNEL,
        payload: JSON.stringify({ jobId, version: "9:generating" })
      });
      await expect(pending).resolves.toMatchObject({ value: { jobId, version: "9:generating" } });

      await subscription.close();
      await source.close();
      expect(first.end).toHaveBeenCalledOnce();
      expect(second.end).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("supports more subscribers than pool max without listener checkouts scaling with subscribers", async () => {
    const pool = authorizedPool();
    const listener = new FakeListenerClient();
    const source = createPostgresGenerationEventSource(pool, "postgresql://events.example/nexus", {
      createClient: () => listener as never
    });
    await source.start();

    const subscriptions = await Promise.all(Array.from({ length: 20 }, () => (
      source.subscribe({ ownerUserId, campaignId, jobId })
    )));

    expect(pool.query).toHaveBeenCalledTimes(20);
    expect(pool.connect).not.toHaveBeenCalled();
    expect(listener.connect).toHaveBeenCalledOnce();

    await Promise.all(subscriptions.map((subscription) => subscription.close()));
    await source.close();
  });

  it("closes all pending iterators during API shutdown and a fresh source can start independently", async () => {
    const pool = authorizedPool();
    const first = new FakeListenerClient();
    const firstSource = createPostgresGenerationEventSource(pool, "postgresql://events.example/nexus", {
      createClient: () => first as never
    });
    await firstSource.start();
    const subscription = await firstSource.subscribe({ ownerUserId, campaignId, jobId });
    const pending = nextHint(subscription);

    await firstSource.close();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });

    const second = new FakeListenerClient();
    const restartedSource = createPostgresGenerationEventSource(pool, "postgresql://events.example/nexus", {
      createClient: () => second as never
    });
    await restartedSource.start();
    expect(second.query).toHaveBeenCalledWith(`LISTEN ${GENERATION_CHANGED_CHANNEL}`);
    await restartedSource.close();
  });
});
