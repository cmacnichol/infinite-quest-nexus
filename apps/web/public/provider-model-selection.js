// Provider model-routing helpers live here so the legacy editor can keep
// ordering and source-selection rules independent from DOM state.
export const MAX_ROUTING_MODELS = 5;

function cleanModelId(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeModelSelection(models) {
  const selected = [];
  for (const value of Array.isArray(models) ? models : []) {
    const modelId = cleanModelId(value);
    if (modelId && !selected.includes(modelId)) selected.push(modelId);
    if (selected.length === MAX_ROUTING_MODELS) break;
  }
  return selected;
}

export function appendModel(models, modelId) {
  const selected = normalizeModelSelection(models);
  const next = cleanModelId(modelId);
  return !next || selected.includes(next) || selected.length === MAX_ROUTING_MODELS
    ? selected
    : [...selected, next];
}

export function moveModel(models, index, direction) {
  const selected = normalizeModelSelection(models);
  const targetIndex = index + direction;
  if (!Number.isInteger(index) || !Number.isInteger(direction) || index < 0 || index >= selected.length || targetIndex < 0 || targetIndex >= selected.length) return selected;
  [selected[index], selected[targetIndex]] = [selected[targetIndex], selected[index]];
  return selected;
}

export function removeModel(models, index) {
  const selected = normalizeModelSelection(models);
  return Number.isInteger(index) && index >= 0 && index < selected.length
    ? selected.filter((_, itemIndex) => itemIndex !== index)
    : selected;
}

export function reconcileModelSelection(selection, discoveredModels) {
  // Discovery is advisory: preserve custom and temporarily unavailable IDs.
  void discoveredModels;
  return normalizeModelSelection(selection);
}

export function minimumKnownContextWindow(selection, discoveredModels) {
  const modelsById = new Map((Array.isArray(discoveredModels) ? discoveredModels : []).flatMap((model) => {
    const ids = [model?.id, model?.instanceId].map(cleanModelId).filter(Boolean);
    return ids.map((id) => [id, Number(model?.contextLength || 0)]);
  }));
  const contexts = normalizeModelSelection(selection).map((modelId) => modelsById.get(modelId));
  return contexts.length && contexts.every((context) => Number.isFinite(context) && context > 0)
    ? Math.min(...contexts)
    : null;
}

export function normalizeRoutingSelection(input = {}) {
  const models = normalizeModelSelection(input.models);
  const presetSlug = cleanModelId(input.presetSlug);
  const presetAllowed = input.providerType === "openrouter" && ["text", "intent"].includes(input.providerRole);
  return presetAllowed && input.routingSource === "openrouter_preset"
    ? { routingSource: "openrouter_preset", models, presetSlug }
    : { routingSource: "models", models, presetSlug: "" };
}

export function selectPresetSnapshot(snapshot) {
  const models = normalizeModelSelection(snapshot?.models);
  return {
    routingSource: "openrouter_preset",
    presetSlug: cleanModelId(snapshot?.slug),
    models,
    snapshot: {
      slug: cleanModelId(snapshot?.slug),
      designatedVersionId: cleanModelId(snapshot?.designatedVersionId),
      version: Number(snapshot?.version || 0),
      configHash: cleanModelId(snapshot?.configHash),
      models,
      providerPolicy: { ...(snapshot?.providerPolicy || {}) }
    }
  };
}

export function comparePresetSnapshots(saved, remote) {
  if (!saved || !remote || cleanModelId(saved.slug) !== cleanModelId(remote.slug)) return { changed: true, reason: "different-preset" };
  if (Number(saved.version) !== Number(remote.version)) return { changed: true, reason: "version" };
  if (cleanModelId(saved.configHash) !== cleanModelId(remote.configHash)) return { changed: true, reason: "configuration" };
  return { changed: false, reason: "current" };
}
