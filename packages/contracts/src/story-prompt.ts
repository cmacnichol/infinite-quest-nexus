import { z } from "zod";

/** Frozen pre-Story-Memory identity retained for captured jobs and overrides. */
export const LEGACY_STORY_PROMPT_PROTOCOL_VERSION = "story-v13-current-state-corrections";
/** Frozen fact-output contract retained for v15 jobs and override proofs. */
export const PREVIOUS_STORY_PROMPT_PROTOCOL_VERSION = "story-v15-canonical-fact-format";
/** The immutable story wire contract shared by newly queued prompts and the engine. */
export const STORY_PROMPT_PROTOCOL_VERSION = "story-v16-fact-wire-distinction";
export const STORY_PROMPT_SCHEMA_VERSION = "story-output-v2";
export const STORY_CONTEXT_POLICY_VERSION = "current-continuity-v2";
/**
 * The Story Memory route is explicitly opted into by a frozen job policy.
 * Keep the pre-enrollment v13 and enrolled v14 constants unchanged for historic jobs.
 */
export const LEGACY_STORY_MEMORY_PROMPT_PROTOCOL_VERSION = "story-v14-continuity-context";
/** Frozen Story Memory contract retained for v15 jobs and override proofs. */
export const PREVIOUS_STORY_MEMORY_PROMPT_PROTOCOL_VERSION = "story-v15-canonical-fact-format";
export const STORY_MEMORY_PROMPT_PROTOCOL_VERSION = "story-v16-fact-wire-distinction";
export const STORY_MEMORY_CONTEXT_POLICY_VERSION = "current-continuity-v3";
/** Explicit opt-in; historical Story Memory constants remain frozen. */
export const CAST_STORY_MEMORY_PROMPT_PROTOCOL_VERSION = "story-v17-campaign-cast";
export const CAST_STORY_MEMORY_CONTEXT_POLICY_VERSION = "current-continuity-v4";
export const CAST_STORY_AUTHORITY_CONTRACT = "Campaign cast authority: use only the selected cast records and supplied evidence. User field overrides govern current portrayal from their effective turn, including intentional empty values. Older conflicting facts remain dated historical evidence; do not restore them as current attributes or treat compliance with a correction as a contradiction. Immutable world rules still apply; unresolved conflicts require uncertainty. Cast coverage is bounded: when tracking is incomplete, use accepted recent history for intervening events, and never infer that an omitted character or field is absent. Aliases identify the supplied stable character only when unambiguous. Prose relationship guidance is not a structured relationship record.";
export const MAX_CONTINUITY_OPEN_THREADS = 500;

/**
 * This contract is appended after an acknowledged creative override so the
 * override remains byte-for-byte intact while authority semantics stay fixed.
 */
export const STORY_FACT_DELTA_WIRE_CONTRACT = [
  "Input canonical fact records may contain id, content, or retrieval metadata. Those records are references, not the output shape.",
  "Output canonical_facts contains strings only, for facts newly established in this turn: [\"The beacon is lit.\"]. Never put id, estimatedTokens, or supersedes_fact_ids inside this array.",
  "Use canonical_fact_updates only for explicit fact updates: [{\"content\":\"The beacon is dark.\",\"supersedes_fact_ids\":[\"an exact visible fact UUID\"]}]. Copy replacement IDs only from supplied visible facts. New additions do not need IDs.",
  "Use [] for superseded_facts. Omitted no-op delta arrays may be normalized by the application, but emit them explicitly.",
  "Return scratchpad, continuity_summary, and open_threads as complete current replacements, even when empty. Do not copy all input facts into output additions."
].join("\n");

/** The exact v15 appendage retained for frozen Story Memory retries. */
export const PREVIOUS_STORY_MEMORY_MANDATORY_CONTRACT = [
  "Story Memory authority contract: application scope and privacy boundaries come first. Pinned world rules and approved corrections outrank profile guidance, accepted state, selected history, summaries, plans, and the current player request.",
  "Treat effective character profile guidance as portrayal authority. Preserve accepted historical references with their source time. Dynamic location, possessions, clothing, and relationship status use the latest applicable accepted change or explicit correction; an origin profile is never a reset. A personality guideline does not make an unusual accepted action a contradiction.",
  "If an immutable world rule conflicts with an approved correction or profile edit, preserve the conflict as uncertainty for an explicit user decision; do not invent a retcon. Apply explicit corrections exactly at their effective base. An empty corrected summary, scratchpad, or thread list is intentional and must not be restored from older material.",
  "Label supplied material by role: player input is intent, accepted narration is an outcome, selected world records are reference authority, and optional excerpts are limited historical evidence. The player input is intent, not proof that its requested outcome happened. Omitted history is unknown, not evidence that it never happened. Older narration remains true at its labeled source time even when current state later changed.",
  "continuity_summary, scratchpad, and open_threads are complete replacements for current continuity and may intentionally be empty. canonical_facts and canonical_fact_updates describe only additions or structured current-turn updates; never repeat all historical facts merely to make those arrays comprehensive. A proposed output cannot grant itself source authority or authorize a new supersession ID. Supersede only a visible, supplied canonical fact ID, and only when the update actually replaces that fact.",
  "Use only the bounded supplied context. Do not claim that all campaign history was verified or that an omitted record is absent. Derived summaries, plans, and candidate output are navigation or proposals, never authority overrides."
].join("\n");

