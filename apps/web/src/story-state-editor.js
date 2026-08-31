import { buildCurrentStateUpdate } from "@infinite-quest/client-core";

export function canonicalFactContent(value) {
  if (typeof value === "string") return value;
  return value && typeof value === "object" && typeof value.content === "string"
    ? value.content
    : "";
}

function cloneAndFreeze(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(cloneAndFreeze));
  }
  if (value && typeof value === "object") {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, cloneAndFreeze(nestedValue)])
    ));
  }
  return value;
}

export function captureCampaignStateEditSession(runtimeState) {
  return cloneAndFreeze(runtimeState || {});
}

export function normalizeTextItems(values) {
  return Array.isArray(values)
    ? values
      .filter(value => typeof value === "string")
      .map(value => value.trim())
      .filter(Boolean)
    : [];
}

export function normalizeCanonicalFacts(values) {
  return Array.isArray(values)
    ? values.flatMap(value => {
      const content = canonicalFactContent(value).trim();
      if (!content) return [];
      const id = value && typeof value === "object" && typeof value.id === "string" && value.id
        ? value.id
        : null;
      return [{ id, content }];
    })
    : [];
}

let nextEditorRowId = 0;

function editorRowKey(kind, value, index = 0) {
  if (value && typeof value === "object" && typeof value.key === "string" && value.key) {
    return value.key;
  }
  if (kind === "fact" && value && typeof value === "object" && typeof value.id === "string" && value.id) {
    return `fact:${value.id}`;
  }
  return `${kind}:new:${index}`;
}

export function createEditableStateRow(document, kind, value, index) {
  const row = document.createElement("div");
  row.className = "state-editor-row";
  row.dataset.rowKey = editorRowKey(kind, value, index);
  if (kind === "fact") {
    row.dataset.itemId = value && typeof value === "object" && typeof value.id === "string"
      ? value.id
      : "";
  }
  const editor = document.createElement("textarea");
  editor.value = canonicalFactContent(value);
  editor.setAttribute("aria-label", kind === "fact" ? "Canonical fact" : "Open thread");
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "small danger";
  remove.textContent = kind === "fact" ? "Remove fact" : "Remove thread";
  remove.setAttribute("aria-label", remove.textContent);
  remove.addEventListener("click", () => {
    const focusTarget = row.nextElementSibling?.querySelector("textarea")
      || row.previousElementSibling?.querySelector("textarea");
    row.remove();
    focusTarget?.focus();
  });
  row.append(editor, remove);
  return row;
}

export function addEditableStateRow(
  document,
  container,
  kind,
  value = kind === "fact" ? { id: null, content: "" } : ""
) {
  if (!container) return null;
  const row = createEditableStateRow(document, kind, value, nextEditorRowId++);
  container.appendChild(row);
  row.querySelector("textarea")?.focus();
  return row;
}

export function renderEditableStateCollection(document, container, values, kind) {
  if (!container) return;
  container.replaceChildren();
  (Array.isArray(values) ? values : []).forEach((value, index) => {
    container.appendChild(createEditableStateRow(document, kind, value, index));
  });
}

function createInspectorText(document, className, text) {
  const element = document.createElement("p");
  element.className = className;
  element.textContent = text;
  return element;
}

function createInspectorList(document, values, emptyText) {
  if (!values.length) return createInspectorText(document, "mini dim", emptyText);
  const list = document.createElement("ul");
  values.forEach(value => {
    const item = document.createElement("li");
    item.textContent = value;
    list.appendChild(item);
  });
  return list;
}

function createInspectorSection(document, title, content, open = false) {
  const details = document.createElement("details");
  details.open = open;
  const summary = document.createElement("summary");
  summary.textContent = title;
  const body = document.createElement("div");
  body.appendChild(content);
  details.append(summary, body);
  return details;
}

export function renderCampaignStateInspector(panel, runtimeState) {
  if (!panel) return;
  const document = panel.ownerDocument;
  const runtime = runtimeState || {};
  const title = document.createElement("h4");
  title.textContent = runtime.isCurrent
    ? "Current state"
    : `Historical state after turn ${runtime.viewedTurnNumber}`;
  const guidance = createInspectorText(
    document,
    "mini",
    runtime.isCurrent
      ? "Editable from Menu → Edit State."
      : "Changes apply only to this saved turn. Later turns and current state remain unchanged."
  );
  const continuitySummary = createInspectorText(
    document,
    "",
    runtime.continuitySummary || "No summary recorded."
  );
  const scratchpad = createInspectorText(
    document,
    "state-inspector-pre",
    runtime.scratchpad || "No scratchpad recorded."
  );
  const trackers = createInspectorList(
    document,
    (runtime.trackers || []).map(tracker => `${tracker.name}: ${tracker.value}`),
    "No trackers recorded."
  );
  const openThreads = createInspectorList(
    document,
    runtime.openThreads || [],
    "No open threads recorded."
  );
  const canonicalFacts = createInspectorList(
    document,
    (runtime.canonicalFacts || []).map(canonicalFactContent),
    "No canonical facts recorded."
  );

  panel.replaceChildren(
    title,
    guidance,
    createInspectorSection(document, "Continuity summary", continuitySummary, true),
    createInspectorSection(document, "Private scratchpad", scratchpad),
    createInspectorSection(document, "Trackers", trackers),
    createInspectorSection(document, "Open threads", openThreads),
    createInspectorSection(document, "Canonical facts", canonicalFacts)
  );
}

