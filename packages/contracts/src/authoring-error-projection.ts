import type { AuthoringFailure, AuthoringIssue } from "./authoring.js";

export type AuthoringIssueReason = "missing_role" | "missing_background" | "missing_drive" | "missing_story_fact" | "mechanics_language" | "prohibited_metadata" | "seed_id_mismatch" | "seed_name_mismatch" | "organizer_evidence" | "source_evidence" | "source_json_decode" | "source_envelope" | "source_schema" | "source_citation_target" | "source_coordinate_order" | "source_coordinates" | "source_quote" | "source_quote_ambiguous" | "source_output_limit" | "source_world_json" | "source_world_schema" | "source_world_closed_target" | "source_world_duplicate" | "source_world_unsupported_fact" | "source_world_identity" | "source_world_mechanics" | "source_world_faithful_expansion" | "source_world_selection";

const ISSUE_LIMIT = 20;
const PROFILE_PATH = /^profile\.(?:identity\.(?:aliases|pronouns)|story\.(?:role|background|personality|motivations|goals|fearsAndConflicts|keyRelationships|narrativeHooks|voiceAndMannerisms|otherGuidance)|appearance\.(?:ancestryOrSpecies|apparentAge|genderPresentation|build|skinOrComplexion|face|eyes|hair|distinguishingFeatures|clothing|equipmentAndAccessories|otherVisualDetails)|unclassifiedNotes)$/;
const WORLD_PATH = /^world\.(?:title|genre|tone|premise|backgroundStory|firstAction|rules)$/;
const CHARACTER_PATH = /^playableCharacters\.\d+\.(?:id|name|characterText|profile(?:\.(?:identity\.(?:aliases|pronouns)|story\.(?:role|background|personality|motivations|goals|fearsAndConflicts|keyRelationships|narrativeHooks|voiceAndMannerisms|otherGuidance)|appearance\.(?:ancestryOrSpecies|apparentAge|genderPresentation|build|skinOrComplexion|face|eyes|hair|distinguishingFeatures|clothing|equipmentAndAccessories|otherVisualDetails)|unclassifiedNotes))?|rpgStats|defaultTriggers)$/;
const ORGANIZER_PATH = /^(?:candidate(?:\.(?:identity\.(?:aliases|pronouns)|story\.(?:role|background|personality|motivations|goals|fearsAndConflicts|keyRelationships|narrativeHooks|voiceAndMannerisms|otherGuidance)|appearance\.(?:ancestryOrSpecies|apparentAge|genderPresentation|build|skinOrComplexion|face|eyes|hair|distinguishingFeatures|clothing|equipmentAndAccessories|otherVisualDetails)|unclassifiedNotes))?|evidence(?:\.\d+\.(?:path|source|quote))?|unassignedText|conflicts|warnings)$/;
const CONVERTED_WORLD_PATH = /^(?:title|genre|tone|backgroundStory|premise|firstAction|story_rules|character_seeds|character_seeds\.\d+\.(?:id|name|role|concept|narrative_hook))$/;
const SOURCE_FACT_PATH = /^facts(?:\.\d+(?:\.(?:category|subject|predicate|value|provenance|citations(?:\.\d+(?:\.(?:paragraphId|start|end|quote))?)?))?)?$/;
const SOURCE_WORLD_PATH = /^(?:fields(?:\.\d+(?:\.(?:path|value|supportingFactIds))?)?|characterFields(?:\.\d+(?:\.(?:selectedCharacterFactId|fields(?:\.\d+(?:\.(?:path|value|supportingFactIds))?)?))?)?|expansionCandidates(?:\.\d+(?:\.(?:target|path|value|supportingFactIds))?)?)$/;

