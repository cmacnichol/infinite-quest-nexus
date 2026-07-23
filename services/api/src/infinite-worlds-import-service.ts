import { z } from "zod";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { initialOwnerId } from "../../../packages/database/src/pool.js";
import type { InfiniteWorldsImportRequest, LegacyStory } from "../../../packages/contracts/src/imports.js";
import {
  canonicalizeWorldContent,
  characterProfileSchema,
  playableCharacterSchema,
  portableWorldSchema,
  worldContentSchema,
  WORLD_CONTENT_SCHEMA_VERSION,
  type WorldContent
} from "../../../packages/contracts/src/world-library.js";
import {
  convertInfiniteWorldsWorld,
  infiniteWorldsCharacters,
  infiniteWorldsStoryToLegacyStory,
  isInfiniteWorldsWorld,
  parseInfiniteWorldsStory
} from "../../../packages/domain/src/infinite-worlds.js";
import { callTextProvider, containsMechanicsLanguage, extractJsonObject } from "../../../packages/story-engine/src/index.js";
import { importLegacyStory, previewLegacyStoryImport } from "./import-service.js";
import { loadTextProvider } from "./provider-service.js";
import { importWorld, previewWorldImport } from "./world-service.js";
import type { FilesystemAssetStore } from "./asset-service.js";
import { resolvePlayableCharacters } from "../../../packages/domain/src/world-characters.js";
import { extractCyoaLayers, parseCyoaExport } from "../../../packages/domain/src/world-template.js";
import { generateTemplateWorld } from "./world-generator-service.js";
import { renderPromptTemplate } from "../../../packages/contracts/src/prompt-library.js";
import {
  promptFromSnapshot,
  resolvePromptSnapshot,
  type PromptSnapshot
} from "./prompt-library-service.js";


export type ImportProgressReport = {
  status: "processing" | "completed" | "failed";
  phase: string;
  progressPercent: number;
  message: string;
  worldId?: string;
  worldVersionId?: string;
  duplicate?: boolean;
  errorMessage?: string;
};

export const activeProgressMap = new Map<string, ImportProgressReport>();

export function getImportProgress(key: string): ImportProgressReport | null {
  return activeProgressMap.get(key) || null;
}

type ResolvedKind = "world_json" | "world_text" | "story_text" | "cyoa_json";


const convertedPlayableCharacterSchema = z.object({
  id: z.string().trim().max(200).default(""),
  name: z.string().trim().min(1).max(200),
  character_text: z.string().max(200_000).default(""),
  profile: characterProfileSchema.optional(),
  rpg_statistics: z.array(z.unknown()).max(10_000).default([]),
  default_triggers: z.array(z.unknown()).max(10_000).default([])
}).passthrough();

const convertedWorldSchema = z.object({
  title: z.string().trim().min(1).max(200),
  genre: z.string().max(2000).default(""),
  tone: z.string().max(2000).default(""),
  backgroundStory: z.string().max(200_000).default(""),
  player_character: z.string().max(200_000).default(""),
  playable_characters: z.array(convertedPlayableCharacterSchema).max(1000).default([]),
  premise: z.string().max(200_000).default(""),
  firstAction: z.string().max(200_000).default(""),
  story_rules: z.string().max(200_000).default(""),
  default_triggers: z.array(z.unknown()).max(10_000).default([]),
  event_triggers: z.array(z.unknown()).max(10_000).default([]),
  rpg_statistics: z.array(z.unknown()).max(10_000).default([])
}).passthrough();

const finalMetadataSchema = z.object({
  choices: z.array(z.string().trim().min(1).max(1000)).max(4).default([]),
  custom_action_suggestion: z.string().trim().max(1000).default(""),
  image_prompt: z.string().trim().max(20_000).default("")
});

function parseJsonText(source: string): unknown {
  let value = source.trim().replace(/^\uFEFF/, "");
  const fenced = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) value = fenced[1].trim();
  return JSON.parse(value);
}

