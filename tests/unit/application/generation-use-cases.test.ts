import { describe, expect, expectTypeOf, test } from "vitest";
import {
  createGenerationApplication,
  createGenerationWorkerApplication,
  GenerationApplicationError,
  type ClaimedGeneration,
  type GenerationClaimRepository,
  type GenerationCommandRepository,
  type GenerationExecutor,
  type GenerationApplicationErrorDetails
} from "../../../packages/application/src/index.js";
import type {
  GenerationActionResponse,
  GenerationEnqueueResponse,
  GenerationJobStatus,
  GenerationRequest,
  GenerationResult,
  GenerationRetryLatestRequest
} from "../../../packages/contracts/src/index.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const campaignId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";

declare const typeOnlyApplication: ReturnType<typeof createGenerationApplication>;

const appendClaim = {
  jobId,
  ownerUserId,
  campaignId,
  providerProfileId: "44444444-4444-4444-8444-444444444444",
  expectedTurnNumber: 4,
  attempts: 2,
  operationKind: "append",
  replacementTurnId: null
} satisfies ClaimedGeneration;

const replacementClaim = {
  ...appendClaim,
  operationKind: "replace_latest",
  replacementTurnId: "55555555-5555-4555-8555-555555555555"
} satisfies ClaimedGeneration;

// @ts-expect-error append claims cannot name a replacement turn.
const invalidAppendClaim: ClaimedGeneration = { ...appendClaim, replacementTurnId: "55555555-5555-4555-8555-555555555555" };
// @ts-expect-error replacement claims require a replacement turn.
const invalidReplacementClaim: ClaimedGeneration = { ...replacementClaim, replacementTurnId: null };
void invalidAppendClaim;
void invalidReplacementClaim;

