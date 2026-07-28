import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runTurnGenerationPhase,
  TURN_GENERATION_STALL_INTERVAL_MS
} from "../../services/api/src/generation-diagnostics.js";

const context = {
  generationJobId: "job-1",
  campaignId: "campaign-1",
  providerProfileId: "provider-1",
  expectedTurnNumber: 4,
  operationKind: "append",
  jobAttempt: 1,
  workerId: "worker-1"
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("turn generation phase diagnostics", () => {
  it("logs phase start and completion with correlated durations", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    let now = 1_000;

    await expect(runTurnGenerationPhase({
      logger: logger as any,
      context,
      phase: "context_retrieval",
      generationStartedAt: 500,
      now: () => now
    }, async () => {
      now = 1_250;
      return "context";
    })).resolves.toBe("context");

    expect(logger.info.mock.calls).toEqual([
      [{ event: "turn_generation_phase_started", ...context, phase: "context_retrieval", totalDurationMs: 500 }],
      [{ event: "turn_generation_phase_completed", ...context, phase: "context_retrieval", durationMs: 250, totalDurationMs: 750 }]
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("repeats safe stall warnings until the phase settles and then clears its timer", async () => {
    vi.useFakeTimers();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const pending = deferred<string>();
    const startedAt = Date.now();
    const result = runTurnGenerationPhase({
      logger: logger as any,
      context,
      phase: "story_generation",
      generationStartedAt: startedAt,
      now: () => Date.now()
    }, () => pending.promise);

    await vi.advanceTimersByTimeAsync(TURN_GENERATION_STALL_INTERVAL_MS * 2);
    expect(logger.warn.mock.calls).toEqual([
      [expect.objectContaining({ event: "turn_generation_phase_stalled", ...context, phase: "story_generation", durationMs: 30_000, totalDurationMs: 30_000 })],
      [expect.objectContaining({ event: "turn_generation_phase_stalled", ...context, phase: "story_generation", durationMs: 60_000, totalDurationMs: 60_000 })]
    ]);

    pending.resolve("done");
    await expect(result).resolves.toBe("done");
    await vi.advanceTimersByTimeAsync(TURN_GENERATION_STALL_INTERVAL_MS);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("logs a sanitized failure and rethrows the original error", async () => {
    vi.useFakeTimers();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const privateMessage = "PRIVATE_PROVIDER_RESPONSE";
    const failure = Object.assign(new Error(privateMessage), {
      code: "https://secret.example/token"
    });

    await expect(runTurnGenerationPhase({
      logger: logger as any,
      context,
      phase: "turn_commit",
      generationStartedAt: Date.now(),
      now: () => Date.now()
    }, async () => { throw failure; })).rejects.toBe(failure);

    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      event: "turn_generation_phase_failed",
      ...context,
      phase: "turn_commit",
      errorName: "Error",
      errorCode: "unclassified_error"
    }));
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(privateMessage);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("secret.example");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses a controlled error code without serializing arbitrary error fields", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const failure = Object.assign(new Error("PRIVATE_PARSE_DETAILS"), {
      code: "generation_cancelled",
      prompt: "PRIVATE_PROMPT"
    });

    await expect(runTurnGenerationPhase({
      logger: logger as any,
      context,
      phase: "story_validation",
      generationStartedAt: 100,
      now: () => 200
    }, async () => { throw failure; })).rejects.toBe(failure);

    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "generation_cancelled"
    }));
    const serialized = JSON.stringify(logger.error.mock.calls);
    expect(serialized).not.toContain("PRIVATE_PARSE_DETAILS");
    expect(serialized).not.toContain("PRIVATE_PROMPT");
  });
});