function resolveKind(request: InfiniteWorldsImportRequest): ResolvedKind {
  if (request.sourceKind !== "auto") return request.sourceKind as ResolvedKind;
  if (/--\s*Turn\s+\d+\s*--/i.test(request.sourceText)) return "story_text";
  try {
    const parsed = parseJsonText(request.sourceText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as Record<string, unknown>).chapters && (parsed as Record<string, unknown>).info) {
      return "cyoa_json";
    }
    return isInfiniteWorldsWorld(parsed) ? "world_json" : "world_text";
  } catch {
    return "world_text";
  }
}

async function targetWorldContent(pool: DatabasePool, targetWorldVersionId: string): Promise<{ worldId: string; content: WorldContent }> {
  const ownerUserId = await initialOwnerId(pool);
  const result = await pool.query<{ world_id: string; content: unknown }>(
    "SELECT world_id, content FROM world_versions WHERE id = $1 AND owner_user_id = $2",
    [targetWorldVersionId, ownerUserId]
  );
  const row = result.rows[0];
  if (!row) throw Object.assign(new Error("Select a published target world before importing matching story text."), { statusCode: 400 });
  return { worldId: row.world_id, content: worldContentSchema.parse(row.content) };
}

function matchedStoryCharacterId(content: WorldContent, characterText: string, requestedId?: string): string | undefined {
  const characters = resolvePlayableCharacters(content);
  if (requestedId) return requestedId;
  if (characters.length === 1) return characters[0]?.id;
  const firstLine = characterText.split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.toLocaleLowerCase() || "";
  if (!firstLine) return undefined;
  const exact = characters.filter((character) => character.name.trim().toLocaleLowerCase() === firstLine);
  return exact.length === 1 ? exact[0]?.id : undefined;
}

export function infiniteWorldsPromptSet(snapshot: PromptSnapshot, batch: number, total: number) {
  const conversion = promptFromSnapshot(snapshot, "infinite_worlds_conversion");
  return {
    conversion,
    recovery: promptFromSnapshot(snapshot, "infinite_worlds_recovery"),
    batch: renderPromptTemplate(promptFromSnapshot(snapshot, "infinite_worlds_batch"), { base: conversion, batch, total }),
    finalTurn: promptFromSnapshot(snapshot, "infinite_worlds_final_turn")
  };
}

function worldConversionPrompt(sourceName: string, sourceText: string, systemPrompt: string): { systemPrompt: string; input: string } {
  return {
    systemPrompt,
    input: JSON.stringify({ task: "Convert this Infinite Worlds world text for Infinite Quest Nexus.", sourceName, sourceText })
  };
}

function sourceChunks(sourceText: string, targetWords = 1500): string[] {
  const words = sourceText.trim().split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  for (let index = 0; index < words.length; index += targetWords) chunks.push(words.slice(index, index + targetWords).join(" "));
  return chunks;
}

function preferText(previous: string, next: string): string {
  const before = previous.trim();
  const after = next.trim();
  if (!after) return before;
  if (!before || after.includes(before) || after.length >= before.length * 0.9) return after;
  if (before.includes(after)) return before;
  return `${before}\n\n${after}`;
}

function mergeNamed(previous: unknown[], next: unknown[]): unknown[] {
  const values = new Map<string, unknown>();
  for (const item of [...previous, ...next]) {
    const row = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const key = String(row.name ?? row.label ?? JSON.stringify(item)).trim().toLowerCase();
    if (key) values.set(key, item);
  }
  return [...values.values()];
}

function mergeConvertedCharacters(
  previous: z.infer<typeof convertedPlayableCharacterSchema>[],
  next: z.infer<typeof convertedPlayableCharacterSchema>[]
): z.infer<typeof convertedPlayableCharacterSchema>[] {
  const characters = new Map<string, z.infer<typeof convertedPlayableCharacterSchema>>();
  for (const character of [...previous, ...next]) {
    const key = String(character.id || character.name).trim().toLocaleLowerCase();
    const existing = characters.get(key);
    characters.set(key, convertedPlayableCharacterSchema.parse(existing ? {
      ...existing,
      ...character,
      character_text: preferText(existing.character_text, character.character_text),
      profile: character.profile ?? existing.profile,
      rpg_statistics: mergeNamed(existing.rpg_statistics, character.rpg_statistics),
      default_triggers: mergeNamed(existing.default_triggers, character.default_triggers)
    } : character));
  }
  return [...characters.values()];
}

