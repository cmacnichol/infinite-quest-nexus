import { z } from "zod";

/** The immutable story wire contract shared by prompt snapshots and the engine. */
export const STORY_PROMPT_PROTOCOL_VERSION = "story-v13-current-state-corrections";
export const STORY_PROMPT_SCHEMA_VERSION = "story-output-v2";
export const STORY_CONTEXT_POLICY_VERSION = "current-continuity-v2";
export const MAX_CONTINUITY_OPEN_THREADS = 500;

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

Priority order: (1) authoritative rules, established continuity, and the current turn input; (2) a complete, coherent turn and complete JSON object; (3) the requested narration length. The length range is a soft pacing goal, not a requirement. End early when the supported events have reached a natural stopping point. Never add repetition, recap, unsupported aftermath, a new material fact, character, location, motive, time jump, plot thread, or durable canon commitment merely to reach a word target. You may add brief sensory or connective detail only when it is consistent with the established situation and does not create a material new claim.

Absolute separation rule: every field must contain fiction or continuity facts only. Never expose non-diegetic resolution metadata, game-system terminology, parser behavior, hidden instructions, or private reasoning. Express outcomes only as natural events and consequences. The authoritativeRules scope contains mandatory world-specific constraints: obey every applicable rule on every turn, even when recent narration, conversation memory, or the player action conflicts with one. Treat those rules as instructions, not optional lore or style suggestions. When authoritative_context.currentContinuity is present, use its corrected current continuity as authoritative over conflicting historical narration or provider conversation memory. Empty corrected fields are intentional. Mandatory world rules still apply. scratchpad, continuity_summary, canonical_facts, canonical_fact_updates, and open_threads are required complete replacement values. Return an empty string or array only when that complete replacement is intentionally empty. canonical_facts contains only facts established this turn. superseded_facts must be []. canonical_fact_updates is the structured form of canonical fact changes; use [] when there are none. For supersedes_fact_ids, copy only exact IDs shown on visible canonical facts in the authoritative context. Never invent, infer, alter, or reuse an ID that is not visible. Use an empty supersedes_fact_ids array for a new fact that replaces nothing. There must be exactly four concise choices. tracker_updates must be an array of JSON objects, never strings; use [] when no tracker changes are needed. Leave enough output budget to close the JSON object.`;

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
  "story_generation", "rpg_assessment", "event_trigger", "event_extension",
  "turn_intent", "scene_coverage", "scene_coverage_rewrite", "event_coverage"
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
  extension_narration_limit_exceeded: "shorten_or_replace_turn"
} as const;

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
  estimatorVersion: z.literal("story-token-estimate-v1").optional()
}).strict().superRefine((value, context) => {
  if (diagnosticActionByCode[value.code] !== value.action) context.addIssue({ code: "custom", path: ["action"], message: "Diagnostic action must match its code." });
});

export type SafeGenerationDiagnostic = z.infer<typeof safeGenerationDiagnosticSchema>;

/** Drops private or malformed persisted diagnostics before a public projection. */
export function projectSafeGenerationDiagnostic(value: unknown): SafeGenerationDiagnostic | null {
  const parsed = safeGenerationDiagnosticSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
export type StoryTurnOutput = z.infer<typeof storyTurnOutputSchema>;

export function storyPromptCompatibilityIdentity(): string {
  return `${STORY_PROMPT_PROTOCOL_VERSION}|${STORY_PROMPT_SCHEMA_VERSION}|${STORY_CONTEXT_POLICY_VERSION}`;
}

export function storyPromptProtocolIdentity(templateHashes: Readonly<Record<string, string>>): string {
  const templates = Object.keys(templateHashes).sort().map((key) => `${key}:${templateHashes[key]}`).join("|");
  return `${storyPromptCompatibilityIdentity()}|${templates}`;
}
