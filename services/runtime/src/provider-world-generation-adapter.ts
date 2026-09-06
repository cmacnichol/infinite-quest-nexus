import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import type { WorldGenerationProgressUpdate } from "../../../packages/application/src/world-campaign/index.js";
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
  normalizeGeneratedPlayableCharacter
} from "../../../packages/domain/src/character-authoring.js";
import { effectiveAuthoringPrompt, WORLD_AUTHORING_PROMPT_PROTOCOL_VERSION } from "../../../packages/domain/src/authoring-prompts.js";
import {
  generatedCharacterNameKey,
  generatedWorldIssues,
  parseCompleteGeneratedWorld,
  projectGeneratedWorldIssues
} from "../../../packages/domain/src/generated-world.js";
import { validateGeneratedCharacter, validateGeneratedWorldFiction } from "../../../packages/domain/src/authoring-output.js";
import { buildTemplateWorldPrompt, type TemplateWorldInput } from "../../../packages/domain/src/world-template.js";
import { ProviderDestinationNotAllowedError } from "../../../packages/security/src/provider-network-policy.js";
import { ProviderResponseTooLargeError } from "../../../packages/story-engine/src/provider-response.js";
import {
  extractJsonObject,
  ProviderHttpError,
  providerTransportErrorDetails,
  type ProviderResult
} from "../../../packages/story-engine/src/index.js";
import { logger } from "../../../packages/logger/src/index.js";
import type { WorldGenerationProviderCollaborators } from "./provider-application-composition.js";
import { runAuthoringResponse } from "./authoring-response-adapter.js";

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

const completeConvertedPlayableCharacterSchema = convertedPlayableCharacterSchema.superRefine((character, context) => {
  if (!character.profile) {
    context.addIssue({ code: "custom", path: ["profile"], message: "Generated structured character profile is required." });
  }
});

function parseGeneratedCharacterForSeed(
  content: string,
  seed: z.infer<typeof generatedCharacterSeedSchema>,
  characterIndex: number
) {
  const character = completeConvertedPlayableCharacterSchema.parse(extractJsonObject(content));
  const issues: z.ZodIssue[] = [];
  if (!character.id.trim()) {
    issues.push({ code: "custom", path: ["playableCharacters", characterIndex, "id"], message: "Generated character ID must match the supplied seed.", params: { authoringReason: "seed_id_mismatch" } });
  } else if (character.id.trim() !== seed.id.trim()) {
    issues.push({ code: "custom", path: ["playableCharacters", characterIndex, "id"], message: "Generated character ID must match the supplied seed.", params: { authoringReason: "seed_id_mismatch" } });
  }
  if (generatedCharacterNameKey(character.name) !== generatedCharacterNameKey(seed.name)) {
    issues.push({ code: "custom", path: ["playableCharacters", characterIndex, "name"], message: "Generated character name must match the supplied seed.", params: { authoringReason: "seed_name_mismatch" } });
  }
  if (issues.length) throw new z.ZodError(issues);
  try {
    validateGeneratedCharacter(playableCharacterSchema.parse({
      id: character.id,
      name: character.name,
      characterText: character.character_text,
      profile: character.profile,
      rpgStats: character.rpg_statistics,
      defaultTriggers: character.default_triggers
    }), "creative");
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    throw new z.ZodError(error.issues.map((issue) => ({
      ...issue,
      path: ["playableCharacters", characterIndex, ...issue.path]
    })));
  }
  return character;
}

const generatedCharacterSeedSchema = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  role: z.string().trim().min(1).max(2000),
  concept: z.string().trim().min(1).max(10_000),
  narrative_hook: z.string().trim().min(1).max(10_000)
}).passthrough();

const convertedWorldSchema = z.object({
  title: z.preprocess((v) => (typeof v === "string" ? v : coerceText(v)), z.string().trim().min(1).max(200)),
  genre: flexibleShortText,
  tone: flexibleShortText,
  backgroundStory: flexibleLongText,
  premise: flexibleLongText,
  firstAction: flexibleLongText,
  story_rules: flexibleLongText,
  character_seeds: z.array(generatedCharacterSeedSchema).min(3).max(4),
  default_triggers: z.array(z.unknown()).max(10_000).default([]),
  event_triggers: z.array(z.unknown()).max(10_000).default([]),
  rpg_statistics: z.array(z.unknown()).max(10_000).default([])
}).passthrough();

