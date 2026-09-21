import type { ResponseSchemaOperation } from "../../contracts/src/text-response-format.js";
import { CURRENT_STORY_RESPONSE_FORMAT_CAPABILITY_IDENTITY } from "../../contracts/src/provider-profile-view.js";
import { sha256, stableStringify } from "../../domain/src/text.js";

export type ProviderOutputSchema = Readonly<{
  operation: ResponseSchemaOperation;
  version: "story-native-v1" | "choices-v1" | "continuity-review-v1";
  name: string;
  schema: Readonly<Record<string, unknown>>;
  schemaHash: string;
  requiresOpenTrackerObjects: boolean;
}>;

type JsonSchema = Readonly<Record<string, unknown>>;

// Mirrors Zod's UUID contract: RFC versions 1–8 plus nil and max UUIDs.
const uuid = "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$";
const nonBlank = "^\\S(?:[\\s\\S]*\\S)?$";
const pointer = "^(?:/(?:[^~/]|~[01])*)*$";
const hash = "^[a-f0-9]{64}$";

function closed(properties: Record<string, JsonSchema>, required = Object.keys(properties)): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

function string(minLength = 0, maxLength?: number, pattern?: string): JsonSchema {
  return { type: "string", ...(minLength ? { minLength } : {}), ...(maxLength === undefined ? {} : { maxLength }), ...(pattern ? { pattern } : {}) };
}

const strictText = (maxLength: number): JsonSchema => string(1, maxLength, nonBlank);
const uuidSchema: JsonSchema = string(36, 36, uuid);
const emptySupersededFacts: JsonSchema = { type: "array", maxItems: 0, items: strictText(4000) };
const canonicalFactUpdate = closed({
  content: strictText(4000),
  supersedes_fact_ids: { type: "array", maxItems: 100, items: uuidSchema }
});

const storySchema: JsonSchema = closed({
  narration: strictText(200_000),
  choices: { type: "array", minItems: 4, maxItems: 4, items: strictText(2000) },
  custom_action_suggestion: strictText(2000),
  scratchpad: string(0, 100_000),
  tracker_updates: {
    type: "array", maxItems: 200,
    items: { type: "object", additionalProperties: true }
  },
  image_prompt: string(0, 20_000),
  continuity_summary: string(0, 20_000),
  canonical_facts: { type: "array", maxItems: 100, items: strictText(4000) },
  superseded_facts: emptySupersededFacts,
  canonical_fact_updates: { type: "array", maxItems: 100, items: canonicalFactUpdate },
  open_threads: { type: "array", maxItems: 500, items: strictText(4000) }
});

const choicesSchema: JsonSchema = closed({
  choices: { type: "array", minItems: 4, maxItems: 4, items: strictText(2000) },
  custom_action_suggestion: strictText(2000)
});

const outputLocation = closed({
  path: string(0, undefined, pointer), start: { type: "integer", minimum: 0 },
  // Quoted evidence is exact text, so leading and trailing whitespace is meaningful.
  end: { type: "integer", minimum: 1 }, quote: string(1, 1000)
});
const sourceBasis = closed({ kind: { const: "source" }, evidenceId: string(64, 64, hash), quote: string(1, 1000) });
const candidateBasis = closed({ kind: { const: "candidate" }, draftHash: string(64, 64, hash), location: outputLocation });
const contradiction = closed({
  kind: { const: "contradiction" },
  category: { enum: ["world_rule", "character_attribute", "relationship", "chronology", "location", "object_state", "thread_loss", "direction_coverage", "replacement_state"] },
  severity: { const: "contradiction" }, basis: { oneOf: [sourceBasis, candidateBasis] }, output: outputLocation, explanation: string(1, 1000)
});
const omission = closed({
  kind: { const: "omission" }, category: { enum: ["thread_loss", "direction_coverage", "replacement_state"] }, severity: { const: "warning" },
  expectedEvidenceIds: { type: "array", minItems: 1, maxItems: 20, uniqueItems: true, items: string(64, 64, hash) },
  outputPath: string(0, undefined, pointer), explanation: string(1, 1000)
});
const continuityReviewSchema: JsonSchema = closed({
  version: { const: "story-continuity-review-v1" }, verdict: { enum: ["pass", "conflict", "uncertain"] },
  findings: { type: "array", maxItems: 20, items: { oneOf: [contradiction, omission] } }
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function entry(operation: ResponseSchemaOperation, version: ProviderOutputSchema["version"], name: string, schema: JsonSchema, requiresOpenTrackerObjects: boolean): ProviderOutputSchema {
  const frozenSchema = deepFreeze(schema);
  return deepFreeze({ operation, version, name, schema: frozenSchema, schemaHash: sha256(stableStringify(frozenSchema)), requiresOpenTrackerObjects });
}

const registry: Readonly<Record<ResponseSchemaOperation, ProviderOutputSchema>> = deepFreeze({
  story: entry("story", CURRENT_STORY_RESPONSE_FORMAT_CAPABILITY_IDENTITY.schemaVersion, "infinite_quest_story_native_v1", storySchema, true),
  choices: entry("choices", "choices-v1", "infinite_quest_choices_v1", choicesSchema, false),
  continuity_review: entry("continuity_review", "continuity-review-v1", "infinite_quest_continuity_review_v1", continuityReviewSchema, false)
});

/** Immutable versioned provider-wire schemas. Application parsing retains semantic checks. */
export function getProviderOutputSchema(operation: ResponseSchemaOperation): ProviderOutputSchema {
  return registry[operation];
}
