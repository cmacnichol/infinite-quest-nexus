import type { AuthoringFailure, AuthoringIssue, AuthoringStage } from "../../../packages/contracts/src/authoring.js";
import { projectAuthoringIssues } from "../../../packages/domain/src/authoring-output.js";
import { ProviderDestinationNotAllowedError } from "../../../packages/security/src/provider-network-policy.js";
import {
  ProviderHttpError,
  ProviderTransportError,
  type ProviderResult
} from "../../../packages/story-engine/src/providers.js";
import { ProviderResponseTooLargeError } from "../../../packages/story-engine/src/provider-response.js";

const MAX_GENERATION_CALLS = 4;
const MAX_TRANSPORT_ATTEMPTS_PER_RESPONSE = 2;
const MAX_REJECTED_RESPONSE_CODE_POINTS = 16_000;
const RETRY_DELAY_MS = 1_000;
const MAX_RETRY_AFTER_MS = 5_000;

export type AuthoringAttempt = {
  repair: boolean;
  issues: AuthoringIssue[];
  rejectedResponse?: string;
};

export class AuthoringResponseError extends Error {
  readonly authoringFailure: AuthoringFailure;
  readonly expose = true;
  readonly statusCode: 413 | 502 | 503 | 504;

  constructor(authoringFailure: AuthoringFailure) {
    super(authoringFailureMessage(authoringFailure));
    this.name = "AuthoringResponseError";
    this.authoringFailure = authoringFailure;
    this.statusCode = authoringFailureStatusCode(authoringFailure);
  }
}

function authoringFailureStatusCode(failure: AuthoringFailure): 413 | 502 | 503 | 504 {
  switch (failure.code) {
    case "authoring_context_exceeded": return 413;
    case "authoring_provider_unavailable": return 503;
    case "authoring_provider_timeout": return 504;
    default: return 502;
  }
}

function authoringFailureMessage(failure: AuthoringFailure): string {
  switch (failure.code) {
    case "authoring_output_limit": return "Generated output was incomplete. Try again.";
    case "authoring_provider_unavailable": return "The text provider is temporarily unavailable. Try again.";
    case "authoring_provider_timeout": return "The text provider timed out. Try again.";
    case "authoring_context_exceeded": return "The authoring request exceeds the provider context limit.";
    case "authoring_provider_rejected": return "The text provider rejected the authoring request.";
    case "invalid_authoring_output": return "Generated content did not meet the required format.";
    case "authoring_conflict": return "The authoring proposal changed. Refresh and try again.";
    case "authoring_expired": return "This authoring proposal has expired.";
    case "authoring_cancelled": return "This authoring proposal was cancelled.";
    case "authoring_retry_exhausted": return "This stage has exhausted its retry limit. Create a new proposal.";
    case "authoring_apply_unavailable": return "Applying authoring proposals is not available yet.";
  }
}

function failure(stage: AuthoringStage, code: AuthoringFailure["code"], retryable: boolean, issues: AuthoringIssue[] = []): AuthoringResponseError {
  return new AuthoringResponseError({ code, stage, retryable, issues });
}

function boundedRejectedResponse(content: string): string {
  const codePoints = Array.from(content);
  if (codePoints.length <= MAX_REJECTED_RESPONSE_CODE_POINTS) return content;
  const marker = "[diagnostic truncated]";
  return `${codePoints.slice(0, MAX_REJECTED_RESPONSE_CODE_POINTS - Array.from(marker).length).join("")}${marker}`;
}

function stageFallbackPath(stage: AuthoringStage): string {
  if (stage === "character") return "generatedCharacter";
  if (stage === "organizer") return "profile";
  return "generatedWorld";
}

function stageIssues(stage: AuthoringStage, issues: AuthoringIssue[]): AuthoringIssue[] {
  return issues.map((issue) => issue.path === "generatedWorld"
    ? { ...issue, path: stageFallbackPath(stage) }
    : issue).slice(0, 20);
}

function limitedIssue(stage: AuthoringStage): AuthoringIssue {
  return {
    path: stageFallbackPath(stage),
    code: "custom",
    message: "Generated output was truncated before completion."
  };
}

