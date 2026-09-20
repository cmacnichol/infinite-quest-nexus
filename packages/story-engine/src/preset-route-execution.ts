import type { TextRouteCandidate } from "../../contracts/src/text-execution-plan.js";
import type { ReportedProviderCost } from "./providers.js";

export type LogicalReservation =
  | Readonly<{ kind: "story"; ownerUserId: string; generationJobId: string; invocationId: string; workerId: string }>
  | Readonly<{ kind: "authoring"; ownerUserId: string; jobId: string; stageId: string; jobGeneration: number; stageGeneration: number; leaseToken: string; operation: "initial" | "repair" }>
  | Readonly<{ kind: "illustration"; ownerUserId: string; promptJobId: string; claimAttempt: number; leaseOwner: string; operation: "initial" | "repair" }>
  | Readonly<{ kind: "direct"; ownerUserId: string; requestScopeId: string; operation: "initial" | "repair" }>;

export type PreparedPhysicalRequest = Readonly<{ body: string; payloadHash: string }>;

export type PhysicalAttemptStatus = "reserved" | "dispatched" | "completed";

export type PhysicalAttemptRecord = Readonly<{
  id: string;
  status: PhysicalAttemptStatus;
  logicalReservation: LogicalReservation;
  candidateOrdinal: number;
  candidate: TextRouteCandidate;
  request: PreparedPhysicalRequest;
  responseStarted?: boolean;
  providerResponseId?: string | null;
  returnedModel?: string | null;
  returnedProviderRoute?: string | null;
}>;

export type PhysicalAttemptUsage = Readonly<{ inputTokens: number; outputTokens: number; totalTokens: number }> | null;

export type PhysicalAttemptRepository = Readonly<{
  reserve(input: Readonly<{
    logicalReservation: LogicalReservation;
    candidateOrdinal: number;
    candidate: TextRouteCandidate;
    request: PreparedPhysicalRequest;
  }>): Promise<PhysicalAttemptRecord | null>;
  markDispatched(reservation: LogicalReservation, attemptId: string, expectedPayloadHash: string): Promise<PhysicalAttemptRecord | null>;
  recordResponseStart(reservation: LogicalReservation, attemptId: string, evidence: Readonly<{
    providerResponseId: string | null;
    returnedModel?: string | null;
    returnedProviderRoute?: string | null;
  }>): Promise<PhysicalAttemptRecord | null>;
  complete(reservation: LogicalReservation, attemptId: string, completion: Readonly<{
    outcome: "succeeded" | "failed";
    failureReason?: PresetRouteFailureReason;
    providerResponseId: string | null;
    returnedModel: string | null;
    returnedProviderRoute: string | null;
    usage: PhysicalAttemptUsage;
    reportedCost: ReportedProviderCost | null;
  }>): Promise<PhysicalAttemptRecord | null>;
}>;

export type PresetRouteFailureReason =
  | "rate_limit"
  | "provider_unavailable"
  | "model_unavailable"
  | "authentication"
  | "schema_invalid"
  | "refusal"
  | "cancelled"
  | "deadline"
  | "ambiguous_transport"
  | "invalid_identity"
  | "unknown";

export type PresetRouteFailure = Readonly<{
  reason: PresetRouteFailureReason;
  emittedOutput: boolean;
  responseStarted: boolean;
}>;

const SAFE_PRE_OUTPUT_FAILURES = new Set<PresetRouteFailureReason>([
  "rate_limit",
  "provider_unavailable",
  "model_unavailable"
]);

export function shouldAdvancePresetRoute(failure: PresetRouteFailure): boolean {
  return !failure.emittedOutput && !failure.responseStarted && SAFE_PRE_OUTPUT_FAILURES.has(failure.reason);
}

export function parseRetryAfterMilliseconds(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  const fromSeconds = Math.round(seconds * 1_000);
  if (Number.isSafeInteger(fromSeconds) && fromSeconds >= 0) return fromSeconds;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  const delay = Math.max(0, at - now);
  return Number.isSafeInteger(delay) ? delay : null;
}

export class PreparedRouteTerminalError extends Error {
  readonly code: string;
  readonly reason: PresetRouteFailureReason;
  readonly attemptId: string | null;

