import type { CampaignContinuityDraft } from "@infinite-quest/client-core";

export interface CampaignContinuityEditor {
  readonly element: HTMLElement;
  readDraft(): CampaignContinuityDraft;
  setDisabled(disabled: boolean): void;
  dispose(): void;
}

type RowKind = "thread" | "fact";

function cloneDraft(draft: CampaignContinuityDraft): CampaignContinuityDraft {
  return {
    continuitySummary: draft.continuitySummary,
    scratchpad: draft.scratchpad,
    openThreads: draft.openThreads.map((row) => ({ ...row })),
    canonicalFacts: draft.canonicalFacts.map((row) => ({ ...row }))
  };
}

function labelWithTextarea(
  document: Document,
  label: string,
  value: string,
  dataAttribute: string,
  onInput: (value: string) => void
): HTMLLabelElement {
  const field = document.createElement("label");
  field.className = "campaign-continuity-field";
  const name = document.createElement("span");
  name.textContent = label;
  const textarea = document.createElement("textarea");
  textarea.rows = 5;
  textarea.value = value;
  textarea.dataset[dataAttribute] = "";
  textarea.addEventListener("input", () => onInput(textarea.value));
  field.append(name, textarea);
  return field;
}

export function createCampaignContinuityEditor(
  document: Document,
  initial: CampaignContinuityDraft,
  options: Readonly<{ idPrefix: string; onChange: () => void }>
): CampaignContinuityEditor {
  let draft = cloneDraft(initial);
  let disabled = false;
  let disposed = false;
  let nextThreadKey = draft.openThreads.length;
  let nextFactKey = draft.canonicalFacts.length;
  const element = document.createElement("section");
  element.className = "campaign-continuity-editor";
  element.dataset.continuityEditor = options.idPrefix;

  const notify = () => {
    if (!disposed) options.onChange();
  };
  const controls = () => element.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>("button, textarea");
  const syncDisabled = () => controls().forEach((control) => { control.disabled = disabled; });

  const renderRows = (kind: RowKind) => {
    const list = element.querySelector<HTMLElement>(kind === "thread" ? "[data-thread-rows]" : "[data-fact-rows]");
    if (!list) return;
    list.replaceChildren();
    const rows = kind === "thread" ? draft.openThreads : draft.canonicalFacts;
    rows.forEach((row, index) => {
      const item = document.createElement("div");
      item.className = "campaign-continuity-row";
      const textarea = document.createElement("textarea");
      textarea.rows = 3;
      textarea.value = row.content;
      if (kind === "thread") textarea.dataset.threadContent = "";
      else textarea.dataset.factContent = "";
      textarea.setAttribute("aria-label", kind === "thread" ? `Open thread ${index + 1}` : `Canonical fact ${index + 1}`);
      textarea.addEventListener("input", () => {
        const activeRows = kind === "thread" ? draft.openThreads : draft.canonicalFacts;
        activeRows[index]!.content = textarea.value;
        notify();
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "secondary-action";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", kind === "thread" ? `Remove open thread ${index + 1}` : `Remove canonical fact ${index + 1}`);
      if (kind === "thread") remove.dataset.removeThread = "";
      else remove.dataset.removeFact = "";
      remove.addEventListener("click", () => {
        if (kind === "thread") draft.openThreads.splice(index, 1);
        else draft.canonicalFacts.splice(index, 1);
        renderRows(kind);
        const rowIndex = Math.min(index, (kind === "thread" ? draft.openThreads : draft.canonicalFacts).length - 1);
        const next = list.querySelectorAll<HTMLTextAreaElement>("textarea").item(rowIndex);
        if (next) next.focus();
        else element.querySelector<HTMLButtonElement>(kind === "thread" ? "[data-add-thread]" : "[data-add-fact]")?.focus();
        notify();
      });
      item.append(textarea, remove);
      list.append(item);
    });
    syncDisabled();
  };

  const summary = labelWithTextarea(document, "Continuity summary", draft.continuitySummary, "continuitySummary", (value) => {
    draft.continuitySummary = value;
    notify();
  });
  summary.querySelector("textarea")!.id = `${options.idPrefix}-continuity-summary`;
  const scratchpad = labelWithTextarea(document, "Private continuity scratchpad", draft.scratchpad, "scratchpad", (value) => {
    draft.scratchpad = value;
    notify();
  });
  scratchpad.querySelector("textarea")!.id = `${options.idPrefix}-scratchpad`;

  const rowsSection = (title: string, kind: RowKind) => {
    const section = document.createElement("section");
    section.className = "campaign-continuity-rows";
    const heading = document.createElement("h4");
    heading.textContent = title;
    const list = document.createElement("div");
    if (kind === "thread") list.dataset.threadRows = "";
    else list.dataset.factRows = "";
    const add = document.createElement("button");
    add.type = "button";
    add.className = "secondary-action";
    add.textContent = kind === "thread" ? "Add open thread" : "Add canonical fact";
    if (kind === "thread") add.dataset.addThread = "";
    else add.dataset.addFact = "";
    add.addEventListener("click", () => {
      if (kind === "thread") draft.openThreads.push({ key: `thread:${nextThreadKey++}`, content: "" });
      else draft.canonicalFacts.push({ key: `fact:new:${nextFactKey++}`, id: null, content: "" });
      renderRows(kind);
      const newest = list.querySelectorAll<HTMLTextAreaElement>("textarea").item(list.querySelectorAll("textarea").length - 1);
      newest?.focus();
      notify();
    });
    section.append(heading, list, add);
    return section;
  };

  element.append(summary, rowsSection("Open threads", "thread"), rowsSection("Canonical facts", "fact"), scratchpad);
  renderRows("thread");
  renderRows("fact");

  return {
    element,
    readDraft: () => cloneDraft(draft),
    setDisabled(next) {
      disabled = next;
      syncDisabled();
    },
    dispose() {
      disposed = true;
      element.replaceChildren();
    }
  };
}
