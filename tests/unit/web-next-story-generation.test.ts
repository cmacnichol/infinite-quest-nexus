import type { GenerationEvent, GenerationRun, GenerationSubmissionInput, GenerationWorkflow } from "../../packages/client-core/src/index.js";
import type { GenerationReviewDecisionRequest } from "../../packages/contracts/src/index.js";
import { describe, expect, it, vi } from "vitest";
import { createStoryGenerationController } from "../../apps/web-next/src/story-player-generation.js";

const campaignId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";

function run(events: readonly GenerationEvent[] = []): GenerationRun {
  return {
    campaignId,
    jobId,
    operationKind: "append",
    replacementTurnId: null,
    async *watch() { yield* events; },
    async *retryGeneration() { yield* events; },
    cancelGeneration: vi.fn(),
    discardGeneration: vi.fn(),
    fetchResult: vi.fn()
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

describe("StoryGenerationController", () => {
  it("submits the real opening action with authoritative append provenance", async () => {
    const submitted: GenerationSubmissionInput[] = [];
    const workflow: GenerationWorkflow = {
      submit: vi.fn(async (_campaignId, input) => { submitted.push(input); return run(); }),
      resume: vi.fn()
    };
    const apply = vi.fn();
    const controller = createStoryGenerationController({
      workflow,
      campaignStore: { attachGeneration: vi.fn(() => ({ campaignId, jobId, apply, retryResult: vi.fn() })) } as never,
      idFactory: { create: () => "opening-idempotency-key" },
      currentCampaign: () => ({ id: campaignId, activeTurnNumber: 0 })
    });

    await controller.submitAppend({
      action: "Wake beneath the observatory.",
      requestedInputMode: "action",
      resolvedInputMode: "action",
      inputModeSource: "opening_action"
    });

    expect(submitted).toEqual([expect.objectContaining({
      operationKind: "append",
      expectedTurnNumber: 1,
      request: expect.objectContaining({
        action: "Wake beneath the observatory.",
        inputModeSource: "opening_action",
        idempotencyKey: "opening-idempotency-key",
        context: {
          budgetTokens: 32_000,
          compression: "auto",
          recentTurns: 8
        }
      })
    })]);
    expect(submitted[0]?.request).not.toHaveProperty("storyLengthProfileOverride");
  });

  it("serializes a requested per-turn length override into the durable append request", async () => {
    const submitted: GenerationSubmissionInput[] = [];
    const workflow: GenerationWorkflow = {
      submit: vi.fn(async (_campaignId, input) => { submitted.push(input); return run(); }),
      resume: vi.fn()
    };
    const controller = createStoryGenerationController({
      workflow,
      campaignStore: { attachGeneration: vi.fn(() => ({ campaignId, jobId, apply: vi.fn(), retryResult: vi.fn() })) } as never,
      idFactory: { create: () => "length-idempotency-key" },
      currentCampaign: () => ({ id: campaignId, activeTurnNumber: 0 })
    });

    await controller.submitAppend({
      action: "Open the observatory.",
      requestedInputMode: "action",
      resolvedInputMode: "action",
      inputModeSource: "explicit",
      storyLengthProfileOverride: "long"
    });

    expect(submitted[0]).toMatchObject({ request: { storyLengthProfileOverride: "long" } });
  });

  it("reports the authoritative append run and original submission before monitoring begins", async () => {
    const submitted = vi.fn();
    const appendRun = run();
    const controller = createStoryGenerationController({
      workflow: { submit: vi.fn(async () => appendRun), resume: vi.fn() },
      campaignStore: { attachGeneration: vi.fn(() => ({ campaignId, jobId, apply: vi.fn(), retryResult: vi.fn() })) } as never,
      idFactory: { create: () => "retained-prompt-key" },
      currentCampaign: () => ({ id: campaignId, activeTurnNumber: 1 }),
      onSubmitted: submitted
    });
    const submission = { action: "Keep the Story Direction.", requestedInputMode: "scene" as const, resolvedInputMode: "scene" as const, inputModeSource: "explicit" as const };

    await controller.submitAppend(submission);

    expect(submitted).toHaveBeenCalledOnce();
    expect(submitted).toHaveBeenCalledWith(appendRun, submission);
  });

  it("does not report a submitted append after its campaign changes while enqueue is pending", async () => {
    const pending = deferred<GenerationRun>();
    const submitted = vi.fn();
    let current = { id: campaignId, activeTurnNumber: 1 };
    const controller = createStoryGenerationController({
      workflow: { submit: vi.fn(() => pending.promise), resume: vi.fn() },
      campaignStore: { attachGeneration: vi.fn(() => ({ campaignId, jobId, apply: vi.fn(), retryResult: vi.fn() })) } as never,
      idFactory: { create: () => "campaign-fence-key" },
      currentCampaign: () => current,
      onSubmitted: submitted
    });

    const submittedAppend = controller.submitAppend({ action: "Keep this local.", requestedInputMode: "action", resolvedInputMode: "action", inputModeSource: "explicit" });
    current = { id: "99999999-9999-4999-8999-999999999999", activeTurnNumber: 4 };
    pending.resolve(run());

    await expect(submittedAppend).resolves.toBe(false);
    expect(submitted).not.toHaveBeenCalled();
  });

  it("serializes a requested per-turn length override into the durable replacement request", async () => {
    const submitted: GenerationSubmissionInput[] = [];
    const replacementTurnId = "33333333-3333-4333-8333-333333333333";
    const replacementRun = { ...run(), operationKind: "replace_latest" as const, replacementTurnId };
    const controller = createStoryGenerationController({
      workflow: {
        submit: vi.fn(async (_campaignId, input) => { submitted.push(input); return replacementRun; }),
        resume: vi.fn()
      },
      campaignStore: { attachGeneration: vi.fn(() => ({ campaignId, jobId, apply: vi.fn(), retryResult: vi.fn() })) } as never,
      idFactory: { create: () => "replacement-length-key" },
      currentCampaign: () => ({ id: campaignId, activeTurnNumber: 4 })
    });

    await controller.submitReplacement(replacementTurnId, {
      action: "Try another path.", requestedInputMode: "action", resolvedInputMode: "action", inputModeSource: "explicit",
      storyLengthProfileOverride: "brief"
    });

    expect(submitted[0]).toMatchObject({
      operationKind: "replace_latest",
      request: { storyLengthProfileOverride: "brief", expectedCurrentTurnNumber: 4 }
    });
  });

  it("keeps streamed narration non-authoritative until the completed result reaches the store", async () => {
    const events: GenerationEvent[] = [
      { type: "narration", text: "The observatory opened." },
      { type: "settled", outcome: "completed", result: { id: jobId, campaignId, expectedTurnNumber: 1, turnNumber: 1 } as never }
    ];
    const apply = vi.fn();
    const completed = vi.fn();
    const controller = createStoryGenerationController({
      workflow: { submit: vi.fn(async () => run(events)), resume: vi.fn() },
      campaignStore: { attachGeneration: vi.fn(() => ({ campaignId, jobId, apply, retryResult: vi.fn() })) } as never,
      idFactory: { create: () => "append-idempotency-key" },
      currentCampaign: () => ({ id: campaignId, activeTurnNumber: 0 }),
      onCompleted: completed
    });

    await controller.submitAppend({ action: "Open it.", requestedInputMode: "action", resolvedInputMode: "action", inputModeSource: "explicit" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(apply).toHaveBeenCalledWith({ type: "narration", text: "The observatory opened." });
    expect(apply).toHaveBeenCalledWith(events[1]);
    expect(completed).toHaveBeenCalledWith(events[1]?.result);
  });

  it("does not apply a stale completion after disposal and keeps a failed cancel monitored", async () => {
    const controller = createStoryGenerationController({
      workflow: { submit: vi.fn(async () => ({ ...run(), cancelGeneration: vi.fn(async () => { throw new Error("still monitoring"); }) })), resume: vi.fn() },
      campaignStore: { attachGeneration: vi.fn(() => ({ campaignId, jobId, apply: vi.fn(), retryResult: vi.fn() })) } as never,
      idFactory: { create: () => "append-idempotency-key" },
      currentCampaign: () => ({ id: campaignId, activeTurnNumber: 0 })
    });

    await controller.submitAppend({ action: "Open it.", requestedInputMode: "action", resolvedInputMode: "action", inputModeSource: "explicit" });
    await expect(controller.cancel()).resolves.toBe(false);
    controller.dispose();
    await expect(controller.retry()).resolves.toBe(false);
  });

  it("reserves an append submission before awaiting the durable workflow", async () => {
    const pending = deferred<GenerationRun>();
    const submit = vi.fn(() => pending.promise);
    const controller = createStoryGenerationController({
      workflow: { submit, resume: vi.fn() },
      campaignStore: { attachGeneration: vi.fn(() => ({ campaignId, jobId, apply: vi.fn(), retryResult: vi.fn() })) } as never,
      idFactory: { create: () => "one-idempotency-key" },
      currentCampaign: () => ({ id: campaignId, activeTurnNumber: 0 })
    });

    const first = controller.submitAppend({ action: "First.", requestedInputMode: "action", resolvedInputMode: "action", inputModeSource: "explicit" });
    const second = controller.submitAppend({ action: "Second.", requestedInputMode: "action", resolvedInputMode: "action", inputModeSource: "explicit" });
    expect(submit).toHaveBeenCalledTimes(1);
    pending.resolve(run());

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
  });

  it("reconciles an unavailable accepted result before allowing the next append", async () => {
    const accepted = { id: jobId, campaignId, expectedTurnNumber: 1, turnNumber: 1 } as never;
    const generation = { result: { state: "unavailable" } };
    const apply = vi.fn();
    const completed = vi.fn();
    const durableRun = { ...run(), fetchResult: vi.fn(async () => ({ type: "settled" as const, outcome: "completed" as const, result: accepted })) };
    const submit = vi.fn(async () => durableRun);
    const controller = createStoryGenerationController({
      workflow: { submit, resume: vi.fn() },
      campaignStore: {
        store: { get: () => ({ generation }) },
        attachGeneration: vi.fn(() => ({ campaignId, jobId, apply, retryResult: vi.fn() }))
      } as never,
      idFactory: { create: () => "result-idempotency-key" },
      currentCampaign: () => ({ id: campaignId, activeTurnNumber: 0 }),
      onCompleted: completed
    });

    await controller.submitAppend({ action: "Open it.", requestedInputMode: "action", resolvedInputMode: "action", inputModeSource: "explicit" });
    await expect(controller.retry()).resolves.toBe(true);
    expect(apply).toHaveBeenCalledWith({ type: "settled", outcome: "completed", result: accepted });
    expect(completed).toHaveBeenCalledWith(accepted);
    await expect(controller.submitAppend({ action: "Continue.", requestedInputMode: "action", resolvedInputMode: "action", inputModeSource: "explicit" })).resolves.toBe(true);
  });

  it("reconciles an acknowledged discard after a monitor has failed", async () => {
    const apply = vi.fn();
    const durableRun = { ...run(), discardGeneration: vi.fn(async () => undefined) };
    const controller = createStoryGenerationController({
      workflow: { submit: vi.fn(async () => durableRun), resume: vi.fn() },
      campaignStore: { attachGeneration: vi.fn(() => ({ campaignId, jobId, apply, retryResult: vi.fn() })) } as never,
      idFactory: { create: () => "discard-idempotency-key" },
      currentCampaign: () => ({ id: campaignId, activeTurnNumber: 0 })
    });

    await controller.submitAppend({ action: "Open it.", requestedInputMode: "action", resolvedInputMode: "action", inputModeSource: "explicit" });
    await expect(controller.discard()).resolves.toBe(true);
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ type: "settled", outcome: "discarded" }));
    await expect(controller.submitAppend({ action: "Continue.", requestedInputMode: "action", resolvedInputMode: "action", inputModeSource: "explicit" })).resolves.toBe(true);
  });

  it("sends an explicit saved review decision through the attached session", async () => {
    const decision: GenerationReviewDecisionRequest = {
      reviewId: "44444444-4444-4444-8444-444444444444",
      revision: 1,
      decision: "keep"
    };
    const decideReview = vi.fn(async () => ({
      id: jobId, status: "queued" as const, operationKind: "append" as const, replacementTurnId: null
    }));
    const controller = createStoryGenerationController({
      workflow: { submit: vi.fn(async () => run()), resume: vi.fn() },
      campaignStore: { attachGeneration: vi.fn(() => ({ campaignId, jobId, apply: vi.fn(), loadReview: vi.fn(), decideReview, retryResult: vi.fn() })) } as never,
      idFactory: { create: () => "review-idempotency-key" },
      currentCampaign: () => ({ id: campaignId, activeTurnNumber: 0 })
    });

    await controller.submitAppend({ action: "Open it.", requestedInputMode: "action", resolvedInputMode: "action", inputModeSource: "explicit" });

    await expect(controller.decideReview(decision)).resolves.toBe(true);
    expect(decideReview).toHaveBeenCalledWith(decision);
  });

  it("reads the attached current review before a page constructs a decision receipt", async () => {
    const currentReview = { version: 1, reviewId: "44444444-4444-4444-8444-444444444444", revision: 1 } as never;
    const durableRun = { ...run(), getReview: vi.fn(async () => currentReview) };
    const controller = createStoryGenerationController({
      workflow: { submit: vi.fn(async () => durableRun), resume: vi.fn() },
      campaignStore: { attachGeneration: vi.fn(() => ({ campaignId, jobId, apply: vi.fn(), loadReview: vi.fn(), decideReview: vi.fn(), retryResult: vi.fn() })) } as never,
      idFactory: { create: () => "review-idempotency-key" },
      currentCampaign: () => ({ id: campaignId, activeTurnNumber: 0 })
    });

    await controller.submitAppend({ action: "Open it.", requestedInputMode: "action", resolvedInputMode: "action", inputModeSource: "explicit" });
    await expect(controller.readCurrentReview()).resolves.toEqual(currentReview);
  });
});
