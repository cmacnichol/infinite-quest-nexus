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

export function createEditableStateRow(document, kind, value) {
  const row = document.createElement("div");
  row.className = "state-editor-row";
  if (kind === "fact") {
    row.dataset.itemId = value && typeof value === "object" && typeof value.id === "string"
      ? value.id
      : "";
  }
  const editor = document.createElement("textarea");
  editor.value = kind === "fact" ? canonicalFactContent(value) : String(value ?? "");
  editor.setAttribute("aria-label", kind === "fact" ? "Canonical fact" : "Open thread");
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "small danger";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => row.remove());
  row.append(editor, remove);
  return row;
}

export function addEditableStateRow(
  document,
  container,
  kind,
  value = kind === "fact" ? { id: null, content: "" } : ""
) {
  if (container) container.appendChild(createEditableStateRow(document, kind, value));
}

export function renderEditableStateCollection(document, container, values, kind) {
  if (!container) return;
  container.replaceChildren();
  (Array.isArray(values) ? values : []).forEach(value => {
    container.appendChild(createEditableStateRow(document, kind, value));
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

export function buildCampaignStateUpdate(runtimeState, editorValues) {
  return {
    expectedTurnNumber: runtimeState.activeTurnNumber,
    expectedRevision: runtimeState.revision,
    effectiveTurnNumber: runtimeState.viewedTurnNumber ?? runtimeState.activeTurnNumber,
    continuitySummary: String(editorValues.continuitySummary ?? ""),
    openThreads: normalizeTextItems(editorValues.openThreads),
    canonicalFacts: normalizeCanonicalFacts(editorValues.canonicalFacts),
    scratchpad: String(editorValues.scratchpad ?? ""),
    trackers: Array.isArray(editorValues.trackers) ? editorValues.trackers : [],
    rpgStats: Array.isArray(runtimeState.rpgStats) ? runtimeState.rpgStats : [],
    eventTriggers: Array.isArray(runtimeState.eventTriggers) ? runtimeState.eventTriggers : [],
    pendingEventTriggers: Array.isArray(runtimeState.pendingEventTriggers)
      ? runtimeState.pendingEventTriggers
      : []
  };
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
  onSaved
) {
  return submitCampaignState(updateState, campaignId, runtimeState, {
    continuitySummary: editor.summary?.value || "",
    openThreads: collectOpenThreadEditorValues(editor.threads),
    canonicalFacts: collectCanonicalFactEditorValues(editor.facts),
    scratchpad: editor.scratchpad?.value || "",
    trackers: editor.trackers
  }, onSaved);
}
