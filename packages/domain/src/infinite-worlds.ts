import type { LegacyStory } from "../../contracts/src/imports.js";
import {
  canonicalizeWorldContent,
  WORLD_CONTENT_SCHEMA_VERSION,
  type PlayableCharacter,
  type WorldContent
} from "../../contracts/src/world-library.js";
import { stripMechanicsLeakage } from "./text.js";
import { campaignCharacterSeed, characterLegacyText, characterSnapshot } from "./world-characters.js";

type JsonObject = Record<string, unknown>;

export type InfiniteWorldsCharacter = JsonObject & {
  name?: unknown;
  description?: unknown;
  skills?: unknown;
  initialTrackedItemValues?: unknown;
};

export type InfiniteWorldsStoryTurn = {
  turnNumber: number;
  action: string;
  outcome: string;
  choices: string[];
  imagePrompt: string;
  hasExplicitOutcome: boolean;
};

export type InfiniteWorldsStory = {
  storyBackground: string;
  characterText: string;
  turns: InfiniteWorldsStoryTurn[];
  diagnostics: string[];
};

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
}

function sections(...values: Array<string | undefined>): string {
  return values.map((value) => String(value ?? "").trim()).filter(Boolean).join("\n\n");
}

function titled(title: string, value: unknown): string {
  const body = text(value);
  return body ? `${title}\n${body}` : "";
}

function compact(value: unknown): string {
  try { return JSON.stringify(value, null, 2); } catch { return text(value); }
}

export function isInfiniteWorldsWorld(value: unknown): value is JsonObject {
  const source = object(value);
  return Array.isArray(source.possibleCharacters)
    || (Array.isArray(source.triggerEvents) && ("background" in source || "instructions" in source || "firstInput" in source))
    || (("schemaVersion" in source || "autoAdvanceVersion" in source) && ("background" in source || "instructions" in source || "objective" in source));
}

export function infiniteWorldsCharacters(value: unknown): InfiniteWorldsCharacter[] {
  const source = object(value);
  return Array.isArray(source.possibleCharacters)
    ? source.possibleCharacters.map(object).filter((character) => Object.keys(character).length) as InfiniteWorldsCharacter[]
    : [];
}

function skillPercent(value: unknown): number {
  const score = Number(value);
  if (!Number.isFinite(score)) return 50;
  if (score <= 1) return 20;
  if (score === 2) return 40;
  if (score === 3) return 60;
  if (score === 4) return 80;
  return 99;
}

function identifier(prefix: string, value: string, index: number): string {
  const slug = value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  return `${prefix}-${index + 1}${slug ? `-${slug}` : ""}`;
}

function rpgStats(skills: unknown, characterName: string): JsonObject[] {
  const entries: Array<[string, unknown]> = [];
  if (Array.isArray(skills)) {
    for (const item of skills) {
      if (typeof item === "string") entries.push([item, 3]);
      else {
        const row = object(item);
        entries.push([text(row.name ?? row.skill ?? row.stat) || "Skill", row.value ?? row.score ?? row.rating ?? 3]);
      }
    }
  } else {
    for (const [name, value] of Object.entries(object(skills))) entries.push([name, value]);
  }
  return entries.filter(([name]) => name.trim()).map(([name, value], index) => ({
    id: identifier("iw-stat", name, index),
    name: name.trim(),
    value: skillPercent(value),
    note: `Imported from Infinite Worlds${characterName ? ` for ${characterName}` : ""}. Original 1–5 rating: ${text(value) || "unknown"}.`
  }));
}