function mergeConvertedWorld(previous: z.infer<typeof convertedWorldSchema> | null, next: z.infer<typeof convertedWorldSchema>) {
  if (!previous) return next;
  return convertedWorldSchema.parse({
    ...previous,
    title: next.title || previous.title,
    genre: preferText(previous.genre, next.genre),
    tone: preferText(previous.tone, next.tone),
    backgroundStory: preferText(previous.backgroundStory, next.backgroundStory),
    player_character: preferText(previous.player_character, next.player_character),
    playable_characters: mergeConvertedCharacters(previous.playable_characters, next.playable_characters),
    premise: preferText(previous.premise, next.premise),
    firstAction: preferText(previous.firstAction, next.firstAction),
    story_rules: preferText(previous.story_rules, next.story_rules),
    default_triggers: mergeNamed(previous.default_triggers, next.default_triggers),
    event_triggers: mergeNamed(previous.event_triggers, next.event_triggers),
    rpg_statistics: mergeNamed(previous.rpg_statistics, next.rpg_statistics)
  });
}

function convertedCharacterId(name: string, index: number, supplied = ""): string {
  if (supplied.trim()) return supplied.trim();
  const slug = name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  return `iw-text-character-${index + 1}${slug ? `-${slug}` : ""}`;
}

function convertedRpgStats(items: unknown[], characterId: string) {
  return items.flatMap((item, index) => {
    const row = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const name = String(row.name || row.skill || row.stat || "").trim();
    if (!name) return [];
    const numeric = Math.round(Number(row.value ?? row.score ?? row.rating ?? 50));
    return [{
      ...row,
      id: String(row.id || `${characterId}-stat-${index + 1}`).slice(0, 200),
      name: name.slice(0, 200),
      value: Number.isFinite(numeric) ? Math.min(99, Math.max(1, numeric)) : 50,
      note: String(row.note || row.covers || "").slice(0, 2000)
    }];
  });
}

function convertedDefaultTriggers(items: unknown[], characterId: string) {
  return items.flatMap((item, index) => {
    const row = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const name = String(row.name || row.label || row.title || "").trim();
    if (!name) return [];
    return [{
      ...row,
      id: String(row.id || `${characterId}-tracker-${index + 1}`).slice(0, 200),
      name: name.slice(0, 300),
      rules: String(row.rules || row.updateRules || row.description || `Track ${name} whenever it changes.`).slice(0, 4000),
      value: String(row.value ?? row.initialValue ?? "Not yet established.").slice(0, 6000)
    }];
  });
}

function convertedPlayableCharacters(converted: z.infer<typeof convertedWorldSchema>) {
  const candidates = converted.playable_characters.length
    ? converted.playable_characters
    : converted.player_character.trim()
      ? [{ id: "", name: converted.player_character.split(/\r?\n/).find((line) => line.trim())?.trim() || "Default character", character_text: converted.player_character, rpg_statistics: converted.rpg_statistics, default_triggers: [] }]
      : [];
  return candidates.map((character, index) => {
    const id = convertedCharacterId(character.name, index, character.id);
    return playableCharacterSchema.parse({
      id,
      name: character.name,
      characterText: character.character_text,
      ...(character.profile ? { profile: character.profile } : {}),
      rpgStats: convertedRpgStats(character.rpg_statistics, id),
      defaultTriggers: convertedDefaultTriggers(character.default_triggers, id),
      source: { type: "infinite-worlds-text", index }
    });
  });
}