  constructor(code: string, reason: PresetRouteFailureReason, message: string, attemptId: string | null = null, options?: ErrorOptions) {
    super(message, options);
    this.name = "PreparedRouteTerminalError";
    this.code = code;
    this.reason = reason;
    this.attemptId = attemptId;
  }
}

type RouteFailureCarrier = Readonly<{
  routeFailureReason?: unknown;
  reason?: unknown;
  retryAfterMs?: unknown;
  responseId?: unknown;
  returnedModel?: unknown;
  returnedProviderRoute?: unknown;
  partialContent?: unknown;
  diagnosticCode?: unknown;
}>;

function safeIdentity(value: unknown): string | null {
  return typeof value === "string" && value.trim() && value.length <= 256 ? value : null;
}

export function classifyPresetRouteFailure(error: unknown): Readonly<PresetRouteFailure & {
  retryAfterMs: number | null;
  providerResponseId: string | null;
  returnedModel: string | null;
  returnedProviderRoute: string | null;
}> {
  const source = error && typeof error === "object" ? error as RouteFailureCarrier & { statusCode?: unknown; code?: unknown; name?: unknown } : {};
  const suppliedReason = source.routeFailureReason ?? source.reason;
  const supplied = typeof suppliedReason === "string" && [
    "rate_limit", "provider_unavailable", "model_unavailable", "authentication", "schema_invalid", "refusal",
    "cancelled", "deadline", "ambiguous_transport", "invalid_identity", "unknown"
  ].includes(suppliedReason) ? suppliedReason as PresetRouteFailureReason : null;
  const statusCode = Number(source.statusCode);
  const code = String(source.code ?? "");
  const diagnosticCode = String(source.diagnosticCode ?? "");
  const name = String(source.name ?? "");
  const reason = supplied
    ?? (/provider_request_timeout|provider_transport_error/i.test(code) ? "ambiguous_transport"
      : /provider_refusal/i.test(diagnosticCode) ? "refusal"
        : /provider_schema|response_format|schema/i.test(diagnosticCode) ? "schema_invalid"
          : /provider_route_unavailable/i.test(diagnosticCode) ? "provider_unavailable"
      : statusCode === 429 ? "rate_limit"
      : statusCode === 401 || statusCode === 403 ? "authentication"
        : statusCode === 404 ? "model_unavailable"
          : statusCode === 502 || statusCode === 503 ? "provider_unavailable"
            : /refusal|content_filter/i.test(code) ? "refusal"
              : /schema|response_contract|structured/i.test(code) ? "schema_invalid"
                : /AbortError|cancel/i.test(`${name} ${code}`) ? "cancelled"
                  : /timeout|transport/i.test(`${name} ${code}`) ? "ambiguous_transport" : "unknown");
  return {
    reason,
    emittedOutput: typeof source.partialContent === "string" && source.partialContent.length > 0,
    responseStarted: safeIdentity(source.responseId) !== null,
    retryAfterMs: Number.isSafeInteger(source.retryAfterMs) && Number(source.retryAfterMs) >= 0 ? Number(source.retryAfterMs) : null,
    providerResponseId: safeIdentity(source.responseId),
    returnedModel: safeIdentity(source.returnedModel),
    returnedProviderRoute: safeIdentity(source.returnedProviderRoute)
  };
}

function assertReturnedIdentity(candidate: TextRouteCandidate, value: Readonly<{ returnedModel?: string | null; returnedProviderRoute?: string | null }>): void {
  if (value.returnedModel && value.returnedModel !== candidate.modelId) {
    throw new PreparedRouteTerminalError("prepared_route_identity_mismatch", "invalid_identity", "The provider returned a model outside the frozen route candidate.");
  }
  const provider = value.returnedProviderRoute;
  if (!provider) return;
  if (candidate.providerPolicy.only && !candidate.providerPolicy.only.includes(provider)) {
    throw new PreparedRouteTerminalError("prepared_route_identity_mismatch", "invalid_identity", "The provider returned a route outside the frozen provider policy.");
  }
  if (candidate.providerPolicy.ignore?.includes(provider)) {
    throw new PreparedRouteTerminalError("prepared_route_identity_mismatch", "invalid_identity", "The provider returned an ignored route.");
  }
}

