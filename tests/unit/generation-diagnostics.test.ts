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
      [{ event: "turn_generation_phase_stalled", ...context, phase: "story_generation", durationMs: 30_000, totalDurationMs: 30_000 }],
      [{ event: "turn_generation_phase_stalled", ...context, phase: "story_generation", durationMs: 60_000, totalDurationMs: 60_000 }]
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

    expect(logger.error.mock.calls).toEqual([[{
      event: "turn_generation_phase_failed",
      ...context,
      phase: "turn_commit",
      errorName: "Error",
      errorCode: "unclassified_error",
      durationMs: 0,
      totalDurationMs: 0
    }]]);
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

    expect(logger.error.mock.calls).toEqual([[{
      event: "turn_generation_phase_failed",
      ...context,
      phase: "story_validation",
      errorName: "Error",
      errorCode: "generation_cancelled",
      durationMs: 0,
      totalDurationMs: 100
    }]]);
  });

  it("replaces syntactically valid provider-controlled failure metadata with safe fallbacks", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const sensitiveCode = "private_provider_token";
    const sensitiveName = "PrivateProviderSecret";
    const failure = Object.assign(new Error("PRIVATE_FAILURE_MESSAGE"), {
      code: sensitiveCode,
      name: sensitiveName
    });

    await expect(runTurnGenerationPhase({
      logger: logger as any,
      context,
      phase: "story_generation",
      generationStartedAt: 100,
      now: () => 200
    }, async () => { throw failure; })).rejects.toBe(failure);

    expect(logger.error.mock.calls).toEqual([[{
      event: "turn_generation_phase_failed",
      ...context,
      phase: "story_generation",
      errorName: "Error",
      errorCode: "unclassified_error",
      durationMs: 0,
      totalDurationMs: 100
    }]]);
  });

  it("preserves the original failure when metadata accessors throw", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const failure = new Error("ORIGINAL_PRIVATE_FAILURE");
    Object.defineProperties(failure, {
      code: {
        get() { throw new Error("PRIVATE_CODE_ACCESSOR_FAILURE"); }
      },
      name: {
        get() { throw new Error("PRIVATE_NAME_ACCESSOR_FAILURE"); }
      }
    });

    let caught: unknown;
    try {
      await runTurnGenerationPhase({
        logger: logger as any,
        context,
        phase: "turn_commit",
        generationStartedAt: 100,
        now: () => 200
      }, async () => { throw failure; });
    } catch (error) {
      caught = error;
    }

    expect(caught === failure).toBe(true);
    expect(logger.error.mock.calls).toEqual([[{
      event: "turn_generation_phase_failed",
      ...context,
      phase: "turn_commit",
      errorName: "Error",
      errorCode: "unclassified_error",
      durationMs: 0,
      totalDurationMs: 100
    }]]);
  });

  it("executes the operation and preserves its result when start logging throws", async () => {
    vi.useFakeTimers();
    const loggerFailure = new Error("synthetic start logger failure");
    const logger = {
      info: vi.fn()
        .mockImplementationOnce(() => { throw loggerFailure; })
        .mockImplementationOnce(() => undefined),
      warn: vi.fn(),
      error: vi.fn()
    };
    const operation = vi.fn(async () => "preserved result");

    await expect(runTurnGenerationPhase({
      logger: logger as any,
      context,
      phase: "provider_loading",
      generationStartedAt: 100,
      now: () => 200
    }, operation)).resolves.toBe("preserved result");

    expect(operation).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves a successful result when completion logging throws", async () => {
    vi.useFakeTimers();
    const loggerFailure = new Error("synthetic completion logger failure");
    const logger = {
      info: vi.fn()
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => { throw loggerFailure; }),
      warn: vi.fn(),
      error: vi.fn()
    };

    await expect(runTurnGenerationPhase({
      logger: logger as any,
      context,
      phase: "input_preparation",
      generationStartedAt: 100,
      now: () => 200
    }, async () => "preserved result")).resolves.toBe("preserved result");

    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves the exact operation rejection when failure logging throws", async () => {
    vi.useFakeTimers();
    const originalFailure = new Error("original operation failure");
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(() => { throw new Error("synthetic error logger failure"); })
    };

    await expect(runTurnGenerationPhase({
      logger: logger as any,
      context,
      phase: "turn_commit",
      generationStartedAt: 100,
      now: () => 200
    }, async () => { throw originalFailure; })).rejects.toBe(originalFailure);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("contains recurring warning logger failures and clears the timer after success", async () => {
    vi.useFakeTimers();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(() => { throw new Error("synthetic warning logger failure"); }),
      error: vi.fn()
    };
    const pending = deferred<string>();
    const result = runTurnGenerationPhase({
      logger: logger as any,
      context,
      phase: "story_generation",
      generationStartedAt: Date.now(),
      now: () => Date.now()
    }, () => pending.promise);

    await vi.advanceTimersByTimeAsync(TURN_GENERATION_STALL_INTERVAL_MS * 2);
    expect(logger.warn).toHaveBeenCalledTimes(2);

    pending.resolve("preserved result");
    await expect(result).resolves.toBe("preserved result");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(TURN_GENERATION_STALL_INTERVAL_MS);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});
