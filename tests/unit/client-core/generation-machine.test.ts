import { copySnapshot } from "../../../packages/client-core/src/generation/projection.js";
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
  it("retains failure reasons in copied snapshots and observes diagnostic updates", () => {
    const machine = createGenerationMachine();
    const failed = snapshot({ status: "failed", errorCode: "generation_failed", errorMessage: "Generation could not be completed." });
    machine.observe(failed);
    const failureDiagnostic = { code: "provider_rate_limited" as const, message: "The provider rate limit was reached. Wait before retrying." };
    for (const operation of [{ operationKind: "append" as const, replacementTurnId: null },
      { operationKind: "replace_latest" as const, replacementTurnId: "33333333-3333-4333-8333-333333333333" }]) {
      const copied = copySnapshot(snapshot({ ...operation, failureDiagnostic }));
      expect(copied.failureDiagnostic).toEqual(failureDiagnostic);
      expect(copied.failureDiagnostic).not.toBe(failureDiagnostic);
    }
    expect(machine.observe({ ...failed, failureDiagnostic })).toMatchObject({ kind: "accepted", snapshot: { failureDiagnostic } });
  });
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

  it("accepts a same-rank status update when only the finite response-format projection changes", () => {
    const machine = createGenerationMachine();
    machine.observe(snapshot({
      status: "generating",
      responseFormat: {
        version: 1,
        savedPolicy: "required",
        effectiveMode: "unknown",
        schemaVersion: null,
        schemaHash: null,
        operation: "story",
        streaming: true,
        requestedModel: "saved-model",
        returnedModel: null,
        returnedRoute: null,
        preflight: "pending",
        preflightDiagnostic: null,
        diagnosticCode: null
      }
    }));

    expect(machine.observe(snapshot({
      status: "generating",
      responseFormat: {
        version: 1,
        savedPolicy: "required",
        effectiveMode: "unavailable",
        schemaVersion: null,
        schemaHash: null,
        operation: "story",
        streaming: true,
        requestedModel: "saved-model",
        returnedModel: null,
        returnedRoute: null,
        preflight: "unavailable",
        preflightDiagnostic: "unsupported_adapter",
        diagnosticCode: null
      }
    }))).toMatchObject({
      kind: "accepted",
      narrationChanged: false,
      snapshot: { responseFormat: { preflightDiagnostic: "unsupported_adapter" } }
    });
  });

  it("compares v2 requested selection and observed serving identity without conflating them", () => {
    const machine = createGenerationMachine();
    const responseFormat = {
      version: 2 as const,
      savedPolicy: "required" as const,
      effectiveMode: "json_schema" as const,
      schemaVersion: "story-v2",
      schemaHash: "a".repeat(64),
      operation: "story" as const,
      streaming: true,
      requestedSelection: { kind: "openrouter_preset" as const, slug: "night-shift" },
      assurance: "trusted_preset" as const,
      actualServedIdentity: { status: "unknown" as const, model: null, providerRoute: null },
      preflight: "selected" as const,
      preflightDiagnostic: null,
      diagnosticCode: null
    };
    const first = snapshot({ status: "generating", responseFormat });
    machine.observe(first);
    expect(machine.observe(first)).toEqual({ kind: "duplicate" });
    expect(machine.observe(snapshot({
      status: "generating",
      responseFormat: {
        ...responseFormat,
        actualServedIdentity: { status: "known", model: "served-model", providerRoute: "served-route" }
      }
    }))).toMatchObject({ kind: "accepted", narrationChanged: false });
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

describe("provider failure snapshot changes", () => {
  const providerFailure = { version: 1 as const, source: "http_error" as const, httpStatus: 429, upstreamStatus: null,
    reason: "rate_limit" as const, limitSource: "unknown" as const, retryAfterMs: null, retryAt: null };
  const failureDiagnostic = { code: "provider_rate_limited" as const,
    message: "The provider rate limit was reached. Wait before retrying.", providerFailure };
  it("copies nested evidence for both operation kinds", () => {
    for (const operation of [{ operationKind: "append" as const, replacementTurnId: null },
      { operationKind: "replace_latest" as const, replacementTurnId: "33333333-3333-4333-8333-333333333333" }]) {
      const copied = copySnapshot(snapshot({ ...operation, failureDiagnostic }));
      expect(copied.failureDiagnostic?.providerFailure).toEqual(providerFailure);
      expect(copied.failureDiagnostic?.providerFailure).not.toBe(providerFailure);
    }
  });
  it.each([
    { version: 2 }, { source: "sse_error" }, { httpStatus: 200 }, { upstreamStatus: 429 },
    { reason: "provider_unavailable" }, { limitSource: "upstream_provider" }, { retryAfterMs: 0 },
    { retryAt: "2026-10-03T15:00:15.000Z" }
  ])("observes every evidence field change: %j", (change) => {
    const machine = createGenerationMachine();
    machine.observe(snapshot({ status: "failed", failureDiagnostic }));
    expect(machine.observe(snapshot({ status: "failed", failureDiagnostic: {
      ...failureDiagnostic, providerFailure: { ...providerFailure, ...change } as never
    } }))).toMatchObject({ kind: "accepted" });
  });
  it("retains its own nested evidence when a caller mutates an observed snapshot", () => {
    const machine = createGenerationMachine();
    const input = snapshot({ status: "failed", failureDiagnostic: { ...failureDiagnostic, providerFailure: { ...providerFailure } } });
    machine.observe(input);
    input.failureDiagnostic!.providerFailure!.httpStatus = 503;
    expect(machine.observe(input)).toMatchObject({ kind: "accepted" });
  });
});
