import type { PlayableCharacter, WorldContent } from "../../contracts/src/world-library.js";

export type CampaignCharacterSeed = {
  character: PlayableCharacter;
  rpgStats: unknown[];
  defaultTriggers: unknown[];
};

export type WorldCampaignReadinessIssueCode =
  | "no-playable-characters"
  | "missing-character-id"
  | "duplicate-character-id"
  | "missing-character-name"
  | "missing-character-text";

export type WorldCampaignReadinessIssue = {
  code: WorldCampaignReadinessIssueCode;
  message: string;
  characterIndex?: number;
  characterId?: string;
};

export type WorldCampaignReadinessAssessment = {
  ready: boolean;
  issues: WorldCampaignReadinessIssue[];
};

function values(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function mergeNamed(shared: unknown[], characterSpecific: unknown[]): unknown[] {
  const merged = new Map<string, unknown>();
  for (const [index, value] of [...shared, ...characterSpecific].entries()) {
    const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const key = String(row.name || row.label || row.id || index).trim().toLocaleLowerCase();
    merged.set(key, value);
  }
  return [...merged.values()];
}

export function assessWorldCampaignReadiness(content: WorldContent): WorldCampaignReadinessAssessment {
  const issues: WorldCampaignReadinessIssue[] = [];
  const characters = content.playableCharacters;
  if (characters.length === 0) {
    issues.push({
      code: "no-playable-characters",
      message: "This world version has no playable characters."
    });
  }

  const seenIds = new Set<string>();
  for (const [characterIndex, character] of characters.entries()) {
    const id = typeof character.id === "string" ? character.id.trim() : "";
    const name = typeof character.name === "string" ? character.name.trim() : "";
    const characterText = typeof character.characterText === "string" ? character.characterText.trim() : "";

    if (!id) {
      issues.push({
        code: "missing-character-id",
        message: `Playable character ${characterIndex + 1} is missing an ID.`,
        characterIndex
      });
    } else if (seenIds.has(id)) {
      issues.push({
        code: "duplicate-character-id",
        message: `Playable character ID "${id}" is duplicated.`,
        characterIndex,
        characterId: id
      });
    } else {
      seenIds.add(id);
    }

    if (!name) {
      issues.push({
        code: "missing-character-name",
        message: `Playable character ${characterIndex + 1} is missing a name.`,
        characterIndex,
        ...(id ? { characterId: id } : {})
      });
    }
    if (!characterText) {
      issues.push({
        code: "missing-character-text",
        message: `Playable character ${name ? `"${name}"` : characterIndex + 1} is missing character guidance.`,
        characterIndex,
        ...(id ? { characterId: id } : {})
      });
    }
  }

  return { ready: issues.length === 0, issues };
}

export function resolvePlayableCharacters(content: WorldContent): PlayableCharacter[] {
  return content.playableCharacters;
}

export function selectPlayableCharacter(content: WorldContent, selectedCharacterId?: string): PlayableCharacter {
  const characters = resolvePlayableCharacters(content);
  if (characters.length === 0) {
    throw Object.assign(new Error("This world version has no playable characters."), { statusCode: 400 });
  }
  if (!selectedCharacterId && characters.length > 1) {
    throw Object.assign(new Error("Select a playable character for this campaign."), { statusCode: 400 });
  }
  const selected = selectedCharacterId
    ? characters.find((character) => character.id === selectedCharacterId)
    : characters[0];
  if (!selected) {
    throw Object.assign(new Error("The selected playable character does not belong to this world version."), { statusCode: 400 });
  }
  return selected;
}

export function campaignCharacterSeed(content: WorldContent, selectedCharacterId?: string): CampaignCharacterSeed {
  const character = selectPlayableCharacter(content, selectedCharacterId);
  return {
    character,
    rpgStats: mergeNamed(values(content.rpgStats), values(character.rpgStats)),
    defaultTriggers: mergeNamed(values(content.defaultTriggers), values(character.defaultTriggers))
  };
}

export function characterSnapshot(character: PlayableCharacter): Record<string, unknown> {
  const snapshot: Record<string, unknown> = { ...character };
  delete snapshot.legacy;
  return snapshot;
}

export function characterTextFromSnapshot(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  return typeof (snapshot as Record<string, unknown>).characterText === "string"
    ? String((snapshot as Record<string, unknown>).characterText).trim()
    : null;
}