describe("generation application use cases", () => {
  test("keeps command error reasons and their safe details typed and readonly", () => {
    const pendingGeneration = {
      id: jobId,
      status: "queued",
      action: "Open the observatory",
      operationKind: "append",
      expectedTurnNumber: 4
    } as const;
    const details = {
      reason: "active_generation",
      pendingGeneration,
      expectedTurnNumber: 4,
      actualTurnNumber: 3,
      generationStatus: "queued"
    } satisfies GenerationApplicationErrorDetails;

    const error = new GenerationApplicationError("active_job", details);
    expect(error.details).toEqual(details);
    if (false) {
      // @ts-expect-error Error details are immutable application data.
      details.pendingGeneration.status = "completed";
      // @ts-expect-error Error detail reasons remain a closed discriminated union.
      const invalid: GenerationApplicationErrorDetails = { reason: "provider_error" };
      void invalid;
    }
  });

  test("forwards all command and query calls to the command repository without mutation", async () => {
    const enqueueResult = { id: jobId, status: "queued", duplicate: false, operationKind: "append", replacementTurnId: null } as GenerationEnqueueResponse;
    const job = { id: jobId } as GenerationJobStatus;
    const result = { id: jobId } as GenerationResult;
    const mutation = { id: jobId, status: "cancelled", operationKind: "append", replacementTurnId: null } as GenerationActionResponse;
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const repository: GenerationCommandRepository = {
      enqueueAppend: async (...args) => { calls.push({ method: "enqueueAppend", args }); return enqueueResult; },
      enqueueReplacement: async (...args) => { calls.push({ method: "enqueueReplacement", args }); return enqueueResult; },
      getJob: async (...args) => { calls.push({ method: "getJob", args }); return job; },
      getResult: async (...args) => { calls.push({ method: "getResult", args }); return result; },
      retry: async (...args) => { calls.push({ method: "retry", args }); return mutation; },
      cancel: async (...args) => { calls.push({ method: "cancel", args }); return mutation; },
      discard: async (...args) => { calls.push({ method: "discard", args }); return mutation; }
    };
    const application = createGenerationApplication(repository);
    const campaignScope = Object.freeze({ ownerUserId, campaignId });
    const jobScope = Object.freeze({ ownerUserId, jobId });
    const request = Object.freeze({ action: "Open the observatory", idempotencyKey: "append-request-0001" }) as GenerationRequest;
    const replacementRequest = Object.freeze({ ...request, expectedCurrentTurnNumber: 3 }) as GenerationRetryLatestRequest;

    await expect(application.enqueueAppend(campaignScope, request)).resolves.toBe(enqueueResult);
    await expect(application.enqueueReplacement(campaignScope, replacementRequest)).resolves.toBe(enqueueResult);
    await expect(application.getJob(jobScope)).resolves.toBe(job);
    await expect(application.getResult(jobScope)).resolves.toBe(result);
    await expect(application.retry(jobScope)).resolves.toBe(mutation);
    await expect(application.cancel(jobScope)).resolves.toBe(mutation);
    await expect(application.discard(jobScope)).resolves.toBe(mutation);

    expect(calls).toEqual([
      { method: "enqueueAppend", args: [campaignScope, request] },
      { method: "enqueueReplacement", args: [campaignScope, replacementRequest] },
      { method: "getJob", args: [jobScope] },
      { method: "getResult", args: [jobScope] },
      { method: "retry", args: [jobScope] },
      { method: "cancel", args: [jobScope] },
      { method: "discard", args: [jobScope] }
    ]);
  });

  test("keeps claim and execution adapters separate while preserving claimed ownership", async () => {
    const calls: Array<{ method: string; value: unknown }> = [];
    const claims: GenerationClaimRepository = {
      claimNext: async (request) => { calls.push({ method: "claimNext", value: request }); return replacementClaim; }
    };
    const executor: GenerationExecutor = {
      execute: async (request) => { calls.push({ method: "execute", value: request }); return true; }
    };
    const worker = createGenerationWorkerApplication({ claims, executor });
    const claimRequest = Object.freeze({ workerId: "worker-a", leaseSeconds: 30 });
    const executionRequest = Object.freeze({ workerId: "worker-a", leaseSeconds: 30, claim: replacementClaim });

    await expect(worker.claimNext(claimRequest)).resolves.toBe(replacementClaim);
    await expect(worker.executeClaimed(executionRequest)).resolves.toBe(true);
    expect(calls).toEqual([
      { method: "claimNext", value: claimRequest },
      { method: "execute", value: executionRequest }
    ]);
    expect(executionRequest.claim.ownerUserId).toBe(ownerUserId);
  });

  test("preserves typed errors and does not rewrite unknown adapter failures", async () => {
    const typedError = new GenerationApplicationError("conflict", { jobId });
    const unknownError = new Error("adapter unavailable");
    const repository: GenerationCommandRepository = {
      enqueueAppend: async () => { throw typedError; },
      enqueueReplacement: async () => { throw unknownError; },
      getJob: async () => { throw unknownError; },
      getResult: async () => { throw unknownError; },
      retry: async () => { throw unknownError; },
      cancel: async () => { throw unknownError; },
      discard: async () => { throw unknownError; }
    };
    const application = createGenerationApplication(repository);
    const campaignScope = { ownerUserId, campaignId };
    const request = { action: "Open the observatory", idempotencyKey: "append-request-0001" } as GenerationRequest;
    const replacementRequest = { ...request, expectedCurrentTurnNumber: 3 } as GenerationRetryLatestRequest;

    await expect(application.enqueueAppend(campaignScope, request)).rejects.toBe(typedError);
    await expect(application.enqueueReplacement(campaignScope, replacementRequest)).rejects.toBe(unknownError);
    expect(typedError.kind).toBe("conflict");
  });

  test("requires owner-scoped campaign and job inputs", () => {
    const request = { action: "Open the observatory", idempotencyKey: "append-request-0001" } as GenerationRequest;
    if (false) {
      // @ts-expect-error campaign operations require the owner scope.
      void typeOnlyApplication.enqueueAppend({ campaignId }, request);
      // @ts-expect-error job operations require the owner scope.
      void typeOnlyApplication.getJob({ jobId });
    }
    expectTypeOf<Parameters<ReturnType<typeof createGenerationApplication>["enqueueAppend"]>[0]>()
      .toMatchTypeOf<Readonly<{ ownerUserId: string; campaignId: string }>>();
    expectTypeOf<Parameters<ReturnType<typeof createGenerationApplication>["getJob"]>[0]>()
      .toMatchTypeOf<Readonly<{ ownerUserId: string; jobId: string }>>();
    expectTypeOf<typeof appendClaim>().toMatchTypeOf<ClaimedGeneration>();
  });
});
