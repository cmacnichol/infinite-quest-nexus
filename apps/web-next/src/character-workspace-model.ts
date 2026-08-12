import {
  MAX_CHARACTER_MECHANICS_ITEMS,
  characterProfileSchema,
  playableCharacterSchema,
  type PlayableCharacter
} from "../../../packages/contracts/src/world-library.js";

export type CharacterMethod = "manual" | "ai";
export type CharacterStage = "method" | "identity" | "story" | "appearance" | "mechanics" | "review";

export interface CharacterValidationIssue {
  stage: CharacterStage;
  path: string;
  message: string;
  severity: "error" | "warning";
}

export interface CharacterWorkspaceState {
  stage: CharacterStage;
  furthestStageIndex: number;
  method: CharacterMethod | null;
  candidate: PlayableCharacter;
  roster: PlayableCharacter[];
}

export interface CreateCharacterWorkspaceOptions {
  roster: readonly PlayableCharacter[];
  candidate?: PlayableCharacter;
  method?: CharacterMethod | null;
  idFactory?: () => string;
}

export interface CharacterValidation {
  issues: CharacterValidationIssue[];
}

export interface CharacterReview {
  provenance: CharacterMethod | null;
  ready: boolean;
  warnings: CharacterValidationIssue[];
  warningCount: number;
  readiness: Array<{ stage: CharacterStage; ready: boolean; issueCount: number }>;
  counts: {
    aliases: number;
    completedStoryFields: number;
    completedAppearanceFields: number;
    stats: number;
    triggers: number;
  };
  candidate: PlayableCharacter;
}

const CHARACTER_STAGES: readonly CharacterStage[] = [
  "method",
  "identity",
  "story",
  "appearance",
  "mechanics",
  "review"
];
const PROHIBITED_ROOT_KEYS = new Set(["user_id", "userId", "owner_user_id", "ownerUserId"]);
const ID_FACTORY_RETRIES = 10;
const MAX_CHARACTER_NAME_LENGTH = 200;
const MAX_CHARACTER_TEXT_LENGTH = 200_000;

function clone<T>(value: T): T {
  if (value === undefined) return value;
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as T;
}

function stripProhibitedRootKeys(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !PROHIBITED_ROOT_KEYS.has(key)));
}

