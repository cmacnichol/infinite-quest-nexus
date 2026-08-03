import { describe, expect, test, vi } from "vitest";
import {
  createGenerationCommandCompatibility,
  mapGenerationApplicationError
} from "../../services/api/src/generation-command-compatibility.js";
import { GenerationApplicationError, type GenerationCommandRepository } from "../../packages/application/src/index.js";
import type {
  GenerationActionResponse,
  GenerationEnqueueResponse,
  GenerationJobStatus,
  GenerationRequest,
  GenerationResult,
  GenerationRetryLatestRequest
} from "../../packages/contracts/src/index.js";
import type { DatabasePool } from "../../packages/database/src/pool.js";
import { logger } from "../../packages/logger/src/index.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const campaignId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";

const request = {
  action: "Open the observatory.",
  idempotencyKey: "append-request-0001"
} as GenerationRequest;
const replacementRequest = {
  ...request,
  expectedCurrentTurnNumber: 3
} as GenerationRetryLatestRequest;

function lifecyclePool() {
  return {
    query: vi.fn(async () => ({
      rows: [{
        generationJobId: jobId,
        campaignId,
        providerProfileId: "44444444-4444-4444-8444-444444444444",
        expectedTurnNumber: 4,
        operationKind: "append",
        jobAttempt: 2
      }]
    }))
  } as unknown as DatabasePool;
}

type RepositoryMethod = keyof GenerationCommandRepository;
type RepositoryRejection = Readonly<{ method: RepositoryMethod; error: Error }>;

function commandRepository(
  calls: Array<{ method: string; scope: unknown; request?: unknown }>,
  rejection?: RepositoryRejection
): GenerationCommandRepository {
  const enqueue = {
    id: jobId,
    status: "queued",
    duplicate: false,
    operationKind: "append",
    replacementTurnId: null
  } as GenerationEnqueueResponse;
  const job = { id: jobId } as GenerationJobStatus;
  const result = { id: jobId } as GenerationResult;
  const mutation = { id: jobId, status: "cancelled", operationKind: "append", replacementTurnId: null } as GenerationActionResponse;
  return {
    enqueueAppend: async (scope, input) => {
      calls.push({ method: "enqueueAppend", scope, request: input });
      if (rejection?.method === "enqueueAppend") throw rejection.error;
      return enqueue;
    },
    enqueueReplacement: async (scope, input) => {
      calls.push({ method: "enqueueReplacement", scope, request: input });
      if (rejection?.method === "enqueueReplacement") throw rejection.error;
      return enqueue;
    },
    getJob: async (scope) => {
      calls.push({ method: "getJob", scope });
      if (rejection?.method === "getJob") throw rejection.error;
      return job;
    },
    getResult: async (scope) => {
      calls.push({ method: "getResult", scope });
      if (rejection?.method === "getResult") throw rejection.error;
      return result;
    },
    retry: async (scope) => {
      calls.push({ method: "retry", scope });
      if (rejection?.method === "retry") throw rejection.error;
      return mutation;
    },
    cancel: async (scope) => {
      calls.push({ method: "cancel", scope });
      if (rejection?.method === "cancel") throw rejection.error;
      return mutation;
    },
    discard: async (scope) => {
      calls.push({ method: "discard", scope });
      if (rejection?.method === "discard") throw rejection.error;
      return mutation;
    }
  };
}

type CompatibilityDelegate =
  | "enqueueGeneration"
  | "enqueueLatestReplacement"
  | "getGenerationJob"
  | "getGenerationResult"
  | "retryGeneration"
  | "cancelGeneration"
  | "discardGeneration";

async function invokeDelegate(
  compatibility: ReturnType<typeof createGenerationCommandCompatibility>,
  delegate: CompatibilityDelegate
) {
  switch (delegate) {
    case "enqueueGeneration": return compatibility.enqueueGeneration(campaignId, request);
    case "enqueueLatestReplacement": return compatibility.enqueueLatestReplacement(campaignId, replacementRequest);
    case "getGenerationJob": return compatibility.getGenerationJob(jobId);
    case "getGenerationResult": return compatibility.getGenerationResult(jobId);
    case "retryGeneration": return compatibility.retryGeneration(jobId);
    case "cancelGeneration": return compatibility.cancelGeneration(jobId);
    case "discardGeneration": return compatibility.discardGeneration(jobId);
  }
}