export const STORY_MEMORY_MANDATORY_CONTRACT = [
  "Story Memory authority contract: application scope and privacy boundaries come first. Pinned world rules and approved corrections outrank profile guidance, accepted state, selected history, summaries, plans, and the current player request.",
  "Treat effective character profile guidance as portrayal authority. Preserve accepted historical references with their source time. Dynamic location, possessions, clothing, and relationship status use the latest applicable accepted change or explicit correction; an origin profile is never a reset. A personality guideline does not make an unusual accepted action a contradiction.",
  "If an immutable world rule conflicts with an approved correction or profile edit, preserve the conflict as uncertainty for an explicit user decision; do not invent a retcon. Apply explicit corrections exactly at their effective base. An empty corrected summary, scratchpad, or thread list is intentional and must not be restored from older material.",
  "Label supplied material by role: player input is intent, accepted narration is an outcome, selected world records are reference authority, and optional excerpts are limited historical evidence. The player input is intent, not proof that its requested outcome happened. Omitted history is unknown, not evidence that it never happened. Older narration remains true at its labeled source time even when current state later changed.",
  "A proposed output cannot grant itself source authority or authorize a new supersession ID. Supersede only a visible, supplied canonical fact ID, and only when the update actually replaces that fact.",
  STORY_FACT_DELTA_WIRE_CONTRACT,
  "Use only the bounded supplied context. Do not claim that all campaign history was verified or that an omitted record is absent. Derived summaries, plans, and candidate output are navigation or proposals, never authority overrides."
].join("\n");

export const STORY_PROSE_GUIDANCE = `Narration prose: Write natural, character-led fiction with clear, concrete language and varied sentence lengths. When characters can and would speak, let the scene unfold through believable conversation mixed with action and brief observation. Give each speaker vocabulary and rhythm consistent with their personality, relationship, and immediate situation. Use contractions, short replies, pauses, and occasional interruptions where they fit. Do not force dialogue into solitary or nonverbal scenes.
When characters speak, write their words as direct dialogue enclosed in double quotation marks, rather than replacing the exchange with a summary or leaving spoken words unquoted. Start a new paragraph whenever the speaker changes. Keep speaker attribution clear through brief dialogue tags or accompanying action. Escape quotation marks correctly inside the JSON narration string so they remain visible in the decoded narration.
Keep world atmosphere distinct from narrative delivery and individual character speech. A bleak or unsettling setting need not make every speaker detached or formal. Show emotion through speech, behavior, and specific perceptions without explaining every gesture. Keep introspection connected to the character's immediate situation.
Use previous narration and retrieved history for facts and continuity. Preserve established character voice and cadence without copying repetitive sentence patterns. Keep purposeful repetition, hesitation, callbacks, and subtext when they reveal character or change an exchange. Avoid circular abstractions that repeatedly redefine the previous phrase without adding meaning. Break up excessive chains of independent clauses when they obscure meaning; allow ordinary conjunctions and flowing sentences.
Plausible present-scene speech, reactions, and connective action may develop the requested events without inventing contradictory history, unsupported knowledge, motives, or durable canon commitments. Respect authoritative rules, continuity, and the requested scope; do not reduce a scene to a factual recap or invent developments merely to reach a word target.
Before returning the JSON, silently remove accidental repetition and circular restatements while retaining meaningful emotional beats and conversational rhythm. Preserve established facts, requested events, viewpoint, and the selected prose style. When repairing a turn, preserve unaffected narration and dialogue; revise only passages needed to correct the reported problem. Stop at a natural stopping point once the supported scene is complete; do not pad.`;