function createTrustedId(roster: readonly PlayableCharacter[], idFactory: () => string): string {
  const ids = new Set(roster.map(({ id }) => id));
  let base = "character";
  for (let attempt = 0; attempt < ID_FACTORY_RETRIES; attempt += 1) {
    const generated = idFactory().trim();
    if (generated) base = generated;
    if (generated && !ids.has(generated)) return generated;
  }
  let suffix = 2;
  while (ids.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function emptyCandidate(id: string): PlayableCharacter {
  return {
    id,
    name: "",
    characterText: "",
    profile: characterProfileSchema.parse({}),
    rpgStats: [],
    defaultTriggers: [],
    source: {}
  };
}

function setAtPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  if (path.length === 0) throw new Error("A character candidate field path is required.");
  let parent = target;
  for (const segment of path.slice(0, -1)) {
    const child = parent[segment];
    if (typeof child !== "object" || child === null || Array.isArray(child)) {
      throw new Error(`Character candidate field path ${path.join(".")} is invalid.`);
    }
    parent = child as Record<string, unknown>;
  }
  parent[path[path.length - 1]!] = clone(value);
}

function issue(
  stage: CharacterStage,
  path: string,
  message: string,
  severity: CharacterValidationIssue["severity"] = "error"
): CharacterValidationIssue {
  return { stage, path, message, severity };
}

function normalizedName(value: unknown): string {
  return typeof value === "string" ? value.trim().toLocaleLowerCase() : "";
}

function duplicateIdentityIssues(state: CharacterWorkspaceState): CharacterValidationIssue[] {
  const issues: CharacterValidationIssue[] = [];
  const candidateId = typeof state.candidate.id === "string" ? state.candidate.id.trim() : "";
  if (candidateId && state.roster.some(({ id }) => id.trim() === candidateId)) {
    issues.push(issue("identity", "candidate.id", "Character ID must be unique in this world draft."));
  }
  const name = normalizedName(state.candidate.name);
  if (name && state.roster.some((character) => normalizedName(character.name) === name)) {
    issues.push(issue("identity", "candidate.name", "Another character already uses this name.", "warning"));
  }
  return issues;
}

function profileContractIssues(state: CharacterWorkspaceState, stage: CharacterStage): CharacterValidationIssue[] {
  const parsed = characterProfileSchema.safeParse(state.candidate.profile ?? {});
  if (parsed.success) return [];
  return parsed.error.issues
    .filter((profileIssue) => {
      const section = profileIssue.path[0];
      if (stage === "identity") return section === "identity";
      if (stage === "story") return section === "story" || section === "unclassifiedNotes";
      return stage === "appearance" && section === "appearance";
    })
    .map((profileIssue) => issue(
      stage,
      `candidate.profile.${profileIssue.path.join(".")}`,
      profileIssue.message
    ));
}

function completedTextCount(value: Record<string, unknown>): number {
  return Object.values(value).filter((entry) => typeof entry === "string" && entry.trim().length > 0).length;
}

export function createCharacterWorkspaceState(options: CreateCharacterWorkspaceOptions): CharacterWorkspaceState {
  const roster = clone([...options.roster]);
  const candidate = options.candidate
    ? clone(options.candidate)
    : emptyCandidate(createTrustedId(roster, options.idFactory ?? (() => crypto.randomUUID())));
  candidate.profile ??= characterProfileSchema.parse({});
  return {
    stage: "method",
    furthestStageIndex: 0,
    method: options.method ?? null,
    candidate,
    roster
  };
}

export function editCharacterCandidate(
  state: CharacterWorkspaceState,
  path: readonly string[],
  value: unknown
): CharacterWorkspaceState {
  const next = clone(state);
  setAtPath(next.candidate as Record<string, unknown>, path, value);
  if (next.method === null) next.method = "manual";
  return next;
}

export function applyGeneratedCharacter(
  state: CharacterWorkspaceState,
  generatedCharacter: unknown
): CharacterWorkspaceState {
  if (typeof generatedCharacter !== "object" || generatedCharacter === null || Array.isArray(generatedCharacter)) {
    throw new Error("Generated character must be an object.");
  }
  const next = clone(state);
  const safeGenerated = stripProhibitedRootKeys(clone(generatedCharacter as Record<string, unknown>));
  const candidate = stripProhibitedRootKeys({
    ...(next.candidate as Record<string, unknown>),
    ...safeGenerated,
    id: next.candidate.id
  });
  const parsed = playableCharacterSchema.safeParse(candidate);
  if (!parsed.success) throw new Error("Generated character does not satisfy the playable-character contract.");
  next.candidate = parsed.data;
  next.method = "ai";
  return next;
}

export function validateCharacterStage(
  state: CharacterWorkspaceState,
  stage: CharacterStage = state.stage
): CharacterValidation {
  const issues: CharacterValidationIssue[] = [];
  const includes = (target: CharacterStage): boolean => stage === target || stage === "review";

  if (includes("method") && state.method === null) {
    issues.push(issue("method", "method", "Choose a character creation method."));
  }
  if (includes("identity")) {
    if (typeof state.candidate.id !== "string" || !state.candidate.id.trim()) {
      issues.push(issue("identity", "candidate.id", "Character ID is required."));
    } else if (state.candidate.id.trim().length > MAX_CHARACTER_NAME_LENGTH) {
      issues.push(issue("identity", "candidate.id", "Character ID must contain 200 characters or fewer."));
    }
    if (typeof state.candidate.name !== "string" || !state.candidate.name.trim()) {
      issues.push(issue("identity", "candidate.name", "Character name is required."));
    } else if (state.candidate.name.trim().length > MAX_CHARACTER_NAME_LENGTH) {
      issues.push(issue("identity", "candidate.name", "Character name must contain 200 characters or fewer."));
    }
    issues.push(...duplicateIdentityIssues(state));
    issues.push(...profileContractIssues(state, "identity"));
  }
  if (includes("story")) {
    if (typeof state.candidate.characterText !== "string" || !state.candidate.characterText.trim()) {
      issues.push(issue("story", "candidate.characterText", "Narrative guidance is required."));
    } else if (state.candidate.characterText.length > MAX_CHARACTER_TEXT_LENGTH) {
      issues.push(issue("story", "candidate.characterText", "Narrative guidance must contain 200000 characters or fewer."));
    }
    issues.push(...profileContractIssues(state, "story"));
  }
  if (includes("appearance")) {
    issues.push(...profileContractIssues(state, "appearance"));
  }
  if (includes("mechanics")) {
    for (const collection of ["rpgStats", "defaultTriggers"] as const) {
      const value = state.candidate[collection];
      if (!Array.isArray(value)) {
        issues.push(issue("mechanics", `candidate.${collection}`, `${collection} must be an array.`));
      } else if (value.length > MAX_CHARACTER_MECHANICS_ITEMS) {
        issues.push(issue(
          "mechanics",
          `candidate.${collection}`,
          `${collection} cannot contain more than ${MAX_CHARACTER_MECHANICS_ITEMS} items.`
        ));
      }
    }
  }
  return { issues };
}

export function setCharacterStage(
  state: CharacterWorkspaceState,
  stage: CharacterStage
): CharacterWorkspaceState {
  const next = clone(state);
  const currentIndex = CHARACTER_STAGES.indexOf(state.stage);
  const nextIndex = CHARACTER_STAGES.indexOf(stage);
  if (nextIndex < 0 || nextIndex === currentIndex) return next;
  if (nextIndex > state.furthestStageIndex && nextIndex > currentIndex + 1) return next;
  const blockingIssues = validateCharacterStage(state, state.stage).issues.filter(({ severity }) => severity === "error");
  if (nextIndex > currentIndex && blockingIssues.length > 0) return next;
  next.stage = stage;
  next.furthestStageIndex = Math.max(next.furthestStageIndex, nextIndex);
  return next;
}

export function characterReview(state: CharacterWorkspaceState): CharacterReview {
  const candidate = clone(state.candidate);
  const allIssues = validateCharacterStage(state, "review").issues;
  const warnings = allIssues.filter(({ severity }) => severity === "warning");
  const profile = candidate.profile ?? characterProfileSchema.parse({});
  const appearance = profile.appearance as Record<string, unknown>;
  const appearanceTextCount = completedTextCount(appearance);
  const distinguishingFeatures = Array.isArray(appearance.distinguishingFeatures)
    ? appearance.distinguishingFeatures.filter((entry) => typeof entry === "string" && entry.trim()).length
    : 0;
  return {
    provenance: state.method,
    ready: allIssues.every(({ severity }) => severity !== "error"),
    warnings,
    warningCount: warnings.length,
    readiness: CHARACTER_STAGES.map((reviewStage) => {
      const stageIssues = validateCharacterStage(state, reviewStage).issues;
      const errors = stageIssues.filter(({ severity }) => severity === "error");
      return { stage: reviewStage, ready: errors.length === 0, issueCount: errors.length };
    }),
    counts: {
      aliases: profile.identity.aliases.length,
      completedStoryFields: completedTextCount(profile.story as Record<string, unknown>),
      completedAppearanceFields: appearanceTextCount + distinguishingFeatures,
      stats: Array.isArray(candidate.rpgStats) ? candidate.rpgStats.length : 0,
      triggers: Array.isArray(candidate.defaultTriggers) ? candidate.defaultTriggers.length : 0
    },
    candidate
  };
}

export function characterHandoffCandidate(state: CharacterWorkspaceState): PlayableCharacter | null {
  const validation = validateCharacterStage(state, "review");
  if (validation.issues.some(({ severity }) => severity === "error")) return null;
  const safeCandidate = stripProhibitedRootKeys(clone(state.candidate) as Record<string, unknown>);
  const parsed = playableCharacterSchema.safeParse(safeCandidate);
  if (!parsed.success || state.roster.some(({ id }) => id.trim() === parsed.data.id)) return null;
  return clone(parsed.data);
}