describe("generation command compatibility", () => {
  test("resolves the server owner and preserves all seven legacy delegate shapes", async () => {
    const calls: Array<{ method: string; scope: unknown; request?: unknown }> = [];
    const pool = lifecyclePool();
    const compatibility = createGenerationCommandCompatibility({
      pool,
      repository: commandRepository(calls),
      initialOwnerId: async (candidate) => {
        expect(candidate).toBe(pool);
        return ownerUserId;
      }
    });
    const infoLog = vi.spyOn(logger, "info").mockImplementation(() => undefined);

    await compatibility.enqueueGeneration(campaignId, request);
    await compatibility.enqueueLatestReplacement(campaignId, replacementRequest);
    await compatibility.getGenerationJob(jobId);
    await compatibility.getGenerationResult(jobId);
    await compatibility.retryGeneration(jobId);
    await compatibility.cancelGeneration(jobId);
    await compatibility.discardGeneration(jobId);

    expect(calls).toEqual([
      { method: "enqueueAppend", scope: { ownerUserId, campaignId }, request },
      { method: "enqueueReplacement", scope: { ownerUserId, campaignId }, request: replacementRequest },
      { method: "getJob", scope: { ownerUserId, jobId } },
      { method: "getResult", scope: { ownerUserId, jobId } },
      { method: "retry", scope: { ownerUserId, jobId } },
      { method: "cancel", scope: { ownerUserId, jobId } },
      { method: "discard", scope: { ownerUserId, jobId } }
    ]);
    infoLog.mockRestore();
  });

  test("rejects unsafe turn input before invoking the repository", async () => {
    const calls: Array<{ method: string; scope: unknown; request?: unknown }> = [];
    const compatibility = createGenerationCommandCompatibility({
      pool: {} as DatabasePool,
      repository: commandRepository(calls),
      initialOwnerId: async () => ownerUserId
    });

    await expect(compatibility.enqueueGeneration(campaignId, {
      ...request,
      action: "I roll a 17 to open the observatory."
    })).rejects.toMatchObject({ statusCode: 400, code: "unsafe_turn_input" });
    expect(calls).toEqual([]);
  });

  test.each([
    ["idempotency_mismatch", {}, 409, "The idempotency key was already used for a different generation request.", undefined],
    ["action_only_mode", {}, 400, "This campaign accepts player actions only.", undefined],
    ["explicit_input_mode_mismatch", {}, 400, "Explicit turn input mode does not match the resolved mode.", undefined],
    ["classification_id_forbidden", {}, 400, "Classification IDs are valid only for Auto input.", undefined],
    ["classification_missing_or_expired", {}, 409, "The Auto classification is missing, expired, consumed, or does not match this input.", undefined],
    ["classification_mode_mismatch", {}, 409, "The submitted turn mode does not match the Auto classification.", undefined],
    ["selected_provider_unavailable", {}, 400, "Enabled text provider profile not found.", undefined],
    ["no_text_provider", {}, 409, "Select a text provider for this campaign or mark a default text provider.", undefined],
    ["stale_current_turn", { actualTurnNumber: 5, expectedTurnNumber: 3 }, 409, "Campaign is at turn 5, not 3.", undefined],
    ["missing_latest_turn", {}, 404, "The latest accepted turn was not found.", undefined],
    ["active_generation", {
      pendingGeneration: { id: jobId, status: "queued", action: "Open the observatory.", operationKind: "append", expectedTurnNumber: 4 }
    }, 409, "This campaign already has an active story generation.", {
      code: "active_generation_exists",
      pendingGeneration: { id: jobId, status: "queued", action: "Open the observatory.", operationKind: "append", expectedTurnNumber: 4 }
    }],
    ["active_illustration", {}, 409, "Wait for the latest turn illustration to finish before retrying the turn.", undefined],
    ["result_not_completed", { generationStatus: "failed" }, 409, "Generation could not be completed.", undefined],
    ["retry_source_state", {}, 409, "Only recoverable or failed generation jobs can be retried.", undefined],
    ["cancel_source_state", {}, 409, "Only active generation jobs can be cancelled.", undefined],
    ["discard_source_state", {}, 409, "Only recoverable or failed generation jobs can be discarded.", undefined]
  ] as const)("maps %s to the established safe HTTP error", (reason, details, statusCode, message, expectedDetails) => {
    const error = mapGenerationApplicationError(new GenerationApplicationError("conflict", { reason, ...details }));
    expect(error).toMatchObject({ statusCode, message });
    expect((error as { details?: unknown }).details).toEqual(expectedDetails);
  });

  test("maps a missing Auto classification ID to its legacy validation response", () => {
    expect(mapGenerationApplicationError(new GenerationApplicationError("invalid_state", {
      reason: "classification_missing_or_expired"
    }))).toMatchObject({ statusCode: 400, message: "Auto input requires a current classification." });
  });

  const pendingGeneration = {
    id: jobId,
    status: "queued",
    action: "Open the observatory.",
    operationKind: "append",
    expectedTurnNumber: 4
  } as const;
  const sharedEnqueueErrors = [
    ["conflict", { reason: "idempotency_mismatch" }, 409, "The idempotency key was already used for a different generation request.", undefined],
    ["invalid_state", { reason: "action_only_mode" }, 400, "This campaign accepts player actions only.", undefined],
    ["invalid_state", { reason: "explicit_input_mode_mismatch" }, 400, "Explicit turn input mode does not match the resolved mode.", undefined],
    ["invalid_state", { reason: "classification_id_forbidden" }, 400, "Classification IDs are valid only for Auto input.", undefined],
    ["conflict", { reason: "classification_missing_or_expired" }, 409, "The Auto classification is missing, expired, consumed, or does not match this input.", undefined],
    ["invalid_state", { reason: "classification_missing_or_expired" }, 400, "Auto input requires a current classification.", undefined],
    ["conflict", { reason: "classification_mode_mismatch" }, 409, "The submitted turn mode does not match the Auto classification.", undefined],
    ["provider_required", { reason: "selected_provider_unavailable" }, 400, "Enabled text provider profile not found.", undefined],
    ["provider_required", { reason: "no_text_provider" }, 409, "Select a text provider for this campaign or mark a default text provider.", undefined],
    ["not_found", { campaignId }, 404, "Campaign not found.", undefined],
    ["active_job", { reason: "active_generation", pendingGeneration }, 409, "This campaign already has an active story generation.", {
      code: "active_generation_exists",
      pendingGeneration
    }]
  ] as const;
  const sharedEnqueueDelegates = [
    ["enqueueGeneration", "enqueueAppend"],
    ["enqueueLatestReplacement", "enqueueReplacement"]
  ] as const;
  const delegateErrorCases = [
    ...sharedEnqueueDelegates.flatMap(([delegate, method]) => sharedEnqueueErrors.map((errorCase) => [delegate, method, ...errorCase] as const)),
    ["enqueueLatestReplacement", "enqueueReplacement", "stale_turn", { reason: "stale_current_turn", actualTurnNumber: 5, expectedTurnNumber: 3 }, 409, "Campaign is at turn 5, not 3.", undefined],
    ["enqueueLatestReplacement", "enqueueReplacement", "not_found", { reason: "missing_latest_turn", campaignId }, 404, "The latest accepted turn was not found.", undefined],
    ["enqueueLatestReplacement", "enqueueReplacement", "active_job", { reason: "active_illustration" }, 409, "Wait for the latest turn illustration to finish before retrying the turn.", undefined],
    ["getGenerationJob", "getJob", "not_found", { jobId }, 404, "Generation job not found.", undefined],
    ["getGenerationResult", "getResult", "not_found", { jobId }, 404, "Generation job not found.", undefined],
    ["retryGeneration", "retry", "not_found", { jobId }, 404, "Generation job not found.", undefined],
    ["cancelGeneration", "cancel", "not_found", { jobId }, 404, "Generation job not found.", undefined],
    ["discardGeneration", "discard", "not_found", { jobId }, 404, "Generation job not found.", undefined],
    ["getGenerationResult", "getResult", "invalid_state", { reason: "result_not_completed", generationStatus: "failed" }, 409, "Generation could not be completed.", undefined],
    ["retryGeneration", "retry", "invalid_state", { reason: "retry_source_state" }, 409, "Only recoverable or failed generation jobs can be retried.", undefined],
    ["cancelGeneration", "cancel", "invalid_state", { reason: "cancel_source_state" }, 409, "Only active generation jobs can be cancelled.", undefined],
    ["discardGeneration", "discard", "invalid_state", { reason: "discard_source_state" }, 409, "Only recoverable or failed generation jobs can be discarded.", undefined]
  ] as const;

  test.each(delegateErrorCases)("maps %s repository errors through the %s owner-scoped delegate", async (
    delegate,
    method,
    kind,
    details,
    statusCode,
    message,
    expectedDetails
  ) => {
    const calls: Array<{ method: string; scope: unknown; request?: unknown }> = [];
    const compatibility = createGenerationCommandCompatibility({
      pool: lifecyclePool(),
      repository: commandRepository(calls, {
        method,
        error: new GenerationApplicationError(kind, details)
      }),
      initialOwnerId: async () => ownerUserId
    });

    const error = await invokeDelegate(compatibility, delegate).then(
      () => undefined,
      (rejection: unknown) => rejection
    );

    expect(error).toMatchObject({ statusCode, message });
    expect((error as { details?: unknown }).details).toEqual(expectedDetails);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method });
  });

  test("preserves retry and cancellation lifecycle logs from the legacy service boundary", async () => {
    const repository = commandRepository([]);
    repository.retry = async () => ({
      id: jobId,
      status: "queued" as const,
      operationKind: "append" as const,
      replacementTurnId: null
    });
    repository.cancel = async () => ({
      id: jobId,
      status: "cancelled" as const,
      operationKind: "append" as const,
      replacementTurnId: null
    });
    const pool = lifecyclePool();
    const compatibility = createGenerationCommandCompatibility({
      pool,
      repository,
      initialOwnerId: async () => ownerUserId
    });
    const infoLog = vi.spyOn(logger, "info").mockImplementation(() => undefined);

    const requeued = await compatibility.retryGeneration(jobId);
    const cancelled = await compatibility.cancelGeneration(jobId);

    expect(requeued).toEqual({
      id: jobId,
      status: "queued",
      operationKind: "append",
      replacementTurnId: null
    });
    expect(cancelled).toEqual({
      id: jobId,
      status: "cancelled",
      operationKind: "append",
      replacementTurnId: null
    });

    expect(infoLog).toHaveBeenNthCalledWith(1, {
      event: "turn_generation_requeued",
      generationJobId: jobId,
      campaignId,
      providerProfileId: "44444444-4444-4444-8444-444444444444",
      expectedTurnNumber: 4,
      operationKind: "append",
      jobAttempt: 2
    });
    expect(infoLog).toHaveBeenNthCalledWith(2, {
      event: "turn_generation_cancelled",
      generationJobId: jobId,
      campaignId,
      operationKind: "append"
    });
    expect(pool.query).toHaveBeenCalledTimes(2);
    infoLog.mockRestore();
  });

  test("loads lifecycle context before retry and cancellation mutations", async () => {
    const events: string[] = [];
    const repository = commandRepository([]);
    repository.retry = async () => {
      events.push("retry");
      return { id: jobId, status: "queued", operationKind: "append", replacementTurnId: null };
    };
    repository.cancel = async () => {
      events.push("cancel");
      return { id: jobId, status: "cancelled", operationKind: "append", replacementTurnId: null };
    };
    const pool = {
      query: vi.fn(async () => {
        events.push("context");
        return {
          rows: [{
            generationJobId: jobId,
            campaignId,
            providerProfileId: "44444444-4444-4444-8444-444444444444",
            expectedTurnNumber: 4,
            operationKind: "append",
            jobAttempt: 2
          }]
        };
      })
    } as unknown as DatabasePool;
    const compatibility = createGenerationCommandCompatibility({
      pool,
      repository,
      initialOwnerId: async () => ownerUserId
    });
    const infoLog = vi.spyOn(logger, "info").mockImplementation(() => undefined);

    await compatibility.retryGeneration(jobId);
    await compatibility.cancelGeneration(jobId);

    expect(events).toEqual(["context", "retry", "context", "cancel"]);
    infoLog.mockRestore();
  });

  test("does not mutate when lifecycle context cannot be loaded", async () => {
    const calls: Array<{ method: string; scope: unknown; request?: unknown }> = [];
    const unavailable = new Error("database socket closed");
    const compatibility = createGenerationCommandCompatibility({
      pool: { query: vi.fn(async () => { throw unavailable; }) } as unknown as DatabasePool,
      repository: commandRepository(calls),
      initialOwnerId: async () => ownerUserId
    });

    await expect(compatibility.retryGeneration(jobId)).rejects.toBe(unavailable);
    await expect(compatibility.cancelGeneration(jobId)).rejects.toBe(unavailable);
    expect(calls).toEqual([]);
  });

  test("returns not-found errors without exposing cross-owner job data and preserves unknown failures", async () => {
    expect(mapGenerationApplicationError(new GenerationApplicationError("not_found", { jobId })))
      .toMatchObject({ statusCode: 404, message: "Generation job not found." });
    expect(mapGenerationApplicationError(new GenerationApplicationError("not_found", { campaignId })))
      .toMatchObject({ statusCode: 404, message: "Campaign not found." });

    const unknown = new Error("database socket closed");
    const repository = commandRepository([]);
    repository.getJob = async () => { throw unknown; };
    const compatibility = createGenerationCommandCompatibility({
      pool: {} as DatabasePool,
      repository,
      initialOwnerId: async () => ownerUserId
    });
    await expect(compatibility.getGenerationJob(jobId)).rejects.toBe(unknown);
  });
});
