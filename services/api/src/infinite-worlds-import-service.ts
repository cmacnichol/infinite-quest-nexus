import { z } from "zod";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { initialOwnerId } from "../../../packages/database/src/pool.js";
import type { InfiniteWorldsImportRequest, LegacyStory } from "../../../packages/contracts/src/imports.js";
import { portableWorldSchema, worldContentSchema, type WorldContent } from "../../../packages/contracts/src/world-library.js";
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

type ResolvedKind = "world_json" | "world_text" | "story_text";

const convertedWorldSchema = z.object({
  title: z.string().trim().min(1).max(200),
  genre: z.string().max(2000).default(""),
  tone: z.string().max(2000).default(""),
  backgroundStory: z.string().max(200_000).default(""),
  player_character: z.string().max(200_000).default(""),
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
  if (request.sourceKind !== "auto") return request.sourceKind;
  if (/--\s*Turn\s+\d+\s*--/i.test(request.sourceText)) return "story_text";
  try {
    return isInfiniteWorldsWorld(parseJsonText(request.sourceText)) ? "world_json" : "world_text";
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

function worldConversionPrompt(sourceName: string, sourceText: string): { systemPrompt: string; input: string } {
  return {
    systemPrompt: `Convert an Infinite Worlds world-editor text export into one compact JSON object. Return JSON only. Preserve source facts and do not invent lore.
Required fields: title, genre, tone, backgroundStory, player_character, premise, firstAction, story_rules, default_triggers, event_triggers, rpg_statistics.
Use only the first listed playable character. Convert skills exactly: 1=20, 2=40, 3=60, 4=80, 5=99. Preserve tracked items as default_triggers. Do not include credentials, model instructions, private reasoning, rolls, checks, dice results, or parser diagnostics in fictional fields.`,
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

function mergeConvertedWorld(previous: z.infer<typeof convertedWorldSchema> | null, next: z.infer<typeof convertedWorldSchema>) {
  if (!previous) return next;
  return convertedWorldSchema.parse({
    ...previous,
    title: next.title || previous.title,
    genre: preferText(previous.genre, next.genre),
    tone: preferText(previous.tone, next.tone),
    backgroundStory: preferText(previous.backgroundStory, next.backgroundStory),
    player_character: preferText(previous.player_character, next.player_character),
    premise: preferText(previous.premise, next.premise),
    firstAction: preferText(previous.firstAction, next.firstAction),
    story_rules: preferText(previous.story_rules, next.story_rules),
    default_triggers: mergeNamed(previous.default_triggers, next.default_triggers),
    event_triggers: mergeNamed(previous.event_triggers, next.event_triggers),
    rpg_statistics: mergeNamed(previous.rpg_statistics, next.rpg_statistics)
  });
}

async function requestConvertedWorld(
  profile: Awaited<ReturnType<typeof loadTextProvider>>,
  prompt: { systemPrompt: string; input: string }
) {
  let result = await callTextProvider(profile, prompt);
  try {
    return convertedWorldSchema.parse(extractJsonObject(result.content));
  } catch (error) {
    if (!result.outputLimited) throw error;
    result = await callTextProvider(profile, {
      ...prompt,
      ...(result.responseId ? { previousResponseId: result.responseId } : {}),
      recoveryInput: "The previous JSON was truncated. Return a complete, more compact replacement object. Start again at { and close every field and the final }."
    });
    return convertedWorldSchema.parse(extractJsonObject(result.content));
  }
}

async function convertWorldText(pool: DatabasePool, request: InfiniteWorldsImportRequest, credentialSecret: string) {
  if (!request.providerProfileId) throw Object.assign(new Error("Select a text provider to convert an Infinite Worlds world TXT export."), { statusCode: 400 });
  const ownerUserId = await initialOwnerId(pool);
  const profile = await loadTextProvider(pool, ownerUserId, request.providerProfileId, credentialSecret, request.model);
  const chunks = sourceChunks(request.sourceText);
  if (!chunks.length) throw Object.assign(new Error("The selected world TXT export was empty."), { statusCode: 400 });
  let converted: z.infer<typeof convertedWorldSchema> | null = null;
  for (const [index, chunk] of chunks.entries()) {
    const basePrompt = worldConversionPrompt(request.sourceName, chunk);
    const partial = await requestConvertedWorld(profile, {
      systemPrompt: `${basePrompt.systemPrompt}\nThis is batch ${index + 1} of ${chunks.length}. Return the full accumulated world object, preserving the supplied partial draft unless this batch corrects it.`,
      input: JSON.stringify({
        task: "Accumulate this batch into an Infinite Quest world import.",
        sourceName: request.sourceName,
        batch: index + 1,
        totalBatches: chunks.length,
        existingPartialDraft: converted,
        sourceText: chunk
      })
    });
    converted = mergeConvertedWorld(converted, partial);
  }
  if (!converted) throw new Error("The text provider did not produce a world import.");
  const content = worldContentSchema.parse({
    schemaVersion: 2,
    world: {
      title: converted.title,
      genre: converted.genre,
      tone: converted.tone,
      backgroundStory: converted.backgroundStory,
      character: converted.player_character,
      premise: converted.premise,
      firstAction: converted.firstAction,
      rules: converted.story_rules
    },
    entities: [], relationships: [], rpgStats: converted.rpg_statistics,
    defaultTriggers: converted.default_triggers, eventTriggers: converted.event_triggers,
    assets: [], defaults: { importedFrom: "infinite-worlds-text" }
  });
  return portableWorldSchema.parse({ format: "infinite-quest-world", formatVersion: 1, title: converted.title, content });
}

async function enrichFinalTurn(pool: DatabasePool, request: InfiniteWorldsImportRequest, story: LegacyStory, credentialSecret: string): Promise<void> {
  const finalTurn = story.turns.at(-1);
  if (!request.enrichFinalTurn || !finalTurn || (Array.isArray(finalTurn.choices) && finalTurn.choices.length)) return;
  if (!request.providerProfileId) throw Object.assign(new Error("Select a text provider to generate missing final-turn choices."), { statusCode: 400 });
  const ownerUserId = await initialOwnerId(pool);
  const profile = await loadTextProvider(pool, ownerUserId, request.providerProfileId, credentialSecret, request.model);
  const result = await callTextProvider(profile, {
    systemPrompt: "Return JSON only with choices (exactly four diegetic next actions), custom_action_suggestion, and image_prompt. Continue from the accepted fictional outcome. Never mention rolls, dice, checks, stats, modifiers, targets, difficulties, parser errors, or private reasoning.",
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
  if (kind === "world_json") {
    const source = parseJsonText(request.sourceText);
    const characters = infiniteWorldsCharacters(source).map((character, index) => ({ index, name: String(character.name || `Character ${index + 1}`) }));
    const worldExport = convertInfiniteWorldsWorld(source, request.selectedCharacterIndex);
    const preview = await previewWorldImport(pool, { sourceName: request.sourceName, worldExport });
    return { ...preview, kind, valid: true, characters, selectedCharacterIndex: request.selectedCharacterIndex };
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
  const story = infiniteWorldsStoryToLegacyStory(parsed, target.content, request.sourceName);
  const preview = await previewLegacyStoryImport(pool, { sourceName: request.sourceName, story, targetWorldVersionId: request.targetWorldVersionId });
  const missingEnrichmentProvider = request.enrichFinalTurn && !request.providerProfileId;
  return {
    ...preview,
    kind,
    targetWorldId: target.worldId,
    diagnostics: parsed.diagnostics,
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
  if (kind === "world_json" || kind === "world_text") {
    const worldExport = kind === "world_json"
      ? convertInfiniteWorldsWorld(parseJsonText(request.sourceText), request.selectedCharacterIndex)
      : await convertWorldText(pool, request, credentialSecret);
    const result = await importWorld(pool, { sourceName: request.sourceName, worldExport });
    return { kind: "world" as const, ...result };
  }
  if (!request.targetWorldVersionId) throw Object.assign(new Error("Select a published target world before importing matching story text."), { statusCode: 400 });
  const target = await targetWorldContent(pool, request.targetWorldVersionId);
  const story = infiniteWorldsStoryToLegacyStory(parseInfiniteWorldsStory(request.sourceText), target.content, request.sourceName);
  await enrichFinalTurn(pool, request, story, credentialSecret);
  const result = await importLegacyStory(pool, { sourceName: request.sourceName, story, targetWorldVersionId: request.targetWorldVersionId }, assetStore);
  return { kind: "campaign" as const, ...result };
}
