import { z } from "zod";
import { sha256Hex } from "./hash.js";
import { castFieldSchema } from "./campaign-cast.js";

/**
 * Provider-facing response envelopes for new version-two execution contracts.
 * These are deliberately independent of local Zod acceptance schemas: local
 * parsing still owns coercion, defaults, evidence binding, and semantic checks.
 */
export const providerOutputSchemaOperationV2Schema = z.enum([
  "story", "choices", "continuity_review", "rpg_assessment", "event_trigger_before", "event_trigger_after",
  "scene_coverage", "event_coverage", "world_outline", "world_seed_character", "standalone_character",
  "character_organizer", "source_extraction", "source_synthesis", "source_character", "illustration_prompt_refinement", "cast_discovery"
]);
export type ProviderOutputSchemaOperationV2 = z.infer<typeof providerOutputSchemaOperationV2Schema>;

/**
 * Logical invocation identities stay separate from provider envelope names.
 * Initial and repair calls can share one envelope while retaining different
 * frozen prompts, plan hashes, and audit identities.
 */
export const responseContractOperationV2Schema = z.enum([
  "story_generation", "story_recovery", "story_choice_repair", "event_extension", "scene_coverage_rewrite",
  "story_continuity_review", "story_continuity_repair", "rpg_assessment", "event_trigger_before",
  "event_trigger_after", "scene_coverage_validation", "event_coverage_validation",
  "world_outline", "world_outline_repair", "world_seed_character", "world_seed_character_repair",
  "standalone_character", "standalone_character_repair", "character_organizer", "character_organizer_repair",
  "source_extraction", "source_extraction_repair", "source_synthesis", "source_synthesis_repair",
  "source_character", "source_character_repair", "illustration_prompt_refinement", "cast_discovery"
]);
export type ResponseContractOperationV2 = z.infer<typeof responseContractOperationV2Schema>;

export const directAuthoringTextOperationV2Schema = z.enum([
  "worldOutline", "worldOutlineRepair", "seedCharacter", "seedCharacterRepair",
  "standaloneCharacter", "standaloneCharacterRepair", "organizer", "organizerRepair"
]);
export type DirectAuthoringTextOperationV2 = z.infer<typeof directAuthoringTextOperationV2Schema>;

export const authoringTextOperationV2Schema = z.enum([
  ...directAuthoringTextOperationV2Schema.options,
  "sourceExtraction", "sourceExtractionRepair", "sourceSynthesis", "sourceSynthesisRepair",
  "sourceCharacter", "sourceCharacterRepair", "illustrationPromptRefinement"
]);
export type AuthoringTextOperationV2 = z.infer<typeof authoringTextOperationV2Schema>;

const directAuthoringContractIdentity = {
  worldOutline: { operation: "world_outline", schemaOperation: "world_outline" },
  worldOutlineRepair: { operation: "world_outline_repair", schemaOperation: "world_outline" },
  seedCharacter: { operation: "world_seed_character", schemaOperation: "world_seed_character" },
  seedCharacterRepair: { operation: "world_seed_character_repair", schemaOperation: "world_seed_character" },
  standaloneCharacter: { operation: "standalone_character", schemaOperation: "standalone_character" },
  standaloneCharacterRepair: { operation: "standalone_character_repair", schemaOperation: "standalone_character" },
  organizer: { operation: "character_organizer", schemaOperation: "character_organizer" },
  organizerRepair: { operation: "character_organizer_repair", schemaOperation: "character_organizer" },
  sourceExtraction: { operation: "source_extraction", schemaOperation: "source_extraction" },
  sourceExtractionRepair: { operation: "source_extraction_repair", schemaOperation: "source_extraction" },
  sourceSynthesis: { operation: "source_synthesis", schemaOperation: "source_synthesis" },
  sourceSynthesisRepair: { operation: "source_synthesis_repair", schemaOperation: "source_synthesis" },
  sourceCharacter: { operation: "source_character", schemaOperation: "source_character" },
  sourceCharacterRepair: { operation: "source_character_repair", schemaOperation: "source_character" },
  illustrationPromptRefinement: { operation: "illustration_prompt_refinement", schemaOperation: "illustration_prompt_refinement" }
} as const satisfies Record<AuthoringTextOperationV2, Readonly<{
  operation: ResponseContractOperationV2;
  schemaOperation: ProviderOutputSchemaOperationV2;
}>>;