const completeConvertedWorldSchema = convertedWorldSchema.superRefine((world, context) => {
  try {
    validateGeneratedWorldFiction(world);
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    for (const issue of error.issues) context.addIssue({ ...issue });
  }

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
  const seedIds = new Set<string>();
  const seedNames = new Set<string>();
  for (const [index, seed] of world.character_seeds.entries()) {
    const id = seed.id.trim().toLocaleLowerCase();
    const name = seed.name.trim().toLocaleLowerCase();
    if (seedIds.has(id)) context.addIssue({ code: "custom", path: ["character_seeds", index, "id"], message: "Generated character seed IDs must be unique." });
    if (seedNames.has(name)) context.addIssue({ code: "custom", path: ["character_seeds", index, "name"], message: "Generated character seed names must be unique." });
    seedIds.add(id);
    seedNames.add(name);
  }
});


function convertedCharacterId(name: string, index: number): string {
  const slug = name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  return `char-${index + 1}${slug ? `-${slug}` : ""}`;
}

export function applicationOwnedCharacterIds(
  characters: ReadonlyArray<{ name: string; id?: string }>
): string[] {
  return characters.map((character, index) => convertedCharacterId(character.name, index));
}

export function applicationOwnedRpgStats(items: unknown[], characterId: string) {
  return items.flatMap((item, index) => {
    const row = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const name = String(row.name || row.skill || row.stat || "").trim();
    if (!name) return [];
    const numeric = Math.round(Number(row.value ?? row.score ?? row.rating ?? 50));
    return [{
      ...row,
      id: `${characterId}-stat-${index + 1}`.slice(0, 200),
      name: name.slice(0, 200),
      value: Number.isFinite(numeric) ? Math.min(99, Math.max(1, numeric)) : 50,
      note: String(row.note || row.covers || "").slice(0, 2000)
    }];
  });
}

export function applicationOwnedDefaultTriggers(items: unknown[], characterId: string) {
  return items.flatMap((item, index) => {
    const row = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const name = String(row.name || row.label || row.title || "").trim();
    if (!name) return [];
    return [{
      ...row,
      id: `${characterId}-tracker-${index + 1}`.slice(0, 200),
      name: name.slice(0, 300),
      rules: String(row.rules || row.updateRules || row.description || `Track ${name} whenever it changes.`).slice(0, 4000),
      value: String(row.value ?? row.initialValue ?? "Not yet established.").slice(0, 6000)
    }];
  });
}

export function applicationOwnedEventTriggers(items: unknown[], worldScope: string): unknown[] {
  return items.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return {
      ...(item as Record<string, unknown>),
      id: `${worldScope}-event-${index + 1}`.slice(0, 200)
    };
  });
}

export type WorldGenProgress = WorldGenerationProgressUpdate;

export function selectCompleteGeneratedCharacters(
  candidates: unknown[]
) {
  const characters: z.infer<typeof completeConvertedPlayableCharacterSchema>[] = [];
  const characterNames = new Set<string>();
  for (const candidate of candidates) {
    const parsed = completeConvertedPlayableCharacterSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const nameKey = generatedCharacterNameKey(parsed.data.name);
    if (characterNames.has(nameKey)) continue;
    characterNames.add(nameKey);
    characters.push(parsed.data);
    if (characters.length === 4) break;
  }
  return {
    characters,
    needed: Math.max(0, 3 - characters.length)
  };
}

export function incompleteGeneratedWorldError(error?: unknown): Error {
  return Object.assign(
    new Error("The text provider did not return a complete world. Review the missing fields and try again."),
    {
      statusCode: 502,
      expose: true,
      details: {
        code: "incomplete_generated_world",
        issues: generatedWorldIssues(error)
      }
    }
  );
}

export function incompleteGeneratedCharacterError(
  characterIndex: number,
  seedName: string,
  error?: unknown
): Error {
  return Object.assign(
    new Error(`The text provider did not return a complete profile for character ${characterIndex + 1}.`),
    {
      statusCode: 502,
      expose: true,
      details: {
        code: "incomplete_generated_character",
        characterIndex,
        seedName: seedName.slice(0, 200),
        issues: generatedWorldIssues(error)
      }
    }
  );
}

