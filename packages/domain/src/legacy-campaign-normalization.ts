import type { LegacyStory, LegacyTurn } from "../../contracts/src/imports.js";
import { storyLengthProfileFromUnknown, type StoryLengthProfile } from "../../contracts/src/story-settings.js";
import {
  playableCharacterSchema,
  type CampaignCharacterProfile,
  type PlayableCharacter,
  type WorldContent
} from "../../contracts/src/world-library.js";
import { normalizeCampaignStateSnapshot, normalizeCampaignTrackers } from "./campaign-trackers.js";
import { legacyWorldContent } from "./legacy-story-world.js";
import {
  campaignCharacterSeed,
  campaignProfileFromCharacter,
  characterSnapshot
} from "./world-characters.js";
import { estimateTokens, stripMechanicsLeakage } from "./text.js";

export type LegacyCampaignDestination =
  | Readonly<{ kind: "create_world" }>
  | Readonly<{ kind: "existing_world_version"; worldContent: WorldContent }>;

export type NormalizedLegacyTurn = Readonly<{
  turnNumber: number;
  sourceTurnNumber: number | null;
  sourceTurnId: string | null;
  action: string;
  inputMode: "action" | "scene";
  inputModeSource: "explicit" | "auto" | "generated_choice" | "opening_action" | "fallback";
  narration: string;
  choices: readonly string[];
  customActionSuggestion: string;
  imagePrompt: string;
  imageUrl: string;
  mechanicsPrivate: unknown | null;
  stateSnapshotPrivate: Readonly<Record<string, unknown>>;
  modelMetadata: Readonly<Record<string, unknown>>;
  importMetadata: Readonly<Record<string, unknown>>;
  acceptedAt: string | null;
}>;

export type NormalizedLegacyCampaign = Readonly<{
  worldContent: WorldContent | null;
  campaignSeed: Readonly<{
    title: string;
    selectedCharacterId: string;
    characterSnapshot: Readonly<Record<string, unknown>>;
    characterProfile: CampaignCharacterProfile | null;
    characterProfileRevision: number;
    characterStrategy: "preserve_source" | "map_to_target";
    storyLengthProfile: StoryLengthProfile;
    turnControlStyle: "action_only" | "flexible_auto" | "flexible_action" | "flexible_scene";
    legacySettings: Readonly<Record<string, unknown>>;
  }>;
  initialState: Readonly<Record<string, unknown>>;
  currentState: Readonly<{
    scratchpad: string;
    trackers: readonly unknown[];
    defaultTriggers: readonly unknown[];
    eventTriggers: readonly unknown[];
    pendingEventTriggers: readonly unknown[];
    rpgStats: readonly unknown[];
  }>;
  turns: readonly NormalizedLegacyTurn[];
  continuitySeed: Readonly<{ content: string; throughTurn: number; sanitized: boolean }> | null;
  provenance: Readonly<Record<string, unknown>>;
  warnings: readonly string[];
  stats: Readonly<{
    turnCount: number;
    completeHistoryCharacters: number;
    estimatedHistoryTokens: number;
    importedSummary: boolean;
    summaryThroughTurn: number;
    sanitizedMemoryCount: number;
    preservedTurnStateCount: number;
    warningCount: number;
  }>;
}>;

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function narration(turn: LegacyTurn): string {
  return text(turn.narration) || text(turn.story) || text(turn.text);
}

function acceptedAt(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function choices(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(entry ?? "").trim()).filter(Boolean).slice(0, 4)
    : [];
}