export function collectOpenThreadEditorValues(container) {
  return [...container.querySelectorAll(".state-editor-row textarea")]
    .map(editor => editor.value);
}

export function collectCanonicalFactEditorValues(container) {
  return [...container.querySelectorAll(".state-editor-row")]
    .map(row => ({
      id: row.dataset.itemId || null,
      content: row.querySelector("textarea")?.value || ""
    }));
}

export function collectCampaignContinuityDraft(editor, seedDraft) {
  const previous = seedDraft || {
    continuitySummary: "",
    scratchpad: "",
    openThreads: [],
    canonicalFacts: []
  };
  const previousThreadKeys = new Map(previous.openThreads.map(row => [row.key, row.key]));
  const previousFactKeys = new Map(previous.canonicalFacts.map(row => [row.key, row.key]));
  const threadRows = [...editor.threads.querySelectorAll(".state-editor-row")];
  const factRows = [...editor.facts.querySelectorAll(".state-editor-row")];

  return {
    continuitySummary: editor.summary?.value || "",
    scratchpad: editor.scratchpad?.value || "",
    openThreads: threadRows.map((row, index) => {
      const key = row.dataset.rowKey || `thread:new:${index}`;
      return {
        key: previousThreadKeys.get(key) || key,
        content: row.querySelector("textarea")?.value || ""
      };
    }),
    canonicalFacts: factRows.map((row, index) => {
      const id = row.dataset.itemId || null;
      const key = row.dataset.rowKey || (id ? `fact:${id}` : `fact:new:${index}`);
      return {
        key: previousFactKeys.get(key) || key,
        id,
        content: row.querySelector("textarea")?.value || ""
      };
    })
  };
}

export function buildCampaignStateUpdate(runtimeState, editorValues) {
  const draft = editorValues.openThreads.every(value => typeof value === "object")
    ? editorValues
    : {
      continuitySummary: String(editorValues.continuitySummary ?? ""),
      scratchpad: String(editorValues.scratchpad ?? ""),
      openThreads: (editorValues.openThreads || []).map((content, index) => ({
        key: `thread:${index}`,
        content: typeof content === "string" ? content : content?.content || ""
      })),
      canonicalFacts: (editorValues.canonicalFacts || []).map((fact, index) => ({
        key: fact?.id ? `fact:${fact.id}` : `fact:new:${index}`,
        id: fact?.id || null,
        content: canonicalFactContent(fact)
      }))
    };
  const base = {
    ...runtimeState,
    isCurrent: runtimeState.isCurrent ?? true,
    viewedTurnNumber: runtimeState.viewedTurnNumber ?? runtimeState.activeTurnNumber,
    continuitySummary: runtimeState.continuitySummary ?? "",
    scratchpad: runtimeState.scratchpad ?? "",
    openThreads: runtimeState.openThreads ?? [],
    canonicalFacts: runtimeState.canonicalFacts ?? [],
    trackers: runtimeState.trackers ?? [],
    rpgStats: runtimeState.rpgStats ?? [],
    eventTriggers: runtimeState.eventTriggers ?? [],
    pendingEventTriggers: runtimeState.pendingEventTriggers ?? []
  };
  return buildCurrentStateUpdate(base, draft, {
    trackers: Array.isArray(editorValues.trackers) ? editorValues.trackers : base.trackers
  });
}

export async function submitCampaignState(
  updateState,
  campaignId,
  runtimeState,
  editorValues,
  onSaved
) {
  const savedState = await updateState(campaignId, buildCampaignStateUpdate(runtimeState, editorValues));
  onSaved(savedState);
  return savedState;
}

export async function saveCampaignStateFromEditor(
  updateState,
  campaignId,
  runtimeState,
  editor,
  onSaved,
  seedDraft
) {
  const draft = collectCampaignContinuityDraft(editor, seedDraft);
  return submitCampaignState(updateState, campaignId, runtimeState, {
    ...draft,
    trackers: editor.trackers
  }, onSaved);
}