export type WorldGenerationFailureDiagnostic = {
  message: string;
  statusCode?: number;
  code?: "incomplete_generated_world"
    | "incomplete_generated_character"
    | "invalid_cyoa_json"
    | "PROVIDER_DESTINATION_NOT_ALLOWED"
    | "provider_response_too_large"
    | "provider_http_error"
    | "provider_request_timeout"
    | "provider_transport_error"
    | "provider_error";
  issues?: ReturnType<typeof generatedWorldIssues>;
};

type WorldGenerationProviderCategory = "http" | "timeout" | "transport" | "provider";

function permanentGeneratedWorldProviderError(input: {
  name: "ProviderDestinationNotAllowedError" | "ProviderResponseTooLargeError";
  message: string;
  statusCode: 422 | 502;
  code: "PROVIDER_DESTINATION_NOT_ALLOWED" | "provider_response_too_large";
  category: "destination" | "response_limit";
}): Error {
  return Object.assign(new Error(input.message), {
    name: input.name,
    statusCode: input.statusCode,
    expose: true,
    code: input.code,
    permanent: true,
    retryable: false,
    details: {
      code: input.code,
      category: input.category,
      permanent: true,
      retryable: false
    }
  });
}

export function generatedWorldProviderError(error: unknown): Error {
  if (error instanceof ProviderDestinationNotAllowedError) {
    return permanentGeneratedWorldProviderError({
      name: "ProviderDestinationNotAllowedError",
      message: "The provider destination is not allowed by the server network policy.",
      statusCode: 422,
      code: "PROVIDER_DESTINATION_NOT_ALLOWED",
      category: "destination"
    });
  }
  if (error instanceof ProviderResponseTooLargeError) {
    return permanentGeneratedWorldProviderError({
      name: "ProviderResponseTooLargeError",
      message: "The provider response exceeded the server's safe size limit.",
      statusCode: 502,
      code: "provider_response_too_large",
      category: "response_limit"
    });
  }
  const failure = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const transport = providerTransportErrorDetails(error);
  const rawStatusCode = Number(failure.statusCode);
  const providerStatus = Number.isInteger(rawStatusCode) && rawStatusCode >= 400 && rawStatusCode <= 599
    ? rawStatusCode
    : undefined;
  let category: WorldGenerationProviderCategory;
  let code: "provider_http_error" | "provider_request_timeout" | "provider_transport_error" | "provider_error";
  let statusCode: number;
  let message: string;

  if (transport?.timedOut) {
    category = "timeout";
    code = "provider_request_timeout";
    statusCode = 504;
    message = "The text provider request timed out.";
  } else if (transport) {
    category = "transport";
    code = "provider_transport_error";
    statusCode = 502;
    message = "The text provider connection failed.";
  } else if (providerStatus && (error instanceof ProviderHttpError || Object.hasOwn(failure, "providerMessage"))) {
    category = "http";
    code = "provider_http_error";
    statusCode = providerStatus;
    message = `The text provider request failed with HTTP ${providerStatus}.`;
  } else {
    category = "provider";
    code = "provider_error";
    statusCode = providerStatus || 502;
    message = providerStatus
      ? `The text provider request failed with HTTP ${providerStatus}.`
      : "The text provider request failed.";
  }

  return Object.assign(new Error(message), {
    name: "WorldGenerationProviderError",
    statusCode,
    expose: true,
    code,
    details: {
      code,
      category,
      ...(category === "http" ? { providerStatus: statusCode } : {})
    }
  });
}

async function callGeneratedWorldProvider(
  request: () => Promise<ProviderResult>
): Promise<ProviderResult> {
  try {
    return await request();
  } catch (error) {
    throw generatedWorldProviderError(error);
  }
}

