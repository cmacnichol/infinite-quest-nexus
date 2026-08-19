import type { GenerationEvent, GenerationRun, GenerationSubmissionInput, GenerationWorkflow } from "../../packages/client-core/src/index.js";
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
        idempotencyKey: "opening-idempotency-key"
      })
    })]);
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
});
