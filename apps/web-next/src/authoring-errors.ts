import { authoringFailureSchema, type AuthoringFailure } from "../../../packages/contracts/src/authoring.js";
import { projectAuthoringFailure } from "../../../packages/contracts/src/authoring-error-projection.js";

export function parseAuthoringFailure(value: unknown): AuthoringFailure | null {
  const parsed = authoringFailureSchema.safeParse(value);
  return parsed.success ? projectAuthoringFailure(parsed.data) : null;
}

export function authoringFailureText(failure: AuthoringFailure): string {
  const stage = failure.stage === "world" ? "world" : failure.stage === "character" ? "character" : "character organization";
  const issueText = failure.issues.slice(0, 3).map((issue) => `${issue.path}: ${issue.message}`).join(" ");
  const recovery = failure.retryable ? " You can retry." : " Review the request before trying again.";
  const correlation = failure.correlationId ? ` Correlation ID: ${failure.correlationId}.` : "";
  if (failure.code === "authoring_provider_unavailable" || failure.code === "authoring_provider_timeout") {
    return `The text provider is unavailable while generating this ${stage}.${recovery}${correlation}`;
  }
  return `Generated ${stage} content needs review.${issueText ? ` ${issueText}` : ""}${recovery}${correlation}`;
}