function legacySummary(value: unknown): { content: string; sanitized: boolean } {
  let source = "";
  if (typeof value === "string") source = value.trim();
  else {
    const history = objectValue(value);
    source = [
      ["Characters", history.characters],
      ["Setting", history.settingDetails ?? history.setting_details],
      ["Plot", history.plotDetails ?? history.plot_details],
      ["Important notes", history.otherImportantNotes ?? history.other_important_notes]
    ].flatMap(([label, entry]) => typeof entry === "string" && entry.trim()
      ? [`${label}:\n${entry.trim()}`]
      : []).join("\n\n");
  }
  const sanitized = stripMechanicsLeakage(source);
  const withoutEmptyHeadings = sanitized.text
    .replace(/^(?:Characters|Setting|Plot|Important notes):\s*(?=\n\n|$)/gmu, "")
    .trim();
  return {
    content: withoutEmptyHeadings.slice(0, 20_000),
    sanitized: sanitized.changed || withoutEmptyHeadings !== sanitized.text
  };
}

function sanitizedSettings(story: LegacyStory): Record<string, unknown> {
  const sourceSettings = story.settings ?? {};
  const scrub = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(scrub);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
      const normalizedKey = key.replaceAll(/[^a-z0-9]/giu, "").toLocaleLowerCase();
      const secret = normalizedKey.includes("apikey")
        || normalizedKey.includes("accesstoken")
        || normalizedKey.includes("refreshtoken")
        || normalizedKey === "token"
        || normalizedKey.includes("password")
        || normalizedKey.includes("credential")
        || normalizedKey.includes("bearer")
        || normalizedKey.includes("providerresponse")
        || normalizedKey.includes("rawresponse");
      return [key, secret ? "" : scrub(entry)];
    }));
  };
  const settings = scrub(sourceSettings) as Record<string, unknown>;
  for (const key of [
    "nexusCampaignId",
    "nexusCampaignTurnCount",
    "nexusPendingGeneration",
    "nexusCampaignWorldVersionId",
    "nexusBranchWorldVersionId"
  ]) delete settings[key];
  settings.storyLength = storyLengthProfileFromUnknown(settings.storyLength ?? settings.story_length);
  const control = settings.turnControlStyle;
  settings.turnControlStyle = control === "action_only" || control === "flexible_auto"
    || control === "flexible_action" || control === "flexible_scene"
    ? control
    : "flexible_action";
  settings.useRpgStats = Boolean(settings.useRpgStats ?? settings.use_rpg_stats ?? story.rpgStats?.length);
  settings.suppressEventTriggers = Boolean(
    story.world.suppressTriggers
    ?? story.world.suppress_triggers
    ?? settings.suppressTriggers
    ?? settings.suppress_triggers
  );
  return settings;
}

function warningsFor(settings: Readonly<Record<string, unknown>>): string[] {
  const warnings: string[] = [];
  if (settings.memoryManagementMode !== undefined || settings.memory_management_mode !== undefined
    || settings.betterMemoryManagement !== undefined) {
    warnings.push("Chronicle replaces legacy memory management mode; the source value is retained only as import provenance.");
  }
  if (settings.storyHistoryTokenLimit !== undefined || settings.story_history_token_limit !== undefined) {
    warnings.push("The provider context window replaces legacy story history token limit behavior; the source value is retained only as import provenance.");
  }
  if (settings.storyHistoryCompression !== undefined || settings.story_history_compression !== undefined) {
    warnings.push("Chronicle replaces legacy story history compression behavior; the source value is retained only as import provenance.");
  }
  return warnings;
}