function trackers(items: unknown, ownerName: string): JsonObject[] {
  return (Array.isArray(items) ? items : []).map((item, index) => {
    if (typeof item === "string") return { id: identifier("iw-tracker", item, index), name: item, rules: `Track this item${ownerName ? ` for ${ownerName}` : ""} whenever it changes.`, value: item };
    const row = object(item);
    const name = text(row.name ?? row.title ?? row.label ?? row.item ?? row.key) || `Tracked Item ${index + 1}`;
    const description = text(row.description ?? row.details ?? row.context ?? row.prompt ?? row.rules);
    return {
      id: identifier("iw-tracker", name, index),
      name,
      rules: text(row.updateRules ?? row.update_rules ?? row.whenToUpdate ?? row.when_to_update ?? row.rules) || description || `Track this item${ownerName ? ` for ${ownerName}` : ""} whenever it changes.`,
      value: text(row.value ?? row.initialValue ?? row.initial_value ?? row.currentValue ?? row.current_value ?? row.startingValue ?? row.starting_value) || description || "Not yet established."
    };
  });
}

function eventTriggers(events: unknown): JsonObject[] {
  return (Array.isArray(events) ? events : []).map((item, index) => {
    const event = object(item);
    const name = text(event.name ?? event.title) || `Infinite Worlds Trigger ${index + 1}`;
    const conditions = Array.isArray(event.triggerConditions) ? event.triggerConditions.map((condition) => {
      const row = object(condition);
      return typeof condition === "string" ? condition : text(row.text ?? row.condition ?? row.data) || compact(condition);
    }).filter(Boolean) : [];
    const effects = Array.isArray(event.triggerEffects) ? event.triggerEffects.map((effect) => {
      const row = object(effect);
      return typeof effect === "string" ? effect : text(row.data ?? row.text ?? row.effect ?? row.instructions) || compact(effect);
    }).filter(Boolean) : [];
    return {
      id: identifier("iw-trigger", name, index),
      label: name,
      timing: "before",
      condition: `${name}: ${event.triggerOnStartOfGame ? "At the start of the adventure. " : ""}${conditions.join("\n") || `When the “${name}” trigger should fire.`}`.trim(),
      effect: effects.join("\n\n") || text(event.effect ?? event.instructions ?? event.data) || compact(event),
      addTextAfter: false,
      triggeredCount: 0,
      lastTriggeredTurn: null,
      lastTriggeredAt: null
    };
  }).filter((trigger) => text(trigger.effect));
}

function conditionTrigger(value: unknown, label: string, id: string): JsonObject | null {
  if (!value) return null;
  const row = object(value);
  const condition = typeof value === "string" ? value : text(row.condition ?? row.when ?? row.text ?? row.name) || compact(value);
  const effect = typeof value === "string" ? `Resolve the ${label.toLowerCase()} according to the imported source.` : text(row.effect ?? row.result ?? row.outcome ?? row.data ?? row.text);
  return { id, label, timing: "after", condition: `${label}: ${condition}`, effect: effect || `Resolve the ${label.toLowerCase()} according to the imported source.`, addTextAfter: true, triggeredCount: 0, lastTriggeredTurn: null, lastTriggeredAt: null };
}

function inferGenre(source: JsonObject): string {
  const material = sections(text(source.title), text(source.background), text(source.instructions), text(source.objective)).toLowerCase();
  const values: string[] = [];
  if (/\b(software|computer|interface|program|reality)\b/.test(material)) values.push("contemporary science fiction");
  if (/\b(magic|wizard|spell|fantasy)\b/.test(material)) values.push("fantasy");
  if (/\b(murder|mystery|detective|investigat)/.test(material)) values.push("mystery");
  if (/\b(cyberpunk|megacorp|hacker|neon)\b/.test(material)) values.push("cyberpunk");
  if (/\b(zombie|undead|outbreak)\b/.test(material)) values.push("survival horror");
  return [...new Set(values)].join(", ") || "Imported Infinite Worlds adventure";
}

function playableCharacter(character: InfiniteWorldsCharacter, index: number): PlayableCharacter {
  const name = text(character.name) || `Character ${index + 1}`;
  return {
    id: identifier("iw-character", name, index),
    name,
    characterText: sections(name, text(character.description), Array.isArray(character.initialTrackedItemValues) ? titled("Initial tracked item values", compact(character.initialTrackedItemValues)) : ""),
    rpgStats: rpgStats(character.skills, name),
    defaultTriggers: trackers(character.initialTrackedItemValues, name),
    source: { type: "infinite-worlds-json", index }
  };
}

