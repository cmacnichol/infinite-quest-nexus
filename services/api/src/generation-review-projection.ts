import {
  generationReviewDetailSchema,
  projectGenerationReviewSummary,
  type GenerationReviewDetail,
  type GenerationReviewReasonCode,
  type GenerationReviewSummary
} from "../../../packages/contracts/src/generation-review.js";

const reasonMessages: Record<GenerationReviewReasonCode, string> = {
  scene_beats_missing: "The candidate does not cover all requested scene beats.",
  narrative_conflict: "The candidate may conflict with established story continuity.",
  review_uncertain: "The automated review could not reach a conclusive result.",
  review_unavailable: "The automated review was unavailable for this candidate.",
  invalid_choices: "The candidate choices do not meet the required structure.",
  invalid_structure: "The candidate does not meet the required story structure.",
  output_incomplete: "The candidate output is incomplete.",
  mechanics_contamination: "The candidate contains game mechanics language.",
  event_coverage_failed: "The candidate does not cover required story events.",
  candidate_stale: "The candidate no longer matches the current campaign authority.",
  candidate_invalid: "The candidate is not valid for acceptance."
};

const continuityDetailPattern = /^Possible (world-rule|character-detail|relationship|chronology|location|object-state|open-thread|story-direction|replacement-state) contradiction in “(.{1,1000})”\.$/u;

function safeFindingMessage(code: GenerationReviewReasonCode, message: string, narration: string | null): string {
  if (code !== "narrative_conflict" || !narration) return reasonMessages[code];
  const match = continuityDetailPattern.exec(message);
  return match && narration.includes(match[2]!) ? message : reasonMessages[code];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Returns the only review checkpoint fields permitted in polling, SSE, and sync. */
export function projectGenerationReviewSnapshot(value: unknown): Readonly<{ review?: GenerationReviewSummary }> {
  const source = record(value);
  const metadata = record(source?.recoveryMetadata);
  const candidate = source?.review ?? metadata?.generationReview;
  try {
    return candidate === undefined ? {} : { review: projectGenerationReviewSummary(candidate) };
  } catch {
    return {};
  }
}

/** Revalidates an application detail response and replaces every untrusted message with an allowlisted one. */
export function projectGenerationReviewDetailResponse(value: unknown): GenerationReviewDetail {
  const detail = generationReviewDetailSchema.parse(value);
  return generationReviewDetailSchema.parse({
    ...detail,
    findings: detail.findings.map(({ code, message }) => ({ code, message: safeFindingMessage(code, message, detail.narration) })),
    retryFailure: detail.retryFailure === null ? null : "The authorized retry did not produce an acceptable replacement."
  });
}
