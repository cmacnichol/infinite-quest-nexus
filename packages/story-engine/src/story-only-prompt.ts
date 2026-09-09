import type { GenerationPolicySnapshot, StoryOnlyPromptSnapshot } from "../../contracts/src/campaign-generation-policy.js";
import { sha256, stableStringify } from "../../domain/src/index.js";

const SYSTEM_SUPPLEMENT = [
  "Story Direction mode is a fiction-only scene direction.",
  "Treat the submitted direction as required narrative events, subject to authoritative world facts and corrected continuity. Unspecified outcomes remain plausible fiction.",
  "Return exactly four distinct immediate final-scene directions and one custom action suggestion distinct from those choices.",
  "Do not repeat completed events, require hidden prerequisites, or claim unsupported achievements.",
  "Trigger rules are inactive for this turn. Hidden mechanics are inactive for this turn.",
  "Do not invent, explain, expose, or resolve rolls, stats, checks, scores, or private mechanics."
].join("\n");

const CHOICE_REPAIR_SYSTEM = [
  "Repair only the generated choices for a Story Direction turn.",
  "Keep the narration and all non-choice continuity unchanged.",
  "Trigger rules and hidden mechanics are inactive."
].join("\n");

function frozenSnapshot(): StoryOnlyPromptSnapshot {
  return Object.freeze({
    systemSupplement: SYSTEM_SUPPLEMENT,
    systemSupplementHash: sha256(SYSTEM_SUPPLEMENT),
    choiceRepairSystem: CHOICE_REPAIR_SYSTEM,
    choiceRepairSystemHash: sha256(CHOICE_REPAIR_SYSTEM)
  });
}

export function storyOnlyPromptSnapshot(): StoryOnlyPromptSnapshot {
  return frozenSnapshot();
}

function verifyPromptSnapshot(prompts: StoryOnlyPromptSnapshot): void {
  if (sha256(prompts.systemSupplement) !== prompts.systemSupplementHash
    || sha256(prompts.choiceRepairSystem) !== prompts.choiceRepairSystemHash) {
    throw new Error("Stored story-only prompt hash does not match its frozen text.");
  }
}

export function generationPolicyIdentity(policy: GenerationPolicySnapshot): string {
  if (policy.playMode === "story_only") verifyPromptSnapshot(policy.prompts);
  return sha256(stableStringify(policy));
}

export function generationExecutionProtocolIdentity(
  legacyIdentity: string,
  policy: GenerationPolicySnapshot
): string {
  if (policy.playMode === "legacy") return legacyIdentity;
  return `${legacyIdentity}|${generationPolicyIdentity(policy)}`;
}

export function composeStoryOnlySystemPrompt(
  baseSystemPrompt: string,
  policy: Extract<GenerationPolicySnapshot, { playMode: "story_only" }>
): string {
  verifyPromptSnapshot(policy.prompts);
  return `${baseSystemPrompt}\n\n${policy.prompts.systemSupplement}`;
}
