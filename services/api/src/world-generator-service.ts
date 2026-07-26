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
  type PlayableCharacterGenerationPreviewRequest,
  type WorldGenerationPreviewRequest,
  type WorldContent
} from "../../../packages/contracts/src/world-library.js";
import {
  CHARACTER_AUTHORING_PROMPT_PROTOCOL_VERSION,
  buildPlayableCharacterGenerationPrompt,
  normalizeGeneratedPlayableCharacter,
  playableCharacterRecoveryInput
} from "../../../packages/domain/src/character-authoring.js";
import { parseCompleteGeneratedWorld } from "../../../packages/domain/src/generated-world.js";
import { buildTemplateWorldPrompt, type TemplateWorldInput } from "../../../packages/domain/src/world-template.js";
import { callTextProvider, extractJsonObject } from "../../../packages/story-engine/src/index.js";
import { logger } from "../../../packages/logger/src/index.js";
import { loadTextProvider, resolveEffectiveProviderId } from "./provider-service.js";
import { promptFromSnapshot, resolvePromptSnapshot } from "./prompt-library-service.js";
import {
  createWorldGenerationProgress,
  updateWorldGenerationProgress,
  type WorldGenerationProgress
} from "./world-generation-progress-service.js";

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

const completeConvertedWorldSchema = convertedWorldSchema.superRefine((world, context) => {
  for (const [key, label] of [
    ["genre", "genre"],
    ["tone", "tone"],
    ["backgroundStory", "backgroundStory"],
    ["premise", "premise"],
    ["firstAction", "firstAction"],
    ["story_rules", "story_rules"]
  ] as const) {
    if (!world[key].trim()) context.addIssue({ code: "custom", path: [key], message: `Generated ${label} is required.` });
  }
});


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

export type WorldGenProgress = WorldGenerationProgress;

export function worldGenerationInputMetadata(input: TemplateWorldInput) {
  return {
    sourceKind: input.sourceKind,
    title: input.title,
    promptLength: input.prompt?.length ?? 0,
    keywordCount: input.keywords.length,
    excerptCount: input.excerpts.length
  };
}

