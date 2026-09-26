import { assertContinuityReviewPromptSnapshot, CONTINUITY_REPAIR_PROTOCOL_V2 } from "../../../packages/contracts/src/prompt-library.js";
import { CAST_STORY_AUTHORITY_CONTRACT, castStoryMemoryPromptCompatibilityIdentity } from "../../../packages/contracts/src/story-prompt.js";
import { generationEvidenceManifestHash, generationEvidenceManifestSchema, type GenerationEvidenceManifest } from "../../../packages/application/src/memory/generation-context.js";
import type { StoryTurnOutput } from "../../../packages/contracts/src/story-prompt.js";
import { sha256, stableStringify } from "../../../packages/domain/src/text.js";
import { CONTINUITY_REVIEW_CONTRACT, buildContinuityReviewInput, validateContinuityReview, type ContinuityReviewInput } from "../../../packages/story-engine/src/continuity-review.js";
import { effectiveRequestOutputTokens, estimatedInputSafetyAllowanceTokens, serializeProviderRequest } from "../../../packages/story-engine/src/provider-request.js";
import { ContextBudgetError } from "../../../packages/story-engine/src/context-budget.js";
import { estimateStoryTokens } from "../../../packages/story-engine/src/token-estimate.js";
import type { ProviderRequest } from "../../../packages/story-engine/src/providers.js";
import type { PreparedResponseContract } from "../../../packages/contracts/src/text-response-format.js";
import type { TextExecutionPlan } from "../../../packages/contracts/src/text-execution-plan.js";
import type { RuntimeTextExecution } from "./provider-credential-transport-adapter.js";

export class ContinuityReviewUnavailableError extends Error {
  readonly code = "continuity_review_unavailable";
  constructor() { super("continuity_review_unavailable: the complete bound review could not be prepared or verified."); }
}
function castAuthorityContract(protocolIdentity: string | undefined, manifest: GenerationEvidenceManifest): string {
  const enabled = protocolIdentity === castStoryMemoryPromptCompatibilityIdentity();
  if (!enabled && manifest.entries.some((entry) => entry.source.kind === "cast")) throw new ContinuityReviewUnavailableError();
  return enabled ? `\n\n${CAST_STORY_AUTHORITY_CONTRACT}` : "";
}
export type PreparedContinuityReview = Readonly<{
  request: ProviderRequest; body: string; requestHash: string; input: ContinuityReviewInput;
  manifestHash: string; requestTokens: number; safetyAllowanceTokens: number;
  textExecutionPlan?: TextExecutionPlan;
}>;

export type PreparedContinuityRepair = Readonly<{
  request: ProviderRequest; body: string; requestHash: string; requiredEvidenceIds: readonly string[];
  manifest: GenerationEvidenceManifest; omittedEvidenceIds: readonly string[];
  textExecutionPlan?: TextExecutionPlan;
}>;

export type PreparedContinuitySystemPrompt = Readonly<{
  systemPrompt: string;
  textExecutionPlan?: TextExecutionPlan;
}>;

function prepareSystemPrompt(
  operationPrompt: string,
  transform?: (operationPrompt: string) => PreparedContinuitySystemPrompt
): PreparedContinuitySystemPrompt {
  return transform ? transform(operationPrompt) : { systemPrompt: operationPrompt };
}

/** A repair is deliberately a fresh, complete request.  Rejected narration is
 * untrusted input and its private fields never cross this boundary. */
