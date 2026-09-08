import {
  authoringApplyReceiptSchema,
  authoringApplySchema,
  authoringCapabilitiesSchema,
  authoringJobPageSchema,
  authoringJobListItemSchema,
  authoringJobListQuerySchema,
  authoringJobViewSchema,
  authoringRetrySchema,
  authoringRevisionCommandSchema,
  authoringReviewSchema,
  authoringSubmitSchema,
  type AuthoringApply,
  type AuthoringApplyReceipt,
  type AuthoringCapabilities,
  type AuthoringJobPage,
  type AuthoringJobView,
  type AuthoringRetry,
  type AuthoringRevisionCommand,
  type AuthoringReview,
  type AuthoringSubmit
} from "../../../packages/contracts/src/authoring.js";

export type AuthoringJobsApiErrorKind = "unavailable" | "source_paused" | "conflict" | "not_found" | "request_failed";

/** Deliberately excludes server response text because it can contain provider details. */
export class AuthoringJobsApiError extends Error {
  constructor(readonly kind: AuthoringJobsApiErrorKind, readonly status: number) {
    super(kind === "unavailable"
      ? "Authoring jobs are unavailable. Try again."
      : kind === "source_paused"
        ? "Story-source execution is paused. You can still inspect, review, apply, cancel, or discard this retained proposal."
      : kind === "conflict"
        ? "This proposal changed elsewhere. Reload or compare before saving."
        : kind === "not_found"
          ? "This authoring proposal is unavailable or expired."
          : "The authoring request could not be completed. Try again.");
    this.name = "AuthoringJobsApiError";
  }
}

type Fetch = typeof globalThis.fetch;

function errorFor(status: number, body?: unknown): AuthoringJobsApiError {
  const sourcePaused = body !== null && typeof body === "object" && "code" in body && (body as { code?: unknown }).code === "source_authoring_disabled";
  return new AuthoringJobsApiError(sourcePaused ? "source_paused" : status === 409 ? "conflict" : status === 404 ? "not_found" : status === 503 ? "unavailable" : "request_failed", status);
}

async function responseJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    let body: unknown = null;
    try { body = await response.json(); } catch { /* status remains authoritative */ }
    throw errorFor(response.status, body);
  }
  try {
    return await response.json();
  } catch {
    throw new AuthoringJobsApiError("request_failed", response.status);
  }
}

function parseResponse<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try { return schema.parse(value); } catch { throw new AuthoringJobsApiError("request_failed", 200); }
}

function body(input: unknown): RequestInit {
  return { headers: { "content-type": "application/json" }, body: JSON.stringify(input) };
}

export interface AuthoringJobsApi {
  loadAuthoringCapabilities(signal?: AbortSignal): Promise<AuthoringCapabilities>;
  submitAuthoringJob(input: AuthoringSubmit, signal?: AbortSignal): Promise<AuthoringJobView>;
  loadAuthoringJob(id: string, signal?: AbortSignal): Promise<AuthoringJobView>;
  listAuthoringJobs(cursor?: string, signal?: AbortSignal): Promise<AuthoringJobPage>;
  saveAuthoringReview(id: string, input: AuthoringReview, signal?: AbortSignal): Promise<AuthoringJobView>;
  retryAuthoringStage(id: string, input: AuthoringRetry, signal?: AbortSignal): Promise<AuthoringJobView>;
  cancelAuthoringJob(id: string, input: AuthoringRevisionCommand, signal?: AbortSignal): Promise<AuthoringJobView>;
  discardAuthoringJob(id: string, input: AuthoringRevisionCommand, signal?: AbortSignal): Promise<void>;
  applyAuthoringJob(id: string, input: AuthoringApply, signal?: AbortSignal): Promise<AuthoringApplyReceipt>;
}

export function createAuthoringJobsApi(fetchImplementation: Fetch = globalThis.fetch): AuthoringJobsApi {
  return {
    async loadAuthoringCapabilities(signal) {
      return parseResponse(authoringCapabilitiesSchema, await responseJson(await fetchImplementation("/api/v1/authoring/capabilities", { signal })));
    },
    async submitAuthoringJob(input, signal) {
      const request = authoringSubmitSchema.parse(input);
      return parseResponse(authoringJobViewSchema, await responseJson(await fetchImplementation("/api/v1/authoring/jobs", { method: "POST", signal, ...body(request) })));
    },
    async loadAuthoringJob(id, signal) {
      return parseResponse(authoringJobViewSchema, await responseJson(await fetchImplementation(`/api/v1/authoring/jobs/${encodeURIComponent(authoringJobListItemSchema.shape.id.parse(id))}`, { signal })));
    },
    async listAuthoringJobs(cursor, signal) {
      const queryInput = authoringJobListQuerySchema.parse(cursor === undefined ? {} : { cursor });
      const query = queryInput.cursor ? `?cursor=${encodeURIComponent(queryInput.cursor)}` : "";
      return parseResponse(authoringJobPageSchema, await responseJson(await fetchImplementation(`/api/v1/authoring/jobs${query}`, { signal })));
    },
    async saveAuthoringReview(id, input, signal) {
      const request = authoringReviewSchema.parse(input);
      return parseResponse(authoringJobViewSchema, await responseJson(await fetchImplementation(`/api/v1/authoring/jobs/${encodeURIComponent(authoringJobListItemSchema.shape.id.parse(id))}/review`, { method: "PUT", signal, ...body(request) })));
    },
    async retryAuthoringStage(id, input, signal) {
      const request = authoringRetrySchema.parse(input);
      return parseResponse(authoringJobViewSchema, await responseJson(await fetchImplementation(`/api/v1/authoring/jobs/${encodeURIComponent(authoringJobListItemSchema.shape.id.parse(id))}/retry`, { method: "POST", signal, ...body(request) })));
    },
    async cancelAuthoringJob(id, input, signal) {
      const request = authoringRevisionCommandSchema.parse(input);
      return parseResponse(authoringJobViewSchema, await responseJson(await fetchImplementation(`/api/v1/authoring/jobs/${encodeURIComponent(authoringJobListItemSchema.shape.id.parse(id))}/cancel`, { method: "POST", signal, ...body(request) })));
    },
    async discardAuthoringJob(id, input, signal) {
      const request = authoringRevisionCommandSchema.parse(input);
      const response = await fetchImplementation(`/api/v1/authoring/jobs/${encodeURIComponent(authoringJobListItemSchema.shape.id.parse(id))}`, { method: "DELETE", signal, ...body(request) });
      if (!response.ok) throw errorFor(response.status);
    },
    async applyAuthoringJob(id, input, signal) {
      const request = authoringApplySchema.parse(input);
      return parseResponse(authoringApplyReceiptSchema, await responseJson(await fetchImplementation(`/api/v1/authoring/jobs/${encodeURIComponent(authoringJobListItemSchema.shape.id.parse(id))}/apply`, { method: "POST", signal, ...body(request) })));
    }
  };
}
