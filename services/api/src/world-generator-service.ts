import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { initialOwnerId } from "../../../packages/database/src/pool.js";
import {
  canonicalizeWorldContent,
  characterProfileSchema,
  playableCharacterSchema,
  WORLD_CONTENT_SCHEMA_VERSION,
  worldContentSchema,
  type PlayableCharacterGenerationRequest,
  type WorldContent
} from "../../../packages/contracts/src/world-library.js";
import {
  buildPlayableCharacterGenerationPrompt,
  normalizeGeneratedPlayableCharacter,
  playableCharacterRecoveryInput
} from "../../../packages/domain/src/character-authoring.js";
import { buildTemplateWorldPrompt, type TemplateWorldInput } from "../../../packages/domain/src/world-template.js";
import { callTextProvider, extractJsonObject } from "../../../packages/story-engine/src/index.js";
import { loadTextProvider, resolveEffectiveProviderId } from "./provider-service.js";

const coerceText = (val: unknown): string => {
  if (val === null || val === undefined) return "";
  if (typeof val === "string") return val;
  if (Array.isArray(val)) {
    return val
      .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
      .filter(Boolean)
      .join("\n\n");
  }
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
};

const flexibleShortText = z.preprocess(coerceText, z.string().max(2000).default(""));
const flexibleLongText = z.preprocess(coerceText, z.string().max(200_000).default(""));

const convertedPlayableCharacterSchema = z.object({
  id: z.string().trim().max(200).default(""),
  name: z.preprocess((v) => (typeof v === "string" ? v : coerceText(v)), z.string().trim().min(1).max(200)),
  character_text: flexibleLongText,
  profile: characterProfileSchema.optional(),
  rpg_statistics: z.array(z.unknown()).max(10_000).default([]),
  default_triggers: z.array(z.unknown()).max(10_000).default([])
}).passthrough();

const convertedWorldSchema = z.object({
  title: z.preprocess((v) => (typeof v === "string" ? v : coerceText(v)), z.string().trim().min(1).max(200)),
  genre: flexibleShortText,
  tone: flexibleShortText,
  backgroundStory: flexibleLongText,
  player_character: flexibleLongText,
  playable_characters: z.array(convertedPlayableCharacterSchema).max(1000).default([]),
  premise: flexibleLongText,
  firstAction: flexibleLongText,
  story_rules: flexibleLongText,
  default_triggers: z.array(z.unknown()).max(10_000).default([]),
  event_triggers: z.array(z.unknown()).max(10_000).default([]),
  rpg_statistics: z.array(z.unknown()).max(10_000).default([])
}).passthrough();


const supplementCharactersSchema = z.object({
  playable_characters: z.array(convertedPlayableCharacterSchema).max(10).default([])
});

function convertedCharacterId(name: string, index: number, supplied = ""): string {
  if (supplied.trim()) return supplied.trim();
  const slug = name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  return `char-${index + 1}${slug ? `-${slug}` : ""}`;
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

export async function generateTemplateWorld(
  pool: DatabasePool,
  ownerUserId: string,
  providerProfileId: string,
  credentialSecret: string,
  input: TemplateWorldInput,
  model?: string,
  onProgress?: (phase: string, percent: number, message: string) => Promise<void> | void
): Promise<{ title: string; content: WorldContent }> {
  if (!providerProfileId) {
    throw Object.assign(new Error("Select a text provider to convert or generate the Story World."), { statusCode: 400 });
  }

  await onProgress?.("extracting", 10, "Loading text provider and preparing modular prompt…");
  const profile = await loadTextProvider(pool, ownerUserId, providerProfileId, credentialSecret, model);

  await onProgress?.("generating_world", 30, "Synthesizing world overview and characters via LLM…");
  const prompt = buildTemplateWorldPrompt(input);
  let result = await callTextProvider(profile, prompt);

  let converted: z.infer<typeof convertedWorldSchema>;
  try {
    converted = convertedWorldSchema.parse(extractJsonObject(result.content));
  } catch (error) {
    if (!result.outputLimited) throw error;
    await onProgress?.("recovering_world", 50, "Output limit reached. Recovering truncated JSON…");
    const recovered = await callTextProvider(profile, {
      ...prompt,
      ...(result.responseId ? { previousResponseId: result.responseId } : {}),
      recoveryInput: "The previous JSON was truncated. Return a complete, compact replacement object with title, genre, tone, backgroundStory, premise, firstAction, story_rules, default_triggers, event_triggers, rpg_statistics, and exactly 3-4 distinct entries in playable_characters. Start again at { and close every field and the final }."
    });
    converted = convertedWorldSchema.parse(extractJsonObject(recovered.content));
  }

  let rawCharacters = [...(converted.playable_characters || [])];
  if (rawCharacters.length === 0 && converted.player_character.trim()) {
    rawCharacters.push({
      id: "char-1",
      name: converted.player_character.split(/\r?\n/).find((line) => line.trim())?.trim() || "Lead Character",
      character_text: converted.player_character,
      rpg_statistics: converted.rpg_statistics || [],
      default_triggers: converted.default_triggers || []
    });
  }

  if (rawCharacters.length < 3) {
    const needed = 3 - rawCharacters.length;
    await onProgress?.("supplementing_characters", 70, `Generating ${needed} additional playable character${needed === 1 ? "" : "s"} to meet the 3-4 character target…`);
    const supplementResult = await callTextProvider(profile, {
      systemPrompt: `You are expanding a Story World character roster. Return JSON only with a single object containing a playable_characters array with exactly ${needed} new, distinct, fitting playable characters. Each entry requires id, name, character_text, profile, rpg_statistics (array of { name, value (1-99), note }), and default_triggers (array of { name, value, rules }). profile must use the same identity, story, appearance, and unclassifiedNotes structure supplied for existing characters. Do not repeat existing characters.`,
      input: JSON.stringify({
        worldTitle: converted.title,
        genre: converted.genre,
        premise: converted.premise,
        existingCharacters: rawCharacters.map((c) => ({ name: c.name, background: c.character_text }))
      })
    });
    try {
      const supplement = supplementCharactersSchema.parse(extractJsonObject(supplementResult.content));
      rawCharacters.push(...supplement.playable_characters);
    } catch {
      // If supplement fails or is truncated, continue with available characters or fallback
    }
  }

  rawCharacters = rawCharacters.slice(0, 4);
  while (rawCharacters.length < 3) {
    const idx = rawCharacters.length + 1;
    rawCharacters.push({
      id: `char-${idx}`,
      name: `Character Option ${idx}`,
      character_text: `An adventurous protagonist in ${converted.title || "this world"}.`,
      rpg_statistics: [{ name: "Resourcefulness", value: 70, note: "Key survival attribute." }],
      default_triggers: []
    });
  }

  await onProgress?.("formatting", 85, "Formatting character roster and world attributes…");
  const playableCharacters = rawCharacters.map((character, index) => {
    const id = convertedCharacterId(character.name, index, character.id);
    return playableCharacterSchema.parse({
      id,
      name: character.name,
      characterText: character.character_text,
      ...(character.profile ? { profile: character.profile } : {}),
      rpgStats: convertedRpgStats(character.rpg_statistics, id),
      defaultTriggers: convertedDefaultTriggers(character.default_triggers, id),
      source: { type: "template-world-generator", index }
    });
  });

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
    entities: [],
    relationships: [],
    rpgStats: convertedRpgStats(converted.rpg_statistics, "world-wide"),
    defaultTriggers: convertedDefaultTriggers(converted.default_triggers, "world-wide"),
    eventTriggers: converted.event_triggers || [],
    assets: [],
    defaults: {
      importedFrom: input.sourceKind,
      defaultPlayableCharacterId: playableCharacters[0]?.id || ""
    }
  });

  await onProgress?.("completed", 100, "World and character generation completed.");
  return {
    title: converted.title || input.title,
    content
  };
}

