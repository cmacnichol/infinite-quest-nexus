import type { PlayableCharacter, WorldContent } from "../../contracts/src/world-library.js";

export const LEGACY_CHARACTER_ID = "legacy-default";

export type ResolvedPlayableCharacter = PlayableCharacter & {
  legacy: boolean;
};

export type CampaignCharacterSeed = {
  character: ResolvedPlayableCharacter;
  rpgStats: unknown[];
  defaultTriggers: unknown[];
};

function firstLine(value: string): string {
  return (value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "Default character").slice(0, 200);
}

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

export function resolvePlayableCharacters(content: WorldContent): ResolvedPlayableCharacter[] {
  if (content.playableCharacters.length) {
    return content.playableCharacters.map((character) => ({ ...character, legacy: false }));
  }
  const characterText = String(content.world.character || "").trim();
  return [{
    id: LEGACY_CHARACTER_ID,
    name: firstLine(characterText),
    characterText,
    rpgStats: values(content.rpgStats),
    defaultTriggers: values(content.defaultTriggers),
    source: { type: "legacy-world-content" },
    legacy: true
  }];
}

export function selectPlayableCharacter(content: WorldContent, selectedCharacterId?: string): ResolvedPlayableCharacter {
  const characters = resolvePlayableCharacters(content);
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
  if (character.legacy) {
    return { character, rpgStats: values(content.rpgStats), defaultTriggers: values(content.defaultTriggers) };
  }
  return {
    character,
    rpgStats: mergeNamed(values(content.rpgStats), values(character.rpgStats)),
    defaultTriggers: mergeNamed(values(content.defaultTriggers), values(character.defaultTriggers))
  };
}

export function characterSnapshot(character: ResolvedPlayableCharacter): Record<string, unknown> {
  const { legacy, ...snapshot } = character;
  return { ...snapshot, legacy };
}

export function characterTextFromSnapshot(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  return typeof (snapshot as Record<string, unknown>).characterText === "string"
    ? String((snapshot as Record<string, unknown>).characterText).trim()
    : null;
}