export function normalizeRawWorldJson(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;

  const getStr = (...keys: string[]): string => {
    for (const key of keys) {
      const val = coerceText(obj[key]).trim();
      if (val) return val;
    }
    return "";
  };

  const getArr = (...keys: string[]): unknown[] => {
    for (const key of keys) {
      const val = obj[key];
      if (Array.isArray(val)) return val;
    }
    return [];
  };

  const normalizedChars = getArr("playable_characters", "playableCharacters", "playable_character_list", "characters").map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const char = item as Record<string, unknown>;
    return {
      ...char,
      id: String(char.id || "").trim(),
      name: coerceText(char.name || char.character_name || char.characterName || "").trim(),
      character_text: coerceText(char.character_text || char.characterText || char.background || char.description || char.details).trim(),
      rpg_statistics: Array.isArray(char.rpg_statistics) ? char.rpg_statistics : (Array.isArray(char.rpgStats) ? char.rpgStats : (Array.isArray(char.rpg_stats) ? char.rpg_stats : [])),
      default_triggers: Array.isArray(char.default_triggers) ? char.default_triggers : (Array.isArray(char.defaultTriggers) ? char.defaultTriggers : [])
    };
  });

  return {
    ...obj,
    title: getStr("title", "world_title", "worldTitle", "name"),
    genre: getStr("genre", "world_genre", "worldGenre"),
    tone: getStr("tone", "world_tone", "worldTone"),
    backgroundStory: getStr("backgroundStory", "background_story", "backgroundCanon", "background_canon", "background", "canon"),
    premise: getStr("premise", "world_premise", "worldPremise", "summary"),
    firstAction: getStr("firstAction", "first_action", "openingAction", "opening_action", "startingAction", "starting_action"),
    story_rules: getStr("story_rules", "storyRules", "rules", "world_rules", "worldRules"),
    player_character: getStr("player_character", "playerCharacter", "leadCharacter", "lead_character"),
    playable_characters: normalizedChars,
    rpg_statistics: getArr("rpg_statistics", "rpgStats", "rpg_stats", "statistics"),
    default_triggers: getArr("default_triggers", "defaultTriggers", "default_trigger_list"),
    event_triggers: getArr("event_triggers", "eventTriggers", "event_trigger_list")
  };
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
    logger.error({ ownerUserId, sourceKind: input.sourceKind }, "World generation failed: missing provider profile ID");
    throw Object.assign(new Error("Select a text provider to convert or generate the Story World."), { statusCode: 400 });
  }

  logger.info({ ownerUserId, providerProfileId, sourceKind: input.sourceKind, title: input.title }, "Starting template world generation");
  logger.debug(worldGenerationInputMetadata(input), "Template world generation input metadata");

  await onProgress?.("extracting", 10, "Loading text provider and preparing modular prompt…");
  const profile = await loadTextProvider(pool, ownerUserId, providerProfileId, credentialSecret, model);

  await onProgress?.("generating_world", 30, "Synthesizing world overview and characters via LLM…");
  const promptSnapshot = await resolvePromptSnapshot(pool, ownerUserId);
  const prompt = buildTemplateWorldPrompt(input, promptFromSnapshot(promptSnapshot, "world_generation"));
  let result = await callTextProvider(profile, prompt);
  logger.debug({ responseId: result.responseId, outputLimited: result.outputLimited }, "Received initial world generation LLM response");

  let converted: z.infer<typeof convertedWorldSchema>;
  try {
    converted = completeConvertedWorldSchema.parse(normalizeRawWorldJson(extractJsonObject(result.content)));
    logger.debug({ title: converted.title }, "Successfully parsed initial generated world JSON");
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : String(error), outputLimited: result.outputLimited }, "Initial LLM world generation parse failed, attempting recovery");
    await onProgress?.("recovering_world", 50, result.outputLimited ? "Output limit reached. Recovering truncated JSON…" : "Generated world was incomplete. Requesting a complete replacement…");
    const recovered = await callTextProvider(profile, {
      ...prompt,
      ...(result.responseId ? { previousResponseId: result.responseId } : {}),
      recoveryInput: promptFromSnapshot(promptSnapshot, "world_generation_recovery")
    });
    converted = completeConvertedWorldSchema.parse(normalizeRawWorldJson(extractJsonObject(recovered.content)));
    logger.info({ title: converted.title }, "Successfully recovered generated world JSON");
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
    logger.info({ existingCount: rawCharacters.length, needed }, "Supplementing playable character roster");
    await onProgress?.("supplementing_characters", 70, `Generating ${needed} additional playable character${needed === 1 ? "" : "s"} to meet the 3-4 character target…`);
    const supplementResult = await callTextProvider(profile, {
      systemPrompt: promptFromSnapshot(promptSnapshot, "world_roster_supplement").replaceAll("{{needed}}", String(needed)),
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
      logger.debug({ added: supplement.playable_characters.length }, "Character roster successfully supplemented");
    } catch (suppErr) {
      logger.warn({ error: suppErr instanceof Error ? suppErr.message : String(suppErr) }, "Playable character roster supplement failed, falling back to default options");
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
  logger.info({ title: converted.title, characterCount: playableCharacters.length }, "Completed template world generation successfully");
  return {
    title: converted.title || input.title,
    content
  };
}

export async function generateWorldPreview(
  pool: DatabasePool,
  request: WorldGenerationPreviewRequest,
  credentialSecret: string
): Promise<{ title: string; content: WorldContent }> {
  const ownerUserId = await initialOwnerId(pool);
  const providerProfileId = await resolveEffectiveProviderId(pool, ownerUserId, "text");
  const progressKey = request.progressKey;
  if (progressKey) await createWorldGenerationProgress(pool, ownerUserId, progressKey);
  if (!providerProfileId) {
    logger.warn({ ownerUserId, title: request.title }, "World preview generation failed: no default text provider configured");
    if (progressKey) {
      await updateWorldGenerationProgress(pool, ownerUserId, progressKey, {
        status: "failed",
        phase: "failed",
        progressPercent: 100,
        message: "Add a text provider or mark one as default in Provider Management before generating a world.",
        errorMessage: "Add a text provider or mark one as default in Provider Management before generating a world."
      });
    }
    throw Object.assign(new Error("Add a text provider or mark one as default in Provider Management before generating a world."), {
      statusCode: 409,
      details: { code: "default_text_provider_unavailable" }
    });
  }
  const incompleteWorldError = () => Object.assign(
    new Error("The text provider did not return a complete world. Revise the prompt and try again."),
    { statusCode: 502, details: { code: "incomplete_generated_world" } }
  );

  logger.info({ title: request.title, promptLength: request.prompt?.length, progressKey }, "Generating world preview from prompt");

  if (progressKey) {
    await updateWorldGenerationProgress(pool, ownerUserId, progressKey, {
      status: "processing",
      phase: "extracting",
      progressPercent: 10,
      message: "Loading text provider and preparing modular prompt…"
    });
  }

  let generated: { title: string; content: WorldContent };
  try {
    generated = await generateTemplateWorld(
      pool,
      ownerUserId,
      providerProfileId,
      credentialSecret,
      {
        sourceName: "new-world-prompt",
        sourceKind: "prompt",
        title: request.title || "Untitled World",
        summary: request.prompt,
        keywords: [],
        excerpts: [],
        prompt: request.prompt
      },
      undefined,
      async (phase, progressPercent, message) => {
        if (progressKey) {
          await updateWorldGenerationProgress(pool, ownerUserId, progressKey, {
            status: "processing",
            phase,
            progressPercent,
            message
          });
        }
      }
    );
  } catch (error) {
    logger.error({ error: error instanceof Error ? error.message : String(error), progressKey }, "World preview generation failed");
    if (progressKey) {
      await updateWorldGenerationProgress(pool, ownerUserId, progressKey, {
        status: "failed",
        phase: "failed",
        progressPercent: 100,
        message: error instanceof Error ? error.message : String(error),
        errorMessage: error instanceof Error ? error.message : String(error)
      });
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError) throw incompleteWorldError();
    throw error;
  }
  try {
    const content = parseCompleteGeneratedWorld(generated.content);
    if (progressKey) {
      await updateWorldGenerationProgress(pool, ownerUserId, progressKey, {
        status: "completed",
        phase: "completed",
        progressPercent: 100,
        message: "World and character generation completed."
      });
    }
    logger.info({ title: content.world.title, progressKey }, "World preview generation succeeded");
    return { title: content.world.title, content };
  } catch (error) {
    logger.error({ error: error instanceof Error ? error.message : String(error), progressKey }, "Generated world preview schema validation failed");
    if (progressKey) {
      await updateWorldGenerationProgress(pool, ownerUserId, progressKey, {
        status: "failed",
        phase: "failed",
        progressPercent: 100,
        message: "The text provider did not return a complete world.",
        errorMessage: "The text provider did not return a complete world."
      });
    }
    throw incompleteWorldError();
  }
}

function characterGenerationError(message: string, statusCode: number, code: string): Error {
  return Object.assign(new Error(message), { statusCode, details: { code } });
}

async function generatePlayableCharacterCandidate(
  pool: DatabasePool,
  ownerUserId: string,
  content: WorldContent,
  request: { prompt: string; characterId?: string | undefined },
  credentialSecret: string
): Promise<{ character: ReturnType<typeof normalizeGeneratedPlayableCharacter> }> {
  logger.info({ ownerUserId, characterId: request.characterId, promptLength: request.prompt?.length }, "Generating playable character candidate");

  const currentCharacter = request.characterId
    ? content.playableCharacters.find((character) => character.id === request.characterId)
    : undefined;
  if (request.characterId && !currentCharacter) {
    logger.warn({ ownerUserId, characterId: request.characterId }, "Playable character generation failed: target character not found in world draft");
    throw characterGenerationError("The selected playable character does not belong to this world draft.", 404, "playable_character_not_found");
  }

  const providerProfileId = await resolveEffectiveProviderId(pool, ownerUserId, "text");
  if (!providerProfileId) {
    logger.warn({ ownerUserId }, "Playable character generation failed: no default text provider configured");
    throw characterGenerationError(
      "Add a text provider or mark one as default in Provider Management before generating a character.",
      409,
      "default_text_provider_unavailable"
    );
  }
  const profile = await loadTextProvider(pool, ownerUserId, providerProfileId, credentialSecret);
  const promptSnapshot = await resolvePromptSnapshot(pool, ownerUserId);
  const prompt = buildPlayableCharacterGenerationPrompt(content, request.prompt, currentCharacter, promptFromSnapshot(promptSnapshot, "character_generation").replaceAll("{{protocol}}", CHARACTER_AUTHORING_PROMPT_PROTOCOL_VERSION));
  let generatedId = currentCharacter?.id || randomUUID();
  while (!currentCharacter && content.playableCharacters.some((character) => character.id === generatedId)) {
    generatedId = randomUUID();
  }
  const providerResult = await callTextProvider(profile, prompt);
  logger.debug({ responseId: providerResult.responseId, outputLimited: providerResult.outputLimited }, "Received character generation LLM response");

  try {
    const character = normalizeGeneratedPlayableCharacter(
      extractJsonObject(providerResult.content),
      generatedId,
      currentCharacter
    );
    logger.info({ characterId: generatedId, name: character.name }, "Playable character candidate generated successfully");
    return { character };
  } catch (error) {
    if (!providerResult.outputLimited) {
      logger.error({ error: error instanceof Error ? error.message : String(error) }, "Character generation output was invalid and output limit was not reached");
      throw characterGenerationError(
        "The text provider returned an invalid character. Revise the prompt and try again.",
        502,
        "invalid_generated_character"
      );
    }

    logger.warn({ error: error instanceof Error ? error.message : String(error) }, "Initial character output reached output limit, attempting recovery");
    const recovered = await callTextProvider(profile, {
      ...prompt,
      ...(providerResult.responseId ? { previousResponseId: providerResult.responseId } : {}),
      rejectedResponse: providerResult.content,
      recoveryInput: playableCharacterRecoveryInput()
    });
    try {
      const character = normalizeGeneratedPlayableCharacter(
        extractJsonObject(recovered.content),
        generatedId,
        currentCharacter
      );
      logger.info({ characterId: generatedId, name: character.name }, "Playable character candidate recovered successfully");
      return { character };
    } catch (recoveryErr) {
      logger.error({ error: recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr), outputLimited: recovered.outputLimited }, "Character generation recovery attempt failed");
      throw characterGenerationError(
        "The text provider could not return a complete character after one recovery attempt.",
        502,
        recovered.outputLimited ? "character_generation_output_limit" : "invalid_generated_character"
      );
    }
  }
}

export async function generatePlayableCharacterPreview(
  pool: DatabasePool,
  request: PlayableCharacterGenerationPreviewRequest,
  credentialSecret: string
) {
  const ownerUserId = await initialOwnerId(pool);
  return generatePlayableCharacterCandidate(
    pool,
    ownerUserId,
    worldContentSchema.parse(request.content),
    request,
    credentialSecret
  );
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

  return generatePlayableCharacterCandidate(
    pool,
    ownerUserId,
    worldContentSchema.parse(draft.content),
    request,
    credentialSecret
  );
}