const CODE_MESSAGES: Readonly<Record<string, string>> = {
  missing: "Generated content is missing a required value.",
  invalid_json: "Generated authoring JSON is malformed.",
  invalid_type: "Generated content has an invalid type.",
  too_small: "Generated content is missing a required value.",
  too_big: "Generated content exceeds an allowed limit.",
  invalid_value: "Generated content contains an unsupported value.",
  invalid_union: "Generated content does not match an allowed structure.",
  invalid_format: "Generated content has an invalid format.",
  unrecognized_keys: "Generated content contains unsupported fields.",
  not_multiple_of: "Generated content contains an invalid numeric value."
};

const ALLOWED_CODES = new Set(["custom", ...Object.keys(CODE_MESSAGES)]);
const AUTHORING_REASONS = new Set<AuthoringIssueReason>([
  "missing_role", "missing_background", "missing_drive", "missing_story_fact", "mechanics_language", "prohibited_metadata", "seed_id_mismatch", "seed_name_mismatch", "organizer_evidence", "source_evidence", "source_json_decode", "source_envelope", "source_schema", "source_citation_target", "source_coordinate_order", "source_coordinates", "source_quote", "source_quote_ambiguous", "source_output_limit", "source_world_json", "source_world_schema", "source_world_closed_target", "source_world_duplicate", "source_world_unsupported_fact", "source_world_identity", "source_world_mechanics", "source_world_faithful_expansion", "source_world_selection"
]);

function isAllowedPath(path: string): boolean {
  return path === "name" || path === "characterText" || path === "rpgStats" || path === "defaultTriggers"
    || path === "playableCharacters" || path === "generatedCharacter" || path === "generatedWorld"
    || PROFILE_PATH.test(path) || WORLD_PATH.test(path) || CHARACTER_PATH.test(path) || ORGANIZER_PATH.test(path) || CONVERTED_WORLD_PATH.test(path) || SOURCE_FACT_PATH.test(path) || SOURCE_WORLD_PATH.test(path);
}

export function safeAuthoringIssuePath(path: string, fallback = "generatedWorld"): string {
  if (isAllowedPath(path)) return path;
  const indexedProfile = /^(playableCharacters\.\d+\.profile)(?:\.|$)/.exec(path);
  if (indexedProfile) return indexedProfile[1]!;
  if (/^profile(?:\.|$)/.test(path)) return "profile";
  return fallback;
}

export function authoringIssueReason(value: unknown): AuthoringIssueReason | undefined {
  return typeof value === "string" && AUTHORING_REASONS.has(value as AuthoringIssueReason)
    ? value as AuthoringIssueReason
    : undefined;
}