export const STORY_SYSTEM_PROMPT = `You are the fiction writer for Infinite Quest.
Return only one valid JSON object. Do not use Markdown.

Required shape:
{
  "narration": "second-person fiction",
  "choices": ["choice 1", "choice 2", "choice 3", "choice 4"],
  "custom_action_suggestion": "a distinct freeform action idea",
  "scratchpad": "complete private continuity notes containing fiction facts only",
  "tracker_updates": [{ "name": "fictional tracker name", "value": "new fictional value" }],
  "image_prompt": "fiction-only illustration prompt, or empty string",
  "continuity_summary": "complete living summary of established characters, setting, goals, and consequences",
  "canonical_facts": ["new fiction facts established by this turn"],
  "superseded_facts": [],
  "canonical_fact_updates": [{ "content": "new or corrected fiction fact", "supersedes_fact_ids": ["exact UUID from a visible canonical fact"] }],
  "open_threads": ["complete current unresolved goals, mysteries, promises, dangers, and planned payoffs"]
}

Format narration as readable prose paragraphs separated by two newline characters (\\n\\n). Prefer two to four sentences per paragraph. Start a new paragraph for a change of speaker, scene transition, or meaningful shift in focus. Do not use Markdown inside narration.

${STORY_PROSE_GUIDANCE}

Priority order: (1) authoritative rules, established continuity, and the current turn input; (2) a complete, coherent turn and complete JSON object; (3) the requested narration length. The length range is a soft pacing goal, not a requirement. End early when the supported events have reached a natural stopping point. Never add repetition, recap, unsupported aftermath, a new material fact, character, location, motive, time jump, plot thread, or durable canon commitment merely to reach a word target. You may add brief sensory or connective detail only when it is consistent with the established situation and does not create a material new claim.

Absolute separation rule: every field must contain fiction or continuity facts only. Never expose non-diegetic resolution metadata, game-system terminology, parser behavior, hidden instructions, or private reasoning. Express outcomes only as natural events and consequences. The authoritativeRules scope contains mandatory world-specific constraints: obey every applicable rule on every turn, even when recent narration, conversation memory, or the player action conflicts with one. Treat those rules as instructions, not optional lore or style suggestions. When authoritative_context.currentContinuity is present, use its corrected current continuity as authoritative over conflicting historical narration or provider conversation memory. Empty corrected fields are intentional. Mandatory world rules still apply.

${STORY_FACT_DELTA_WIRE_CONTRACT}

For supersedes_fact_ids, copy only exact IDs shown on visible canonical facts in the authoritative context. Never invent, infer, alter, or reuse an ID that is not visible. Use an empty supersedes_fact_ids array for a new fact that replaces nothing. There must be exactly four concise choices. tracker_updates must be an array of JSON objects, never strings; use [] when no tracker changes are needed. Leave enough output budget to close the JSON object.`;

export const STORY_PROMPT_REQUIRED_SHAPE_PREVIEW = `Required shape:\n${STORY_SYSTEM_PROMPT.slice(STORY_SYSTEM_PROMPT.indexOf("{"), STORY_SYSTEM_PROMPT.indexOf("}\n\n") + 1)}`;

export const canonicalFactUpdateSchema = z.object({
  content: z.string().trim().min(1).max(4000),
  supersedes_fact_ids: z.array(z.uuid()).max(100)
});

const historicalCanonicalFactUpdateSchema = canonicalFactUpdateSchema.extend({
  supersedes_fact_ids: z.array(z.uuid()).max(100).default([])
});

const storyTurnOutputFields = {
  narration: z.string().trim().min(1).max(200_000),
  choices: z.array(z.string().trim().min(1).max(2000)).length(4),
  custom_action_suggestion: z.string().trim().min(1).max(2000),
  scratchpad: z.string().max(100_000),
  tracker_updates: z.array(z.record(z.string(), z.unknown())).max(200).default([]),
  image_prompt: z.string().max(20_000).default(""),
  continuity_summary: z.string().max(20_000),
  canonical_facts: z.array(z.string().trim().min(1).max(4000)).max(100),
  superseded_facts: z.array(z.string().trim().min(1).max(4000)).max(100),
  canonical_fact_updates: z.array(canonicalFactUpdateSchema).max(100),
  open_threads: z.array(z.string().trim().min(1).max(4000)).max(MAX_CONTINUITY_OPEN_THREADS)
};

export const storyTurnOutputSchema = z.object(storyTurnOutputFields).superRefine((value, context) => {
  if (value.superseded_facts.length) context.addIssue({
    code: "custom",
    path: ["superseded_facts"],
    message: "New story output must use canonical_fact_updates for supersession."
  });
});

