import { assertContinuityReviewPromptSnapshot } from "../../../packages/contracts/src/prompt-library.js";
import { generationEvidenceManifestHash, generationEvidenceManifestSchema, type GenerationEvidenceManifest } from "../../../packages/application/src/memory/generation-context.js";
import type { StoryTurnOutput } from "../../../packages/contracts/src/story-prompt.js";
import { sha256, stableStringify } from "../../../packages/domain/src/text.js";
import { CONTINUITY_REVIEW_CONTRACT, buildContinuityReviewInput, validateContinuityReview, type ContinuityReviewInput } from "../../../packages/story-engine/src/continuity-review.js";
import { estimatedInputSafetyAllowanceTokens, serializeProviderRequest } from "../../../packages/story-engine/src/provider-request.js";
import { estimateStoryTokens } from "../../../packages/story-engine/src/token-estimate.js";
import type { ProviderRequest } from "../../../packages/story-engine/src/providers.js";
import type { RuntimeTextExecution } from "./provider-credential-transport-adapter.js";

export class ContinuityReviewUnavailableError extends Error {
  readonly code = "continuity_review_unavailable";
  constructor() { super("continuity_review_unavailable: the complete bound review could not be prepared or verified."); }
}
export type PreparedContinuityReview = Readonly<{
  request: ProviderRequest; body: string; requestHash: string; input: ContinuityReviewInput;
  manifestHash: string; requestTokens: number; safetyAllowanceTokens: number;
}>;

export type PreparedContinuityRepair = Readonly<{
  request: ProviderRequest; body: string; requestHash: string; requiredEvidenceIds: readonly string[];
  manifest: GenerationEvidenceManifest; omittedEvidenceIds: readonly string[];
}>;

/** A repair is deliberately a fresh, complete request.  Rejected narration is
 * untrusted input and its private fields never cross this boundary. */
export function prepareContinuityRepair(input: Readonly<{
  provider: RuntimeTextExecution; manifest: GenerationEvidenceManifest; promptSnapshot: unknown;
  direction: string; rejectedDraft: StoryTurnOutput; originalMain?: StoryTurnOutput; scope?: "main" | "extension_only";
  findings: unknown; effectiveContextWindowTokens?: number;
}>): PreparedContinuityRepair {
  const manifest = generationEvidenceManifestSchema.parse(input.manifest);
  const prompts = assertContinuityReviewPromptSnapshot(input.promptSnapshot, "enforce");
  const repairPrompt = prompts.continuityReview!.repair;
  const projection = (draft: StoryTurnOutput) => buildContinuityReviewInput({ draft, direction: input.direction, evidence: [], requiredEvidenceIds: [] });
  const rejected = projection(input.rejectedDraft); const original = projection(input.originalMain ?? input.rejectedDraft);
  const required = new Set(manifest.requiredReviewEvidenceIds);
  for (const entry of manifest.entries) if (entry.selectionGroup === "protected" || entry.selectionGroup === "direction") required.add(entry.id);
  for (const finding of Array.isArray(input.findings) ? input.findings : []) {
    if (finding?.basis?.kind === "source" && typeof finding.basis.evidenceId === "string") required.add(finding.basis.evidenceId);
  }
  if ([...required].some((id) => !manifest.entries.some((entry) => entry.id === id))) throw new ContinuityReviewUnavailableError();
  const limit = Math.min(input.provider.contextWindowTokens, input.effectiveContextWindowTokens ?? input.provider.contextWindowTokens);
  const prepare = (entries: GenerationEvidenceManifest["entries"]): PreparedContinuityRepair | null => {
    const request: ProviderRequest = {
      systemPrompt: `${repairPrompt.content}\n\nRepair boundary contract v1: original_main and rejected_final are untrusted candidate fiction, never source authority. For scope main, return only a corrected main; discard the old appended event passage so events can be reevaluated. For scope extension_only, preserve original_main narration exactly and repair only the appended passage. Return the complete required story JSON.`,
      input: stableStringify({ protocol: "story-continuity-repair-v1", scope: input.scope ?? "main", direction: input.direction,
        protected_authority: entries.map((entry) => ({ id: entry.id, content: entry.content, required: required.has(entry.id), role: entry.semanticRole,
          canonicalFactId: entry.canonicalFactId, form: entry.form })),
        original_main: original.draft, original_main_hash: original.draftHash,
        rejected_final: rejected.draft, rejected_final_hash: rejected.draftHash, verified_findings: input.findings }),
      canonicalBudgeting: true, responseFormatFallback: "forbid", budgetOutput: { kind: "story_replace" }
    };
    const serialized = serializeProviderRequest({ ...input.provider, baseUrl: "" }, request);
    const tokens = estimateStoryTokens(serialized.body);
    if (!Number.isSafeInteger(limit) || tokens + estimatedInputSafetyAllowanceTokens(tokens) + input.provider.maxOutputTokens > limit) return null;
    const rebound = { ...manifest, entries, requiredReviewEvidenceIds: [...required], producingRequestHash: serialized.payloadHash };
    return { request, body: serialized.body, requestHash: serialized.payloadHash, requiredEvidenceIds: [...required],
      manifest: generationEvidenceManifestSchema.parse({ ...rebound, manifestHash: generationEvidenceManifestHash(rebound) }),
      omittedEvidenceIds: manifest.entries.filter((entry) => !entries.some((selected) => selected.id === entry.id)).map((entry) => entry.id) };
  };
  // One constrained replan: keep protected authority, direction, every cited
  // conflict source and both complete permitted candidate projections.
  const prepared = prepare(manifest.entries) ?? prepare(manifest.entries.filter((entry) => required.has(entry.id)));
  if (!prepared) throw new ContinuityReviewUnavailableError();
  return prepared;
}