export function convertInfiniteWorldsWorld(value: unknown): { format: "infinite-quest-world"; formatVersion: 1; title: string; content: WorldContent } {
  if (!isInfiniteWorldsWorld(value)) throw new Error("The JSON does not look like an Infinite Worlds world export.");
  const source = object(value);
  const characters = infiniteWorldsCharacters(source);
  if (!characters.length) {
    throw Object.assign(
      new Error("The Infinite Worlds world export has no playable characters. Add at least one possible character before importing it."),
      { statusCode: 400 }
    );
  }
  const playableCharacters = characters.map(playableCharacter);
  const defaultCharacter = playableCharacters[0];
  const title = text(source.title ?? source.name) || "Imported Infinite Worlds Adventure";
  const defaultTriggers: JsonObject[] = text(source.summaryRequest) ? [{ name: "Continuity / source summary request", rules: "Update whenever source-important continuity changes occur.", value: text(source.summaryRequest) }] : [];
  const triggers = eventTriggers(source.triggerEvents);
  const victory = conditionTrigger(source.victoryCondition, "Victory condition", "iw-victory-condition");
  const defeat = conditionTrigger(source.defeatCondition, "Defeat condition", "iw-defeat-condition");
  if (victory) triggers.push(victory);
  if (defeat) triggers.push(defeat);
  const instructionBlocks = Array.isArray(source.instructionBlocks)
    ? source.instructionBlocks.map((item, index) => { const row = object(item); return titled(text(row.name) || `Instruction Block ${index + 1}`, row.content ?? row.text ?? row.instructions); }).filter(Boolean).join("\n\n")
    : "";
  const content = canonicalizeWorldContent({
    schemaVersion: WORLD_CONTENT_SCHEMA_VERSION,
    world: {
      title,
      genre: inferGenre(source),
      tone: text(source.authorStyle) || "Interactive fiction adapted from Infinite Worlds",
      backgroundStory: text(source.background),
      premise: sections(titled("Description", source.description), titled("Objective", source.objective)),
      firstAction: text(source.firstInput),
      rules: sections(titled("Main Infinite Worlds instructions", source.instructions), titled("Summary request", source.summaryRequest), instructionBlocks)
    },
    playableCharacters,
    entities: [],
    relationships: [],
    rpgStats: [],
    defaultTriggers,
    eventTriggers: triggers,
    assets: [],
    defaults: {
      importedFrom: "infinite-worlds-json",
      defaultPlayableCharacterId: defaultCharacter?.id || "",
      useRpgStats: playableCharacters.some((character) => character.rpgStats.length > 0)
    }
  });
  return { format: "infinite-quest-world", formatVersion: 1, title, content };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function topLevelSection(source: string, heading: string): string {
  const startPattern = new RegExp(`--\\s*${escapeRegExp(heading)}\\s*--`, "i");
  const match = startPattern.exec(source);
  if (!match) return "";
  const rest = source.slice(match.index + match[0].length);
  const end = rest.search(/\n\s*--\s*(?:Character|Turn\s+\d+|Story Background)\s*--/i);
  return (end >= 0 ? rest.slice(0, end) : rest).trim();
}

function subsection(block: string, heading: string): string {
  const marker = new RegExp(`(^|\\n)\\s*${escapeRegExp(heading)}\\s*\\n\\s*-{2,}\\s*\\n`, "i");
  const match = marker.exec(block);
  if (!match) return "";
  const rest = block.slice(match.index + match[0].length);
  const end = rest.search(/\n\s*(?:Action|Outcome|Choices?|Options?|Possible Actions?|Image Prompt)\s*\n\s*-{2,}\s*\n/i);
  return (end >= 0 ? rest.slice(0, end) : rest).trim();
}

function choiceList(value: string): string[] {
  const source = value.trim();
  if (!source) return [];
  if (source.startsWith("[")) {
    try {
      const parsed = JSON.parse(source) as unknown;
      if (Array.isArray(parsed)) return [...new Set(parsed.map(text).filter(Boolean))].slice(0, 4);
    } catch { /* use line format */ }
  }
  return [...new Set(source.split(/\n+/).map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter(Boolean))].slice(0, 4);
}

export function parseInfiniteWorldsStory(value: string): InfiniteWorldsStory {
  const source = String(value ?? "").replace(/\r\n?/g, "\n");
  const turns: InfiniteWorldsStoryTurn[] = [];
  const expression = /--\s*Turn\s+(\d+)\s*--([\s\S]*?)(?=\n\s*--\s*Turn\s+\d+\s*--|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(source))) {
    const block = match[2] ?? "";
    const explicitOutcome = subsection(block, "Outcome");
    const action = subsection(block, "Action");
    const outcome = explicitOutcome || block.trim();
    if (!outcome && !action) continue;
    const choicesText = ["Choices", "Choice", "Options", "Option", "Possible Actions"].map((heading) => subsection(block, heading)).find(Boolean) || "";
    turns.push({
      turnNumber: Number(match[1]) || turns.length + 1,
      action,
      outcome,
      choices: choiceList(choicesText),
      imagePrompt: subsection(block, "Image Prompt"),
      hasExplicitOutcome: Boolean(explicitOutcome)
    });
  }
  const diagnostics: string[] = [];
  const numbers = turns.map((turn) => turn.turnNumber);
  if (new Set(numbers).size !== numbers.length) diagnostics.push("The source contains duplicate turn numbers.");
  if (turns.some((turn) => !turn.hasExplicitOutcome)) diagnostics.push("One or more turns did not have an explicit Outcome section; their complete turn block was retained.");
  if (turns.slice(1).some((turn) => !turn.action)) diagnostics.push("One or more later turns did not include a selected Action.");
  return { storyBackground: topLevelSection(source, "Story Background"), characterText: topLevelSection(source, "Character"), turns, diagnostics };
}