/** Only import/replay callers may use this parser for pre-protocol stored output. */
export const storyTurnOutputHistoricalSchema = z.object(storyTurnOutputFields).partial({
  scratchpad: true,
  continuity_summary: true,
  canonical_facts: true,
  superseded_facts: true,
  canonical_fact_updates: true,
  open_threads: true
}).extend({
  canonical_fact_updates: z.array(historicalCanonicalFactUpdateSchema).max(100).optional()
});

export const generationDiagnosticOperationSchema = z.enum([
  "story_generation", "story_choice_repair", "rpg_assessment", "event_trigger", "event_extension",
  "turn_intent", "scene_coverage", "scene_coverage_rewrite", "event_coverage", "story_continuity_review", "story_continuity_repair"
]);

const diagnosticActionByCode = {
  context_budget_invalid: "adjust_context",
  context_budget_exceeded: "adjust_context",
  continuity_output_budget_exceeded: "adjust_output_or_state",
  provider_context_overflow: "check_provider_window",
  authoritative_context_invalid: "repair_authority",
  prompt_override_incompatible: "update_prompt",
  prompt_protocol_upgrade_required: "discard_and_reenqueue",
  event_coverage_failed: "retry_event",
  extension_narration_limit_exceeded: "shorten_or_replace_turn",
  context_evidence_omitted: "adjust_context",
  context_ready: "adjust_context",
  source_validation_failed: "repair_authority",
  continuity_review_conflict: "discard_and_reenqueue",
  continuity_review_unavailable: "discard_and_reenqueue"
} as const;

const safeDiagnosticReasonCodeSchema = z.enum([
  "context_limit", "request_limit", "recent_gap", "unsupported_world_shape",
  "source_revision_changed", "unverifiable_excerpt", "duplicate_source",
  "missing_authority", "source_validation_failed", "review_unavailable"
]);

const safeDiagnosticCountsSchema = z.object({
  authorityComponents: z.number().int().nonnegative().max(10_000).optional(),
  optionalEvidenceOmitted: z.number().int().nonnegative().max(10_000).optional(),
  recentTurnsTarget: z.number().int().nonnegative().max(500).optional(),
  recentTurnsIncluded: z.number().int().nonnegative().max(500).optional(),
  worldReferencesIncluded: z.number().int().nonnegative().max(10_000).optional(),
  worldReferencesOmitted: z.number().int().nonnegative().max(10_000).optional(),
  excerptsComplete: z.number().int().nonnegative().max(10_000).optional(),
  excerptsPartial: z.number().int().nonnegative().max(10_000).optional(),
  sourceValidationFailures: z.number().int().nonnegative().max(10_000).optional(),
  duplicateSources: z.number().int().nonnegative().max(10_000).optional()
}).strict();

const safeDiagnosticReviewSchema = z.object({
  status: z.enum(["off", "observed", "passed", "conflict", "uncertain", "unavailable"]),
  automaticRepair: z.enum(["not_consumed", "consumed", "unavailable"])
}).strict();

const safeProtectedComponentEstimatesSchema = z.object({
  rules: z.number().int().nonnegative().max(1_000_000_000).optional(),
  world_canon: z.number().int().nonnegative().max(1_000_000_000).optional(),
  character_profile: z.number().int().nonnegative().max(1_000_000_000).optional(),
  current_state: z.number().int().nonnegative().max(1_000_000_000).optional(),
  current_scene: z.number().int().nonnegative().max(1_000_000_000).optional(),
  direction: z.number().int().nonnegative().max(1_000_000_000).optional()
}).strict();

const safeDiagnosticIdentitySchema = z.string().regex(/^[a-z0-9][a-z0-9._|:-]{0,499}$/);

