import { describe, expect, test } from "vitest";
import {
  createGenerationApplicationAdapter,
  mapGenerationApplicationError,
  type GenerationApplicationAdapter,
  type GenerationHttpError
} from "../../services/api/src/generation-application-adapter.js";
import { mapGenerationApplicationError as mapCompatibilityGenerationApplicationError } from "../../services/api/src/generation-command-compatibility.js";
import {
  GenerationApplicationError,
  type EnqueueGenerationResult,
  type GenerationApplication,
  type GenerationApplicationErrorDetails,
  type GenerationApplicationErrorKind,
  type GenerationApplicationErrorReason,
  type GenerationJob,
  type GenerationMutationResult,
  type OwnerScope
} from "../../packages/application/src/index.js";
import type {
  GenerationRequest,
  GenerationResult,
  GenerationRetryLatestRequest
} from "../../packages/contracts/src/index.js";
import { isSafeGenerationDiagnosticErrorCode } from "../../services/api/src/generation-diagnostics.js";

const ownerScope: OwnerScope = { ownerUserId: "11111111-1111-4111-8111-111111111111" };
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
const pendingGeneration = {
  id: jobId,
  status: "queued",
  action: request.action,
  operationKind: "append",
  expectedTurnNumber: 4
} as const;

type MappingFixture = Readonly<{
  kind: GenerationApplicationErrorKind;
  details: Omit<GenerationApplicationErrorDetails, "reason">;
  expectedStatusCode: number;
  expectedMessage: string;
  expectedDetails?: unknown;
}>;

const mappingFixtures: Record<GenerationApplicationErrorReason, MappingFixture> = {
  idempotency_mismatch: { kind: "conflict", details: {}, expectedStatusCode: 409, expectedMessage: "The idempotency key was already used for a different generation request." },
  action_only_mode: { kind: "invalid_state", details: {}, expectedStatusCode: 400, expectedMessage: "This campaign accepts player actions only." },
  explicit_input_mode_mismatch: { kind: "invalid_state", details: {}, expectedStatusCode: 400, expectedMessage: "Explicit turn input mode does not match the resolved mode." },
  classification_id_forbidden: { kind: "invalid_state", details: {}, expectedStatusCode: 400, expectedMessage: "Classification IDs are valid only for Auto input." },
  classification_missing_or_expired: { kind: "conflict", details: {}, expectedStatusCode: 409, expectedMessage: "The Auto classification is missing, expired, consumed, or does not match this input." },
  classification_mode_mismatch: { kind: "conflict", details: {}, expectedStatusCode: 409, expectedMessage: "The submitted turn mode does not match the Auto classification." },
  selected_provider_unavailable: { kind: "provider_required", details: {}, expectedStatusCode: 400, expectedMessage: "Enabled text provider profile not found." },
  no_text_provider: { kind: "provider_required", details: {}, expectedStatusCode: 409, expectedMessage: "Select a text provider for this campaign or mark a default text provider." },
  stale_current_turn: { kind: "stale_turn", details: { actualTurnNumber: 5, expectedTurnNumber: 3 }, expectedStatusCode: 409, expectedMessage: "Campaign is at turn 5, not 3." },
  missing_latest_turn: { kind: "not_found", details: {}, expectedStatusCode: 404, expectedMessage: "The latest accepted turn was not found." },
  active_generation: {
    kind: "active_job",
    details: { pendingGeneration },
    expectedStatusCode: 409,
    expectedMessage: "This campaign already has an active story generation.",
    expectedDetails: { code: "active_generation_exists", pendingGeneration }
  },
  active_illustration: { kind: "active_job", details: {}, expectedStatusCode: 409, expectedMessage: "Wait for the latest turn illustration to finish before retrying the turn." },
  result_not_completed: { kind: "invalid_state", details: { generationStatus: "failed" }, expectedStatusCode: 409, expectedMessage: "Generation could not be completed." },
  retry_source_state: { kind: "invalid_state", details: {}, expectedStatusCode: 409, expectedMessage: "Only recoverable or failed generation jobs can be retried." },
  cancel_source_state: { kind: "invalid_state", details: {}, expectedStatusCode: 409, expectedMessage: "Only active generation jobs can be cancelled." },
  discard_source_state: { kind: "invalid_state", details: {}, expectedStatusCode: 409, expectedMessage: "Only recoverable or failed generation jobs can be discarded." }
};

function errorSnapshot(error: GenerationHttpError) {
  return {
    name: error.name,
    message: error.message,
    statusCode: error.statusCode,
    details: error.details,
    hasTopLevelCode: Object.prototype.hasOwnProperty.call(error, "code"),
  };
}