function selectedCharacter(input: Readonly<{
  story: LegacyStory;
  destination: LegacyCampaignDestination;
  selectedCharacterId?: string;
  characterStrategy?: "preserve_source" | "map_to_target";
}>): Readonly<{
  worldContent: WorldContent | null;
  character: PlayableCharacter;
  strategy: "preserve_source" | "map_to_target";
  rpgStats: readonly unknown[];
  defaultTriggers: readonly unknown[];
}> {
  if (input.destination.kind === "create_world") {
    const worldContent = legacyWorldContent(input.story, input.selectedCharacterId);
    const seed = campaignCharacterSeed(worldContent, input.selectedCharacterId);
    return { worldContent, character: seed.character, strategy: "preserve_source", rpgStats: seed.rpgStats, defaultTriggers: seed.defaultTriggers };
  }

  const portable = input.story.format === "infinite-quest-campaign";
  const strategy = input.characterStrategy ?? (portable ? "preserve_source" : "map_to_target");
  if (strategy === "map_to_target") {
    const seed = campaignCharacterSeed(input.destination.worldContent, input.selectedCharacterId);
    return { worldContent: null, character: seed.character, strategy, rpgStats: seed.rpgStats, defaultTriggers: seed.defaultTriggers };
  }

  const stored = input.story.campaign?.characterSnapshot;
  const character = stored
    ? playableCharacterSchema.parse(stored)
    : legacyWorldContent(input.story, input.selectedCharacterId).playableCharacters[0];
  if (!character) throw Object.assign(new Error("The portable campaign does not contain a character snapshot to preserve."), { statusCode: 400 });
  return {
    worldContent: null,
    character,
    strategy,
    rpgStats: array(character.rpgStats),
    defaultTriggers: array(character.defaultTriggers)
  };
}

function normalizedSnapshot(turn: LegacyTurn): Record<string, unknown> {
  const source = objectValue(turn.worldStateSnapshot);
  const withFallbacks = {
    ...source,
    ...(source.scratchpad === undefined && turn.scratchpadSnapshot !== undefined
      ? { scratchpad: turn.scratchpadSnapshot }
      : {}),
    ...(source.trackers === undefined && turn.trackersSnapshot !== undefined
      ? { trackers: turn.trackersSnapshot }
      : {})
  };
  return normalizeCampaignStateSnapshot(withFallbacks);
}