export function authoringResponseContractIdentity(operationValue: unknown): Readonly<{
  operation: ResponseContractOperationV2;
  schemaOperation: ProviderOutputSchemaOperationV2;
  invocationKey: `${ProviderOutputSchemaOperationV2}:nonstream`;
}> {
  const operation = authoringTextOperationV2Schema.parse(operationValue);
  const identity = directAuthoringContractIdentity[operation];
  return Object.freeze({ ...identity, invocationKey: `${identity.schemaOperation}:nonstream` });
}

export function directAuthoringResponseContractIdentity(operationValue: unknown): Readonly<{
  operation: ResponseContractOperationV2;
  schemaOperation: ProviderOutputSchemaOperationV2;
  invocationKey: `${ProviderOutputSchemaOperationV2}:nonstream`;
}> {
  const operation = directAuthoringTextOperationV2Schema.parse(operationValue);
  return authoringResponseContractIdentity(operation);
}

export type ProviderOutputSchemaV2 = Readonly<{
  operation: ProviderOutputSchemaOperationV2;
  version: string;
  name: string;
  schema: Readonly<Record<string, unknown>>;
  schemaHash: string;
  requiresOpenTrackerObjects: boolean;
}>;

type JsonSchema = Readonly<Record<string, unknown>>;
const nonBlank = "^\\S(?:[\\s\\S]*\\S)?$";
const uuid = "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$";
const pointer = "^(?:/(?:[^~/]|~[01])*)*$";
const sourceEvidenceId = "^evidence:[a-f0-9]{24}$";

function closed(properties: Record<string, JsonSchema>, required = Object.keys(properties)): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}
function string(minLength = 0, maxLength?: number, pattern?: string): JsonSchema {
  return { type: "string", ...(minLength ? { minLength } : {}), ...(maxLength === undefined ? {} : { maxLength }), ...(pattern ? { pattern } : {}) };
}
const text = (maximum: number) => string(1, maximum, nonBlank);
const optionalText = (maximum: number) => string(0, maximum);
const uuidSchema = string(36, 36, uuid);
const stringList = (maximum: number, itemMaximum: number) => ({ type: "array", maxItems: maximum, items: text(itemMaximum) } as const);

const rpgStat = closed({ name: text(200), value: { type: "integer", minimum: 1, maximum: 99 }, note: text(2_000) });
const defaultTrigger = closed({ name: text(200), value: text(4_000), rules: text(4_000) });
const characterProfile = closed({
  identity: closed({ aliases: stringList(20, 200), pronouns: optionalText(2_000) }),
  story: closed({
    role: optionalText(20_000), background: optionalText(20_000), personality: optionalText(20_000), motivations: optionalText(20_000),
    goals: optionalText(20_000), fearsAndConflicts: optionalText(20_000), keyRelationships: optionalText(20_000), narrativeHooks: optionalText(20_000),
    voiceAndMannerisms: optionalText(20_000), otherGuidance: optionalText(20_000)
  }),
  appearance: closed({
    ancestryOrSpecies: optionalText(2_000), apparentAge: optionalText(2_000), genderPresentation: optionalText(2_000), build: optionalText(2_000),
    skinOrComplexion: optionalText(2_000), face: optionalText(20_000), eyes: optionalText(2_000), hair: optionalText(20_000),
    distinguishingFeatures: stringList(50, 2_000), clothing: optionalText(20_000), equipmentAndAccessories: optionalText(20_000), otherVisualDetails: optionalText(20_000)
  }),
  unclassifiedNotes: optionalText(200_000)
});