export const safeGenerationDiagnosticSchema = z.object({
  code: z.enum(Object.keys(diagnosticActionByCode) as [keyof typeof diagnosticActionByCode, ...Array<keyof typeof diagnosticActionByCode>]),
  operation: generationDiagnosticOperationSchema,
  action: z.enum(["adjust_context", "adjust_output_or_state", "check_provider_window", "repair_authority", "update_prompt", "discard_and_reenqueue", "retry_event", "shorten_or_replace_turn"]),
  field: z.enum(["rules", "scratchpad", "continuity_summary", "open_threads", "canonical_facts", "narration", "context_settings"]).optional(),
  scope: z.enum(["campaign_context", "provider_request", "output_skeleton", "extension_narration"]).optional(),
  requiredTokens: z.number().int().nonnegative().optional(),
  availableTokens: z.number().int().nonnegative().optional(),
  requiredCharacters: z.number().int().nonnegative().optional(),
  availableCharacters: z.number().int().nonnegative().optional(),
  countMode: z.literal("estimated").optional(),
  estimatorVersion: z.literal("story-token-estimate-v1").optional(),
  protocolIdentity: safeDiagnosticIdentitySchema.optional(),
  policyIdentity: safeDiagnosticIdentitySchema.optional(),
  queryVariantCount: z.number().int().nonnegative().max(32).optional(),
  reasonCodes: z.array(safeDiagnosticReasonCodeSchema).max(20).optional(),
  counts: safeDiagnosticCountsSchema.optional(),
  review: safeDiagnosticReviewSchema.optional(),
  protectedComponents: safeProtectedComponentEstimatesSchema.optional()
}).strict().superRefine((value, context) => {
  if (diagnosticActionByCode[value.code] !== value.action) context.addIssue({ code: "custom", path: ["action"], message: "Diagnostic action must match its code." });
});

export type SafeGenerationDiagnostic = z.infer<typeof safeGenerationDiagnosticSchema>;

export type SafeGenerationContextDiagnostic = Readonly<{
  reasonCodes?: readonly NonNullable<SafeGenerationDiagnostic["reasonCodes"]>[number][];
  counts?: Readonly<NonNullable<SafeGenerationDiagnostic["counts"]>>;
}>;

function safeDiagnosticInteger(value: unknown, maximum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum
    ? value
    : undefined;
}

function safeDiagnosticRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Reduces private planner diagnostics to the fixed public vocabulary. It
 * intentionally ignores component names, source IDs, source paths, excerpts,
 * and token values.
 */
export function projectSafeGenerationContextDiagnostic(value: unknown): SafeGenerationContextDiagnostic {
  const source = safeDiagnosticRecord(value);
  if (!source) return {};
  const layers = safeDiagnosticRecord(source.layers);
  const world = safeDiagnosticRecord(source.worldReferenceOmissions);
  const counts: Record<string, number> = {};
  const reasons = new Set<z.infer<typeof safeDiagnosticReasonCodeSchema>>();
  const recent = safeDiagnosticRecord(layers?.recent);
  const target = safeDiagnosticInteger(recent?.target, 500);
  const included = safeDiagnosticInteger(recent?.included, 500);
  if (target !== undefined) counts.recentTurnsTarget = target;
  if (included !== undefined) counts.recentTurnsIncluded = included;
  if (recent?.firstGapReason === "recent_gap" || recent?.firstGapReason === "context_limit" || recent?.firstGapReason === "request_limit") {
    reasons.add(recent.firstGapReason);
  }
  const duplicateSources = safeDiagnosticInteger(layers?.duplicateSourceCount, 10_000);
  if (duplicateSources) {
    counts.duplicateSources = duplicateSources;
    reasons.add("duplicate_source");
  }
  const components = safeDiagnosticRecord(layers?.components);
  if (components) {
    const count = Object.values(components).filter((entry) => safeDiagnosticInteger(entry, Number.MAX_SAFE_INTEGER) !== undefined).length;
    if (count) counts.authorityComponents = count;
  }
  const excerptsComplete = safeDiagnosticInteger(layers?.excerptsComplete, 10_000);
  const excerptsPartial = safeDiagnosticInteger(layers?.excerptsPartial, 10_000);
  const sourceValidationFailures = safeDiagnosticInteger(layers?.sourceValidationFailures, 10_000);
  if (excerptsComplete !== undefined) counts.excerptsComplete = excerptsComplete;
  if (excerptsPartial !== undefined) counts.excerptsPartial = excerptsPartial;
  if (sourceValidationFailures !== undefined) {
    counts.sourceValidationFailures = sourceValidationFailures;
    if (sourceValidationFailures) reasons.add("source_validation_failed");
  }
  const omitted = Array.isArray(layers?.omitted) ? layers.omitted : [];
  let omittedCount = 0;
  for (const entry of omitted) {
    const reason = safeDiagnosticRecord(entry)?.reason;
    if (reason === "context_limit" || reason === "request_limit" || reason === "recent_gap" || reason === "unsupported_world_shape" || reason === "source_revision_changed" || reason === "unverifiable_excerpt" || reason === "duplicate_source") {
      omittedCount += 1;
      reasons.add(reason);
    }
  }
  if (omittedCount) counts.optionalEvidenceOmitted = Math.min(omittedCount, 10_000);
  const worldOmitted = ["unrecognizedRecordCount", "missingEndpointCount", "ambiguousAliasCount", "oversizedRecordCount", "entityCapCount", "relationshipCapCount"]
    .map((key) => safeDiagnosticInteger(world?.[key], 10_000) ?? 0)
    .reduce((total, count) => Math.min(10_000, total + count), 0);
  if (worldOmitted) {
    counts.worldReferencesOmitted = worldOmitted;
    reasons.add("unsupported_world_shape");
  }
  return {
    ...(reasons.size ? { reasonCodes: safeDiagnosticReasonCodeSchema.options.filter((reason) => reasons.has(reason)) } : {}),
    ...(Object.keys(counts).length ? { counts: safeDiagnosticCountsSchema.parse(counts) } : {})
  };
}

