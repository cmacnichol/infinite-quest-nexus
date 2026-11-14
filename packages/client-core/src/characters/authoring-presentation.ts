import type { PlayableCharacter } from "@infinite-quest/contracts";
import type { CharacterEditorContext, EditorValue } from "./editor-model.js";
import { PROFILE_FIELDS, SUPPORTING_FIELDS, type ProfileFieldDescriptor } from "./profile-fields.js";
export type EditorSectionId = "overview" | "identity" | "personality" | "appearance" | "situation" | "notes" | "mechanics" | "sources";
export type EditorSectionSummary = { id: EditorSectionId; label: string; paths?: string[]; populated: number; errors: number; hasErrors?: boolean; detail: string };
const labels: Record<EditorSectionId, string> = { overview: "Overview", identity: "Identity", personality: "Personality and voice", appearance: "Appearance", situation: "Current situation", notes: "History and notes", mechanics: "Mechanics", sources: "Sources and history" };
const sectionIds: Record<string, EditorSectionId> = { Identity: "identity", "Personality and voice": "personality", Appearance: "appearance", "Current situation": "situation", History: "notes", Mechanics: "mechanics" };
const overview = new Set(["name", "story.role", "story.personality", "story.background"]);
function fields(context: CharacterEditorContext): readonly ProfileFieldDescriptor[] {
  if (context === "campaign-supporting") return [PROFILE_FIELDS[0]!, PROFILE_FIELDS[1]!, ...SUPPORTING_FIELDS];
  if (context === "campaign-preset") return [...PROFILE_FIELDS, ...SUPPORTING_FIELDS.filter(field => field.path.startsWith("state.") || field.path === "appearance.description")];
  return PROFILE_FIELDS;
}
export function editorSectionForPath(path: string, context: CharacterEditorContext): EditorSectionId | undefined {
  const field = fields(context).find(field => field.path === path);
  return field ? overview.has(path) ? "overview" : sectionIds[field.section] : undefined;
}
export function sectionsForContext(context: CharacterEditorContext): EditorSectionId[] {
  const available = new Set(fields(context).map(field => editorSectionForPath(field.path, context)));
  if (context === "world-draft") available.add("mechanics");
  return (Object.keys(labels) as EditorSectionId[]).filter(id => available.has(id));
}
export function summarizeEditorSections(context: CharacterEditorContext, values: Record<string, EditorValue>, errorPaths: readonly string[], mechanics?: { statistics: number; trackers: number }): EditorSectionSummary[] {
  return sectionsForContext(context).map(id => {
    const paths = fields(context).filter(field => editorSectionForPath(field.path, context) === id).map(field => field.path);
    const populated = paths.filter(path => Array.isArray(values[path]) ? (values[path] as string[]).some(value => value.trim()) : String(values[path] ?? "").trim()).length;
    const errors = errorPaths.filter(path => paths.includes(path) || id === "mechanics" && /^(rpgStats|defaultTriggers)(\.|\[|$)/.test(path)).length;
    const hasErrors = errors > 0;
    const detail = id === "mechanics" ? `${mechanics?.statistics ?? 0} statistics, ${mechanics?.trackers ?? 0} trackers` : populated ? `${populated} ${populated === 1 ? "detail" : "details"}` : "Not added";
    return { id, label: labels[id], paths, populated, errors, hasErrors, detail };
  });
}
export function worldCharacterSummary(character: PlayableCharacter): string {
  const summary = [character.profile?.story?.personality, character.profile?.story?.background, character.characterText].find(value => value?.trim())?.trim() ?? "";
  const points = Array.from(summary);
  return points.length > 160 ? points.slice(0, 160).join("") + "…" : summary;
}
export function filterWorldCharacters(characters: readonly PlayableCharacter[], options: { query: string; use: "all" | "playable" | "supporting" | "both" }): PlayableCharacter[] {
  const query = options.query.trim().toLocaleLowerCase();
  return characters.filter(character => (options.use === "all" || (character.campaignUse ?? "playable") === options.use)
    && (!query || [character.name, ...(character.profile?.identity?.aliases ?? []), character.profile?.story?.role ?? ""].some(value => value.toLocaleLowerCase().includes(query))));
}