const storyProperties = {
  choices: { type: "array", minItems: 4, maxItems: 4, items: text(2_000) }, custom_action_suggestion: text(2_000),
  scratchpad: optionalText(100_000), tracker_updates: { type: "array", maxItems: 200, items: { type: "object", additionalProperties: true } },
  image_prompt: optionalText(20_000), continuity_summary: optionalText(20_000), canonical_facts: stringList(100, 4_000),
  superseded_facts: { type: "array", maxItems: 0, items: text(4_000) },
  canonical_fact_updates: { type: "array", maxItems: 100, items: closed({ content: text(4_000), supersedes_fact_ids: { type: "array", maxItems: 100, items: uuidSchema } }) },
  open_threads: stringList(500, 4_000)
} as const;
// Key order matters for the v2 hash: narration stays first, exactly as before.
const story = closed({ narration: text(200_000), ...storyProperties });
/** v3 needs no JSON escapes: paragraph boundaries are array items. */
const storyParagraphs = closed({ narration_paragraphs: { type: "array", minItems: 1, maxItems: 400, items: string(1, 20_000) }, ...storyProperties });
const choices = closed({ choices: { type: "array", minItems: 4, maxItems: 4, items: text(2_000) }, custom_action_suggestion: text(2_000) });
const outputLocation = closed({ path: string(0, undefined, pointer), start: { type: "integer", minimum: 0 }, end: { type: "integer", minimum: 1 }, quote: string(1, 1_000) });
const sourceBasis = closed({ kind: { const: "source" }, evidenceId: string(64, 64, "^[a-f0-9]{64}$"), quote: string(1, 1_000) });
const candidateBasis = closed({ kind: { const: "candidate" }, draftHash: string(64, 64, "^[a-f0-9]{64}$"), location: outputLocation });
const continuityReview = closed({
  version: { const: "story-continuity-review-v1" }, verdict: { enum: ["pass", "conflict", "uncertain"] },
  findings: { type: "array", maxItems: 20, items: { oneOf: [
    closed({ kind: { const: "contradiction" }, category: { enum: ["world_rule", "character_attribute", "relationship", "chronology", "location", "object_state", "thread_loss", "direction_coverage", "replacement_state"] }, severity: { const: "contradiction" }, basis: { oneOf: [sourceBasis, candidateBasis] }, output: outputLocation, explanation: string(1, 1_000) }),
    closed({ kind: { const: "omission" }, category: { enum: ["thread_loss", "direction_coverage", "replacement_state"] }, severity: { const: "warning" }, expectedEvidenceIds: { type: "array", minItems: 1, maxItems: 20, uniqueItems: true, items: string(64, 64, "^[a-f0-9]{64}$") }, outputPath: string(0, undefined, pointer), explanation: string(1, 1_000) })
  ] } }
});
const assessment = closed({ stat_id: text(200), difficulty_modifier: { type: "integer", minimum: -50, maximum: 40 }, rationale: text(2_000), favorable_outcome: text(3_000), setback_outcome: text(3_000) });
const eventDecision = closed({ activated_trigger_ids: { type: "array", maxItems: 200, items: text(200) }, reasons: { type: "object", additionalProperties: text(2_000) } });
const coverage = closed({ covered: { type: "boolean" }, missing_required_beats: stringList(20, 500), contradictions: stringList(20, 500) });
const eventCoverage = closed({ event_results: { type: "array", maxItems: 500, items: closed({ event_id: text(200), covered: { type: "boolean" }, missing_required_beats: stringList(20, 500), contradictions: stringList(20, 500) }) } });
const seed = closed({ id: text(200), name: text(200), role: text(2_000), concept: text(10_000), narrative_hook: text(10_000) });
const worldOutline = closed({
  title: text(200), genre: text(2_000), tone: text(2_000), backgroundStory: text(200_000), premise: text(200_000), firstAction: text(200_000), story_rules: text(200_000),
  rpg_statistics: { type: "array", maxItems: 10_000, items: rpgStat }, default_triggers: { type: "array", maxItems: 10_000, items: defaultTrigger }, event_triggers: { type: "array", maxItems: 10_000, items: defaultTrigger },
  character_seeds: { type: "array", minItems: 3, maxItems: 4, items: seed }
});
const seedCharacter = closed({ id: text(200), name: text(200), character_text: optionalText(200_000), profile: characterProfile, rpg_statistics: { type: "array", maxItems: 10_000, items: rpgStat }, default_triggers: { type: "array", maxItems: 10_000, items: defaultTrigger } });
const standaloneCharacter = closed({ name: text(200), profile: characterProfile, rpgStats: { type: "array", maxItems: 10_000, items: rpgStat }, defaultTriggers: { type: "array", maxItems: 10_000, items: defaultTrigger } });
const organizer = closed({
  candidate: characterProfile, evidence: { type: "array", maxItems: 500, items: closed({ path: text(300), source: text(100), quote: text(4_000) }) },
  unassignedText: { type: "array", maxItems: 100, items: optionalText(20_000) }, conflicts: { type: "array", maxItems: 100, items: optionalText(4_000) }, warnings: { type: "array", maxItems: 100, items: optionalText(4_000) }, protocolVersion: text(100)
});
const extractionCitation = closed({ evidenceId: string(9, 33, sourceEvidenceId) });
const extractionFact = closed({ category: { enum: ["character", "location", "faction", "relationship", "rule", "event", "tone"] }, subject: text(4_000), predicate: text(4_000), value: text(4_000), provenance: { enum: ["stated", "inferred"] }, citations: { type: "array", minItems: 1, maxItems: 200, items: extractionCitation } });
const extraction = closed({ facts: { type: "array", maxItems: 200, items: extractionFact } });
const sourceField = closed({ path: text(500), value: text(20_000), supportingFactIds: { type: "array", minItems: 1, maxItems: 200, items: text(200) } });
const sourceSynthesis = closed({ fields: { type: "array", maxItems: 2_000, items: sourceField }, characterFields: { type: "array", maxItems: 20, items: closed({ selectedCharacterFactId: text(200), fields: { type: "array", maxItems: 2_000, items: sourceField } }) }, expansionCandidates: { type: "array", maxItems: 2_000, items: closed({ target: text(200), path: text(500), value: text(20_000), supportingFactIds: { type: "array", minItems: 1, maxItems: 200, items: text(200) } }) } });
const illustrationPrompt = closed({ image_prompt: text(20_000) });

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export function stableJsonHash(value: unknown): string { return sha256Hex(canonicalJson(value)); }
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
function entry(operation: ProviderOutputSchemaOperationV2, version: string, name: string, schema: JsonSchema, requiresOpenTrackerObjects = false): ProviderOutputSchemaV2 {
  const frozen = deepFreeze(schema);
  return deepFreeze({ operation, version, name, schema: frozen, schemaHash: stableJsonHash(frozen), requiresOpenTrackerObjects });
}

