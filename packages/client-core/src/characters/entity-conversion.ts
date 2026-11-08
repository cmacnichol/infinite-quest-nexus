import { characterProfileSchema } from "@infinite-quest/contracts";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
const strings = (value: unknown): string[] => typeof value === "string" ? (value.trim() ? [value.trim()] : [])
  : Array.isArray(value) ? value.flatMap(strings) : [];
const first = (row: RecordValue, keys: string[]) => keys.flatMap((key) => strings(row[key]))[0] ?? "";

/** Local preview; map-shaped historical data is accepted here only. */
export function previewEntityConversions(entities: unknown) {
  const rows = Array.isArray(entities) ? entities : Object.entries(record(entities) ?? {}).map(([key, value]) => ({ key, ...record(value) }));
  return rows.flatMap((value) => {
    const row = record(value);
    if (!row || row.linkedCharacterId || !/^(character|person|npc)$/iu.test(first(row, ["kind", "type", "category"]))) return [];
    const entityId = first(row, ["id", "key"]);
    const name = first(row, ["name", "title", "label"]);
    if (!entityId || !name) return [];
    const aliases = [...new Set([...strings(row.aliases), ...strings(row.alias)].map((value) => value.slice(0, 200)))].slice(0, 20);
    const notes = ["description", "summary", "details", "notes"].flatMap((key) => strings(row[key])).join("\n\n").slice(0, 200_000);
    const profile = characterProfileSchema.parse({ identity: { aliases }, story: {
      role: first(row, ["role"]).slice(0, 20_000), background: ["background", "lore"].flatMap((key) => strings(row[key])).join("\n\n").slice(0, 20_000)
    }, unclassifiedNotes: notes });
    const used = new Set(["id", "key", "kind", "type", "category", "name", "title", "label", "aliases", "alias", "role", "background", "lore", "description", "summary", "details", "notes", "linkedCharacterId"]);
    const unconverted = Object.fromEntries(Object.entries(row).filter(([key]) => !used.has(key)));
    for (const key of ["description", "summary", "details", "notes", "background", "lore", "role", "aliases", "alias"]) {
      const limit = ["description", "summary", "details", "notes"].includes(key) ? 200_000 : key === "aliases" || key === "alias" ? 200 : 20_000;
      if (strings(row[key]).some((value) => value.length > limit)) unconverted[`${key} (original)`] = row[key];
    }
    if (["description", "summary", "details", "notes"].flatMap((key) => strings(row[key])).join("\n\n").length > 200_000)
      unconverted["notes (original)"] = [row.description, row.summary, row.details, row.notes];
    if (["background", "lore"].flatMap((key) => strings(row[key])).join("\n\n").length > 20_000)
      unconverted["background (original)"] = [row.background, row.lore];
    if (strings(row.aliases).length + strings(row.alias).length > 20) unconverted["aliases (original)"] = [row.aliases, row.alias];
    return [{ entityId, name, profile, characterText: notes, unconverted }];
  });
}
