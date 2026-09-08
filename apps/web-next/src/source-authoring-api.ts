import { authoringJobListItemSchema, authoringJobViewSchema, authoringSourceSynthesisSchema, type AuthoringJobView } from "../../../packages/contracts/src/authoring.js";
import { sourceAuthoringInputSchema, sourceFactReviewSchema, type SourceAuthoringInput, type SourceFactReview } from "../../../packages/contracts/src/source-authoring.js";

type Fetch = typeof globalThis.fetch;

const sourceErrorMessages = {
  authoring_revision_conflict: "The source review changed elsewhere. Compare the reviews before saving again.",
  authoring_idempotency_conflict: "This key belongs to a different source request. Start a new proposal for edited source.",
  authoring_input_too_large: "The source exceeds the durable input limit.",
  authoring_active_job_limit: "Finish, cancel, or discard an existing proposal before creating another.",
  choose_source_facts: "Choose at least one supported source fact before synthesis.",
  authoring_apply_unavailable: "Applying this source proposal is not available yet.",
  authoring_invalid_request: "The source authoring request is invalid.",
  authoring_invalid_state: "This source job cannot accept that command in its current state.",
  authoring_not_found: "This source proposal is unavailable or expired.",
  authoring_disabled: "Durable source authoring is not enabled.",
  source_authoring_disabled: "Story-source execution is paused. You can still inspect, review, apply, cancel, or discard this retained proposal."
} as const;

export type SourceAuthoringErrorCode = keyof typeof sourceErrorMessages | "unknown";

/** Fixed client-owned messages prevent server or provider details from reaching the page. */
export class SourceAuthoringApiError extends Error {
  constructor(readonly code: SourceAuthoringErrorCode, readonly status: number) {
    super(code === "unknown" ? "The source authoring request could not be completed. Try again." : sourceErrorMessages[code]);
    this.name = "SourceAuthoringApiError";
  }
}

function allowlistedCode(value: unknown): SourceAuthoringErrorCode {
  if (!value || typeof value !== "object" || !("code" in value)) return "unknown";
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" && Object.hasOwn(sourceErrorMessages, code) ? code as keyof typeof sourceErrorMessages : "unknown";
}

async function responseJson(response: Response): Promise<unknown> {
  let value: unknown;
  try { value = await response.json(); } catch { throw new SourceAuthoringApiError("unknown", response.status); }
  if (!response.ok) throw new SourceAuthoringApiError(allowlistedCode(value), response.status);
  return value;
}

function parsedJob(value: unknown): AuthoringJobView {
  try { return authoringJobViewSchema.parse(value); } catch { throw new SourceAuthoringApiError("unknown", 200); }
}

function body(input: unknown): RequestInit {
  return { headers: { "content-type": "application/json" }, body: JSON.stringify(input) };
}

export interface SourceAuthoringApi {
  submitSourceAuthoring(input: SourceAuthoringInput, signal?: AbortSignal): Promise<AuthoringJobView>;
  saveSourceFactReview(id: string, input: SourceFactReview, signal?: AbortSignal): Promise<AuthoringJobView>;
  beginSourceSynthesis(id: string, expectedRevision: number, signal?: AbortSignal): Promise<AuthoringJobView>;
}

/** Deliberately separate from generic authoring endpoints so source review cannot drift onto concept routes. */
export function createSourceAuthoringApi(fetchImplementation: Fetch = globalThis.fetch): SourceAuthoringApi {
  const sourceJobId = (id: string) => encodeURIComponent(authoringJobListItemSchema.shape.id.parse(id));
  return {
    async submitSourceAuthoring(input, signal) {
      const request = sourceAuthoringInputSchema.parse(input);
      return parsedJob(await responseJson(await fetchImplementation("/api/v1/authoring/source-jobs", { method: "POST", signal, ...body(request) })));
    },
    async saveSourceFactReview(id, input, signal) {
      const request = sourceFactReviewSchema.parse(input);
      return parsedJob(await responseJson(await fetchImplementation(`/api/v1/authoring/source-jobs/${sourceJobId(id)}/facts`, { method: "PUT", signal, ...body(request) })));
    },
    async beginSourceSynthesis(id, expectedRevision, signal) {
      const request = authoringSourceSynthesisSchema.parse({ expectedRevision });
      return parsedJob(await responseJson(await fetchImplementation(`/api/v1/authoring/source-jobs/${sourceJobId(id)}/synthesis`, { method: "POST", signal, ...body(request) })));
    }
  };
}