const castEvidence = { paragraphId: string(1, 200), quote: string(1, 1000) };
const castDiscovery = closed({ version: { const: 1 }, characters: { type: "array", maxItems: 20, items: closed({
  localKey: string(1, 100), name: text(200), aliases: stringList(20, 200), existingCharacterId: { anyOf: [uuidSchema, { type: "null" }] },
  identityEvidence: { type: "array", minItems: 1, maxItems: 8, items: closed(castEvidence) },
  observations: { type: "array", maxItems: 20, items: closed({ ...castEvidence, field: { enum: castFieldSchema.options }, value: string(1, 2000),
    mode: { enum: ["fact", "claim"] }, speakerCharacterId: { anyOf: [uuidSchema, { type: "null" }] } }) }
}) } });

const preferredRegistry: Readonly<Record<ProviderOutputSchemaOperationV2, ProviderOutputSchemaV2>> = deepFreeze({
  cast_discovery: entry("cast_discovery", "cast-discovery-v1", "infinite_quest_cast_discovery_v1", castDiscovery),
  story: entry("story", "story-native-v2", "infinite_quest_story_native_v2", story, true),
  choices: entry("choices", "choices-v2", "infinite_quest_choices_v2", choices),
  continuity_review: entry("continuity_review", "continuity-review-v2", "infinite_quest_continuity_review_v2", continuityReview),
  rpg_assessment: entry("rpg_assessment", "rpg-assessment-v1", "infinite_quest_rpg_assessment_v1", assessment),
  event_trigger_before: entry("event_trigger_before", "event-trigger-before-v1", "infinite_quest_event_trigger_before_v1", eventDecision),
  event_trigger_after: entry("event_trigger_after", "event-trigger-after-v1", "infinite_quest_event_trigger_after_v1", eventDecision),
  scene_coverage: entry("scene_coverage", "scene-coverage-v1", "infinite_quest_scene_coverage_v1", coverage),
  event_coverage: entry("event_coverage", "event-coverage-v1", "infinite_quest_event_coverage_v1", eventCoverage),
  world_outline: entry("world_outline", "world-outline-v1", "infinite_quest_world_outline_v1", worldOutline),
  world_seed_character: entry("world_seed_character", "world-seed-character-v1", "infinite_quest_world_seed_character_v1", seedCharacter),
  standalone_character: entry("standalone_character", "standalone-character-v1", "infinite_quest_standalone_character_v1", standaloneCharacter),
  character_organizer: entry("character_organizer", "character-organizer-v1", "infinite_quest_character_organizer_v1", organizer),
  source_extraction: entry("source_extraction", "source-extraction-v1", "infinite_quest_source_extraction_v1", extraction),
  source_synthesis: entry("source_synthesis", "source-synthesis-v1", "infinite_quest_source_synthesis_v1", sourceSynthesis),
  source_character: entry("source_character", "source-character-v1", "infinite_quest_source_character_v1", sourceSynthesis),
  illustration_prompt_refinement: entry("illustration_prompt_refinement", "illustration-prompt-refinement-v1", "infinite_quest_illustration_prompt_refinement_v1", illustrationPrompt)
});

