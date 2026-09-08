import type { AuthoringFailure, AuthoringIssue } from "./authoring.js";

export type AuthoringIssueReason = "missing_role" | "missing_background" | "missing_drive" | "missing_story_fact" | "mechanics_language" | "prohibited_metadata" | "seed_id_mismatch" | "seed_name_mismatch" | "organizer_evidence";

const ISSUE_LIMIT = 20;
const PROFILE_PATH = /^profile\.(?:identity\.(?:aliases|pronouns)|story\.(?:role|background|personality|motivations|goals|fearsAndConflicts|keyRelationships|narrativeHooks|voiceAndMannerisms|otherGuidance)|appearance\.(?:ancestryOrSpecies|apparentAge|genderPresentation|build|skinOrComplexion|face|eyes|hair|distinguishingFeatures|clothing|equipmentAndAccessories|otherVisualDetails)|unclassifiedNotes)$/;
const WORLD_PATH = /^world\.(?:title|genre|tone|premise|backgroundStory|firstAction|rules)$/;
const CHARACTER_PATH = /^playableCharacters\.\d+\.(?:id|name|characterText|profile(?:\.(?:identity\.(?:aliases|pronouns)|story\.(?:role|background|personality|motivations|goals|fearsAndConflicts|keyRelationships|narrativeHooks|voiceAndMannerisms|otherGuidance)|appearance\.(?:ancestryOrSpecies|apparentAge|genderPresentation|build|skinOrComplexion|face|eyes|hair|distinguishingFeatures|clothing|equipmentAndAccessories|otherVisualDetails)|unclassifiedNotes))?|rpgStats|defaultTriggers)$/;
const ORGANIZER_PATH = /^(?:candidate(?:\.(?:identity\.(?:aliases|pronouns)|story\.(?:role|background|personality|motivations|goals|fearsAndConflicts|keyRelationships|narrativeHooks|voiceAndMannerisms|otherGuidance)|appearance\.(?:ancestryOrSpecies|apparentAge|genderPresentation|build|skinOrComplexion|face|eyes|hair|distinguishingFeatures|clothing|equipmentAndAccessories|otherVisualDetails)|unclassifiedNotes))?|evidence(?:\.\d+\.(?:path|source|quote))?|unassignedText|conflicts|warnings)$/;
const CONVERTED_WORLD_PATH = /^(?:title|genre|tone|backgroundStory|premise|firstAction|story_rules|character_seeds|character_seeds\.\d+\.(?:id|name|role|concept|narrative_hook))$/;

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
  "missing_role", "missing_background", "missing_drive", "missing_story_fact", "mechanics_language", "prohibited_metadata", "seed_id_mismatch", "seed_name_mismatch", "organizer_evidence"
]);

function isAllowedPath(path: string): boolean {
  return path === "name" || path === "characterText" || path === "rpgStats" || path === "defaultTriggers"
    || path === "playableCharacters" || path === "generatedCharacter" || path === "generatedWorld"
    || PROFILE_PATH.test(path) || WORLD_PATH.test(path) || CHARACTER_PATH.test(path) || ORGANIZER_PATH.test(path) || CONVERTED_WORLD_PATH.test(path);
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
    "world.firstAction", "world.rules", "profile.story.role", "profile.story.background",
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