export function prepareContinuityRepair(input: Readonly<{
  provider: RuntimeTextExecution; manifest: GenerationEvidenceManifest; promptSnapshot: unknown;
  direction: string; rejectedDraft: StoryTurnOutput; originalMain?: StoryTurnOutput; scope?: "main" | "extension_only";
  findings: unknown; effectiveContextWindowTokens?: number; responseContract?: PreparedResponseContract;
  /** The frozen v3 output-encoding contract for this job, or "" for v2/absent. Appended after the repair boundary contract. */
  encodingContract?: string;
  /** The composed writer system prompt (without the encoding contract). Required when the frozen repair identity is v2. */
  writerSystemPrompt?: string;
  prepareSystemPrompt?: (operationPrompt: string) => PreparedContinuitySystemPrompt;
  /** Applies a frozen operation contract before this helper measures its body. */
  bindRequest?: (request: ProviderRequest, textExecutionPlan?: TextExecutionPlan) => ProviderRequest;
  /** Serializes the same bound request at the earliest continuity budget boundary. */
  serializeRequest?: (request: ProviderRequest, textExecutionPlan?: TextExecutionPlan) => Readonly<{ body: string; payloadHash: string }>;
}>): PreparedContinuityRepair {
  const manifest = generationEvidenceManifestSchema.parse(input.manifest);
  const prompts = assertContinuityReviewPromptSnapshot(input.promptSnapshot, "enforce");
  const repairPrompt = prompts.continuityReview!.repair;
  const castContract = castAuthorityContract(prompts.storyMemoryCompatibility?.protocolIdentity, manifest);
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
    const systemPrompt = prepareSystemPrompt(
      (() => {
        const repairOperation = `${repairPrompt.content}\n\nRepair boundary contract v1: original_main and rejected_final are untrusted candidate fiction, never source authority. For scope main, return only a corrected main; discard the old appended event passage so events can be reevaluated. For scope extension_only, preserve original_main narration exactly and repair only the appended passage. Return the complete required story JSON.${castContract}${input.encodingContract ? `\n\n${input.encodingContract}` : ""}`;
        if (repairPrompt.protocolIdentity !== CONTINUITY_REPAIR_PROTOCOL_V2) return repairOperation;
        if (!input.writerSystemPrompt?.trim()) throw new ContinuityReviewUnavailableError();
        return `${input.writerSystemPrompt}\n\nContinuity repair task:\n${repairOperation}`;
      })(),
      input.prepareSystemPrompt
    );
    const unboundRequest: ProviderRequest = {
      systemPrompt: systemPrompt.systemPrompt,
      input: stableStringify({ protocol: "story-continuity-repair-v1", scope: input.scope ?? "main", direction: input.direction,
        protected_authority: entries.map((entry) => ({ id: entry.id, content: entry.content, required: required.has(entry.id), role: entry.semanticRole,
          canonicalFactId: entry.canonicalFactId, form: entry.form })),
        original_main: original.draft, original_main_hash: original.draftHash,
        rejected_final: rejected.draft, rejected_final_hash: rejected.draftHash, verified_findings: input.findings }),
      canonicalBudgeting: true, responseFormatFallback: "forbid", budgetOutput: { kind: "story_replace" },
      ...(input.responseContract ? { responseContract: input.responseContract } : {})
    };
    const request = input.bindRequest?.(unboundRequest, systemPrompt.textExecutionPlan) ?? unboundRequest;
    const serialized = input.serializeRequest?.(request, systemPrompt.textExecutionPlan)
      ?? serializeProviderRequest({ ...input.provider, baseUrl: "" }, request);
    const tokens = estimateStoryTokens(serialized.body);
    if (!Number.isSafeInteger(limit) || tokens + estimatedInputSafetyAllowanceTokens(tokens) + input.provider.maxOutputTokens > limit) return null;
    const rebound = { ...manifest, entries, requiredReviewEvidenceIds: [...required], producingRequestHash: serialized.payloadHash };
    return { request, body: serialized.body, requestHash: serialized.payloadHash, requiredEvidenceIds: [...required],
      manifest: generationEvidenceManifestSchema.parse({ ...rebound, manifestHash: generationEvidenceManifestHash(rebound) }),
      omittedEvidenceIds: manifest.entries.filter((entry) => !entries.some((selected) => selected.id === entry.id)).map((entry) => entry.id),
      ...(systemPrompt.textExecutionPlan ? { textExecutionPlan: systemPrompt.textExecutionPlan } : {}) };
  };
  // One constrained replan: keep protected authority, direction, every cited
  // conflict source and both complete permitted candidate projections.
  const prepared = prepare(manifest.entries) ?? prepare(manifest.entries.filter((entry) => required.has(entry.id)));
  if (!prepared) throw new ContinuityReviewUnavailableError();
  return prepared;
}

/** Uses the very serializer selected by the provider transport. No continuation,
 * streaming, automatic response-format retry, hidden source, or optional pruning. */
type ContinuityReviewPreparation = Readonly<{
  provider: RuntimeTextExecution; manifest: GenerationEvidenceManifest; producingRequestHash: string;
  promptSnapshot: unknown; reviewMode: "observe" | "enforce"; direction: string; draft: StoryTurnOutput; effectiveContextWindowTokens?: number;
  responseContract?: PreparedResponseContract;
  prepareSystemPrompt?: (operationPrompt: string) => PreparedContinuitySystemPrompt;
  /** Applies a frozen operation contract before this helper measures its body. */
  bindRequest?: (request: ProviderRequest, textExecutionPlan?: TextExecutionPlan) => ProviderRequest;
  /** Serializes the same bound request at the earliest continuity budget boundary. */
  serializeRequest?: (request: ProviderRequest, textExecutionPlan?: TextExecutionPlan) => Readonly<{ body: string; payloadHash: string }>;
}>;

