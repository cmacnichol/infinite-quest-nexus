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