export function authoringIssueMessage(path: string, code: string, reason?: unknown): string {
  if (code !== "custom") return CODE_MESSAGES[code] || "Generated content failed validation.";
  switch (authoringIssueReason(reason)) {
    case "mechanics_language": return "Generated fictional content contains mechanics language.";
    case "prohibited_metadata": return "Generated character contains prohibited provider metadata.";
    case "organizer_evidence": return "Organizer evidence does not support a populated profile field.";
    case "source_evidence": return "Generated source facts need exact evidence inside the selected source chunk.";
    case "source_json_decode": return "Generated source response is not valid JSON.";
    case "source_envelope": return "Generated source response must contain only a facts list.";
    case "source_schema": return "Generated source facts do not match the required fields.";
    case "source_citation_target": return "Generated source citation does not identify a selected source paragraph.";
    case "source_coordinate_order": return "Generated source citation end must follow its start.";
    case "source_coordinates": return "Generated source citation coordinates are outside the selected source chunk.";
    case "source_quote": return "Generated source citation quote does not match the selected source text.";
    case "source_quote_ambiguous": return "Generated source citation quote must identify one unique selected passage.";
    case "source_output_limit": return "Generated source output was truncated before completion.";
    case "source_world_json": return "Generated source-world response is not valid JSON.";
    case "source_world_schema": return "Generated source-world response does not match the required fields.";
    case "source_world_closed_target": return "Generated source-world field uses an unsupported target.";
    case "source_world_duplicate": return "Generated source-world response assigns a target more than once.";
    case "source_world_unsupported_fact": return "Generated source-world field is not supported by the reviewed facts.";
    case "source_world_identity": return "Generated source-world field does not match a selected identity.";
    case "source_world_mechanics": return "Generated source-world field contains mechanics.";
    case "source_world_faithful_expansion": return "Faithful source-world response cannot contain expansion candidates.";
    case "source_world_selection": return "The reviewed source selection is no longer valid.";
    case "missing_role": return "Generated character role is required.";
    case "missing_background": return "Generated character background is required.";
    case "missing_drive": return "Generated character needs a motivation, goal, or narrative hook.";
    case "missing_story_fact": return "Generated character profile is incomplete.";
    case "seed_id_mismatch": return "Generated character ID must match the supplied seed.";
    case "seed_name_mismatch": return "Generated character name must match the supplied seed.";
  }
  if (path === "world.title") return "Generated title is required.";
  if (path === "world.genre") return "Generated genre is required.";
  if (path === "world.tone") return "Generated tone is required.";
  if (path === "world.premise") return "Generated premise is required.";
  if (path === "world.backgroundStory") return "Generated background and canon are required.";
  if (path === "world.firstAction") return "Generated opening action is required.";
  if (path === "world.rules") return "Generated rules are required.";
  if (/(?:^|\.)story\.role$/.test(path)) return "Generated character role is required.";
  if (/(?:^|\.)story\.background$/.test(path)) return "Generated character background is required.";
  if (/(?:^|\.)(?:story\.(?:motivations|goals|narrativeHooks))$/.test(path)) return "Generated character needs a motivation, goal, or narrative hook.";
  if (/(?:^|\.)characterText$/.test(path)) return "Generated character guidance contains mechanics language.";
  if (/(?:^|\.)profile(?:\.|$)/.test(path)) return "Generated character profile is incomplete or contains mechanics language.";
  if (/^playableCharacters\.\d+\.name$/.test(path)) return "Generated character names must be distinct.";
  if (/^playableCharacters\.\d+\.id$/.test(path)) return "Generated character IDs must be distinct.";
  if (path === "playableCharacters") return "Generated worlds require three or four playable characters.";
  return "Generated content failed validation.";
}

// Derive the public allowlist from the same code-owned message policy used by validators.
const SAFE_MESSAGES = new Set([
  ...Object.values(CODE_MESSAGES),
  ...[...AUTHORING_REASONS].map((reason) => authoringIssueMessage("", "custom", reason)),
  ...["", "world.title", "world.genre", "world.tone", "world.premise", "world.backgroundStory",
    "world.firstAction", "world.rules", "profile.story.role", "profile.story.background", "facts.0.citations",
    "profile.story.motivations", "characterText", "profile", "playableCharacters.0.name",
    "playableCharacters.0.id", "playableCharacters"].map((path) => authoringIssueMessage(path, "custom"))
]);

export function safeAuthoringIssueCode(code: string): string {
  return ALLOWED_CODES.has(code) ? code : "custom";
}

function projectIssue(issue: AuthoringIssue, fallback: string): AuthoringIssue {
  const path = safeAuthoringIssuePath(issue.path.slice(0, 500), fallback);
  const code = safeAuthoringIssueCode(issue.code.slice(0, 100));
  return { path, code, message: SAFE_MESSAGES.has(issue.message) ? issue.message : authoringIssueMessage(path, code) };
}

/** The closed authoring-error representation safe for HTTP and browser rendering. */
export function projectAuthoringFailure(failure: AuthoringFailure): AuthoringFailure {
  const fallback = failure.stage === "organizer" ? "profile" : failure.stage === "character" ? "generatedCharacter" : "generatedWorld";
  return { ...failure, issues: failure.issues.slice(0, ISSUE_LIMIT).map((issue) => projectIssue(issue, fallback)) };
}