export function worldGenerationFailureDiagnostic(error: unknown): WorldGenerationFailureDiagnostic {
  const failure = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const rawStatusCode = Number(failure.statusCode);
  const statusCode = Number.isInteger(rawStatusCode) && rawStatusCode >= 400 && rawStatusCode <= 599
    ? rawStatusCode
    : undefined;
  const details = failure.details && typeof failure.details === "object"
    ? failure.details as Record<string, unknown>
    : {};
  const detailsCode = details.code;
  if (detailsCode === "PROVIDER_DESTINATION_NOT_ALLOWED"
    || failure.code === "PROVIDER_DESTINATION_NOT_ALLOWED") {
    return {
      message: "The provider destination is not allowed by the server network policy.",
      statusCode: 422,
      code: "PROVIDER_DESTINATION_NOT_ALLOWED"
    };
  }
  if (detailsCode === "provider_response_too_large"
    || failure.code === "provider_response_too_large") {
    return {
      message: "The provider response exceeded the server's safe size limit.",
      statusCode: 502,
      code: "provider_response_too_large"
    };
  }
  if (detailsCode === "incomplete_generated_world") {
    const issues = projectGeneratedWorldIssues(details.issues);
    const issueSummary = issues
      .slice(0, 4)
      .map((issue) => `${issue.path || "generated world"}: ${issue.message}`)
      .join(" ");
    const message = [
      "The text provider did not return a complete world. Review the missing fields and try again.",
      issueSummary
    ].filter(Boolean).join(" ").slice(0, 500);
    return {
      message,
      statusCode: 502,
      code: "incomplete_generated_world",
      issues
    };
  }
  if (detailsCode === "incomplete_generated_character") {
    return {
      message: "The text provider did not return a complete character profile. Review the missing fields and try again.",
      statusCode: 502,
      code: "incomplete_generated_character"
    };
  }
  if (detailsCode === "invalid_cyoa_json") {
    return {
      message: "Invalid Choose Your Own Adventure JSON structure.",
      statusCode: 400,
      code: "invalid_cyoa_json"
    };
  }
  if (detailsCode === "provider_request_timeout" || failure.code === "provider_request_timeout") {
    return {
      message: "The text provider request timed out. Check the provider endpoint and server logs.",
      ...(statusCode ? { statusCode } : {}),
      code: "provider_request_timeout"
    };
  }
  if (detailsCode === "provider_transport_error" || failure.code === "provider_transport_error") {
    return {
      message: "The text provider connection failed. Check the provider endpoint and server logs.",
      ...(statusCode ? { statusCode } : {}),
      code: "provider_transport_error"
    };
  }
  if (detailsCode === "provider_http_error" && statusCode) {
    return {
      message: `The text provider request failed with HTTP ${statusCode}. Check the provider endpoint and server logs.`,
      statusCode,
      code: "provider_http_error"
    };
  }
  if (detailsCode === "provider_error") {
    return {
      message: statusCode
        ? `The text provider request failed with HTTP ${statusCode}. Check the provider endpoint and server logs.`
        : "The text provider request failed. Check the provider endpoint and server logs.",
      ...(statusCode ? { statusCode } : {}),
      code: "provider_error"
    };
  }
  return {
    message: statusCode
      ? `World generation failed with status ${statusCode}. Check the server logs and try again.`
      : "World generation failed. Check the server logs and try again.",
    ...(statusCode ? { statusCode } : {})
  };
}

function isGeneratedWorldValidationError(error: unknown): error is z.ZodError | SyntaxError {
  return error instanceof z.ZodError || error instanceof SyntaxError;
}

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

  const normalizeGeneratedSeed = (item: unknown, index: number) => {
    const character = item && typeof item === "object" && !Array.isArray(item)
      ? item as Record<string, unknown>
      : {};
    const profile = character.profile && typeof character.profile === "object" && !Array.isArray(character.profile)
      ? character.profile as Record<string, unknown>
      : {};
    const story = profile.story && typeof profile.story === "object" && !Array.isArray(profile.story)
      ? profile.story as Record<string, unknown>
      : {};
    const concept = coerceText(
      character.concept ?? character.character_text ?? character.characterText ?? character.background ?? character.description
    ).trim();
    return {
      id: coerceText(character.id).trim() || `seed-${index + 1}`,
      name: coerceText(character.name ?? character.character_name ?? character.characterName).trim(),
      role: coerceText(character.role ?? story.role).trim(),
      concept,
      narrative_hook: coerceText(character.narrative_hook ?? character.narrativeHook ?? story.narrativeHooks).trim() || concept
    };
  };
  const hasSeedKey = Object.hasOwn(obj, "character_seeds") || Object.hasOwn(obj, "characterSeeds");
  const seedSource = Object.hasOwn(obj, "character_seeds") ? obj.character_seeds : obj.characterSeeds;
  const legacyCharacters = getArr("playable_characters", "playableCharacters", "playable_character_list", "characters");
  const normalizedSeeds = (Array.isArray(seedSource) ? seedSource : legacyCharacters)
    .map((item, index) => normalizeGeneratedSeed(item, index));
  const normalizedChars = legacyCharacters.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const character = item as Record<string, unknown>;
    return {
      ...character,
      id: String(character.id || "").trim(),
      name: coerceText(character.name || character.character_name || character.characterName || "").trim(),
      character_text: coerceText(character.character_text || character.characterText || character.background || character.description || character.details).trim(),
      rpg_statistics: Array.isArray(character.rpg_statistics) ? character.rpg_statistics : (Array.isArray(character.rpgStats) ? character.rpgStats : (Array.isArray(character.rpg_stats) ? character.rpg_stats : [])),
      default_triggers: Array.isArray(character.default_triggers) ? character.default_triggers : (Array.isArray(character.defaultTriggers) ? character.defaultTriggers : [])
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
    character_seeds: hasSeedKey && !Array.isArray(seedSource) ? seedSource : normalizedSeeds,
    playable_characters: normalizedChars,
    rpg_statistics: getArr("rpg_statistics", "rpgStats", "rpg_stats", "statistics"),
    default_triggers: getArr("default_triggers", "defaultTriggers", "default_trigger_list"),
    event_triggers: getArr("event_triggers", "eventTriggers", "event_trigger_list")
  };
}

