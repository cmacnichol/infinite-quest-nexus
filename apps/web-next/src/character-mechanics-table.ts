import { mergeStructuredFields, structuredFieldsFor } from "./world-editor-fields";

export function renderMechanicsTable(host: HTMLElement, options: { kind: "stat" | "trigger"; items: readonly unknown[]; max: number; onChange(items: unknown[]): void }): { dispose(): void } {
  const document = host.ownerDocument;
  const columns = options.kind === "stat" ? [["name", "Name"], ["value", "Value"], ["note", "Note"]] : [["name", "Name"], ["condition", "Condition"], ["effect", "Effect"]];
  const singular = options.kind === "stat" ? "statistic" : "tracker";
  let items = [...options.items];
  let removed: { item: unknown; index: number } | null = null;
  let disposed = false;
  let page = 0;
  const pageSize = 50;
  function render(): void {
    host.replaceChildren();
    const table = document.createElement("table");
    const head = document.createElement("thead");
    const heading = document.createElement("tr");
    for (const [, label] of columns) { const th = document.createElement("th"); th.scope = "col"; th.textContent = label!; heading.append(th); }
    const actions = document.createElement("th"); actions.scope = "col"; actions.textContent = "Actions"; heading.append(actions); head.append(heading); table.append(head);
    const body = document.createElement("tbody");
    items.slice(page * pageSize, (page + 1) * pageSize).forEach((item, offset) => {
      const index = page * pageSize + offset;
      const row = document.createElement("tr");
      const fields = structuredFieldsFor(options.kind, item);
      const remove = document.createElement("button");
      remove.type = "button"; remove.textContent = "Remove";
      const updateRemoveLabel = (name: unknown): void => { remove.setAttribute("aria-label", `Remove ${typeof name === "string" && name.trim() ? name.trim() : `Unnamed ${singular}`}`); };
      updateRemoveLabel(fields.name);
      for (const [key, label] of columns) {
        const cell = document.createElement("td"); cell.dataset.label = label!;
        const control = document.createElement("input"); control.type = "text"; control.value = String(fields[key!] ?? ""); control.setAttribute("aria-label", `${label} for row ${index + 1}`);
        control.addEventListener("input", () => {
          if (disposed) return;
          items[index] = mergeStructuredFields(options.kind, items[index], { [key!]: control.value });
          if (key === "name") updateRemoveLabel(control.value);
          options.onChange([...items]);
        });
        cell.append(control); row.append(cell);
      }
      remove.addEventListener("click", () => { if (disposed) return; removed = { item: items[index], index }; items.splice(index, 1); page = Math.min(page, Math.max(0, Math.ceil(items.length / pageSize) - 1)); options.onChange([...items]); render(); const undo = host.querySelector<HTMLButtonElement>("[data-undo-remove]"); (undo && !undo.disabled ? undo : host.querySelector<HTMLElement>("tbody input, button:not(:disabled)"))?.focus(); });
      const cell = document.createElement("td"); cell.append(remove); row.append(cell); body.append(row);
    });
    table.append(body); host.append(table);
    if (items.length > pageSize) {
      const previous = document.createElement("button"); previous.type = "button"; previous.textContent = "Previous rows"; previous.disabled = page === 0;
      previous.addEventListener("click", () => { if (disposed || page === 0) return; page--; render(); host.querySelector<HTMLInputElement>("tbody input")?.focus(); });
      const next = document.createElement("button"); next.type = "button"; next.textContent = "Next rows"; next.disabled = (page + 1) * pageSize >= items.length;
      next.addEventListener("click", () => { if (disposed || (page + 1) * pageSize >= items.length) return; page++; render(); host.querySelector<HTMLInputElement>("tbody input")?.focus(); });
      const range = document.createElement("span"); range.setAttribute("role", "status"); range.textContent = `Rows ${page * pageSize + 1}–${Math.min((page + 1) * pageSize, items.length)} of ${items.length}`;
      host.append(previous, range, next);
    }
    const add = document.createElement("button"); add.type = "button"; add.textContent = `Add ${singular}`; add.disabled = items.length >= options.max;
    add.addEventListener("click", () => { if (disposed || items.length >= options.max) return; items.push({}); page = Math.floor((items.length - 1) / pageSize); options.onChange([...items]); render(); host.querySelector<HTMLInputElement>(`input[aria-label="Name for row ${items.length}"]`)?.focus(); }); host.append(add);
    if (removed) {
      const undo = document.createElement("button"); undo.type = "button"; undo.textContent = "Undo remove"; undo.dataset.undoRemove = "";
      undo.addEventListener("click", () => { if (disposed || !removed || items.length >= options.max) return; const index = removed.index; items.splice(index, 0, removed.item); page = Math.floor(index / pageSize); removed = null; options.onChange([...items]); render(); host.querySelector<HTMLInputElement>(`input[aria-label="Name for row ${index + 1}"]`)?.focus(); });
      undo.disabled = items.length >= options.max; host.append(undo);
    }
    const describedBy = host.getAttribute("aria-describedby");
    if (describedBy) host.querySelector<HTMLElement>("input, button")?.setAttribute("aria-describedby", describedBy);
  }
  render();
  return { dispose() { disposed = true; host.replaceChildren(); } };
}
