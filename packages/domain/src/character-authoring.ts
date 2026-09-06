import { z } from "zod";
import {
  characterProfileSchema,
  playableCharacterSchema,
  type PlayableCharacter,
  type WorldContent
} from "../../contracts/src/world-library.js";
import { validateGeneratedCharacter } from "./authoring-output.js";
import { effectiveAuthoringPrompt, CHARACTER_AUTHORING_PROMPT_PROTOCOL_VERSION } from "./authoring-prompts.js";

export { CHARACTER_AUTHORING_PROMPT_PROTOCOL_VERSION } from "./authoring-prompts.js";

const generatedCharacterSchema = z.object({
  name: z.string().trim().min(1).max(200),
  profile: characterProfileSchema,
  rpgStats: z.array(z.unknown()).max(10_000).default([]),
  defaultTriggers: z.array(z.unknown()).max(10_000).default([])
});

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function textValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join("\n\n");
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function normalizeRpgStats(value: unknown, characterId: string): unknown[] {
  const rows = Array.isArray(value) ? value : [];
  return rows.flatMap((entry, index) => {
    const row = objectValue(entry);
    const name = textValue(row.name ?? row.skill ?? row.stat).slice(0, 200);
    if (!name) return [];
    const rawValue = Number(row.value ?? row.score ?? row.rating ?? 50);
    const numericValue = Number.isFinite(rawValue) ? Math.round(rawValue) : 50;
    return [{
      id: textValue(row.id || `${characterId}-stat-${index + 1}`).slice(0, 200),
      name,
      value: Math.min(99, Math.max(1, numericValue)),
      note: textValue(row.note ?? row.covers).slice(0, 2000)
    }];
  });
}

function normalizeDefaultTriggers(value: unknown, characterId: string): unknown[] {
  const rows = Array.isArray(value) ? value : [];
  return rows.flatMap((entry, index) => {
    const row = objectValue(entry);
    const name = textValue(row.name ?? row.label ?? row.title).slice(0, 300);
    if (!name) return [];
    return [{
      id: textValue(row.id || `${characterId}-tracker-${index + 1}`).slice(0, 200),
      name,
      value: textValue(row.value ?? row.initialValue ?? "Not yet established.").slice(0, 6000),
      rules: textValue(row.rules ?? row.updateRules ?? row.description ?? `Track ${name} whenever it changes.`).slice(0, 4000)
    }];
  });
}

function generatedShape(value: unknown): Record<string, unknown> {
  const source = objectValue(value);
  const nested = objectValue(source.character);
  const candidate = Object.keys(nested).length ? nested : source;
  return {
    ...candidate,
    name: candidate.name,
    profile: candidate.profile,
    rpgStats: candidate.rpgStats ?? candidate.rpg_statistics ?? [],
    defaultTriggers: candidate.defaultTriggers ?? candidate.default_triggers ?? candidate.startingTrackers ?? []
  };
}

function clippedText(value: unknown, maxLength: number): string {
  return textValue(value).slice(0, maxLength);
}

function profileGuidance(profile: z.infer<typeof characterProfileSchema>): string {
  return [
    profile.story.role,
    profile.story.background,
    profile.story.personality,
    profile.story.motivations,
    profile.story.goals,
    profile.story.narrativeHooks,
    profile.story.otherGuidance
  ].map(textValue).filter(Boolean).join("\n\n").slice(0, 20_000);
}

function promptCharacter(character: PlayableCharacter) {
  return {
    id: character.id,
    name: character.name,
    characterText: clippedText(character.characterText, 12_000),
    ...(character.profile ? { profile: character.profile } : {}),
    rpgStats: character.rpgStats.slice(0, 100),
    defaultTriggers: character.defaultTriggers.slice(0, 100),
    source: character.source
  };
}

export function buildPlayableCharacterGenerationPrompt(
  content: WorldContent,
  userPrompt: string,
  currentCharacter?: PlayableCharacter,
  systemPromptOverride?: string
): { systemPrompt: string; input: string } {
  const systemPrompt = effectiveAuthoringPrompt("character", systemPromptOverride || "You author playable characters for Infinite Quest Nexus. Create substantial, useful story guidance and concrete visual details. Keep unknown details empty instead of using placeholders.").content;

  return {
    systemPrompt,
    input: JSON.stringify({
      task: currentCharacter
        ? "Create a complete revised candidate for the selected playable character."
        : "Create one new, distinct playable character for this world.",
      userPrompt,
      world: {
        title: content.world.title,
        genre: clippedText(content.world.genre, 2_000),
        tone: clippedText(content.world.tone, 2_000),
        premise: clippedText(content.world.premise, 8_000),
        backgroundStory: clippedText(content.world.backgroundStory, 12_000),
        rules: clippedText(content.world.rules, 8_000),
        firstAction: clippedText(content.world.firstAction, 4_000)
      },
      worldMechanics: {
        rpgStats: content.rpgStats.slice(0, 100),
        defaultTriggers: content.defaultTriggers.slice(0, 100),
        eventTriggers: content.eventTriggers.slice(0, 100)
      },
      roster: content.playableCharacters.map((character) => ({ id: character.id, name: character.name })),
      ...(currentCharacter ? { currentCharacter: promptCharacter(currentCharacter) } : {})
    })
  };
}

export function normalizeGeneratedPlayableCharacter(
  value: unknown,
  characterId: string,
  currentCharacter?: PlayableCharacter
): PlayableCharacter {
  const generated = generatedCharacterSchema.parse(generatedShape(value));
  const character = playableCharacterSchema.parse({
    ...(currentCharacter || {}),
    ...generated,
    id: characterId,
    name: generated.name,
    characterText: currentCharacter?.characterText || profileGuidance(generated.profile),
    profile: generated.profile,
    rpgStats: normalizeRpgStats(generated.rpgStats, characterId),
    defaultTriggers: normalizeDefaultTriggers(generated.defaultTriggers, characterId),
    source: currentCharacter?.source ?? {
      type: "character-generator",
      promptProtocolVersion: CHARACTER_AUTHORING_PROMPT_PROTOCOL_VERSION
    }
  });
  validateGeneratedCharacter({ ...character, characterText: "" }, "creative");
  return character;
}

export function playableCharacterRecoveryInput(): string {
  return "The preceding character JSON reached its output limit. Return one compact, complete replacement JSON object with name, profile, rpgStats, and defaultTriggers. Start again at {, close every field and the final }, and omit id and source.";
}