function characterGenerationError(message: string, statusCode: number, code: string): Error {
  return Object.assign(new Error(message), { statusCode, details: { code } });
}

export async function generatePlayableCharacter(
  pool: DatabasePool,
  worldId: string,
  request: PlayableCharacterGenerationRequest,
  credentialSecret: string
): Promise<{ character: ReturnType<typeof normalizeGeneratedPlayableCharacter> }> {
  const ownerUserId = await initialOwnerId(pool);
  const result = await pool.query<{
    status: string;
    revision: number;
    content: WorldContent;
  }>(
    `SELECT w.status, wd.revision, wd.content
       FROM worlds w
       JOIN world_drafts wd ON wd.world_id = w.id AND wd.owner_user_id = w.owner_user_id
      WHERE w.id = $1 AND w.owner_user_id = $2`,
    [worldId, ownerUserId]
  );
  const draft = result.rows[0];
  if (!draft) throw characterGenerationError("World draft not found.", 404, "world_draft_not_found");
  if (draft.status === "archived") {
    throw characterGenerationError("Restore the world before generating a character.", 409, "world_archived");
  }
  if (draft.revision !== request.expectedRevision) {
    throw characterGenerationError("The world draft changed. Reload it before generating a character.", 409, "world_draft_revision_conflict");
  }

  const content = worldContentSchema.parse(draft.content);
  const currentCharacter = request.characterId
    ? content.playableCharacters.find((character) => character.id === request.characterId)
    : undefined;
  if (request.characterId && !currentCharacter) {
    throw characterGenerationError("The selected playable character does not belong to this world draft.", 404, "playable_character_not_found");
  }

  const providerProfileId = await resolveEffectiveProviderId(pool, ownerUserId, "text");
  if (!providerProfileId) {
    throw characterGenerationError(
      "Add a text provider or mark one as default in Provider Management before generating a character.",
      409,
      "default_text_provider_unavailable"
    );
  }
  const profile = await loadTextProvider(pool, ownerUserId, providerProfileId, credentialSecret);
  const prompt = buildPlayableCharacterGenerationPrompt(content, request.prompt, currentCharacter);
  let generatedId = currentCharacter?.id || randomUUID();
  while (!currentCharacter && content.playableCharacters.some((character) => character.id === generatedId)) {
    generatedId = randomUUID();
  }
  const providerResult = await callTextProvider(profile, prompt);

  try {
    return {
      character: normalizeGeneratedPlayableCharacter(
        extractJsonObject(providerResult.content),
        generatedId,
        currentCharacter
      )
    };
  } catch (error) {
    if (!providerResult.outputLimited) {
      throw characterGenerationError(
        "The text provider returned an invalid character. Revise the prompt and try again.",
        502,
        "invalid_generated_character"
      );
    }

    const recovered = await callTextProvider(profile, {
      ...prompt,
      ...(providerResult.responseId ? { previousResponseId: providerResult.responseId } : {}),
      rejectedResponse: providerResult.content,
      recoveryInput: playableCharacterRecoveryInput()
    });
    try {
      return {
        character: normalizeGeneratedPlayableCharacter(
          extractJsonObject(recovered.content),
          generatedId,
          currentCharacter
        )
      };
    } catch {
      throw characterGenerationError(
        "The text provider could not return a complete character after one recovery attempt.",
        502,
        recovered.outputLimited ? "character_generation_output_limit" : "invalid_generated_character"
      );
    }
  }
}
