import { describe, expect, it, vi } from "vitest";

import {
  PreparedRouteTerminalError,
  executePresetRoutes,
  parseRetryAfterMilliseconds,
  shouldAdvancePresetRoute,
  type PhysicalAttemptRepository
} from "../../packages/story-engine/src/preset-route-execution.js";

const storyReservation = {
  kind: "story" as const,
  ownerUserId: "00000000-0000-4000-8000-000000000001",
  generationJobId: "00000000-0000-4000-8000-000000000002",
  invocationId: "story-invocation",
  workerId: "worker-a"
};

function attempts(): PhysicalAttemptRepository {
  const rows = new Map<number, any>();
  return {
    async reserve(input) {
      const prior = rows.get(input.candidateOrdinal);
      if (prior) return prior;
      const row = { id: `attempt-${input.candidateOrdinal}`, status: "reserved", ...input };
      rows.set(input.candidateOrdinal, row);
      return row;
    },
    async markDispatched(_reservation, attemptId) {
      const ordinal = Number(attemptId.split("-")[1]);
      const row = { ...rows.get(ordinal), status: "dispatched" };
      rows.set(ordinal, row);
      return row;
    },
    async recordResponseStart(_reservation, attemptId, evidence) {
      const ordinal = Number(attemptId.split("-")[1]);
      const row = { ...rows.get(ordinal), ...evidence };
      rows.set(ordinal, row);
      return row;
    },
    async recordOutput(_reservation, attemptId) {
      const ordinal = Number(attemptId.split("-")[1]);
      const row = { ...rows.get(ordinal), emittedOutput: true };
      rows.set(ordinal, row);
      return row;
    },
    async complete(_reservation, attemptId, completion) {
      const ordinal = Number(attemptId.split("-")[1]);
      const row = { ...rows.get(ordinal), status: "completed", ...completion };
      rows.set(ordinal, row);
      return row;
    }
  };
}

const candidates = [
  { modelId: "model-a", providerPolicy: { order: ["a", "b"], allow_fallbacks: false }, contextWindowTokens: 8_000, maxOutputTokens: 1_000 },
  { modelId: "model-b", providerPolicy: { only: ["b"], data_collection: "deny" as const }, contextWindowTokens: 8_000, maxOutputTokens: 1_000 }
];
const planProvenance = {
  planHash: "a".repeat(64),
  preset: { slug: "story-preset", versionId: "preset-v1", configHash: "b".repeat(64) }
} as const;

