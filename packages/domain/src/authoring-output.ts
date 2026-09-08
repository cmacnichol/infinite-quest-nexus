import { authoringIssueMessage, safeAuthoringIssuePath, safeAuthoringIssueCode, type AuthoringIssueReason } from "../../contracts/src/authoring-error-projection.js";
import { z } from "zod";
import {
  playableCharacterSchema,
  type AuthoringIssue,
  type PlayableCharacter
} from "../../contracts/src/index.js";
import { containsMechanicsLanguage } from "./text.js";

export { authoringIssueMessage, authoringIssueReason, safeAuthoringIssuePath, projectAuthoringFailure } from "../../contracts/src/authoring-error-projection.js";

export type CharacterCompletionMode = "creative" | "source";

const ISSUE_LIMIT = 20;
const PATH_LIMIT = 500;
const CODE_LIMIT = 100;
const MESSAGE_LIMIT = 500;

const STORY_FIELDS = [
  "role", "background", "personality", "motivations", "goals",
  "fearsAndConflicts", "keyRelationships", "narrativeHooks",
  "voiceAndMannerisms", "otherGuidance"
] as const;

function zodIssues(error: unknown): Array<{ path: string; code: string; reason?: unknown }> {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      code: issue.code,
      reason: (issue as { params?: Record<string, unknown> }).params?.authoringReason
    }));
  }
  if (error instanceof SyntaxError) return [{ path: "generatedWorld", code: "invalid_json" }];
  return [];
}

export function projectAuthoringIssues(error: unknown): AuthoringIssue[] {
  return zodIssues(error).slice(0, ISSUE_LIMIT).map(({ path, code, reason }) => {
    return projectAuthoringIssue({ path, code }, reason);
  });
}

function projectAuthoringIssue(
  issue: Pick<AuthoringIssue, "path" | "code">,
  reason?: unknown,
): AuthoringIssue {
  const boundedPath = issue.path.slice(0, PATH_LIMIT);
  const boundedCode = issue.code.slice(0, CODE_LIMIT);
  const code = safeAuthoringIssueCode(boundedCode);
  const path = safeAuthoringIssuePath(boundedPath);
  return {
    path,
    code,
    message: authoringIssueMessage(path, code, reason).slice(0, MESSAGE_LIMIT)
  };
}

function populated(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function profileFiction(profile: PlayableCharacter["profile"], prefix = "profile"): Array<[string, string]> {
  const fiction: Array<[string, string]> = [];
  const visit = (value: unknown, path: string) => {
    if (typeof value === "string") {
      fiction.push([path, value]);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}.${index}`));
      return;
    }
    if (!value || typeof value !== "object") return;
    Object.entries(value as Record<string, unknown>).forEach(([key, item]) => visit(item, `${path}.${key}`));
  };
  if (profile) visit(profile, prefix);
  return fiction;
}

function mechanicsFictionIssues(fiction: Array<[string, string]>): z.ZodIssue[] {
  return fiction.filter(([, text]) => containsMechanicsLanguage(text)).map(([path]) => ({
    code: "custom",
    path: path.split("."),
    message: "Generated fictional content contains mechanics language.",
    params: { authoringReason: "mechanics_language" }
  }));
}

function characterProfileFictionIssues(profile: PlayableCharacter["profile"], prefix = "profile"): z.ZodIssue[] {
  return [
    ...mechanicsFictionIssues(profileFiction(profile, prefix)),
    ...prohibitedProfileMetadata(profile, prefix).map((path): z.ZodIssue => ({
      code: "custom",
      path: path.split("."),
      message: "Generated character contains prohibited provider metadata.",
      params: { authoringReason: "prohibited_metadata" }
    }))
  ];
}

// Integrity is independent of creative completion, including for incomplete organizer proposals.
export function validateCharacterProfileFiction(profile: PlayableCharacter["profile"], prefix = "profile"): void {
  const issues = characterProfileFictionIssues(profile, prefix);
  if (issues.length) throw new z.ZodError(issues);
}

// Rules and typed mechanics are deliberately outside the generated fictional prose boundary.
export function validateGeneratedWorldFiction(world: {
  title: string; genre: string; tone: string; premise: string; backgroundStory: string; firstAction: string;
}): void {
  const fields = ["title", "genre", "tone", "premise", "backgroundStory", "firstAction"] as const;
  const issues = mechanicsFictionIssues(fields.map((field) => [`world.${field}`, world[field]]));
  if (issues.length) throw new z.ZodError(issues);
}

function prohibitedProfileMetadata(value: PlayableCharacter["profile"], prefix: string): string[] {
  const paths: string[] = [];
  const prohibitedKey = /(?:private|hidden|internal|reasoning|scratchpad|credential|secret|api[_-]?key|token|password)/i;
  const visit = (entry: unknown, path: string) => {
    if (Array.isArray(entry)) {
      entry.forEach((item, index) => visit(item, `${path}.${index}`));
      return;
    }
    if (!entry || typeof entry !== "object") return;
    Object.entries(entry as Record<string, unknown>).forEach(([key, item]) => {
      const childPath = `${path}.${key}`;
      if (prohibitedKey.test(key)) paths.push(childPath);
      visit(item, childPath);
    });
  };
  if (value) visit(value, prefix);
  return paths;
}

export function validateGeneratedCharacter(value: unknown, mode: CharacterCompletionMode): PlayableCharacter {
  const character = playableCharacterSchema.parse(value);
  const profile = character.profile;
  const issues: Array<{ path: string; message: string; reason: AuthoringIssueReason }> = [];
  if (!profile) {
    issues.push({ path: "profile", message: "Generated character profile is required.", reason: "missing_story_fact" });
  } else if (mode === "creative") {
    if (!populated(profile.story.role)) issues.push({ path: "profile.story.role", message: "Generated character role is required.", reason: "missing_role" });
    if (!populated(profile.story.background)) issues.push({ path: "profile.story.background", message: "Generated character background is required.", reason: "missing_background" });
    if (![profile.story.motivations, profile.story.goals, profile.story.narrativeHooks].some(populated)) {
      issues.push({ path: "profile.story.motivations", message: "Generated character needs a motivation, goal, or narrative hook.", reason: "missing_drive" });
    }
  } else if (!STORY_FIELDS.some((field) => populated(profile.story[field] ?? ""))) {
    issues.push({ path: "profile.story", message: "Generated source character needs a story fact.", reason: "missing_story_fact" });
  }
  const integrityIssues = [
    ...mechanicsFictionIssues([["name", character.name], ["characterText", character.characterText]]),
    ...characterProfileFictionIssues(profile)
  ];
  if (issues.length || integrityIssues.length) {
    throw new z.ZodError([...issues.map((issue): z.ZodIssue => ({
      code: "custom",
      path: issue.path.split("."),
      message: issue.message,
      params: { authoringReason: issue.reason }
    })), ...integrityIssues]);
  }
  return character;
}