export async function generateTemplateWorld(
  _pool: DatabasePool,
  ownerUserId: string,
  providerProfileId: string,
  input: TemplateWorldInput,
  providers: WorldGenerationProviderCollaborators,
  worldId: string,
  model?: string,
  onProgress?: (phase: string, percent: number, message: string) => Promise<void> | void,
): Promise<{ title: string; content: WorldContent }> {
  if (!providerProfileId) {
    logger.error({ ownerUserId, sourceKind: input.sourceKind }, "World generation failed: missing provider profile ID");
    throw Object.assign(new Error("Select a text provider to convert or generate the Story World."), { statusCode: 400 });
  }

  logger.info({ ownerUserId, providerProfileId, sourceKind: input.sourceKind, title: input.title }, "Starting template world generation");
  logger.debug(worldGenerationInputMetadata(input), "Template world generation input metadata");

  await onProgress?.("extracting", 10, "Loading text provider and preparing modular prompt…");
  const resolution = await providers.resolution.resolveDirect({
    ownerUserId,
    providerRole: "text",
    selectedProviderProfileId: providerProfileId,
    ...(model === undefined ? {} : { model }),
  });
  if (resolution.status !== "resolved") {
    throw Object.assign(new Error("The selected text provider is unavailable."), { statusCode: 409 });
  }
  const provider = await providers.execution.text(
    { ownerUserId }, resolution.providerProfileId, "text", resolution.model,
  );

  await onProgress?.("generating_world", 30, "Synthesizing world structure and character seeds via LLM…");
  const promptSnapshot = (await providers.prompts.loadWorldGenerationPromptSnapshot({ ownerUserId, worldId })).snapshot;
  const worldPrompt = buildTemplateWorldPrompt(input, providers.promptTools.content(promptSnapshot, "world_generation"));
  const worldRepairPrompt = providers.promptTools.content(promptSnapshot, "world_generation_recovery");
  const converted = await runAuthoringResponse({
    stage: "world",
    request: async (attempt) => {
      if (attempt.repair) {
        await onProgress?.("recovering_world", 35, "Generated world was incomplete. Requesting a complete replacement…");
      }
      return provider.execute({
        ...worldPrompt,
        systemPrompt: effectiveAuthoringPrompt("world", attempt.repair ? worldRepairPrompt : providers.promptTools.content(promptSnapshot, "world_generation")).content,
        responseFormatFallback: "forbid",
        ...(attempt.rejectedResponse === undefined ? {} : {
          rejectedResponse: attempt.rejectedResponse,
          recoveryInput: JSON.stringify({ issues: attempt.issues })
        })
      });
    },
    parse: (content) => completeConvertedWorldSchema.parse(normalizeRawWorldJson(extractJsonObject(content))),
    delay: async (milliseconds) => { await new Promise<void>((resolve) => setTimeout(resolve, milliseconds)); }
  });
  let validationResult: ProviderResult | undefined;

  const rawCharacters: z.infer<typeof completeConvertedPlayableCharacterSchema>[] = [];
  for (const [characterIndex, seed] of converted.character_seeds.entries()) {
    const safeSeedName = seed.name.slice(0, 200);
    const percent = 40 + Math.round((characterIndex / converted.character_seeds.length) * 45);
    await onProgress?.(
      "generating_character",
      percent,
      `Generating character ${characterIndex + 1} of ${converted.character_seeds.length}: ${safeSeedName}…`
    );
    const characterRequest = {
      systemPrompt: effectiveAuthoringPrompt("world_character", providers.promptTools.content(promptSnapshot, "world_character_generation")).content,
      input: JSON.stringify({
        world: {
          title: converted.title,
          genre: converted.genre,
          tone: converted.tone,
          backgroundStory: converted.backgroundStory,
          premise: converted.premise,
          firstAction: converted.firstAction,
          storyRules: converted.story_rules
        },
        seed,
        otherSeeds: converted.character_seeds
          .filter((candidate) => candidate.id !== seed.id)
          .map(({ id, name, role }) => ({ id, name, role })),
        acceptedCharacterNames: rawCharacters.map((character) => character.name)
      })
    };
    const characterRepairPrompt = providers.promptTools.content(promptSnapshot, "world_character_generation_recovery");
    const generatedCharacter = await runAuthoringResponse({
      stage: "character",
      request: async (attempt) => {
        if (attempt.repair) {
          await onProgress?.("recovering_character", percent, `Character ${characterIndex + 1} was incomplete. Requesting a complete replacement…`);
        }
        return provider.execute({
          ...characterRequest,
          systemPrompt: effectiveAuthoringPrompt("world_character", attempt.repair ? characterRepairPrompt : providers.promptTools.content(promptSnapshot, "world_character_generation")).content,
          responseFormatFallback: "forbid",
          ...(attempt.rejectedResponse === undefined ? {} : {
            rejectedResponse: attempt.rejectedResponse,
            recoveryInput: JSON.stringify({ issues: attempt.issues })
          })
        });
      },
      parse: (content) => parseGeneratedCharacterForSeed(content, seed, characterIndex),
      delay: async (milliseconds) => { await new Promise<void>((resolve) => setTimeout(resolve, milliseconds)); }
    });
    rawCharacters.push(generatedCharacter);
  }

  await onProgress?.("formatting", 85, "Formatting character roster and world attributes…");
  let content: WorldContent;
  try {
    const characterIds = applicationOwnedCharacterIds(rawCharacters);
    const playableCharacters = rawCharacters.map((character, index) => {
      const id = characterIds[index]!;
      return playableCharacterSchema.parse({
        id,
        name: character.name,
        characterText: character.character_text,
        profile: character.profile,
        rpgStats: applicationOwnedRpgStats(character.rpg_statistics, id),
        defaultTriggers: applicationOwnedDefaultTriggers(character.default_triggers, id),
        source: { type: "template-world-generator", index, promptProtocolVersion: CHARACTER_AUTHORING_PROMPT_PROTOCOL_VERSION }
      });
    });

    content = parseCompleteGeneratedWorld(canonicalizeWorldContent({
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
      rpgStats: applicationOwnedRpgStats(converted.rpg_statistics, "world-wide"),
      defaultTriggers: applicationOwnedDefaultTriggers(converted.default_triggers, "world-wide"),
      eventTriggers: applicationOwnedEventTriggers(converted.event_triggers, "generated-world"),
      assets: [],
      defaults: {
        importedFrom: input.sourceKind,
        defaultPlayableCharacterId: playableCharacters[0]?.id || "",
        authoringPromptProtocolVersion: WORLD_AUTHORING_PROMPT_PROTOCOL_VERSION
      }
    }));
  } catch (error) {
    if (!isGeneratedWorldValidationError(error)) throw error;
    logger.error({
      responseId: validationResult?.responseId,
      finishReason: validationResult?.finishReason,
      outputLimited: validationResult?.outputLimited,
      issues: generatedWorldIssues(error)
    }, "Generated world completion validation failed");
    throw incompleteGeneratedWorldError(error);
  }

  await onProgress?.("completed", 100, "World and character generation completed.");
  logger.info({ characterCount: content.playableCharacters.length }, "Completed template world generation successfully");
  return {
    title: content.world.title,
    content
  };
}

