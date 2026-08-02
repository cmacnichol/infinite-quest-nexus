import { describe, expect, it } from "vitest";
import type { GenerationEnqueueResponse } from "../../../packages/contracts/src/index.js";
import type { GenerationSubmissionInput, StoredGenerationSubmission } from "../../../packages/client-core/src/generation/types.js";
import { createGenerationSubmissionCoordinator } from "../../../packages/client-core/src/generation/submission.js";

const campaignId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";

function input(): GenerationSubmissionInput {
  return {
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
  };
}

function response(overrides: Partial<GenerationEnqueueResponse> = {}): GenerationEnqueueResponse {
  return { id: jobId, status: "queued", duplicate: false, ...overrides };
}

describe("generation submission coordinator", () => {
  it("stamps and saves the envelope before enqueue, then saves the returned durable job id", async () => {
    const events: string[] = [];
    const saved: StoredGenerationSubmission[] = [];
    const coordinator = createGenerationSubmissionCoordinator({
      api: {
        async enqueue() {
          events.push("enqueue");
          expect(saved).toEqual([{ ...input(), createdAt: 1_000 }]);
          return response();
        },
        async enqueueReplacement() {
          throw new Error("unexpected replacement enqueue");
        }
      },
      clock: { now: () => 1_000 },
      store: {
        load: () => null,
        save(_campaignId, submission) {
          events.push("save");
          saved.push(submission);
        },
        clear: () => undefined
      }
    });

    await expect(coordinator.submit(campaignId, input())).resolves.toEqual(response());
    expect(events).toEqual(["save", "enqueue", "save"]);
    expect(saved).toEqual([
      { ...input(), createdAt: 1_000 },
      { ...input(), createdAt: 1_000, jobId }
    ]);
  });

  it("uses one injected clock for the exact fifteen-minute expiry boundary", () => {
    let now = 1_000;
    let record: StoredGenerationSubmission | null = { ...input(), createdAt: 0 };
    const coordinator = createGenerationSubmissionCoordinator({
      api: { enqueue: async () => response(), enqueueReplacement: async () => response() },
      clock: { now: () => now },
      store: {
        load: () => record,
        save: () => undefined,
        clear: () => { record = null; }
      }
    });

    now = 900_000 - 1;
    expect(coordinator.load(campaignId)).toEqual(record);
    now = 900_000;
    expect(coordinator.load(campaignId)).toBeNull();
    expect(record).toBeNull();
  });

  it("replays the original idempotency key without minting a replacement key", async () => {
    const replayedRequests: string[] = [];
    const coordinator = createGenerationSubmissionCoordinator({
      api: {
        async enqueue(_campaignId, request) {
          replayedRequests.push(request.idempotencyKey);
          return response({ duplicate: true });
        },
        async enqueueReplacement() {
          throw new Error("unexpected replacement enqueue");
        }
      },
      clock: { now: () => 1_000 },
      store: { load: () => null, save: () => undefined, clear: () => undefined }
    });

    await coordinator.replay(campaignId, { ...input(), createdAt: 1 });
    expect(replayedRequests).toEqual(["submission-key"]);
  });

  it("preserves saved failed or completed job ids for later workflow recovery", () => {
    const saved = { ...input(), createdAt: 1_000, jobId };
    const coordinator = createGenerationSubmissionCoordinator({
      api: { enqueue: async () => response(), enqueueReplacement: async () => response() },
      clock: { now: () => 1_000 },
      store: { load: () => saved, save: () => undefined, clear: () => undefined }
    });

    expect(coordinator.load(campaignId)).toEqual(saved);
  });
});