async function requestConvertedWorld(
  profile: Awaited<ReturnType<typeof loadTextProvider>>,
  prompt: { systemPrompt: string; input: string },
  recoveryInput: string
) {
  let result = await callTextProvider(profile, prompt);
  try {
    return convertedWorldSchema.parse(extractJsonObject(result.content));
  } catch (error) {
    if (!result.outputLimited) throw error;
    result = await callTextProvider(profile, {
      ...prompt,
      ...(result.responseId ? { previousResponseId: result.responseId } : {}),
      recoveryInput
    });
    return convertedWorldSchema.parse(extractJsonObject(result.content));
  }
}

async function convertWorldText(pool: DatabasePool, request: InfiniteWorldsImportRequest, credentialSecret: string) {
  if (!request.providerProfileId) throw Object.assign(new Error("Select a text provider to convert an Infinite Worlds world TXT export."), { statusCode: 400 });
  const ownerUserId = await initialOwnerId(pool);
  const profile = await loadTextProvider(pool, ownerUserId, request.providerProfileId, credentialSecret, request.model);
  const snapshot = await resolvePromptSnapshot(pool, ownerUserId);
  const chunks = sourceChunks(request.sourceText);
  if (!chunks.length) throw Object.assign(new Error("The selected world TXT export was empty."), { statusCode: 400 });
  let converted: z.infer<typeof convertedWorldSchema> | null = null;
  for (const [index, chunk] of chunks.entries()) {
    const prompts = infiniteWorldsPromptSet(snapshot, index + 1, chunks.length);
    const basePrompt = worldConversionPrompt(request.sourceName, chunk, prompts.conversion);
    const partial = await requestConvertedWorld(profile, {
      systemPrompt: prompts.batch,
      input: JSON.stringify({
        task: "Accumulate this batch into an Infinite Quest world import.",
        sourceName: request.sourceName,
        batch: index + 1,
        totalBatches: chunks.length,
        existingPartialDraft: converted,
        sourceText: chunk
      })
    }, prompts.recovery);
    converted = mergeConvertedWorld(converted, partial);
  }
  if (!converted) throw new Error("The text provider did not produce a world import.");
  const playableCharacters = convertedPlayableCharacters(converted);
  if (!playableCharacters.length) {
    throw Object.assign(new Error("The converted Infinite Worlds world has no playable characters. Add a character to the source and import it again."), { statusCode: 400 });
  }
  const content = canonicalizeWorldContent({
    schemaVersion: WORLD_CONTENT_SCHEMA_VERSION,
    world: {
      title: converted.title,
      genre: converted.genre,
      tone: converted.tone,
      backgroundStory: converted.backgroundStory,
      premise: converted.premise,
      firstAction: converted.firstAction,
      rules: converted.story_rules
    },
    playableCharacters,
    entities: [], relationships: [], rpgStats: playableCharacters.length ? [] : convertedRpgStats(converted.rpg_statistics, "iw-text-world"),
    defaultTriggers: convertedDefaultTriggers(converted.default_triggers, "iw-text-world"), eventTriggers: converted.event_triggers,
    assets: [], defaults: {
      importedFrom: "infinite-worlds-text",
      defaultPlayableCharacterId: playableCharacters[0]?.id || ""
    }
  });
  return portableWorldSchema.parse({ format: "infinite-quest-world", formatVersion: 1, title: converted.title, content });
}

async function enrichFinalTurn(pool: DatabasePool, request: InfiniteWorldsImportRequest, story: LegacyStory, credentialSecret: string): Promise<void> {
  const finalTurn = story.turns.at(-1);
  if (!request.enrichFinalTurn || !finalTurn || (Array.isArray(finalTurn.choices) && finalTurn.choices.length)) return;
  if (!request.providerProfileId) throw Object.assign(new Error("Select a text provider to generate missing final-turn choices."), { statusCode: 400 });
  const ownerUserId = await initialOwnerId(pool);
  const profile = await loadTextProvider(pool, ownerUserId, request.providerProfileId, credentialSecret, request.model);
  const snapshot = await resolvePromptSnapshot(pool, ownerUserId);
  const result = await callTextProvider(profile, {
    systemPrompt: infiniteWorldsPromptSet(snapshot, 1, 1).finalTurn,
    input: JSON.stringify({ world: story.world, recentTurns: story.turns.slice(-6).map((turn) => ({ action: turn.action, narration: turn.narration ?? turn.story ?? turn.text })) })
  });
  if (result.outputLimited) throw new Error("Final-turn enrichment reached the provider output limit. Import again without enrichment or increase that provider's output allowance.");
  const metadata = finalMetadataSchema.parse(extractJsonObject(result.content));
  finalTurn.choices = metadata.choices.filter((choice) => !containsMechanicsLanguage(choice));
  if (!containsMechanicsLanguage(metadata.custom_action_suggestion)) finalTurn.customActionSuggestion = metadata.custom_action_suggestion;
  if (!containsMechanicsLanguage(metadata.image_prompt)) finalTurn.imagePrompt = metadata.image_prompt;
}

