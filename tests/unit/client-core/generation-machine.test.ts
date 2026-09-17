import { describe, expect, it } from "vitest";
import type { GenerationStreamSnapshot } from "../../../packages/contracts/src/index.js";
import { createGenerationMachine } from "../../../packages/client-core/src/generation/machine.js";

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
    replacementTurnId: null,
    attempts: 1,
    partialNarration: null,
    errorCode: null,
    errorMessage: null,
    resultTurnId: null,
    ...overrides
  } as GenerationStreamSnapshot;
}

describe("generation machine", () => {
  it("reconciles a review receipt through the same-attempt queue and rejects a delayed pending review", () => {
    const machine = createGenerationMachine();
    const pending = snapshot({
      status: "recoverable",
      partialNarration: "The gate groans.",
      review: {
        version: 1, reviewId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", revision: 1, state: "pending",
        stage: "continuity", candidateScope: "final", reasons: ["narrative_conflict"], canKeep: true, canRetry: true
      }
    });
    machine.observe(pending);
    machine.acknowledgeReviewDecision((pending.review! as any).reviewId, (pending.review! as any).revision);

    expect(machine.observe(snapshot({
      status: "queued",
      partialNarration: "The gate groans.",
      review: { ...(pending.review! as any), revision: 2, state: "decided" }
    }))).toMatchObject({ kind: "accepted" });
    expect(machine.observe(pending)).toEqual({ kind: "stale" });
  });

  it("accepts a higher review revision from another tab without treating it as a duplicate", () => {
    const machine = createGenerationMachine();
    const pending = snapshot({
      status: "recoverable",
      review: {
        version: 1, reviewId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", revision: 1, state: "pending",
        stage: "continuity", candidateScope: "final", reasons: ["narrative_conflict"], canKeep: true, canRetry: true
      }
    });
    machine.observe(pending);

    expect(machine.observe(snapshot({ status: "recoverable", review: { ...(pending.review! as any), revision: 2, state: "decided" } })))
      .toMatchObject({ kind: "accepted" });
  });

  it("reconciles another tab's decided higher review revision into the same-attempt queue", () => {
    const machine = createGenerationMachine();
    const pending = snapshot({ status: "recoverable", review: {
      version: 1, reviewId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", revision: 1, state: "pending",
      stage: "continuity", candidateScope: "final", reasons: ["narrative_conflict"], canKeep: true, canRetry: true
    } });
    machine.observe(pending);

    expect(machine.observe(snapshot({ status: "queued", review: { ...(pending.review! as any), revision: 2, state: "decided" } })))
      .toMatchObject({ kind: "accepted", terminal: false });
  });

  it("does not emit a narration change for an initial empty preview", () => {
    const machine = createGenerationMachine();

    expect(machine.observe(snapshot({ status: "queued", partialNarration: null })))
      .toMatchObject({ kind: "accepted", narrationChanged: false });
  });

  it("ignores exact duplicates but accepts progressive narration at the same rank", () => {
    const machine = createGenerationMachine();
    const generating = snapshot({ status: "generating", partialNarration: "The gate groans." });

    expect(machine.observe(generating)).toMatchObject({ kind: "accepted", narrationChanged: true });
    expect(machine.observe(generating)).toEqual({ kind: "duplicate" });
    expect(machine.observe(snapshot({ status: "generating", partialNarration: "The gate groans open." })))
      .toMatchObject({ kind: "accepted", narrationChanged: true });
  });

  it("emits a narration change when the current narration is cleared", () => {
    const machine = createGenerationMachine();
    machine.observe(snapshot({ status: "generating", partialNarration: "The gate groans." }));

    expect(machine.observe(snapshot({ status: "generating", partialNarration: null })))
      .toMatchObject({ kind: "accepted", narrationChanged: true });
  });

  it("accepts skipped stages and rejects a lower high-water mark as stale", () => {
    const machine = createGenerationMachine();

    expect(machine.observe(snapshot({ status: "committing" }))).toMatchObject({ kind: "accepted" });
    expect(machine.observe(snapshot({ status: "generating" }))).toEqual({ kind: "stale" });
  });

  it("emits narration only when partial narration changes, not for a status or error update", () => {
    const machine = createGenerationMachine();
    machine.observe(snapshot({ status: "queued", partialNarration: null }));

    expect(machine.observe(snapshot({ status: "assessing", partialNarration: null })))
      .toMatchObject({ kind: "accepted", narrationChanged: false });
    expect(machine.observe(snapshot({ status: "generating", partialNarration: "The gate groans." })))
      .toMatchObject({ kind: "accepted", narrationChanged: true });
    expect(machine.observe(snapshot({ status: "generating", partialNarration: "The gate groans.", errorCode: "generation_failed" })))
      .toMatchObject({ kind: "accepted", narrationChanged: false });
  });

  it("allows the server's same-attempt queue frame only after retry is acknowledged", () => {
    const machine = createGenerationMachine();
    machine.observe(snapshot({ status: "recoverable", attempts: 1 }));

    expect(machine.observe(snapshot({ status: "queued", attempts: 1 }))).toEqual({ kind: "stale" });
    machine.acknowledgeRetry();
    expect(machine.observe(snapshot({ status: "queued", attempts: 1 }))).toMatchObject({ kind: "accepted" });
    expect(machine.observe(snapshot({ status: "assessing", attempts: 2 }))).toMatchObject({ kind: "accepted" });
  });

  it("allows an acknowledged retry from failed through the server's same-attempt queue frame", () => {
    const machine = createGenerationMachine();
    machine.observe(snapshot({ status: "failed", attempts: 1 }));

    machine.acknowledgeRetry();
    expect(machine.observe(snapshot({ status: "queued", attempts: 1 }))).toMatchObject({ kind: "accepted" });
  });

  it("allows a same-rank terminal command transition only after discard is acknowledged", () => {
    const machine = createGenerationMachine();
    machine.observe(snapshot({ status: "failed" }));
    machine.acknowledgeDiscard();

    expect(machine.observe(snapshot({ status: "discarded" }))).toMatchObject({ kind: "accepted" });
  });

  it.each(["completed", "failed", "discarded", "cancelled", "recoverable"] as const)(
    "ranks %s as terminal",
    (status) => {
      const machine = createGenerationMachine();

      expect(machine.observe(snapshot({ status }))).toMatchObject({ kind: "accepted", terminal: true });
    }
  );
});
