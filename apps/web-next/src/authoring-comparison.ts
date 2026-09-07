/** Show differing authored fields with both values, without transport metadata. */
export function renderAuthoringComparison(document: Document, local: unknown, remote: unknown, labels = ["Local draft", "Server review"]): HTMLElement[] {
  const fields = (value: unknown, path: string[] = [], result = new Map<string, string>()): Map<string, string> => {
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (["id", "schemaVersion", "source"].includes(key)) continue;
        fields(child, [...path, /^\d+$/.test(key) ? String(Number(key) + 1) : key.replace(/([a-z])([A-Z])/g, "$1 $2")], result);
      }
    } else result.set(path.join(" / "), value === undefined ? "Not present" : value === "" ? "Empty" : String(value));
    return result;
  };
  const left = fields(local); const right = fields(remote);
  const changed = [...new Set([...left.keys(), ...right.keys()])].filter(key => left.get(key) !== right.get(key));
  return [left, right].map((values, index) => {
    const section = document.createElement("section");
    section.dataset[index === 0 ? "authoringCompareLocal" : "authoringCompareRemote"] = "";
    const heading = document.createElement("h4"); heading.textContent = labels[index]!;
    const list = document.createElement("dl"); list.className = "authoring-comparison-fields";
    for (const key of changed) {
      const label = document.createElement("dt"); label.textContent = key.charAt(0).toUpperCase() + key.slice(1);
      const value = document.createElement("dd"); value.textContent = values.get(key) ?? "Not present";
      list.append(label, value);
    }
    if (changed.length === 0) { const message = document.createElement("p"); message.textContent = "The authored fields match."; section.append(heading, message); }
    else section.append(heading, list);
    return section;
  });
}