function expectedSnapshot(fixture: MappingFixture) {
  return {
    name: "Error",
    message: fixture.expectedMessage,
    statusCode: fixture.expectedStatusCode,
    details: fixture.expectedDetails,
    hasTopLevelCode: false
  };
}

type ApplicationMethod = keyof GenerationApplication;
type AdapterMethod = keyof GenerationApplicationAdapter;
type ApplicationCall = Readonly<{ method: ApplicationMethod; scope: unknown; request?: unknown }>;

function applicationFake(
  calls: ApplicationCall[],
  rejection?: Readonly<{ method: ApplicationMethod; error: Error }>
) {
  const successes = {
    enqueueAppend: { id: jobId, status: "queued", duplicate: false, operationKind: "append", replacementTurnId: null } as EnqueueGenerationResult,
    enqueueReplacement: { id: jobId, status: "queued", duplicate: false, operationKind: "replace_latest", replacementTurnId: "44444444-4444-4444-8444-444444444444" } as EnqueueGenerationResult,
    getJob: { id: jobId } as GenerationJob,
    getResult: { id: jobId } as GenerationResult,
    retry: { id: jobId, status: "queued", operationKind: "append", replacementTurnId: null } as GenerationMutationResult,
    cancel: { id: jobId, status: "cancelled", operationKind: "append", replacementTurnId: null } as GenerationMutationResult,
    discard: { id: jobId, status: "discarded", operationKind: "append", replacementTurnId: null } as GenerationMutationResult
  };
  const rejected = (method: ApplicationMethod) => {
    if (rejection?.method === method) throw rejection.error;
  };
  const application: GenerationApplication = {
    async enqueueAppend(scope, input) { calls.push({ method: "enqueueAppend", scope, request: input }); rejected("enqueueAppend"); return successes.enqueueAppend; },
    async enqueueReplacement(scope, input) { calls.push({ method: "enqueueReplacement", scope, request: input }); rejected("enqueueReplacement"); return successes.enqueueReplacement; },
    async getJob(scope) { calls.push({ method: "getJob", scope }); rejected("getJob"); return successes.getJob; },
    async getResult(scope) { calls.push({ method: "getResult", scope }); rejected("getResult"); return successes.getResult; },
    async retry(scope) { calls.push({ method: "retry", scope }); rejected("retry"); return successes.retry; },
    async cancel(scope) { calls.push({ method: "cancel", scope }); rejected("cancel"); return successes.cancel; },
    async discard(scope) { calls.push({ method: "discard", scope }); rejected("discard"); return successes.discard; }
  };
  return { application, successes };
}

async function invoke(adapter: GenerationApplicationAdapter, method: AdapterMethod) {
  switch (method) {
    case "enqueueGeneration": return adapter.enqueueGeneration(ownerScope, campaignId, request);
    case "enqueueLatestReplacement": return adapter.enqueueLatestReplacement(ownerScope, campaignId, replacementRequest);
    case "getGenerationJob": return adapter.getGenerationJob(ownerScope, jobId);
    case "getGenerationResult": return adapter.getGenerationResult(ownerScope, jobId);
    case "retryGeneration": return adapter.retryGeneration(ownerScope, jobId);
    case "cancelGeneration": return adapter.cancelGeneration(ownerScope, jobId);
    case "discardGeneration": return adapter.discardGeneration(ownerScope, jobId);
  }
}

const adapterCases = [
  ["enqueueGeneration", "enqueueAppend", { ownerUserId: ownerScope.ownerUserId, campaignId }, request],
  ["enqueueLatestReplacement", "enqueueReplacement", { ownerUserId: ownerScope.ownerUserId, campaignId }, replacementRequest],
  ["getGenerationJob", "getJob", { ownerUserId: ownerScope.ownerUserId, jobId }, undefined],
  ["getGenerationResult", "getResult", { ownerUserId: ownerScope.ownerUserId, jobId }, undefined],
  ["retryGeneration", "retry", { ownerUserId: ownerScope.ownerUserId, jobId }, undefined],
  ["cancelGeneration", "cancel", { ownerUserId: ownerScope.ownerUserId, jobId }, undefined],
  ["discardGeneration", "discard", { ownerUserId: ownerScope.ownerUserId, jobId }, undefined]
] as const satisfies ReadonlyArray<readonly [AdapterMethod, ApplicationMethod, unknown, unknown]>;