export type WorldGenerationProviderDependencies = {
  createWorldGenerationProgress(pool: DatabasePool, ownerUserId: string, progressKey: string): Promise<void>;
  updateWorldGenerationProgress(
    pool: DatabasePool,
    ownerUserId: string,
    progressKey: string,
    progress: WorldGenerationProgressUpdate,
  ): Promise<void>;
};

export async function generateWorldPreviewForOwner(
  pool: DatabasePool,
  ownerUserId: string,
  request: WorldGenerationPreviewRequest,
  providers: WorldGenerationProviderCollaborators,
  dependencies: WorldGenerationProviderDependencies
): Promise<{ title: string; content: WorldContent }> {
  const providerResolution = await providers.resolution.resolveDirect({ ownerUserId, providerRole: "text" });
  const providerProfileId = providerResolution.status === "resolved"
    ? providerResolution.providerProfileId
    : null;
  const progressKey = request.progressKey;
  if (progressKey) await dependencies.createWorldGenerationProgress(pool, ownerUserId, progressKey);
  if (!providerProfileId) {
    logger.warn({ ownerUserId, title: request.title }, "World preview generation failed: no default text provider configured");
    if (progressKey) {
      await dependencies.updateWorldGenerationProgress(pool, ownerUserId, progressKey, {
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
  logger.info({ title: request.title, promptLength: request.prompt?.length, progressKey }, "Generating world preview from prompt");

  if (progressKey) {
    await dependencies.updateWorldGenerationProgress(pool, ownerUserId, progressKey, {
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
      {
        sourceName: "new-world-prompt",
        sourceKind: "prompt",
        title: request.title || "Untitled World",
        summary: request.prompt,
        keywords: [],
        excerpts: [],
        prompt: request.prompt
      },
      providers,
      progressKey || "world-generation-preview",
      providerResolution.status === "resolved" ? providerResolution.model : undefined,
      async (phase, progressPercent, message) => {
        if (progressKey) {
          await dependencies.updateWorldGenerationProgress(pool, ownerUserId, progressKey, {
            status: "processing",
            phase,
            progressPercent,
            message
          });
        }
      }
    );
  } catch (error) {
    const failure = worldGenerationFailureDiagnostic(error);
    logger.error({
      progressKey,
      statusCode: failure.statusCode,
      code: failure.code,
      issues: failure.issues
    }, "World preview generation failed");
    if (progressKey) {
      await dependencies.updateWorldGenerationProgress(pool, ownerUserId, progressKey, {
        status: "failed",
        phase: "failed",
        progressPercent: 100,
        message: failure.message,
        errorMessage: failure.message
      });
    }
    throw error;
  }
  if (progressKey) {
    await dependencies.updateWorldGenerationProgress(pool, ownerUserId, progressKey, {
      status: "completed",
      phase: "completed",
      progressPercent: 100,
      message: "World and character generation completed."
    });
  }
  logger.info({ progressKey, characterCount: generated.content.playableCharacters.length }, "World preview generation succeeded");
  return generated;
}

function characterGenerationError(message: string, statusCode: number, code: string): Error {
  return Object.assign(new Error(message), { statusCode, details: { code } });
}

async function generatePlayableCharacterCandidate(
  pool: DatabasePool,
  ownerUserId: string,
  content: WorldContent,
  request: { prompt: string; characterId?: string | undefined },
  providers: WorldGenerationProviderCollaborators,
  worldId: string,
  onProgress?: (phase: "generating" | "validating", percent: 35 | 80, message: string) => Promise<void>,
): Promise<{ character: ReturnType<typeof normalizeGeneratedPlayableCharacter> }> {
  logger.info({ ownerUserId, characterId: request.characterId, promptLength: request.prompt?.length }, "Generating playable character candidate");

  const currentCharacter = request.characterId
    ? content.playableCharacters.find((character) => character.id === request.characterId)
    : undefined;
  if (request.characterId && !currentCharacter) {
    logger.warn({ ownerUserId, characterId: request.characterId }, "Playable character generation failed: target character not found in world draft");
    throw characterGenerationError("The selected playable character does not belong to this world draft.", 404, "playable_character_not_found");
  }

  const providerResolution = await providers.resolution.resolveDirect({ ownerUserId, providerRole: "text" });
  if (providerResolution.status !== "resolved") {
    logger.warn({ ownerUserId }, "Playable character generation failed: no default text provider configured");
    throw characterGenerationError(
      "Add a text provider or mark one as default in Provider Management before generating a character.",
      409,
      "default_text_provider_unavailable"
    );
  }
  const provider = await providers.execution.text(
    { ownerUserId }, providerResolution.providerProfileId, "text", providerResolution.model,
  );
  await onProgress?.("generating", 35, "Generating character preview.");
  const promptSnapshot = (await providers.prompts.loadWorldGenerationPromptSnapshot({ ownerUserId, worldId })).snapshot;
  const prompt = buildPlayableCharacterGenerationPrompt(
    content,
    request.prompt,
    currentCharacter,
    providers.promptTools.content(promptSnapshot, "character_generation")
      .replaceAll("{{protocol}}", CHARACTER_AUTHORING_PROMPT_PROTOCOL_VERSION),
  );
  let generatedId = currentCharacter?.id || randomUUID();
  while (!currentCharacter && content.playableCharacters.some((character) => character.id === generatedId)) {
    generatedId = randomUUID();
  }
  const character = await runAuthoringResponse({
    stage: "character",
    request: async (attempt) => {
      if (attempt.repair) await onProgress?.("generating", 35, "Generated character was incomplete. Requesting a complete replacement.");
      return provider.execute({
        ...prompt,
        systemPrompt: effectiveAuthoringPrompt("character", prompt.systemPrompt).content,
        responseFormatFallback: "forbid",
        ...(attempt.rejectedResponse === undefined ? {} : {
          rejectedResponse: attempt.rejectedResponse,
          recoveryInput: JSON.stringify({ issues: attempt.issues })
        })
      });
    },
    parse: (content) => normalizeGeneratedPlayableCharacter(extractJsonObject(content), generatedId, currentCharacter),
    delay: async (milliseconds) => { await new Promise<void>((resolve) => setTimeout(resolve, milliseconds)); }
  });
  await onProgress?.("validating", 80, "Validating generated character.");
  logger.info({ characterId: generatedId, name: character.name }, "Playable character candidate generated successfully");
  return { character };
}

export async function generatePlayableCharacterPreviewForOwner(
  pool: DatabasePool,
  ownerUserId: string,
  request: PlayableCharacterGenerationPreviewRequest,
  providers: WorldGenerationProviderCollaborators,
  dependencies: WorldGenerationProviderDependencies,
) {
  const progressKey = request.progressKey;
  try {
    if (progressKey) {
      await dependencies.createWorldGenerationProgress(pool, ownerUserId, progressKey);
      await dependencies.updateWorldGenerationProgress(pool, ownerUserId, progressKey, {
        status: "processing",
        phase: "preparing",
        progressPercent: 10,
        message: "Preparing character generation."
      });
    }
    const generated = await generatePlayableCharacterCandidate(
      pool,
      ownerUserId,
      worldContentSchema.parse(request.content),
      request,
      providers,
      "playable-character-preview",
      async (phase, progressPercent, message) => {
        if (progressKey) {
          await dependencies.updateWorldGenerationProgress(pool, ownerUserId, progressKey, {
            status: "processing",
            phase,
            progressPercent,
            message
          });
        }
      },
    );
    if (progressKey) {
      await dependencies.updateWorldGenerationProgress(pool, ownerUserId, progressKey, {
        status: "completed",
        phase: "completed",
        progressPercent: 100,
        message: "Character preview completed."
      });
    }
    return generated;
  } catch (error) {
    if (progressKey) {
      const message = "Character preview generation failed. Check the text provider and try again.";
      try {
        await dependencies.updateWorldGenerationProgress(pool, ownerUserId, progressKey, {
          status: "failed",
          phase: "failed",
          progressPercent: 100,
          message,
          errorMessage: message
        });
      } catch {
        logger.warn({ progressKey }, "Could not record safe character preview failure progress");
      }
    }
    throw error;
  }
}

export async function generatePlayableCharacterForOwner(
  pool: DatabasePool,
  ownerUserId: string,
  worldId: string,
  request: PlayableCharacterGenerationRequest,
  providers: WorldGenerationProviderCollaborators,
): Promise<{ character: ReturnType<typeof normalizeGeneratedPlayableCharacter> }> {
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
    providers,
    worldId,
  );
}