/** Every addressable wire version per operation, preferred first. Never remove
 * a version that a frozen job may still reference. */
const versionedRegistry: Readonly<Record<ProviderOutputSchemaOperationV2, readonly ProviderOutputSchemaV2[]>> = deepFreeze({
  ...(Object.fromEntries(Object.entries(preferredRegistry).map(([operation, schema]) => [operation, [schema]])) as Record<ProviderOutputSchemaOperationV2, ProviderOutputSchemaV2[]>),
  story: [entry("story", "story-native-v3", "infinite_quest_story_paragraphs_v3", storyParagraphs, true), preferredRegistry.story]
});

/** Picks one version for an operation: the first, in preference order, that the caller accepts. */
export function selectProviderOutputSchemaV2(
  operation: ProviderOutputSchemaOperationV2,
  accepts: (schema: ProviderOutputSchemaV2) => boolean
): ProviderOutputSchemaV2 | null {
  return versionedRegistry[operation].find(accepts) ?? null;
}

export function providerOutputSchemaVersionsV2(operation: ProviderOutputSchemaOperationV2): readonly ProviderOutputSchemaV2[] {
  return versionedRegistry[operation];
}

export function findProviderOutputSchemaV2(operation: ProviderOutputSchemaOperationV2, version: string): ProviderOutputSchemaV2 | undefined {
  return versionedRegistry[operation]?.find((entry) => entry.version === version);
}

/** Resolves a registered version from persisted evidence that only carries a schema hash, not a
 * version string (e.g. SchemaVerificationV2). Never throws. */
export function findProviderOutputSchemaV2ByHash(operation: ProviderOutputSchemaOperationV2, schemaHash: string): ProviderOutputSchemaV2 | undefined {
  return versionedRegistry[operation]?.find((entry) => entry.schemaHash === schemaHash);
}

/** Returns an immutable strict wire schema; callers must retain their local semantic parser. */
export function getProviderOutputSchemaV2(operation: ProviderOutputSchemaOperationV2, version?: string): ProviderOutputSchemaV2 {
  if (version === undefined) return versionedRegistry[operation][0]!;
  const found = findProviderOutputSchemaV2(operation, version);
  if (!found) throw new Error(`Unknown ${operation} schema version ${version}.`);
  return found;
}
