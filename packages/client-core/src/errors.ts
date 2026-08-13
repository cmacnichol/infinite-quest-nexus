export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export class NexusApiError extends Error {
  readonly statusCode: number;
  readonly correlationId: string | null;
  readonly errorName: string;
  readonly domainCode: string | null;
  readonly details: unknown;
  readonly issues: unknown;
  readonly retryAfter: string | null;

  constructor(message: string, options: {
    statusCode: number;
    correlationId?: string | null;
    errorName?: string;
    domainCode?: string | null;
    details?: unknown;
    issues?: unknown;
    retryAfter?: string | null;
  }) {
    super(message);
    this.name = "NexusApiError";
    this.statusCode = options.statusCode;
    this.correlationId = options.correlationId ?? null;
    this.errorName = options.errorName ?? "NexusApiError";
    this.domainCode = options.domainCode ?? null;
    this.details = options.details ?? null;
    this.issues = options.issues ?? null;
    this.retryAfter = options.retryAfter?.trim() || null;
  }
}

export type ApiContractErrorPhase = "request" | "response";
export type ApiContractErrorKind =
  | "request_schema_mismatch"
  | "malformed_json"
  | "response_schema_mismatch"
  | "unexpected_empty_response";

export class ApiContractError extends Error {
  readonly phase: ApiContractErrorPhase;
  readonly kind: ApiContractErrorKind;
  readonly method: HttpMethod;
  readonly path: string;
  readonly statusCode: number | null;
  readonly correlationId: string | null;
  readonly issues: unknown;

  constructor(message: string, options: {
    phase: ApiContractErrorPhase;
    kind: ApiContractErrorKind;
    method: HttpMethod;
    path: string;
    statusCode?: number | null;
    correlationId?: string | null;
    issues?: unknown;
    cause?: unknown;
  }) {
    if (options.cause === undefined) {
      super(message);
    } else {
      super(message, { cause: options.cause });
    }
    this.name = "ApiContractError";
    this.phase = options.phase;
    this.kind = options.kind;
    this.method = options.method;
    this.path = options.path;
    this.statusCode = options.statusCode ?? null;
    this.correlationId = options.correlationId ?? null;
    this.issues = options.issues ?? null;
  }
}