function deadlineSignal(signal: AbortSignal | undefined, remainingMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, remainingMs));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function executePresetRoutes<T extends Readonly<{
  providerResponseId?: string | null;
  responseId?: string | null;
  returnedModel?: string | null;
  returnedProviderRoute?: string | null;
  usage?: PhysicalAttemptUsage;
  reportedCost?: ReportedProviderCost | null;
  usageReported?: boolean;
}>>(input: Readonly<{
  candidates: readonly TextRouteCandidate[];
  logicalReservation: LogicalReservation;
  attempts: PhysicalAttemptRepository;
  prepareCandidate(candidate: TextRouteCandidate, candidateOrdinal: number): PreparedPhysicalRequest;
  beforeDispatch?(candidate: TextRouteCandidate, candidateOrdinal: number): Promise<void>;
  invoke(request: Readonly<{
    candidate: TextRouteCandidate;
    candidateOrdinal: number;
    preparedRequest: PreparedPhysicalRequest;
    signal: AbortSignal;
    onResponseStart(evidence: Readonly<{ providerResponseId: string | null; returnedModel?: string | null; returnedProviderRoute?: string | null }>): Promise<void>;
    onOutput(delta: string): void;
  }>): Promise<T>;
  totalDeadlineMs: number;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}>): Promise<Readonly<{ value: T; attemptId: string; candidateOrdinal: number }>> {
  if (!input.candidates.length) throw new PreparedRouteTerminalError("prepared_route_exhausted", "unknown", "The frozen route has no candidates.");
  if (!Number.isSafeInteger(input.totalDeadlineMs) || input.totalDeadlineMs <= 0) {
    throw new PreparedRouteTerminalError("prepared_route_deadline_invalid", "deadline", "The prepared route deadline is invalid.");
  }
  const now = input.now ?? Date.now;
  const startedAt = now();
  const sleep = input.sleep ?? ((milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  }));
  let lastFailure: PresetRouteFailureReason = "unknown";
  for (let candidateOrdinal = 0; candidateOrdinal < input.candidates.length; candidateOrdinal += 1) {
    const candidate = input.candidates[candidateOrdinal]!;
    const remaining = input.totalDeadlineMs - (now() - startedAt);
    if (remaining <= 0) throw new PreparedRouteTerminalError("prepared_route_deadline_exceeded", "deadline", "The prepared route deadline elapsed.");
    if (input.signal?.aborted) throw new PreparedRouteTerminalError("prepared_route_cancelled", "cancelled", "The prepared route was cancelled.");
    const preparedRequest = input.prepareCandidate(candidate, candidateOrdinal);
    const attempt = await input.attempts.reserve({ logicalReservation: input.logicalReservation, candidateOrdinal, candidate, request: preparedRequest });
    if (!attempt) throw new PreparedRouteTerminalError("prepared_route_lease_lost", "cancelled", "The logical reservation no longer has a live claim.");
    if (attempt.status !== "reserved") {
      throw new PreparedRouteTerminalError("prepared_route_unknown_outcome", "ambiguous_transport", "A dispatched physical attempt cannot be resent or advanced.", attempt.id);
    }
    if (input.beforeDispatch) {
      try {
        await input.beforeDispatch(candidate, candidateOrdinal);
      } catch (error) {
        const failure = classifyPresetRouteFailure(error);
        throw new PreparedRouteTerminalError("prepared_route_preflight_failed", failure.reason,
          "The prepared route failed current dispatch authority checks.", attempt.id, { cause: error });
      }
    }
    const dispatchRemaining = input.totalDeadlineMs - (now() - startedAt);
    if (dispatchRemaining <= 0) {
      throw new PreparedRouteTerminalError("prepared_route_deadline_exceeded", "deadline", "The prepared route deadline elapsed before dispatch.", attempt.id);
    }
    if (input.signal?.aborted) {
      throw new PreparedRouteTerminalError("prepared_route_cancelled", "cancelled", "The prepared route was cancelled before dispatch.", attempt.id);
    }
    const dispatched = await input.attempts.markDispatched(input.logicalReservation, attempt.id, preparedRequest.payloadHash);
    if (!dispatched || dispatched.status !== "dispatched") {
      throw new PreparedRouteTerminalError("prepared_route_lease_lost", "cancelled", "The physical attempt lost its dispatch claim.", attempt.id);
    }
    let emittedOutput = false;
    let responseStarted = false;
    let responseEvidence: { providerResponseId: string | null; returnedModel: string | null; returnedProviderRoute: string | null } = {
      providerResponseId: null, returnedModel: null, returnedProviderRoute: null
    };
    const wireRemaining = input.totalDeadlineMs - (now() - startedAt);
    const signal = deadlineSignal(input.signal, wireRemaining);
    try {
      if (wireRemaining <= 0) {
        throw Object.assign(new Error("The prepared route deadline elapsed after dispatch."), { routeFailureReason: "deadline" });
      }
      if (input.signal?.aborted) {
        throw Object.assign(new Error("The prepared route was cancelled after dispatch."), { routeFailureReason: "cancelled" });
      }
      const value = await input.invoke({
        candidate, candidateOrdinal, preparedRequest, signal,
        onOutput(delta) { if (delta.length) emittedOutput = true; },
        async onResponseStart(evidence) {
          responseStarted = true;
          responseEvidence = {
            providerResponseId: evidence.providerResponseId,
            returnedModel: evidence.returnedModel ?? null,
            returnedProviderRoute: evidence.returnedProviderRoute ?? null
          };
          const recorded = await input.attempts.recordResponseStart(input.logicalReservation, attempt.id, responseEvidence);
          if (!recorded) throw new PreparedRouteTerminalError("prepared_route_lease_lost", "cancelled", "The response-start evidence lost its logical lease.", attempt.id);
        }
      });
      assertReturnedIdentity(candidate, value);
      const providerResponseId = value.providerResponseId ?? value.responseId ?? responseEvidence.providerResponseId;
      const completed = await input.attempts.complete(input.logicalReservation, attempt.id, {
        outcome: "succeeded", providerResponseId: providerResponseId ?? null,
        returnedModel: value.returnedModel ?? responseEvidence.returnedModel,
        returnedProviderRoute: value.returnedProviderRoute ?? responseEvidence.returnedProviderRoute,
        usage: value.usageReported === false ? null : value.usage ?? null,
        reportedCost: value.reportedCost ?? null
      });
      if (!completed) throw new PreparedRouteTerminalError("prepared_route_lease_lost", "cancelled", "The physical attempt completion lost its logical lease.", attempt.id);
      return { value, attemptId: attempt.id, candidateOrdinal };
    } catch (error) {
      if (error instanceof PreparedRouteTerminalError && error.code === "prepared_route_lease_lost") throw error;
      const failure = classifyPresetRouteFailure(error);
      const observed = {
        ...failure,
        emittedOutput: emittedOutput || failure.emittedOutput,
        responseStarted: responseStarted || failure.responseStarted
      };
      lastFailure = observed.reason;
      const failed = await input.attempts.complete(input.logicalReservation, attempt.id, {
        outcome: "failed", failureReason: observed.reason,
        providerResponseId: failure.providerResponseId ?? responseEvidence.providerResponseId,
        returnedModel: failure.returnedModel ?? responseEvidence.returnedModel,
        returnedProviderRoute: failure.returnedProviderRoute ?? responseEvidence.returnedProviderRoute,
        usage: null, reportedCost: null
      });
      if (!failed) {
        throw new PreparedRouteTerminalError("prepared_route_lease_lost", "cancelled", "The failed physical attempt lost its logical lease.", attempt.id, { cause: error });
      }
      if (!shouldAdvancePresetRoute(observed) || candidateOrdinal === input.candidates.length - 1) {
        const code = observed.reason === "cancelled" ? "prepared_route_cancelled"
          : observed.reason === "deadline" ? "prepared_route_deadline_exceeded"
            : candidateOrdinal === input.candidates.length - 1 && shouldAdvancePresetRoute(observed) ? "prepared_route_exhausted"
              : "prepared_route_terminal";
        throw new PreparedRouteTerminalError(code, observed.reason, "The prepared route sequence ended without a safe next candidate.", attempt.id, { cause: error });
      }
      const delay = failure.retryAfterMs ?? 0;
      const afterFailureRemaining = input.totalDeadlineMs - (now() - startedAt);
      if (delay >= afterFailureRemaining) {
        throw new PreparedRouteTerminalError("prepared_route_deadline_exceeded", "deadline", "Retry-After exceeds the prepared route deadline.", attempt.id, { cause: error });
      }
      if (delay > 0) await sleep(delay, deadlineSignal(input.signal, afterFailureRemaining));
    }
  }
  throw new PreparedRouteTerminalError("prepared_route_exhausted", lastFailure, "The prepared route candidates were exhausted.");
}
