import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { logger } from "../../../packages/logger/src/index.js";

type CapacityRepository = Readonly<{
  tryAcquire(limit: number, leaseMs: number): Promise<string | null>;
  release(id: string): Promise<void>;
}>;
type PermitOptions = Readonly<{ timeoutMs: number; signal?: AbortSignal }>;
type Permit = { active: boolean; dispatching: boolean; signal: AbortSignal };

export type TextProviderCapacity = ReturnType<typeof createSharedTextProviderCapacity>;

export function createSharedTextProviderCapacity(repository: CapacityRepository, limit: number, pollMs = 25) {
  const context = new AsyncLocalStorage<Permit>();

  async function withPermit<T>(options: PermitOptions, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 86_395_000) {
      throw new RangeError("Invalid text provider capacity timeout");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Text provider capacity deadline exceeded")), options.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const deadline = Date.now() + options.timeoutMs;
    let lease: string | null = null;
    let permit: Permit | undefined;
    try {
      while (!lease) {
        signal.throwIfAborted();
        // The grace period allows an aborted transport to finish closing. Expiry
        // recovers capacity after process loss; it cannot cancel remote work.
        lease = await repository.tryAcquire(limit, Math.max(1, deadline - Date.now()) + 5000);
        if (!lease) await delay(pollMs, undefined, { signal });
      }
      signal.throwIfAborted();
      permit = { active: true, dispatching: false, signal };
      return await context.run(permit, () => work(signal));
    } finally {
      if (permit) permit.active = false;
      clearTimeout(timeout);
      if (lease) {
        try { await repository.release(lease); }
        catch {
          // Preserve paid output (or the original failure); expiry recovers the
          // operational lease if database cleanup is temporarily unavailable.
          logger.warn({ event: "text_provider_capacity_release_failed" });
        }
      }
    }
  }

  async function execute<T>(options: PermitOptions, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const inherited = context.getStore();
    if (inherited?.active && !inherited.dispatching) {
      const signal = options.signal ? AbortSignal.any([inherited.signal, options.signal]) : inherited.signal;
      signal.throwIfAborted();
      inherited.dispatching = true;
      try { return await work(signal); }
      finally { inherited.dispatching = false; }
    }
    return withPermit(options, async (signal) => {
      context.getStore()!.dispatching = true;
      return work(signal);
    });
  }

  return { withPermit, execute };
}