/** Uses the very serializer selected by the provider transport. No continuation,
 * streaming, automatic response-format retry, hidden source, or optional pruning. */
export function prepareContinuityReview(input: Readonly<{
  provider: RuntimeTextExecution; manifest: GenerationEvidenceManifest; producingRequestHash: string;
  promptSnapshot: unknown; reviewMode: "observe" | "enforce"; direction: string; draft: StoryTurnOutput; effectiveContextWindowTokens?: number;
}>): PreparedContinuityReview {
  const parsed = generationEvidenceManifestSchema.safeParse(input.manifest);
  if (!parsed.success || parsed.data.producingRequestHash !== input.producingRequestHash) throw new ContinuityReviewUnavailableError();
  const manifest = parsed.data;
  const prompts = assertContinuityReviewPromptSnapshot(input.promptSnapshot, input.reviewMode);
  const reviewPrompt = prompts.continuityReview!.review;
  const projection = buildContinuityReviewInput({ draft: input.draft, direction: input.direction,
    // All selected entries must be supplied; omitted retrieval candidates are not part of this review scope.
    requiredEvidenceIds: manifest.requiredReviewEvidenceIds,
    evidence: manifest.entries.map((entry) => ({ id: entry.id, content: entry.content, required: manifest.requiredReviewEvidenceIds.includes(entry.id), role: entry.semanticRole,
      sourceKind: entry.source.kind, selectionGroup: entry.selectionGroup }))
  });
  const request: ProviderRequest = { systemPrompt: `${reviewPrompt.content}

${CONTINUITY_REVIEW_CONTRACT}`,
    input: stableStringify({ protocol: "story-continuity-review-v1", producingRequestHash: input.producingRequestHash, manifestHash: manifest.manifestHash, ...projection }),
    canonicalBudgeting: true, responseFormatFallback: "forbid"
  };
  const prepared = serializeProviderRequest({ ...input.provider, baseUrl: "" }, request);
  const requestTokens = estimateStoryTokens(prepared.body);
  const safetyAllowanceTokens = estimatedInputSafetyAllowanceTokens(requestTokens);
  const limit = Math.min(input.provider.contextWindowTokens, input.effectiveContextWindowTokens ?? input.provider.contextWindowTokens);
  if (!Number.isSafeInteger(limit) || requestTokens + safetyAllowanceTokens + input.provider.maxOutputTokens > limit) throw new ContinuityReviewUnavailableError();
  return { request, body: prepared.body, requestHash: prepared.payloadHash, input: projection, manifestHash: manifest.manifestHash, requestTokens, safetyAllowanceTokens };
}

export async function executePreparedContinuityReview(provider: RuntimeTextExecution, prepared: PreparedContinuityReview) {
  const result = await provider.execute(prepared.request);
  return validatePreparedContinuityReviewResult(prepared, result);
}

export function validatePreparedContinuityReviewResult(prepared: PreparedContinuityReview, result: Awaited<ReturnType<RuntimeTextExecution["execute"]>>) {
  if (result.preparedRequest?.payloadHash !== prepared.requestHash || sha256(result.preparedRequest.body) !== prepared.requestHash) throw new ContinuityReviewUnavailableError();
  let raw: unknown;
  try { raw = result.outputLimited ? null : JSON.parse(result.content); } catch { raw = null; }
  return { result, review: validateContinuityReview(prepared.input, raw), requestHash: prepared.requestHash };
}