export async function previewInfiniteWorldsImport(pool: DatabasePool, request: InfiniteWorldsImportRequest) {
  const kind = resolveKind(request);
  if (kind === "cyoa_json") {
    let parsed;
    try {
      parsed = parseCyoaExport(request.sourceText);
    } catch (error) {
      return {
        kind: "cyoa_json" as const,
        valid: false,
        requiresProvider: true,
        warnings: [`Invalid Choose Your Own Adventure JSON structure: ${error instanceof Error ? error.message : String(error)}`],
        counts: { topLevelTitle: "Unknown", layer1ChaptersCount: 0, characterTarget: "3-4 playable characters" }
      };
    }
    const extracted = extractCyoaLayers(parsed, request.sourceName);
    const validProvider = Boolean(request.providerProfileId);
    return {
      kind: "cyoa_json" as const,
      valid: validProvider,
      requiresProvider: true,
      warnings: validProvider ? [] : ["Select a text provider before importing this Choose Your Own Adventure story export."],
      counts: {
        topLevelTitle: extracted.title,
        layer1ChaptersCount: Math.max(0, extracted.excerpts.length - 1),
        characterTarget: "3-4 playable characters"
      }
    };
  }
  if (kind === "world_json") {
    const source = parseJsonText(request.sourceText);
    const characters = infiniteWorldsCharacters(source).map((character, index) => ({ index, name: String(character.name || `Character ${index + 1}`) }));
    if (!characters.length) {
      return {
        kind,
        valid: false,
        duplicate: false,
        existingWorldId: null,
        characters,
        counts: { entities: 0, relationships: 0, triggers: 0 },
        warnings: ["The Infinite Worlds world export has no playable characters. Add at least one possible character before importing it."]
      };
    }
    const worldExport = convertInfiniteWorldsWorld(source);
    const preview = await previewWorldImport(pool, { sourceName: request.sourceName, worldExport });
    return { ...preview, kind, valid: true, characters };
  }
  if (kind === "world_text") {
    return {
      kind,
      valid: Boolean(request.providerProfileId),
      requiresProvider: true,
      warnings: request.providerProfileId ? ["World text conversion uses the selected text provider during import."] : ["Select a text provider before importing this world TXT export."],
      counts: { sourceCharacters: request.sourceText.length, sourceWords: request.sourceText.trim().split(/\s+/).filter(Boolean).length }
    };
  }
  if (!request.targetWorldVersionId) {
    return { kind, valid: false, warnings: ["Select a published world in World Library before importing its matching story TXT."], counts: { turns: 0 } };
  }
  const target = await targetWorldContent(pool, request.targetWorldVersionId);
  const parsed = parseInfiniteWorldsStory(request.sourceText);
  const characters = resolvePlayableCharacters(target.content);
  const selectedCharacterId = matchedStoryCharacterId(target.content, parsed.characterText, request.selectedCharacterId);
  if (!selectedCharacterId && characters.length > 1) {
    return {
      kind,
      targetWorldId: target.worldId,
      diagnostics: parsed.diagnostics,
      characters: characters.map((character) => ({ id: character.id, name: character.name })),
      selectedCharacterId: null,
      valid: false,
      warnings: ["Choose the playable character used by this story before importing it."],
      counts: { turns: parsed.turns.length }
    };
  }
  const story = infiniteWorldsStoryToLegacyStory(parsed, target.content, request.sourceName, selectedCharacterId);
  const preview = await previewLegacyStoryImport(pool, { sourceName: request.sourceName, story, targetWorldVersionId: request.targetWorldVersionId, selectedCharacterId });
  const missingEnrichmentProvider = request.enrichFinalTurn && !request.providerProfileId;
  return {
    ...preview,
    kind,
    targetWorldId: target.worldId,
    diagnostics: parsed.diagnostics,
    characters: characters.map((character) => ({ id: character.id, name: character.name })),
    selectedCharacterId,
    valid: preview.valid && !missingEnrichmentProvider,
    warnings: [...preview.warnings, ...(missingEnrichmentProvider ? ["Select a text provider or disable final-turn enrichment."] : [])]
  };
}