/** Canonical public seam for interpreting legacy campaign formats before preview or commit. */
export function normalizeLegacyCampaign(input: Readonly<{
  story: LegacyStory;
  destination: LegacyCampaignDestination;
  selectedCharacterId?: string;
  characterStrategy?: "preserve_source" | "map_to_target";
}>): NormalizedLegacyCampaign {
  const selection = selectedCharacter(input);
  const settings = sanitizedSettings(input.story);
  const warnings = warningsFor(input.story.settings ?? {});
  const sourceNumbers = input.story.turns.map((turn) => turn.turnNumber ?? null);
  const sequential = sourceNumbers.every((value, index) => value === null || value === index + 1);
  if (!sequential) warnings.push("Legacy turn numbers were preserved as provenance and normalized to a contiguous accepted-turn ledger.");

  let completeHistoryCharacters = 0;
  let estimatedHistoryTokens = 0;
  let sanitizedMemoryCount = 0;
  const turns = input.story.turns.map((turn, index): NormalizedLegacyTurn => {
    const fiction = narration(turn);
    if (!fiction) throw Object.assign(new Error(`Turn ${index + 1} has no narration, story, or text content.`), { statusCode: 400 });
    const action = text(turn.action);
    const sanitizedAction = stripMechanicsLeakage(action);
    const sanitizedNarration = stripMechanicsLeakage(fiction);
    if (sanitizedAction.changed || sanitizedNarration.changed) sanitizedMemoryCount += 1;
    completeHistoryCharacters += action.length + fiction.length;
    estimatedHistoryTokens += estimateTokens(`${action}\n${fiction}`);
    const sourceTurnId = text(turn.id) || null;
    const sourceTurnNumber = Number.isInteger(turn.turnNumber) ? turn.turnNumber! : null;
    return Object.freeze({
      turnNumber: index + 1,
      sourceTurnNumber,
      sourceTurnId,
      action,
      inputMode: turn.inputMode ?? "action",
      inputModeSource: turn.inputModeSource ?? "explicit",
      narration: fiction,
      choices: Object.freeze(choices(turn.choices)),
      customActionSuggestion: text(turn.customActionSuggestion ?? turn.custom_action_suggestion),
      imagePrompt: text(turn.imagePrompt),
      imageUrl: text(turn.imageUrl),
      mechanicsPrivate: turn.roll ?? null,
      stateSnapshotPrivate: Object.freeze(normalizedSnapshot(turn)),
      modelMetadata: Object.freeze(objectValue(turn.llmModelInfo)),
      importMetadata: Object.freeze({
        importedFrom: turn.importedFrom ?? null,
        sourceTurnId,
        sourceTurnNumber,
        legacyCreatedAt: acceptedAt(turn.createdAt)
      }),
      acceptedAt: acceptedAt(turn.createdAt)
    });
  });

  const summary = legacySummary(input.story.fullHistory);
  const throughTurn = Math.min(
    turns.length,
    Math.max(0, input.story.fullHistoryCompressedThroughTurn ?? turns.length)
  );
  const continuitySeed = summary.content
    ? Object.freeze({ content: summary.content, throughTurn, sanitized: summary.sanitized })
    : null;
  const currentTrackers = normalizeCampaignTrackers(input.story.trackers ?? []);
  const defaultTriggers = normalizeCampaignTrackers(
    input.story.defaultTriggers ?? input.story.baseTrackersAtStart ?? selection.defaultTriggers
  );
  const eventTriggers = array(input.story.eventTriggers);
  const pendingEventTriggers = array(input.story.pendingEventTriggers);
  const rpgStats = array(input.story.rpgStats).length ? array(input.story.rpgStats) : [...selection.rpgStats];
  const currentState = Object.freeze({
    scratchpad: input.story.scratchpad ?? "",
    trackers: Object.freeze(currentTrackers),
    defaultTriggers: Object.freeze(defaultTriggers),
    eventTriggers: Object.freeze(eventTriggers),
    pendingEventTriggers: Object.freeze(pendingEventTriggers),
    rpgStats: Object.freeze(rpgStats)
  });
  const initialState = Object.freeze({
    scratchpad: "",
    trackers: normalizeCampaignTrackers(input.story.baseTrackersAtStart ?? input.story.trackers ?? []),
    eventTriggers,
    pendingEventTriggers: [],
    rpgStats,
    ...(continuitySeed ? { continuitySummary: continuitySeed.content } : {})
  });
  const portableProfile = input.story.campaign?.characterProfile ?? null;
  const characterProfile = portableProfile ?? campaignProfileFromCharacter(selection.character);
  const characterProfileRevision = characterProfile
    ? portableProfile ? input.story.campaign?.characterProfileRevision ?? 0 : 1
    : 0;
  const storyLengthProfile = storyLengthProfileFromUnknown(settings.storyLength);
  const turnControlStyle = settings.turnControlStyle as NormalizedLegacyCampaign["campaignSeed"]["turnControlStyle"];
  const provenance = Object.freeze({
    world: input.story.worldImportProvenance ?? null,
    story: input.story.storyImportProvenance ?? null,
    sourceSettings: settings,
    selectedCharacterId: selection.character.id,
    characterStrategy: selection.strategy
  });

  return Object.freeze({
    worldContent: selection.worldContent,
    campaignSeed: Object.freeze({
      title: input.story.campaign?.title?.trim() || input.story.world.title?.trim() || "Imported campaign",
      selectedCharacterId: selection.character.id,
      characterSnapshot: Object.freeze(characterSnapshot(selection.character)),
      characterProfile,
      characterProfileRevision,
      characterStrategy: selection.strategy,
      storyLengthProfile,
      turnControlStyle,
      legacySettings: Object.freeze(settings)
    }),
    initialState,
    currentState,
    turns: Object.freeze(turns),
    continuitySeed,
    provenance,
    warnings: Object.freeze(warnings),
    stats: Object.freeze({
      turnCount: turns.length,
      completeHistoryCharacters,
      estimatedHistoryTokens,
      importedSummary: continuitySeed !== null,
      summaryThroughTurn: continuitySeed?.throughTurn ?? 0,
      sanitizedMemoryCount,
      preservedTurnStateCount: turns.length,
      warningCount: warnings.length
    })
  });
}