type RetryDecision = Readonly<{ retry: boolean; delayMs: number; code: AuthoringFailure["code"] }>;

function retryDecision(error: unknown): RetryDecision | null {
  if (error instanceof ProviderResponseTooLargeError) {
    return { retry: false, delayMs: 0, code: "authoring_output_limit" };
  }
  if (error instanceof ProviderTransportError) {
    return { retry: true, delayMs: RETRY_DELAY_MS, code: error.code === "provider_request_timeout" ? "authoring_provider_timeout" : "authoring_provider_unavailable" };
  }
  if (error instanceof ProviderHttpError) {
    if (error.statusCode === 408 || error.statusCode === 504) {
      return { retry: true, delayMs: retryDelay(error.retryAfterMs), code: "authoring_provider_timeout" };
    }
    if ([429, 502, 503].includes(error.statusCode)) {
      return { retry: true, delayMs: retryDelay(error.retryAfterMs), code: "authoring_provider_unavailable" };
    }
    if (error.statusCode === 413) return { retry: false, delayMs: 0, code: "authoring_context_exceeded" };
    return { retry: false, delayMs: 0, code: "authoring_provider_rejected" };
  }
  if (error instanceof ProviderDestinationNotAllowedError) {
    return { retry: false, delayMs: 0, code: "authoring_provider_rejected" };
  }
  return null;
}

function retryDelay(retryAfterMs: number | null): number {
  return retryAfterMs !== null && retryAfterMs <= MAX_RETRY_AFTER_MS ? Math.max(0, retryAfterMs) : RETRY_DELAY_MS;
}

function recognizedOutputIssues(error: unknown): AuthoringIssue[] | null {
  const issues = projectAuthoringIssues(error);
  return issues.length ? issues : null;
}

export async function runAuthoringResponse<T>(options: {
  stage: AuthoringStage;
  request(attempt: AuthoringAttempt): Promise<ProviderResult>;
  parse(content: string): T;
  delay(milliseconds: number): Promise<void>;
  /** Durable callers fence each paid request and accepted response to a live claim. */
  currentClaim?(): Promise<boolean>;
}): Promise<T> {
  let generationCalls = 0;
  let repair = false;
  let issues: AuthoringIssue[] = [];
  let rejectedResponse: string | undefined;

  while (true) {
    let result: ProviderResult | undefined;
    let transportAttempts = 0;
    while (transportAttempts < MAX_TRANSPORT_ATTEMPTS_PER_RESPONSE && generationCalls < MAX_GENERATION_CALLS) {
      if (options.currentClaim && !await options.currentClaim()) {
        throw failure(options.stage, "authoring_cancelled", false);
      }
      generationCalls += 1;
      transportAttempts += 1;
      try {
        result = await options.request({
          repair,
          issues,
          ...(rejectedResponse === undefined ? {} : { rejectedResponse })
        });
        break;
      } catch (error) {
        const decision = retryDecision(error);
        if (!decision) throw error;
        if (!decision.retry || transportAttempts >= MAX_TRANSPORT_ATTEMPTS_PER_RESPONSE || generationCalls >= MAX_GENERATION_CALLS) {
          throw failure(options.stage, decision.code, decision.retry);
        }
        await options.delay(decision.delayMs);
      }
    }
    if (!result) throw failure(options.stage, "authoring_provider_unavailable", true);

    try {
      const parsed = options.parse(result.content);
      if (options.currentClaim && !await options.currentClaim()) {
        throw failure(options.stage, "authoring_cancelled", false);
      }
      return parsed;
    } catch (error) {
      const projected = recognizedOutputIssues(error);
      if (!projected) throw error;
      const outputIssues = result.outputLimited
        ? [...projected.slice(0, 19), limitedIssue(options.stage)]
        : projected;
      issues = stageIssues(options.stage, outputIssues);
      if (repair) {
        throw failure(options.stage, result.outputLimited ? "authoring_output_limit" : "invalid_authoring_output", true, issues);
      }
      repair = true;
      rejectedResponse = boundedRejectedResponse(result.content);
    }
  }
}