export function infiniteWorldsStoryToLegacyStory(parsed: InfiniteWorldsStory, worldContent: WorldContent, sourceName: string, selectedCharacterId?: string): LegacyStory {
  if (!parsed.turns.length) throw new Error("No '-- Turn N --' sections were found in the Infinite Worlds story text.");
  const seed = campaignCharacterSeed(worldContent, selectedCharacterId);
  const overview = {
    ...worldContent.world,
    character: characterLegacyText(null, characterSnapshot(seed.character)) || seed.character.name
  };
  const turns = parsed.turns.map((turn, index) => ({
    turnNumber: index + 1,
    action: stripMechanicsLeakage(turn.action || (index === 0 ? overview.firstAction || "Imported opening scene" : "Continue.")).text,
    narration: stripMechanicsLeakage(turn.outcome).text,
    choices: (turn.choices.length ? turn.choices : parsed.turns[index + 1]?.action ? [parsed.turns[index + 1]!.action] : []).map((choice) => stripMechanicsLeakage(choice).text).filter(Boolean),
    imagePrompt: stripMechanicsLeakage(turn.imagePrompt).text,
    importedFrom: { source: "Infinite Worlds", sourceFileName: sourceName, sourceTurnNumber: turn.turnNumber },
    createdAt: new Date().toISOString()
  }));
  return {
    world: overview,
    turns,
    rpgStats: seed.rpgStats,
    defaultTriggers: seed.defaultTriggers,
    eventTriggers: worldContent.eventTriggers,
    scratchpad: "",
    fullHistory: turns.map((turn) => `Turn ${turn.turnNumber}\nAction: ${turn.action}\n${turn.narration}`).join("\n\n"),
    fullHistoryCompressedThroughTurn: turns.length,
    storyImportProvenance: { sourceType: "infinite_worlds_story_txt", sourceName, diagnostics: parsed.diagnostics, selectedCharacterId: seed.character.id, selectedCharacterName: seed.character.name }
  };
}
