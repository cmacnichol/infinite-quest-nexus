import { playableCharacterSchema, type PlayableCharacter } from "@infinite-quest/contracts";
import { createEditorDraft, projectEditorProfile, WORLD_PROFILE_FIELDS, type CharacterEditorDraft } from "@infinite-quest/client-core";
export type WorldMechanicRow = { rowId: string; name: string; value: string; note?: string; rules?: string; original: unknown };
export type WorldFormCapture = {
  profileDraft: CharacterEditorDraft; name: string; guidance: string;
  campaignUse: "playable" | "supporting" | "both"; startingCastDefault: boolean; alwaysInContext: boolean;
  statRows: WorldMechanicRow[]; trackerRows: WorldMechanicRow[];
};
function copy<T>(value: T): T {
  if (Array.isArray(value)) return value.map(copy) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)])) as T;
  return value;
}
const newId = (): string => (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto.randomUUID();
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function rowValues(kind: "stat" | "tracker", original: unknown) {
  const row = object(original);
  return kind === "stat"
    ? { name: String(row.name ?? row.skill ?? row.stat ?? ""), value: String(row.value ?? row.score ?? row.rating ?? ""), note: String(row.note ?? row.covers ?? "") }
    : { name: String(row.name ?? row.label ?? row.title ?? ""), value: String(row.value ?? row.initialValue ?? ""), rules: String(row.rules ?? row.updateRules ?? row.description ?? "") };
}
export function createWorldFormSession(character: PlayableCharacter | null) {
  let baseline = copy(character ?? { id: newId(), name: "", characterText: "", rpgStats: [], defaultTriggers: [], source: { type: "world-library-editor" } }) as PlayableCharacter;
  if (!baseline.id) baseline.id = newId();
  const mechanicIds = new Map<string, string>();
  let undo: { kind: "stat" | "tracker"; row: WorldMechanicRow; index: number } | null = null;
  function initial(record: PlayableCharacter): WorldFormCapture {
    const rows = (kind: "stat" | "tracker", values: unknown[]) => values.map(original => ({ rowId: newId(), ...rowValues(kind, original), original: copy(original) }));
    return { profileDraft: createEditorDraft("world-draft", record), name: record.name, guidance: record.characterText ?? "", campaignUse: record.campaignUse ?? "playable", startingCastDefault: record.startingCastDefault !== false, alwaysInContext: record.alwaysInContext === true, statRows: rows("stat", record.rpgStats ?? []), trackerRows: rows("tracker", record.defaultTriggers ?? []) };
  }
  let state = initial(baseline);
  function projectRows(kind: "stat" | "tracker", rows: WorldMechanicRow[]): unknown[] {
    return rows.flatMap(row => {
      const keys = kind === "stat" ? ["name", "value", "note"] as const : ["name", "value", "rules"] as const;
      const originalValues = rowValues(kind, row.original);
      if (row.original !== null && row.original !== undefined && keys.every(key => row[key] === originalValues[key as keyof typeof originalValues])) return [copy(row.original)];
      const values = Object.fromEntries(keys.map(key => [key, (row[key] ?? "").trim()]));
      if (!Object.values(values).some(Boolean)) return [];
      if (!values.name) throw new Error(`Every ${kind === "stat" ? "statistic" : "tracker"} with content needs a name.`);
      const original = object(row.original);
      if (!mechanicIds.has(row.rowId)) mechanicIds.set(row.rowId, String(original.id || newId()));
      const id = mechanicIds.get(row.rowId)!;
      if (kind === "stat") {
        const value = values.value === "" ? 50 : Number(values.value);
        if (!Number.isInteger(value) || value < 1 || value > 99) throw new Error(`The value for “${values.name}” must be a whole number from 1 to 99.`);
        return [{ ...original, id, name: values.name, value, note: values.note || "" }];
      }
      return [{ ...original, id, name: values.name, value: values.value || "Not yet established.", rules: values.rules || `Track ${values.name} whenever it changes.` }];
    });
  }
  return {
    capture(input: WorldFormCapture): void { state = copy(input); },
    read(): WorldFormCapture { return copy(state); },
    projectForCommit(): PlayableCharacter {
      const profile = projectEditorProfile(state.profileDraft);
      const story = object(profile.story);
      const hasGuidance = WORLD_PROFILE_FIELDS.filter(field => field.path.startsWith("story.")).some(field => {
        const value = story[field.path.slice("story.".length)];
        return Array.isArray(value) ? value.length > 0 : Boolean(String(value ?? "").trim());
      });
      if (state.campaignUse !== "supporting" && !state.guidance.trim() && !hasGuidance) throw new Error("Add at least one story detail, such as a role or background, before saving.");
      const result = { ...baseline, name: state.name.trim(), characterText: state.guidance.trim(), profile, campaignUse: state.campaignUse, startingCastDefault: state.startingCastDefault, alwaysInContext: state.alwaysInContext, rpgStats: projectRows("stat", state.statRows), defaultTriggers: projectRows("tracker", state.trackerRows) };
      // Validate without using the normalized output: untouched imported values remain exact.
      playableCharacterSchema.parse(result);
      return copy(result) as PlayableCharacter;
    },
    removeMechanic(kind: "stat" | "tracker", rowId: string): void {
      const rows = kind === "stat" ? state.statRows : state.trackerRows;
      const index = rows.findIndex(row => row.rowId === rowId);
      if (index < 0) return;
      undo = { kind, index, row: copy(rows[index]!) }; rows.splice(index, 1);
    },
    undoRemoval(): boolean {
      if (!undo) return false;
      const rows = undo.kind === "stat" ? state.statRows : state.trackerRows;
      rows.splice(undo.index, 0, copy(undo.row)); undo = null; return true;
    },
    markApplied(record: PlayableCharacter): void { baseline = copy(record); state = initial(baseline); undo = null; }
  };
}