/** Drops private or malformed persisted diagnostics before a public projection. */
export function projectSafeGenerationDiagnostic(value: unknown): SafeGenerationDiagnostic | null {
  const parsed = safeGenerationDiagnosticSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
export type StoryTurnOutput = z.infer<typeof storyTurnOutputSchema>;

export function storyPromptCompatibilityIdentity(): string {
  return `${STORY_PROMPT_PROTOCOL_VERSION}|${STORY_PROMPT_SCHEMA_VERSION}|${STORY_CONTEXT_POLICY_VERSION}`;
}

export function storyPromptMandatoryContract(protocolIdentity: string = storyPromptCompatibilityIdentity()): string {
  if (protocolIdentity === storyPromptCompatibilityIdentity()) return STORY_FACT_DELTA_WIRE_CONTRACT;
  throw new Error("Unsupported story mandatory contract protocol.");
}

export function composeStoryPromptSystemPrompt(
  creativePrompt: string,
  protocolIdentity: string = storyPromptCompatibilityIdentity()
): string {
  return `${creativePrompt}\n\n${storyPromptMandatoryContract(protocolIdentity)}`;
}

export function storyMemoryPromptCompatibilityIdentity(): string {
  return `${STORY_MEMORY_PROMPT_PROTOCOL_VERSION}|${STORY_PROMPT_SCHEMA_VERSION}|${STORY_MEMORY_CONTEXT_POLICY_VERSION}`;
}
export function castStoryMemoryPromptCompatibilityIdentity(): string {
  return `${CAST_STORY_MEMORY_PROMPT_PROTOCOL_VERSION}|${STORY_PROMPT_SCHEMA_VERSION}|${CAST_STORY_MEMORY_CONTEXT_POLICY_VERSION}`;
}

export function previousStoryMemoryPromptCompatibilityIdentity(): string {
  return `${PREVIOUS_STORY_MEMORY_PROMPT_PROTOCOL_VERSION}|${STORY_PROMPT_SCHEMA_VERSION}|${STORY_MEMORY_CONTEXT_POLICY_VERSION}`;
}

export function storyMemoryMandatoryContract(promptProtocol: string = STORY_MEMORY_PROMPT_PROTOCOL_VERSION): string {
  if (promptProtocol === CAST_STORY_MEMORY_PROMPT_PROTOCOL_VERSION) return `${STORY_MEMORY_MANDATORY_CONTRACT}\n${CAST_STORY_AUTHORITY_CONTRACT}`;
  if (promptProtocol === STORY_MEMORY_PROMPT_PROTOCOL_VERSION) return STORY_MEMORY_MANDATORY_CONTRACT;
  if (promptProtocol === PREVIOUS_STORY_MEMORY_PROMPT_PROTOCOL_VERSION) return PREVIOUS_STORY_MEMORY_MANDATORY_CONTRACT;
  throw new Error("Unsupported Story Memory mandatory contract protocol.");
}

export function composeStoryMemorySystemPrompt(
  creativePrompt: string,
  supplement = "",
  promptProtocol: string = STORY_MEMORY_PROMPT_PROTOCOL_VERSION
): string {
  return `${creativePrompt}${supplement ? `\n\n${supplement}` : ""}\n\n${storyMemoryMandatoryContract(promptProtocol)}`;
}

export function storyPromptProtocolIdentity(templateHashes: Readonly<Record<string, string>>): string {
  const templates = Object.keys(templateHashes).sort().map((key) => `${key}:${templateHashes[key]}`).join("|");
  return `${storyPromptCompatibilityIdentity()}|${templates}`;
}