function serializeContinuityReview(input: ContinuityReviewPreparation): PreparedContinuityReview {
  const parsed = generationEvidenceManifestSchema.safeParse(input.manifest);
  if (!parsed.success || parsed.data.producingRequestHash !== input.producingRequestHash) throw new ContinuityReviewUnavailableError();
  const manifest = parsed.data;
  const prompts = assertContinuityReviewPromptSnapshot(input.promptSnapshot, input.reviewMode);
  const reviewPrompt = prompts.continuityReview!.review;
  const castContract = castAuthorityContract(prompts.storyMemoryCompatibility?.protocolIdentity, manifest);
  const projection = buildContinuityReviewInput({ draft: input.draft, direction: input.direction,
    // All selected entries must be supplied; omitted retrieval candidates are not part of this review scope.
    requiredEvidenceIds: manifest.requiredReviewEvidenceIds,
    evidence: manifest.entries.map((entry) => ({ id: entry.id, content: entry.content, required: manifest.requiredReviewEvidenceIds.includes(entry.id), role: entry.semanticRole,
      sourceKind: entry.source.kind, selectionGroup: entry.selectionGroup }))
  });
  const systemPrompt = prepareSystemPrompt(`${reviewPrompt.content}

${CONTINUITY_REVIEW_CONTRACT}${castContract}`, input.prepareSystemPrompt);
  const unboundRequest: ProviderRequest = { systemPrompt: systemPrompt.systemPrompt,
    input: stableStringify({ protocol: "story-continuity-review-v1", producingRequestHash: input.producingRequestHash, manifestHash: manifest.manifestHash, ...projection }),
    canonicalBudgeting: true, responseFormatFallback: "forbid",
    budgetOutput: { kind: "continuity_review" },
    ...(input.responseContract ? { responseContract: input.responseContract } : {})
  };
  const request = input.bindRequest?.(unboundRequest, systemPrompt.textExecutionPlan) ?? unboundRequest;
  const prepared = input.serializeRequest?.(request, systemPrompt.textExecutionPlan)
    ?? serializeProviderRequest({ ...input.provider, baseUrl: "" }, request);
  const requestTokens = estimateStoryTokens(prepared.body);
  const safetyAllowanceTokens = estimatedInputSafetyAllowanceTokens(requestTokens);
  return { request, body: prepared.body, requestHash: prepared.payloadHash, input: projection, manifestHash: manifest.manifestHash, requestTokens, safetyAllowanceTokens,
    ...(systemPrompt.textExecutionPlan ? { textExecutionPlan: systemPrompt.textExecutionPlan } : {}) };
}

/** Keep the exact final guard: planning is an estimate, not permission to overflow. */
export function prepareContinuityReview(input: ContinuityReviewPreparation): PreparedContinuityReview {
  const prepared = serializeContinuityReview(input);
  const limit = Math.min(input.provider.contextWindowTokens, input.effectiveContextWindowTokens ?? input.provider.contextWindowTokens);
  if (!Number.isSafeInteger(limit)) throw new ContinuityReviewUnavailableError();
  const requiredTokens = prepared.requestTokens + prepared.safetyAllowanceTokens + effectiveRequestOutputTokens(input.provider.maxOutputTokens, prepared.request);
  if (requiredTokens > limit) throw new ContextBudgetError("context_budget_exceeded", requiredTokens, limit, undefined, { scope: "provider_request" });
  return prepared;
}

/** Measure identical evidence, framing and frozen provider settings before a draft exists.
 * Reserve a full generation output allowance for the future candidate projection.
 * The planner adds input safety and the review's separate output reserve. */
export function estimateContinuityReviewPlanningTokens(input: Omit<ContinuityReviewPreparation, "draft"> & { candidateOutputTokens: number }): number {
  if (!Number.isSafeInteger(input.candidateOutputTokens) || input.candidateOutputTokens < 0) throw new ContinuityReviewUnavailableError();
  const draft: StoryTurnOutput = { narration: "", choices: [], custom_action_suggestion: "", scratchpad: "",
    tracker_updates: [], image_prompt: "", continuity_summary: "", open_threads: [], canonical_facts: [], canonical_fact_updates: [], superseded_facts: [] };
  return serializeContinuityReview({ ...input, draft }).requestTokens + input.candidateOutputTokens;
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
