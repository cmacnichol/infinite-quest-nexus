import { DEFAULT_READER_PREFERENCES, readerPreferencesSchema, type ReaderPreferences } from "@infinite-quest/contracts";

const choices = {
  areaWidth: ["Reading area", ["standard", "wide", "full"]],
  widthCh: ["Text column width", [60, 72, 84, "full"]],
  fontSizePx: ["Text size (pixels)", [16, 18, 20, 22]],
  lineHeight: ["Line spacing", [1.5, 1.7, 1.9]],
  theme: ["Reader theme", ["dark", "light", "sepia"]],
  fontFamily: ["Reader font", ["sans", "serif"]],
  paragraphSpacingEm: ["Paragraph spacing (em)", [0.5, 1, 1.5]]
} as const;

export function mountReaderPreferenceFields(document: Document) {
  const element = document.createElement("details");
  element.className = "reader-profile-fields";
  const summary = document.createElement("summary");
  summary.textContent = "Reading appearance";
  element.append(summary);
  const selects = new Map<keyof ReaderPreferences, HTMLSelectElement>();
  for (const key of Object.keys(choices) as (keyof ReaderPreferences)[]) {
    const [name, values] = choices[key];
    const label = document.createElement("label");
    label.textContent = name;
    const select = document.createElement("select");
    select.dataset.readerPreference = key;
    select.setAttribute("aria-label", name);
    for (const value of values) {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = typeof value === "string" ? value[0]!.toUpperCase() + value.slice(1) : String(value);
      select.append(option);
    }
    label.append(select); element.append(label); selects.set(key, select);
  }
  function set(value: ReaderPreferences = DEFAULT_READER_PREFERENCES) {
    for (const [key, select] of selects) {
      for (const option of Array.from(select.querySelectorAll("option"))) option.selected = option.value === String(value[key]);
    }
  }
  set();
  return {element, set, get(): ReaderPreferences {
    const values = Object.fromEntries([...selects].map(([key, select]) => [key, [...choices[key][1]].find(entry => String(entry) === select.value) ?? DEFAULT_READER_PREFERENCES[key]]));
    return readerPreferencesSchema.parse(values);
  }};
}
