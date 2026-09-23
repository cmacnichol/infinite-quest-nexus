import {
  ApiContractError,
  GenerationWorkflowProtocolError,
  NexusApiError
} from "@infinite-quest/client-core";
import type { AbortSignalLike } from "@infinite-quest/client-core";
import { generationStreamSnapshotSchema } from "@infinite-quest/contracts";
import { toAbortSignal } from "./abort-bridge.js";
import type {
  GenerationSourceEvent,
  PollSessionOptions
} from "./types.js";

const POLL_INTERVAL_MS = 1500;
const MAX_BACKOFF_MS = 5000;
const HIDDEN_MINIMUM_MS = 5000;
const MAX_RETRY_AFTER_MS = 60_000;
const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "discarded",
  "cancelled",
  "recoverable"
]);

function isTerminalSnapshot(snapshot: import("@infinite-quest/contracts").GenerationStreamSnapshot): boolean {
  return TERMINAL_STATUSES.has(snapshot.status)
    && !(snapshot.status === "recoverable" && snapshot.review !== undefined);
}

export function createPollSession(
  options: PollSessionOptions,
  jobId: string,
  signal: AbortSignalLike
): AsyncGenerator<GenerationSourceEvent, void, void> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  let listening = false;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    controller.abort();
    if (listening) {
      signal.removeEventListener("abort", onAbort);
      listening = false;
    }
  };

  async function* session(): AsyncGenerator<GenerationSourceEvent, void, void> {
    if (signal.aborted) return;
    signal.addEventListener("abort", onAbort, { once: true });
    listening = true;
    try {
      if (signal.aborted) return;
      yield* runPollSession(options, jobId, controller.signal);
    } finally {
      cleanup();
    }
  }

  const iterator = session();
  const originalReturn = iterator.return.bind(iterator);
  iterator.return = async (value: void) => {
    cleanup();
    return originalReturn(value);
  };
  return iterator;
}

async function* runPollSession(
  options: PollSessionOptions,
  jobId: string,
  signal: AbortSignalLike
): AsyncGenerator<GenerationSourceEvent, void, void> {
  let consecutiveFailures = 0;

  while (!signal.aborted) {
    let snapshot: import("@infinite-quest/contracts").GenerationStreamSnapshot;
    try {
      const bridge = toAbortSignal(signal);
      try {
        const response = await options.api.get(jobId, bridge.signal);
        const parsed = generationStreamSnapshotSchema.safeParse(response);
        if (!parsed.success) {
          throw new ApiContractError("Invalid generation status response.", {
            phase: "response", kind: "response_schema_mismatch", method: "GET", path: `/generation-jobs/${jobId}`
          });
        }
        snapshot = parsed.data;
      } finally {
        bridge.dispose();
      }
    } catch (cause) {
      if (signal.aborted) return;
      if (cause instanceof GenerationWorkflowProtocolError) throw cause;
      const invalidSnapshot = cause instanceof ApiContractError;
      if (!invalidSnapshot && !isTransientPollingError(cause)) throw cause;
      // A rejected status response is not evidence that the durable job failed.
      // Keep the last validated state and reconcile the same job after backoff.

      consecutiveFailures += 1;
      const waitMilliseconds = pollingFailureDelay(
        consecutiveFailures,
        options.random,
        cause,
        options.clock
      );
      if (invalidSnapshot || consecutiveFailures >= 2) {
        yield {
          kind: "degraded",
          reason: invalidSnapshot ? "invalid_snapshot" : "poll_failed",
          consecutiveFailures
        };
      }
      await waitForNextPoll(options, waitMilliseconds, signal);
      continue;
    }

    if (signal.aborted) return;
    consecutiveFailures = 0;
    yield { kind: "snapshot", snapshot };
    if (isTerminalSnapshot(snapshot)) return;
    await waitForNextPoll(options, POLL_INTERVAL_MS, signal);
  }
}

function isTransientPollingError(cause: unknown): cause is TypeError | NexusApiError {
  if (cause instanceof TypeError) return true;
  if (!(cause instanceof NexusApiError)) return false;
  return cause.statusCode === 408
    || cause.statusCode === 425
    || cause.statusCode === 429
    || (cause.statusCode >= 500 && cause.statusCode <= 599);
}

function pollingFailureDelay(
  consecutiveFailures: number,
  random: () => number,
  cause: unknown,
  clock: PollSessionOptions["clock"]
): number {
  const randomValue = random();
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue >= 1) {
    throw new RangeError("Polling random value must be finite and in [0, 1).");
  }
  const base = Math.min(MAX_BACKOFF_MS, POLL_INTERVAL_MS * 2 ** (consecutiveFailures - 1));
  const calculated = Math.min(MAX_BACKOFF_MS, base + Math.floor(base * 0.2 * randomValue));
  if (!(cause instanceof NexusApiError) || !cause.retryAfter) return calculated;
  const retryAfter = retryAfterMilliseconds(cause.retryAfter, clock.now());
  return retryAfter === null ? calculated : Math.max(calculated, retryAfter);
}

function retryAfterMilliseconds(value: string, now: number): number | null {
  let milliseconds: number;
  if (/^\d+$/.test(value)) {
    milliseconds = Number(value) * 1000;
  } else {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return null;
    milliseconds = timestamp - now;
  }
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return null;
  return Math.min(MAX_RETRY_AFTER_MS, milliseconds);
}

async function waitForNextPoll(
  options: PollSessionOptions,
  milliseconds: number,
  signal: AbortSignalLike
): Promise<void> {
  if (signal.aborted) return;
  if (!options.visibility.isHidden()) {
    await options.delay.wait(milliseconds, signal);
    return;
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) controller.abort();
  try {
    await Promise.race([
      options.delay.wait(Math.max(HIDDEN_MINIMUM_MS, milliseconds), controller.signal),
      options.visibility.waitUntilVisible(controller.signal)
    ]);
  } finally {
    controller.abort();
    signal.removeEventListener("abort", onAbort);
  }
}
