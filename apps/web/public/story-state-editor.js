export function canonicalFactContent(value) {
  if (typeof value === "string") return value;
  return value && typeof value === "object" && typeof value.content === "string"
    ? value.content
    : "";
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
  request,
  campaignId,
  runtimeState,
  editorValues,
  onSaved
) {
  const savedState = await request(`/campaigns/${campaignId}/state`, {
    method: "PATCH",
    body: JSON.stringify(buildCampaignStateUpdate(runtimeState, editorValues))
  });
  onSaved(savedState);
  return savedState;
}

export async function saveCampaignStateFromEditor(
  request,
  campaignId,
  runtimeState,
  editor,
  onSaved
) {
  return submitCampaignState(request, campaignId, runtimeState, {
    continuitySummary: editor.summary?.value || "",
    openThreads: collectOpenThreadEditorValues(editor.threads),
    canonicalFacts: collectCanonicalFactEditorValues(editor.facts),
    scratchpad: editor.scratchpad?.value || "",
    trackers: editor.trackers
  }, onSaved);
}
