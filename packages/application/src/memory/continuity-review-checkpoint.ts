import { z, continuityReviewSchema, sha256Hex } from "@infinite-quest/contracts";
import { generationEvidenceManifestSchema, generationEvidenceManifestHash, type GenerationEvidenceManifest, canonicalEvidenceJson } from "./generation-context.js";
import { generationReviewCheckpointSchema } from "../generation/review-checkpoint.js";
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const reviewBindingSchema = z.object({
  draftHash: hash, producingRequestHash: hash.nullable(), manifestHash: hash.nullable(), auxiliaryRequestHashes: z.array(hash).max(4).optional(), providerConfigurationHash: hash,
  promptHash: hash, promptProtocol: z.literal("story-continuity-review-v1"), policyHash: hash
}).strict();
export type ReviewBinding = Readonly<z.infer<typeof reviewBindingSchema>>;
export function reviewBindingHash(binding: ReviewBinding): string { return sha256Hex(canonicalEvidenceJson(reviewBindingSchema.parse(binding))); }
export const continuityReviewCheckpointSchema = z.object({
  version: z.literal(1), mode: z.enum(["observe", "enforce"]), binding: reviewBindingSchema, bindingHash: hash,
  status: z.enum(["dispatched", "completed"]), verdict: z.enum(["pass", "conflict", "uncertain", "unavailable"]),
  reviewRequestHash: hash.nullable(), result: continuityReviewSchema.nullable(),
  /** Diagnostic-only: why an "unavailable" verdict could not reach a result.
   * Optional so rows persisted before this field existed still parse. */
  unavailableReason: z.enum(["context_budget_exceeded", "provider_failed", "invalid_output", "evidence_unavailable"]).optional()
}).strict().superRefine((value, context) => {
  if ((value.status === "dispatched" || value.verdict !== "unavailable") && !value.reviewRequestHash) context.addIssue({ code: "custom", message: "Dispatched and completed reviews require their exact request identity." });
  if (value.verdict !== "unavailable" && (!value.binding.manifestHash || !value.binding.producingRequestHash)) context.addIssue({ code: "custom", message: "A review result requires complete input identity." });
  if (value.bindingHash !== reviewBindingHash(value.binding)) context.addIssue({ code: "custom", message: "Review binding hash differs." });
  if (value.status === "dispatched" && (value.verdict !== "unavailable" || value.result !== null)) context.addIssue({ code: "custom", message: "Unfinished review cannot contain a result." });
  if (value.verdict !== "unavailable" && (!value.result || value.result.verdict !== value.verdict)) context.addIssue({ code: "custom", message: "Review verdict must match its result." });
  if (value.verdict === "unavailable" && value.result !== null) context.addIssue({ code: "custom", message: "Unavailable review cannot claim a result." });
  if (value.verdict !== "unavailable" && value.unavailableReason !== undefined) context.addIssue({ code: "custom", message: "An unavailable reason only applies to an unavailable verdict." });
});
export type ContinuityReviewCheckpoint = z.infer<typeof continuityReviewCheckpointSchema>;

/** Server-known identity required to honor a single final-candidate Keep receipt.
 * The receipt is audit evidence; the locked job and this immutable binding remain authority. */
export type GenerationReviewAcceptanceBinding = Readonly<{
  jobId: string; actorUserId: string; candidateScope: "main" | "final"; candidateHash: string;
  stage: string; findingsHash: string; ownerUserId: string; campaignId: string; worldId: string;
  worldVersionId: string | null; baseIdentity: unknown; protocol: Readonly<{ version: string; promptHash: string }>;
  policyHash: string; operationKind: "append" | "replace_latest"; replacementTurnId: string | null;
}>;

/**
 * Proves that the currently locked job is committing the precise candidate that
 * its owner elected to keep. This deliberately has no general review override:
 * callers may use it only for the final continuity waiver.
 */
export function assertGenerationReviewAcceptance(value: unknown, expected: GenerationReviewAcceptanceBinding): void {
  const checkpoint = generationReviewCheckpointSchema.safeParse(value);
  const unavailable = (): never => {
    throw Object.assign(new Error("The saved generation review acceptance does not bind this commit."), {
      code: "generation_review_acceptance_unavailable"
    });
  };
  if (!checkpoint.success || !checkpoint.data) unavailable();
  const current = checkpoint.data!;
  if (current.state !== "decided" || current.candidateScope !== expected.candidateScope || current.stage !== expected.stage
    || current.operationKind !== expected.operationKind || current.replacementTurnId !== expected.replacementTurnId) unavailable();
  const candidate = current.gateCandidate;
  if (candidate.scope !== expected.candidateScope || candidate.storyHash !== expected.candidateHash
    || candidate.ownerUserId !== expected.ownerUserId || candidate.campaignId !== expected.campaignId
    || candidate.worldId !== expected.worldId || candidate.worldVersionId !== expected.worldVersionId
    || candidate.policyHash !== expected.policyHash || candidate.protocol.version !== expected.protocol.version
    || candidate.protocol.promptHash !== expected.protocol.promptHash
    || canonicalEvidenceJson(candidate.baseIdentity) !== canonicalEvidenceJson(expected.baseIdentity)) unavailable();
  const receipt = current.decisionJournal.find((entry) => entry.reviewId === current.reviewId
    // `decideReview` advances the checkpoint revision after recording the
    // decision at the revision the user was shown.
    && entry.revision === current.revision - 1 && entry.decision === "keep");
  if (!receipt || receipt.actorUserId !== expected.actorUserId || receipt.candidateScope !== expected.candidateScope
    || receipt.candidateHash !== expected.candidateHash || receipt.findingsHash !== expected.findingsHash
    || receipt.findingsHash !== sha256Hex(canonicalEvidenceJson(current.reasons))
    || receipt.actionReceipt.jobId !== expected.jobId || receipt.actionReceipt.operationKind !== expected.operationKind
    || receipt.actionReceipt.replacementTurnId !== expected.replacementTurnId
    || receipt.offeredCandidate.storyHash !== expected.candidateHash
    || canonicalEvidenceJson(receipt.offeredCandidate.baseIdentity) !== canonicalEvidenceJson(expected.baseIdentity)) unavailable();
}