describe("preset route execution", () => {
  it("uses candidates in frozen order and advances only after a safe pre-output rate limit", async () => {
    const invoke = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { routeFailureReason: "rate_limit", retryAfterMs: 0 }))
      .mockResolvedValueOnce({ content: "ok", responseId: "response-b", returnedModel: "model-b", returnedProviderRoute: "b", usage: null, reportedCost: null });

    const result = await executePresetRoutes({
      candidates,
      planProvenance,
      logicalReservation: storyReservation,
      attempts: attempts(),
      prepareCandidate: (candidate, candidateOrdinal) => ({ body: JSON.stringify({ model: candidate.modelId, ordinal: candidateOrdinal }), payloadHash: `hash-${candidateOrdinal}` }),
      invoke,
      totalDeadlineMs: 1_000,
      sleep: async () => undefined
    });

    expect(invoke.mock.calls.map(([input]) => [input.candidateOrdinal, input.candidate.modelId])).toEqual([[0, "model-a"], [1, "model-b"]]);
    expect(result.attemptId).toBe("attempt-1");
    expect((result.value as { content: string }).content).toBe("ok");
  });

  it.each([
    ["authentication", false, false],
    ["schema_invalid", false, false],
    ["refusal", false, false],
    ["cancelled", false, false],
    ["deadline", false, false],
    ["ambiguous_transport", false, false],
    ["rate_limit", true, false],
    ["rate_limit", false, true]
  ] as const)("keeps %s terminal with emittedOutput=%s responseStarted=%s", (reason, emittedOutput, responseStarted) => {
    expect(shouldAdvancePresetRoute({ reason, emittedOutput, responseStarted })).toBe(false);
  });

  it.each(["rate_limit", "provider_unavailable", "model_unavailable"] as const)("advances %s before response evidence", (reason) => {
    expect(shouldAdvancePresetRoute({ reason, emittedOutput: false, responseStarted: false })).toBe(true);
  });

  it("does not resend an already dispatched unknown attempt after reclaim", async () => {
    const repository = attempts();
    const prior = await repository.reserve({ logicalReservation: storyReservation, planProvenance, candidateOrdinal: 0, candidate: candidates[0]!, request: { body: "{}", payloadHash: "hash-0" } });
    await repository.markDispatched(storyReservation, prior!.id, "hash-0");
    const invoke = vi.fn();
    await expect(executePresetRoutes({
      candidates: candidates.slice(0, 1), planProvenance, logicalReservation: storyReservation, attempts: repository,
      prepareCandidate: () => ({ body: "{}", payloadHash: "hash-0" }), invoke, totalDeadlineMs: 1_000
    })).rejects.toMatchObject({ code: "prepared_route_unknown_outcome" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("blocks revoked authority before dispatch and leaves the reserved attempt undispatched", async () => {
    const repository = attempts();
    const markDispatched = vi.spyOn(repository, "markDispatched");
    const invoke = vi.fn();
    await expect(executePresetRoutes({
      candidates: candidates.slice(0, 1), planProvenance, logicalReservation: storyReservation, attempts: repository,
      prepareCandidate: () => ({ body: "{}", payloadHash: "hash-0" }),
      beforeDispatch: async () => { throw Object.assign(new Error("revoked"), { routeFailureReason: "authentication" }); },
      invoke, totalDeadlineMs: 1_000
    })).rejects.toMatchObject({ reason: "authentication" });
    expect(markDispatched).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects returned identities outside the frozen candidate and provider policy", async () => {
    const repository = attempts();
    const complete = vi.spyOn(repository, "complete");
    await expect(executePresetRoutes({
      candidates: candidates.slice(0, 1), planProvenance, logicalReservation: storyReservation, attempts: repository,
      prepareCandidate: () => ({ body: "{}", payloadHash: "hash-0" }),
      invoke: async () => ({ content: "wrong", returnedModel: "model-x", returnedProviderRoute: "x", usage: null, reportedCost: null }),
      totalDeadlineMs: 1_000
    })).rejects.toMatchObject({ reason: "invalid_identity" });
    expect(complete).toHaveBeenCalledWith(storyReservation, "attempt-0", expect.objectContaining({
      outcome: "failed", failureReason: "invalid_identity", returnedModel: "model-x", returnedProviderRoute: "x"
    }));
  });

  it("parses Retry-After seconds and dates against the supplied clock", () => {
    const now = Date.parse("2026-09-20T12:00:00.000Z");
    expect(parseRetryAfterMilliseconds("1.5", now)).toBe(1_500);
    expect(parseRetryAfterMilliseconds("Sun, 20 Sep 2026 12:00:02 GMT", now)).toBe(2_000);
    expect(parseRetryAfterMilliseconds("invalid", now)).toBeNull();
  });

  it("bounds Retry-After by the total deadline", async () => {
    const invoke = vi.fn().mockRejectedValue(Object.assign(new Error("rate limited"), { routeFailureReason: "rate_limit", retryAfterMs: 2_000 }));
    await expect(executePresetRoutes({
      candidates, planProvenance, logicalReservation: storyReservation, attempts: attempts(),
      prepareCandidate: (_candidate, index) => ({ body: "{}", payloadHash: `hash-${index}` }), invoke,
      totalDeadlineMs: 1_000, now: () => 0, sleep: async () => undefined
    })).rejects.toMatchObject({ code: "prepared_route_deadline_exceeded" });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("charges reservation and authority preflight time to the total deadline", async () => {
    let currentTime = 0;
    const repository = attempts();
    const markDispatched = vi.spyOn(repository, "markDispatched");
    const invoke = vi.fn();
    await expect(executePresetRoutes({
      candidates: candidates.slice(0, 1), planProvenance, logicalReservation: storyReservation, attempts: repository,
      prepareCandidate: () => ({ body: "{}", payloadHash: "hash-0" }),
      beforeDispatch: async () => { currentTime = 1_001; },
      invoke, totalDeadlineMs: 1_000, now: () => currentTime
    })).rejects.toMatchObject({ code: "prepared_route_deadline_exceeded", reason: "deadline" });
    expect(markDispatched).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("normalizes an in-flight total-deadline abort as a terminal deadline error", async () => {
    const error = await executePresetRoutes({
      candidates: candidates.slice(0, 1), planProvenance, logicalReservation: storyReservation, attempts: attempts(),
      prepareCandidate: () => ({ body: "{}", payloadHash: "hash-0" }),
      invoke: async ({ signal }) => new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
      totalDeadlineMs: 5
    }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(PreparedRouteTerminalError);
    expect(error).toMatchObject({ code: "prepared_route_deadline_exceeded", reason: "deadline", attemptId: "attempt-0" });
  });

  it("normalizes cancellation during Retry-After as a terminal cancellation error", async () => {
    const controller = new AbortController();
    const error = await executePresetRoutes({
      candidates, planProvenance, logicalReservation: storyReservation, attempts: attempts(),
      prepareCandidate: (_candidate, index) => ({ body: "{}", payloadHash: `hash-${index}` }),
      invoke: async () => { throw Object.assign(new Error("rate limited"), { routeFailureReason: "rate_limit", retryAfterMs: 10 }); },
      totalDeadlineMs: 1_000, signal: controller.signal,
      sleep: async (_milliseconds, signal) => {
        controller.abort(new Error("stop"));
        throw signal.reason;
      }
    }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(PreparedRouteTerminalError);
    expect(error).toMatchObject({ code: "prepared_route_cancelled", reason: "cancelled", attemptId: "attempt-0" });
  });
});
