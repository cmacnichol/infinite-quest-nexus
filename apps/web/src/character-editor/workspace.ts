import type { EditorSectionId, EditorSectionSummary } from "@infinite-quest/client-core";
export type { EditorSectionId, EditorSectionSummary };
export type EditorPresentationSnapshot = {
  name: string; destination: string; status: string;
  dirty: boolean; busy: boolean; locked: boolean; readOnly: boolean;
  sections: EditorSectionSummary[];
};
export type EditorCommitResult = "applied" | "saved" | "blocked";
export type EditorPresentationPort = {
  snapshot(): EditorPresentationSnapshot;
  flush(): void;
  commit(): Promise<EditorCommitResult>;
  requestClose(): Promise<boolean>;
};
/** Presentation only. The adapter owns drafts, validation, writes and leave decisions. */
export function mountCharacterWorkspace(host: HTMLElement, port: EditorPresentationPort, content: {
  sections: Map<EditorSectionId, HTMLElement>; preview(): HTMLElement;
}): { refresh(): void; reveal(section: EditorSectionId, control?: HTMLElement): void; dispose(): void } {
  const document = host.ownerDocument;
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const root = document.createElement("section"); root.className = "character-workspace";
  root.setAttribute("aria-label", "Character editor");
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "") => {
    const node = document.createElement(tag); node.className = className; return node;
  };
  const button = (text: string, action: () => void, primary = false) => {
    const node = make("button", `button ${primary ? "primary" : "secondary"}`); node.type = "button"; node.textContent = text;
    node.addEventListener("click", action); return node;
  };
  let disposed = false, closing = false, committing = false, previewing = false;
  let current: EditorSectionId = content.sections.keys().next().value ?? "overview";
  let previewFocus: HTMLElement | null = null;
  let commitError = "";
  const header = make("header", "character-workspace-header");
  const identity = make("div"), title = make("h2"), destination = make("p");
  identity.append(title, destination);
  const close = async () => {
    if (closing || committing || port.snapshot().busy) return;
    port.flush(); closing = true;
    try { await port.requestClose(); } finally { closing = false; }
  };
  header.append(button("Back", () => void close()), identity);
  const layout = make("div", "character-workspace-layout"), nav = make("nav", "character-workspace-rail"); nav.setAttribute("aria-label", "Character sections");
  const narrow = make("div", "character-workspace-narrow"), label = make("label"), selector = make("select"); label.append("Section", selector); selector.setAttribute("aria-label", "Section");
  selector.addEventListener("change", () => reveal(selector.value as EditorSectionId));
  const adjacent = (direction: number) => {
    const ids = port.snapshot().sections.filter(section => content.sections.has(section.id)).map(section => section.id);
    const id = ids[ids.indexOf(current) + direction]; if (id) reveal(id);
  };
  const previous = button("Previous section", () => adjacent(-1)), next = button("Next section", () => adjacent(1));
  narrow.append(label, previous, next);
  const working = make("div", "character-workspace-working"), heading = make("h3"), detail = make("p"), fields = make("fieldset", "character-workspace-fields"), preview = make("div", "character-workspace-preview"); heading.tabIndex = -1;
  const edit = button("Return to editing", () => { previewing = false; refresh(); previewFocus?.focus(); });
  preview.hidden = true; working.append(heading, detail, fields, preview, edit);
  // Move original nodes exactly once: adapters retain their controls, IDs and listeners.
  const origins = new Map<HTMLElement, Comment>();
  const originalHidden = new Map<HTMLElement, HTMLElement["hidden"]>();
  for (const node of content.sections.values()) {
    originalHidden.set(node, node.hidden);
    if (node.parentNode) {
      const marker = document.createComment("character-workspace-section"); node.before(marker); origins.set(node, marker);
    }
    fields.append(node);
  }
  layout.append(nav, working);
  const footer = make("footer", "character-workspace-footer"), status = make("p"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const previewButton = button("Preview sheet", () => {
    port.flush(); previewFocus = document.activeElement as HTMLElement; previewing = true;
    // The adapter returns safe DOM (textContent for all untrusted values), never HTML strings.
    preview.replaceChildren(content.preview()); refresh(); heading.focus();
  });
  const commit = button("Save character", () => void (async () => {
    if (commit.disabled || committing) return;
    port.flush(); committing = true; commitError = ""; refresh();
    try {
      const result = await port.commit();
      if (result === "blocked" && !disposed) {
        // Restore enabled controls before native validation matching and focus.
        committing = false; refresh();
        const section = port.snapshot().sections.find(section => section.errors > 0 && content.sections.has(section.id));
        if (section) reveal(section.id, content.sections.get(section.id)?.querySelector<HTMLElement>('[aria-invalid="true"], :invalid') ?? undefined);
      }
    } catch { commitError = "Save failed; your changes are kept"; }
    finally { committing = false; if (!disposed) refresh(); }
  })(), true);
  footer.append(status, previewButton, button("Cancel", () => void close()), commit);
  root.append(header, narrow, layout, footer); host.append(root);
  const dialog = host.closest("dialog"); dialog?.classList.add("character-workspace-dialog");
  function refresh() {
    if (disposed) return;
    const state = port.snapshot();
    const summaries = state.sections.filter(section => content.sections.has(section.id));
    if (!summaries.some(section => section.id === current) && summaries[0]) current = summaries[0].id;
    title.textContent = state.name.trim() || "New character"; destination.textContent = state.destination;
    const announcement = commitError || state.status;
    if (status.textContent !== announcement) status.textContent = announcement;
    nav.replaceChildren(); selector.replaceChildren();
    for (const section of summaries) {
      const text = `${section.label} · ${section.detail}${section.errors ? ` · ${section.errors} ${section.errors === 1 ? "error" : "errors"}` : ""}`;
      const item = button(text, () => reveal(section.id));
      if (section.id === current) item.setAttribute("aria-current", "true"); nav.append(item);
      const option = make("option"); option.value = section.id; option.textContent = text; selector.append(option);
    }
    selector.value = current;
    previous.disabled = summaries[0]?.id === current; next.disabled = summaries.at(-1)?.id === current;
    const selected = summaries.find(section => section.id === current);
    heading.textContent = previewing ? "Preview sheet" : selected?.label ?? "Character";
    detail.textContent = previewing ? "Local draft preview" : selected?.detail ?? "";
    for (const [id, node] of content.sections) node.hidden = previewing || id !== current;
    fields.hidden = previewing; preview.hidden = !previewing; edit.hidden = !previewing; previewButton.hidden = previewing;
    const locked = state.busy || state.locked || state.readOnly || committing;
    // Shell locks are inherited through one native fieldset. Adapters retain each
    // control's own disabled policy, including capability rules changed during AI work.
    fields.disabled = locked;
    commit.disabled = locked || !state.dirty && !/^World draft:/i.test(state.destination);
    commit.textContent = committing || state.busy ? "Saving…" : state.destination === "World draft: cast suggestion" ? "Apply to suggestion" : /^World draft:/i.test(state.destination) ? "Apply to world draft" : "Save character";
  }
  function reveal(section: EditorSectionId, control?: HTMLElement) {
    if (!content.sections.has(section)) return;
    port.flush(); current = section; previewing = false; refresh();
    if (control && content.sections.get(section)?.contains(control)) {
      for (let ancestor = control.parentElement; ancestor && ancestor !== fields; ancestor = ancestor.parentElement) {
        if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
      }
      control.focus(); control.scrollIntoView({ block: "nearest" });
    } else { working.scrollTop = 0; heading.focus(); }
  }
  const cancel = (event: Event) => { event.preventDefault(); void close(); };
  dialog?.addEventListener("cancel", cancel);
  const input = (event: Event) => { if (event.target instanceof Node && fields.contains(event.target)) refresh(); }; root.addEventListener("input", input);
  const viewport = document.defaultView?.visualViewport;
  const resize = () => { root.style.maxHeight = viewport ? `${viewport.height}px` : ""; };
  viewport?.addEventListener("resize", resize); resize();
  refresh(); heading.focus();
  return { refresh, reveal, dispose() {
    disposed = true; viewport?.removeEventListener("resize", resize); dialog?.removeEventListener("cancel", cancel); dialog?.classList.remove("character-workspace-dialog");
    for (const [node, hidden] of originalHidden) node.hidden = hidden;
    for (const [node, marker] of origins) marker.replaceWith(node);
    root.remove(); if (returnFocus?.isConnected) returnFocus.focus();
  } };
}