export function assertContinuityReviewCommit(mode: "off" | "observe" | "enforce", value: unknown, binding: ReviewBinding): void {
  if (mode === "off") return;
  const checkpoint = continuityReviewCheckpointSchema.safeParse(value);
  if (!checkpoint.success || checkpoint.data.mode !== mode || checkpoint.data.bindingHash !== reviewBindingHash(binding)
    || checkpoint.data.status !== "completed" || (mode === "enforce" && checkpoint.data.verdict !== "pass")) {
    throw Object.assign(new Error("The final story does not have a compatible completed continuity review."), { code: "continuity_review_unavailable" });
  }
}

/** Rebind selected evidence only after proving that the final producing request
 * still carries those exact fields. Candidate/rejected-output text is never searched. */
export function bindManifestToProducingRequest(value: GenerationEvidenceManifest, requestBody: string): GenerationEvidenceManifest {
  const manifest = generationEvidenceManifestSchema.parse(value);
  const wire = JSON.parse(requestBody) as Record<string, unknown>;
  const inputs: string[] = typeof wire.input === "string" ? [wire.input] : [];
  if (Array.isArray(wire.messages)) for (const message of wire.messages) if (message?.role === "user" && typeof message.content === "string") inputs.push(message.content);
  let envelope: Record<string, unknown> | undefined;
  for (const input of inputs) {
    try {
      const parsed = JSON.parse(input.split("\n\nREJECTED RESPONSE TO REWRITE:\n", 1)[0]!.split("\n\nRECOVERY REQUIREMENT:\n", 1)[0]!) as Record<string, unknown>;
      if (parsed.authoritative_context || parsed.protected_fiction_safe_base_authority || parsed.protocol === "story-continuity-repair-v1") { envelope = parsed; break; }
    } catch { /* Non-authority user messages cannot establish evidence. */ }
  }
  const authority = envelope?.authoritative_context ?? envelope?.protected_fiction_safe_base_authority;
  const pointer = (source: unknown, path: string): unknown => {
    let current = source;
    for (const raw of path === "" ? [] : path.slice(1).split("/")) {
      const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
      if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) return undefined;
      current = Reflect.get(current, key);
    }
    return current;
  };
  for (const entry of manifest.entries) {
    let field: unknown;
    const repairEvidence = Array.isArray(envelope?.protected_authority)
      ? envelope.protected_authority.find((candidate) => candidate && typeof candidate === "object" && Reflect.get(candidate, "id") === entry.id) as Record<string, unknown> | undefined
      : undefined;
    if (repairEvidence) field = repairEvidence.content;
    else if (entry.selectionGroup === "direction") field = envelope?.direction ?? pointer(envelope, "/current_turn_input/text") ?? envelope?.original_player_action ?? envelope?.player_action;
    else if (entry.selectionGroup === "world") {
      const references = pointer(authority, "/worldReferences");
      field = Array.isArray(references) ? references.find((item) => item.sourceId === entry.source.id && item.sourcePath === entry.sourcePath)?.content : undefined;
    } else if (entry.form === "excerpt") {
      const chronicle = pointer(authority, "/chronicle");
      field = Array.isArray(chronicle) ? chronicle.find((item) => (item.turnId ?? item.id) === entry.source.id && item.sourceHash === entry.source.contentHash)?.content : undefined;
    } else field = pointer(authority, entry.sourcePath);
    if (field === undefined || (typeof field === "string" ? field : canonicalEvidenceJson(field)) !== entry.content) throw Object.assign(new Error("Final producing request does not retain selected source evidence."), { code: "continuity_review_unavailable" });
  }
  const rebound = { ...manifest, producingRequestHash: sha256Hex(requestBody) };
  return generationEvidenceManifestSchema.parse({ ...rebound, manifestHash: generationEvidenceManifestHash(rebound) });
}

/** A choice-only response contributes to the final object without becoming
 * source authority. Bind that producing request separately from the main. */
export function validatedChoiceRequestHashes(value: unknown, mainStory: unknown, providerConfigurationHash: string): string[] {
  if (value === undefined) return [];
  const record = value as Record<string, unknown>;
  if (record.status !== "validated") return [];
  const fail = () => { throw Object.assign(new Error("Choice repair provenance does not match the reviewed main."), { code: "generation_checkpoint_incompatible" }); };
  if (typeof record.repairRequestBody !== "string" || record.repairRequestPayloadHash !== sha256Hex(record.repairRequestBody)
    || record.providerConfigurationHash !== providerConfigurationHash || !record.fields || typeof record.fields !== "object"
    || !record.base || typeof record.base !== "object" || record.resultHash !== sha256Hex(canonicalEvidenceJson(record.fields))) return fail();
  if (canonicalEvidenceJson({ ...record.base, ...record.fields }) !== canonicalEvidenceJson(mainStory)) return fail();
  return [record.repairRequestPayloadHash as string];
}