describe("generation application adapter", () => {
  test.each(Object.entries(mappingFixtures) as Array<[GenerationApplicationErrorReason, MappingFixture]>)
  ("maps %s with the legacy transport snapshot", (reason, fixture) => {
    const applicationError = new GenerationApplicationError(fixture.kind, { reason, ...fixture.details });
    const mapped = mapGenerationApplicationError(applicationError);

    expect(errorSnapshot(mapped)).toEqual(expectedSnapshot(fixture));
    expect(errorSnapshot(mapped)).toEqual(errorSnapshot(mapCompatibilityGenerationApplicationError(applicationError)));
  });

  test.each([
    ["missing Auto classification validation", "invalid_state", { reason: "classification_missing_or_expired" }, 400, "Auto input requires a current classification.", undefined],
    ["missing Auto classification conflict", "conflict", { reason: "classification_missing_or_expired" }, 409, "The Auto classification is missing, expired, consumed, or does not match this input.", undefined],
    ...(["failed", "recoverable", "cancelled", "discarded"] as const).map((generationStatus) => ["terminal result " + generationStatus, "invalid_state", { reason: "result_not_completed", generationStatus }, 409, "Generation could not be completed.", undefined] as const),
    ["non-terminal result", "invalid_state", { reason: "result_not_completed", generationStatus: "generating" }, 409, "Generation is generating.", undefined],
    ["concrete stale turn", "stale_turn", { reason: "stale_current_turn", actualTurnNumber: 9, expectedTurnNumber: 6 }, 409, "Campaign is at turn 9, not 6.", undefined],
    ["active generation without pending job", "active_job", { reason: "active_generation" }, 409, "This campaign already has an active story generation.", { code: "active_generation_exists", pendingGeneration: null }],
    ["not found campaign", "not_found", { campaignId }, 404, "Campaign not found.", undefined],
    ["not found job", "not_found", { jobId }, 404, "Generation job not found.", undefined],
    ["generic fallback", "invalid_state", {}, 409, "Generation command could not be completed.", undefined]
  ] as const)("maps %s with exact legacy parity", (_label, kind, details, statusCode, message, detailsOutput) => {
    const applicationError = new GenerationApplicationError(kind, details);
    const mapped = mapGenerationApplicationError(applicationError);
    expect(errorSnapshot(mapped)).toEqual({ name: "Error", message, statusCode, details: detailsOutput, hasTopLevelCode: false });
    expect(errorSnapshot(mapped)).toEqual(errorSnapshot(mapCompatibilityGenerationApplicationError(applicationError)));
  });

  test("shares the active-generation diagnostic allowlist without exposing a top-level code", () => {
    const mapped = mapGenerationApplicationError(new GenerationApplicationError("active_job", {
      reason: "active_generation",
      pendingGeneration
    }));
    const code = (mapped.details as { code: unknown }).code;
    expect(typeof code).toBe("string");
    expect(isSafeGenerationDiagnosticErrorCode(code as string)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(mapped, "code")).toBe(false);
  });

  test.each(adapterCases)("delegates %s exactly once with the owner-scoped application input", async (adapterMethod, applicationMethod, scope, input) => {
    const calls: ApplicationCall[] = [];
    const { application, successes } = applicationFake(calls);
    const result = await invoke(createGenerationApplicationAdapter(application), adapterMethod);

    expect(result).toBe(successes[applicationMethod]);
    expect(calls).toEqual(input === undefined
      ? [{ method: applicationMethod, scope }]
      : [{ method: applicationMethod, scope, request: input }]);
  });

  test.each(adapterCases)("maps typed application errors from %s", async (adapterMethod, applicationMethod) => {
    const calls: ApplicationCall[] = [];
    const error = new GenerationApplicationError("active_job", { reason: "active_generation", pendingGeneration });
    const { application } = applicationFake(calls, { method: applicationMethod, error });

    await expect(invoke(createGenerationApplicationAdapter(application), adapterMethod)).rejects.toSatisfy((received) => {
      expect(errorSnapshot(received as GenerationHttpError)).toEqual(errorSnapshot(mapGenerationApplicationError(error)));
      return true;
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe(applicationMethod);
  });

  test.each(adapterCases)("rethrows arbitrary errors by identity from %s", async (adapterMethod, applicationMethod) => {
    const calls: ApplicationCall[] = [];
    const error = new Error("arbitrary failure");
    const { application } = applicationFake(calls, { method: applicationMethod, error });

    await expect(invoke(createGenerationApplicationAdapter(application), adapterMethod)).rejects.toBe(error);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe(applicationMethod);
  });
});
