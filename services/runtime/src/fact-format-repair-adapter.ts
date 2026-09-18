import { canonicalEvidenceJson } from "../../../packages/application/src/memory/generation-context.js";
import { sha256 } from "../../../packages/domain/src/text.js";
import type { GenerationReviewCheckpoint } from "../../../packages/application/src/generation/review-checkpoint.js";
import { planFactFormatRepair, type FactFormatRepairPlan, type VisibleRepairFact } from "../../../packages/story-engine/src/fact-format-repair.js";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;

function originalAuthority(value: unknown): RecordValue | null {
  if (typeof value !== "string") return null;
  const original = value.split("\n\nREJECTED RESPONSE TO REWRITE:\n", 1)[0]!.split("\n\nRECOVERY REQUIREMENT:\n", 1)[0]!;
  try { return record(JSON.parse(original)); } catch { return null; }
}

/** Reads only the exact serialized producing request, never live campaign state. */
export function visibleFactsFromProducingRequest(requestBody: string): readonly VisibleRepairFact[] | null {
  let rendered: RecordValue | null;
  try { rendered = record(JSON.parse(requestBody)); } catch { return null; }
  if (!rendered) return null;
  const inputAuthority = originalAuthority(rendered.input);
  const messageAuthority = Array.isArray(rendered.messages)
    ? rendered.messages.flatMap((message) => record(message)?.role === "user" ? [originalAuthority(record(message)?.content)] : []).find(Boolean) ?? null : null;
  const authority = record(rendered.authoritative_context ?? rendered.protected_fiction_safe_base_authority
    ?? inputAuthority?.authoritative_context ?? inputAuthority?.protected_fiction_safe_base_authority
    ?? messageAuthority?.authoritative_context ?? messageAuthority?.protected_fiction_safe_base_authority);
  const continuity = record(authority?.currentContinuity);
  if (!continuity || !Array.isArray(continuity.canonicalFacts)) return null;
  const facts = new Map<string, string>();
  const add = (value: unknown): boolean => {
    const fact = record(value);
    if (!fact || typeof fact.id !== "string" || typeof fact.content !== "string") return false;
    const prior = facts.get(fact.id);
    if (prior !== undefined && prior !== fact.content) return false;
    facts.set(fact.id, fact.content); return true;
  };
  for (const fact of continuity.canonicalFacts) if (!add(fact)) return null;
  if (Array.isArray(authority?.chronicle)) for (const entry of authority!.chronicle) {
    const row = record(entry); if (row?.kind === "canonical_fact" && !add(row)) return null;
  }
  return [...facts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, content]) => ({ id, content }));
}

export function repairPlanHash(plan: FactFormatRepairPlan): string { return sha256(canonicalEvidenceJson(plan)); }

export function prepareFactFormatRepair(rawOutput: string, requestBody: string): Readonly<{ plan: FactFormatRepairPlan; planHash: string }> | null {
  const visibleFacts = visibleFactsFromProducingRequest(requestBody);
  if (visibleFacts === null) return null;
  const result = planFactFormatRepair({ rawOutput, visibleFacts });
  return result.eligible ? { plan: result.plan, planHash: repairPlanHash(result.plan) } : null;
}

/** Replays a saved offer against the same immutable source and rejects tampering. */
export function applyAuthorizedFactFormatRepair(input: Readonly<{ checkpoint: GenerationReviewCheckpoint; rawOutput: string; requestBody: string }>): FactFormatRepairPlan | null {
  const repair = input.checkpoint.version === 2 ? input.checkpoint.factFormatRepair : undefined;
  const receipt = input.checkpoint.decisionJournal.find((entry) => entry.decision === "repair_format"
    && entry.reviewId === input.checkpoint.reviewId
    && entry.revision === input.checkpoint.revision - 1
    && entry.planHash === repair?.planHash
    && entry.repair.rawOutputReference === repair?.rawOutputReference
    && entry.repair.producingRequestHash === repair?.producingRequestHash
    && entry.repair.sourceResponseId === repair?.sourceResponseId);
  if (!repair || repair.status !== "authorized" || !receipt || receipt.decision !== "repair_format"
    || sha256(input.rawOutput) !== repair.plan.rawOutputHash || sha256(input.requestBody) !== repair.producingRequestHash) return null;
  const recalculated = prepareFactFormatRepair(input.rawOutput, input.requestBody);
  if (!recalculated || recalculated.planHash !== repair.planHash || receipt.planHash !== repair.planHash
    || canonicalEvidenceJson(recalculated.plan) !== canonicalEvidenceJson(repair.plan)) return null;
  return recalculated.plan;
}