export async function importInfiniteWorlds(
  pool: DatabasePool,
  request: InfiniteWorldsImportRequest,
  credentialSecret: string,
  assetStore?: FilesystemAssetStore
) {
  const kind = resolveKind(request);
  const progressKey = request.sourceName + ":" + request.sourceText.length;
  if (kind === "cyoa_json") {
    try {
      activeProgressMap.set(progressKey, {
        status: "processing",
        phase: "extracting",
        progressPercent: 5,
        message: "Parsing CYOA story description and branch choices…"
      });
      const parsed = parseCyoaExport(request.sourceText);
      const extracted = extractCyoaLayers(parsed, request.sourceName);
      const generated = await generateTemplateWorld(
        pool,
        await initialOwnerId(pool),
        request.providerProfileId || "",
        credentialSecret,
        extracted,
        request.model,
        async (phase, progressPercent, message) => {
          activeProgressMap.set(progressKey, {
            status: "processing",
            phase,
            progressPercent,
            message
          });
        }
      );
      const worldExport = portableWorldSchema.parse({
        format: "infinite-quest-world",
        formatVersion: 1,
        title: generated.title,
        content: generated.content
      });
      activeProgressMap.set(progressKey, {
        status: "processing",
        phase: "saving_draft",
        progressPercent: 95,
        message: "Saving generated world and character roster to authoritative storage…"
      });
      const result = await importWorld(pool, { sourceName: request.sourceName, worldExport });
      activeProgressMap.set(progressKey, {
        status: "completed",
        phase: "completed",
        progressPercent: 100,
        message: "World and 3-4 playable characters generated from CYOA story.",
        worldId: result.worldId,
        worldVersionId: result.worldVersionId,
        duplicate: result.duplicate
      });
      return { kind: "world" as const, ...result };
    } catch (error) {
      activeProgressMap.set(progressKey, {
        status: "failed",
        phase: "failed",
        progressPercent: 100,
        message: error instanceof Error ? error.message : String(error),
        errorMessage: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }
  if (kind === "world_json" || kind === "world_text") {
    const worldExport = kind === "world_json"
      ? convertInfiniteWorldsWorld(parseJsonText(request.sourceText))
      : await convertWorldText(pool, request, credentialSecret);
    const result = await importWorld(pool, { sourceName: request.sourceName, worldExport });
    return { kind: "world" as const, ...result };
  }
  if (!request.targetWorldVersionId) throw Object.assign(new Error("Select a published target world before importing matching story text."), { statusCode: 400 });
  const target = await targetWorldContent(pool, request.targetWorldVersionId);
  const parsed = parseInfiniteWorldsStory(request.sourceText);
  const selectedCharacterId = matchedStoryCharacterId(target.content, parsed.characterText, request.selectedCharacterId);
  const story = infiniteWorldsStoryToLegacyStory(parsed, target.content, request.sourceName, selectedCharacterId);
  await enrichFinalTurn(pool, request, story, credentialSecret);
  const result = await importLegacyStory(pool, { sourceName: request.sourceName, story, targetWorldVersionId: request.targetWorldVersionId, selectedCharacterId }, assetStore);
  return { kind: "campaign" as const, ...result };
}
