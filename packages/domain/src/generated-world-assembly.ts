import type { AuthoringWorldOutline } from "../../contracts/src/authoring.js";
import { canonicalizeWorldContent, type WorldContent } from "../../contracts/src/world-library.js";
import { WORLD_AUTHORING_PROMPT_PROTOCOL_VERSION } from "./authoring-prompts.js";

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

/** Shared storage assembly for validated world fields and any completed character subset.
 * Complete synchronous generation applies its stricter roster gate after this boundary.
 */
export function assembleGeneratedWorldContent(options: Readonly<{
  outline: AuthoringWorldOutline;
  playableCharacters: readonly WorldContent["playableCharacters"][number][];
  importedFrom: string;
}>): WorldContent {
  return canonicalizeWorldContent({
    world: {
      title: options.outline.title,
      genre: options.outline.genre,
      tone: options.outline.tone,
      backgroundStory: options.outline.backgroundStory,
      premise: options.outline.premise,
      firstAction: options.outline.firstAction,
      rules: options.outline.rules
    },
    playableCharacters: options.playableCharacters,
    entities: [], relationships: [],
    rpgStats: applicationOwnedRpgStats(options.outline.rpgStats, "world-wide"),
    defaultTriggers: applicationOwnedDefaultTriggers(options.outline.defaultTriggers, "world-wide"),
    eventTriggers: applicationOwnedEventTriggers(options.outline.eventTriggers, "generated-world"),
    assets: [],
    defaults: {
      importedFrom: options.importedFrom,
      defaultPlayableCharacterId: options.playableCharacters[0]?.id || "",
      authoringPromptProtocolVersion: WORLD_AUTHORING_PROMPT_PROTOCOL_VERSION
    }
  });
}
