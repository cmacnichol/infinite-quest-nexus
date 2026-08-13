import { describe, expect, it, vi } from "vitest";
import type { GenerationEvent } from "../../packages/client-core/src/index.js";
import type { GenerationRequest } from "../../packages/contracts/src/index.js";
import {
  activeGenerationConflict,
  fetchCompletedGenerationResult,
  generationSubmissionInput,
  observeGenerationRunEvents,
  presentGenerationEvents,
  resumeActiveGenerationConflict,
  type StoryGenerationEvent
} from "../../apps/web/src/story-generation-monitor.js";

async function* events(...values: StoryGenerationEvent[]) {
  yield* values;
}

async function* generationEvents(...values: GenerationEvent[]) {
  yield* values;
}

describe("Story Player generation presentation", () => {
  it("builds the persisted append submission with its expected turn number", () => {
    const request: GenerationRequest = {
      action: "Open the gate.",
      requestedInputMode: "action",
      resolvedInputMode: "action",
      inputModeSource: "explicit",
      idempotencyKey: "append-key",
      context: { budgetTokens: 32_000, compression: "auto", recentTurns: 8 }
    };
    expect(generationSubmissionInput({ operationKind: "append", expectedTurnNumber: 7 }, request)).toEqual({
      operationKind: "append",
      expectedTurnNumber: 7,
      request
    });
  });

  it.each([
    { label: "reload resume", retryFirst: false, selectedMethod: "watch", skippedMethod: "retryGeneration" },
    { label: "recoverable retry", retryFirst: true, selectedMethod: "retryGeneration", skippedMethod: "watch" }
  ] as const)("creates and releases a live controller for $label", async ({ retryFirst, selectedMethod, skippedMethod }) => {
    const stream = generationEvents({ type: "detached", jobId: "job-1" });
    const receivedSignals: AbortSignal[] = [];
    const run = {
      jobId: "job-1",
      watch: vi.fn((signal: AbortSignal) => {
        receivedSignals.push(signal);
        return stream;
      }),
      retryGeneration: vi.fn((signal: AbortSignal) => {
        receivedSignals.push(signal);
        return stream;
      })
    };
    const controllerState = { abortController: null as AbortController | null };
    const result = await observeGenerationRunEvents(run, retryFirst, controllerState, async (values) => {
      expect(values).toBe(stream);
      expect(controllerState.abortController?.signal).toBe(receivedSignals[0]);
      expect(receivedSignals[0]?.aborted).toBe(false);
      controllerState.abortController?.abort();
      expect(receivedSignals[0]?.aborted).toBe(true);
      return "observed";
    });

    expect(result).toBe("observed");
    expect(run[selectedMethod]).toHaveBeenCalledOnce();
    expect(run[skippedMethod]).not.toHaveBeenCalled();
    expect(controllerState.abortController).toBeNull();
  });

  it("renders progressive narration and treats monitoring degradation as non-terminal", async () => {
    const narration: string[] = [];
    const activity: string[] = [];
    await presentGenerationEvents(events(
      { type: "status", snapshot: { status: "generating", stage: "scene" } },
      { type: "narration", text: "A torch gutters." },
      { type: "degraded", reason: "stream_lost", consecutiveFailures: 1 },
      { type: "settled", outcome: "completed", result: { resultTurnId: "turn-1" } }
    ), {
      onStatus: () => undefined,
      onNarration: (text) => narration.push(text),
      onDegraded: (reason) => activity.push(reason),
      onCompleted: async () => undefined,
      onCancelled: async () => undefined,
      onTerminalFailure: () => undefined,
      onResultUnavailable: () => undefined
    });
    expect(narration).toEqual(["A torch gutters."]);
    expect(activity).toEqual(["stream_lost"]);
  });

  it("surfaces a result-unavailable recovery without treating it as a rejected turn", async () => {
    let recovery = "";
    await presentGenerationEvents(events({ type: "result_unavailable", jobId: "job-1", error: new Error("later") }), {
      onStatus: () => undefined,
      onNarration: () => undefined,
      onDegraded: () => undefined,
      onCompleted: async () => undefined,
      onCancelled: async () => undefined,
      onTerminalFailure: () => undefined,
      onResultUnavailable: (jobId) => { recovery = jobId; }
    });
    expect(recovery).toBe("job-1");
  });

  it("retries a completed result through GenerationRun.fetchResult only", async () => {
    const fetchResult = async () => ({
      type: "settled" as const,
      outcome: "completed" as const,
      result: { resultTurnId: "turn-1" }
    });
    const run = {
      fetchResult: vi.fn(fetchResult),
      retryGeneration: vi.fn(),
      watch: vi.fn(),
      cancelGeneration: vi.fn(),
      discardGeneration: vi.fn(),
      campaignId: "campaign-1",
      jobId: "job-1"
    };
    const onCompleted = vi.fn();
    const onResultUnavailable = vi.fn();

    await fetchCompletedGenerationResult(run, { onCompleted, onResultUnavailable });

    expect(run.fetchResult).toHaveBeenCalledOnce();
    expect(run.retryGeneration).not.toHaveBeenCalled();
    expect(run.watch).not.toHaveBeenCalled();
    expect(onCompleted).toHaveBeenCalledWith({ resultTurnId: "turn-1" });
    expect(onResultUnavailable).not.toHaveBeenCalled();
  });

  it("keeps another failed result fetch complete-but-loading", async () => {
    const unavailable = { type: "result_unavailable" as const, jobId: "job-1", error: new Error("later") };
    const run = {
      fetchResult: vi.fn(async () => unavailable),
      retryGeneration: vi.fn(),
      watch: vi.fn(),
      cancelGeneration: vi.fn(),
      discardGeneration: vi.fn(),
      campaignId: "campaign-1",
      jobId: "job-1"
    };
    const onCompleted = vi.fn();
    const onResultUnavailable = vi.fn();

    await fetchCompletedGenerationResult(run, { onCompleted, onResultUnavailable });

    expect(run.fetchResult).toHaveBeenCalledOnce();
    expect(run.retryGeneration).not.toHaveBeenCalled();
    expect(onResultUnavailable).toHaveBeenCalledWith("job-1", unavailable.error);
    expect(onCompleted).not.toHaveBeenCalled();
  });

  it("recognizes only the structured active-generation conflict", () => {
    const pendingGeneration = { id: "job-1", action: "Open the gate" };
    expect(activeGenerationConflict({
      statusCode: 409,
      domainCode: "active_generation_exists",
      details: { code: "active_generation_exists", pendingGeneration }
    })).toEqual(pendingGeneration);
    expect(activeGenerationConflict({ statusCode: 409, message: "Conflict" })).toBeNull();
    expect(activeGenerationConflict({
      statusCode: 500,
      domainCode: "active_generation_exists",
      details: { pendingGeneration }
    })).toBeNull();
  });

  it("resumes the authoritative active job without submitting another key", async () => {
    const pendingGeneration = { id: "job-1", action: "Open the gate" };
    const run = { jobId: "job-1" };
    const workflow = {
      resume: vi.fn(async () => run),
      submit: vi.fn()
    };

    await expect(resumeActiveGenerationConflict({
      statusCode: 409,
      domainCode: "active_generation_exists",
      details: { code: "active_generation_exists", pendingGeneration }
    }, "campaign-1", workflow as never)).resolves.toEqual({
      message: "a turn is already generating",
      pendingGeneration,
      run
    });
    expect(workflow.resume).toHaveBeenCalledOnce();
    expect(workflow.resume).toHaveBeenCalledWith("campaign-1");
    expect(workflow.submit).not.toHaveBeenCalled();

    await expect(resumeActiveGenerationConflict({ statusCode: 409 }, "campaign-1", workflow as never))
      .resolves.toBeNull();
    expect(workflow.resume).toHaveBeenCalledOnce();
  });
});
