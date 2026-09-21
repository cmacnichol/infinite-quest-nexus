import { describe, expect, it } from "vitest";
import {
  createSelectionEditorState,
  reduceSelectionEditor,
  serializeSelectionEditorPatch,
  type SelectionEditorState
} from "../../packages/client-core/src/providers/selection-editor.js";
import type { SafePresetDetail, SafePresetPage } from "../../packages/contracts/src/provider-presets.js";

const emptyPage: SafePresetPage = { presets: [], totalCount: 0, offset: 0, nextOffset: null };
const detailA = {
  slug: "preset-a", name: "Preset A", versionId: "v1", version: 1, standardPrompt: "Owner-visible prompt.",
  candidateModelIds: ["route/model"], providerPolicy: {}, excludedProviderSlugs: [], parameters: {},
  limits: { configuredMaxTokens: null, configuredMaxCompletionTokens: null, effectiveMaxOutputTokens: null, contextWindowTokens: { status: "unknown", value: null } },
  responseFormat: { mode: "json_schema", assurance: "trusted_preset" }
} satisfies SafePresetDetail;

function initialPresetState(): SelectionEditorState {
  return createSelectionEditorState({
    savedSelection: { kind: "openrouter_preset", slug: "saved-preset" },
    responseFormatPolicy: "required",
    textExecutionOverrides: { parameters: { temperature: 0.4 } },
    profileRevision: "profile-1",
    configurationRevision: "config-1",
    credentialRevision: "credential-1"
  });
}

describe("provider selection editor", () => {
  it("ignores stale list success, failure, and finally events", () => {
    const newer = reduceSelectionEditor(initialPresetState(), {
      type: "requestStarted", requestId: "new", mode: "preset", offset: 0
    });
    expect(reduceSelectionEditor(newer, { type: "listLoaded", requestId: "old", page: emptyPage })).toEqual(newer);
    expect(reduceSelectionEditor(newer, { type: "requestFailed", requestId: "old", error: "discovery_unavailable" })).toEqual(newer);
    expect(reduceSelectionEditor(newer, { type: "requestFinished", requestId: "old" })).toEqual(newer);
    expect(reduceSelectionEditor(newer, { type: "requestFinished", requestId: "new" }).list.busy).toBe(false);
  });

  it("keeps Model and Preset drafts independent across mode changes", () => {
    let state = createSelectionEditorState({
      savedSelection: { kind: "model", modelId: "historical-model" },
      responseFormatPolicy: "legacy",
      profileRevision: "profile-1",
      configurationRevision: "config-1",
      credentialRevision: "credential-1"
    });
    state = reduceSelectionEditor(state, { type: "modelDraftChanged", modelId: "custom-model", responseFormatPolicy: "auto" });
    state = reduceSelectionEditor(state, { type: "modeChanged", mode: "preset" });
    state = reduceSelectionEditor(state, { type: "presetDraftChanged", slug: "night-shift" });
    state = reduceSelectionEditor(state, { type: "modeChanged", mode: "model" });

    expect(state.modelDraft).toMatchObject({ modelId: "custom-model", responseFormatPolicy: "auto" });
    expect(state.presetDraft).toMatchObject({ slug: "night-shift", responseFormatPolicy: "required" });
  });

  it("resets overrides only when a concrete selection identity changes", () => {
    let state = initialPresetState();
    state = reduceSelectionEditor(state, { type: "presetOverrideIntentChanged", intent: { mode: "explicit", value: { parameters: { temperature: 0.8 } } } });
    state = reduceSelectionEditor(state, { type: "modeChanged", mode: "model" });
    state = reduceSelectionEditor(state, { type: "modelDraftChanged", modelId: "custom-model", responseFormatPolicy: "auto" });
    state = reduceSelectionEditor(state, { type: "modelOverrideIntentChanged", intent: { mode: "explicit", value: { parameters: { top_p: 0.7 } } } });
    state = reduceSelectionEditor(state, { type: "modeChanged", mode: "preset" });

    expect(state.presetDraft).toMatchObject({ slug: "saved-preset", overrideIntent: { mode: "explicit", value: { parameters: { temperature: 0.8 } } } });
    expect(state.modelDraft).toMatchObject({ modelId: "custom-model", responseFormatPolicy: "auto", overrideIntent: { mode: "explicit", value: { parameters: { top_p: 0.7 } } } });

    state = reduceSelectionEditor(state, { type: "presetDraftChanged", slug: "different-preset" });
    expect(state.presetDraft.overrideIntent).toEqual({ mode: "inherit" });
    state = reduceSelectionEditor(state, { type: "modeChanged", mode: "model" });
    state = reduceSelectionEditor(state, { type: "modelDraftChanged", modelId: "different-model", responseFormatPolicy: "required" });
    expect(state.modelDraft.overrideIntent).toEqual({ mode: "inherit" });
  });

  it("invalidates list success, failure, and finally callbacks when mode changes", () => {
    const started = reduceSelectionEditor(initialPresetState(), { type: "requestStarted", requestId: "list-a", mode: "preset", offset: 0 });
    const model = reduceSelectionEditor(started, { type: "modeChanged", mode: "model" });
    expect(model.list).toEqual({ requestId: null, busy: false, requestedOffset: 0, presets: [], totalCount: 0, nextOffset: null, error: null, errorField: null });
    expect(reduceSelectionEditor(model, { type: "listLoaded", requestId: "list-a", page: emptyPage })).toEqual(model);
    expect(reduceSelectionEditor(model, { type: "requestFailed", requestId: "list-a", error: "discovery_unavailable" })).toEqual(model);
    expect(reduceSelectionEditor(model, { type: "requestFinished", requestId: "list-a" })).toEqual(model);
  });
  it("deduplicates paged results by slug without replacing the earlier order", () => {
    let state = reduceSelectionEditor(initialPresetState(), { type: "requestStarted", requestId: "page-1", mode: "preset", offset: 0 });
    state = reduceSelectionEditor(state, { type: "listLoaded", requestId: "page-1", page: {
      presets: [{ slug: "alpha", name: "Alpha", status: "active", designatedVersionId: "v1", updatedAt: "2026-09-20T00:00:00.000Z" }],
      totalCount: 2, offset: 0, nextOffset: 1
    } });
    state = reduceSelectionEditor(state, { type: "requestStarted", requestId: "page-2", mode: "preset", offset: 1 });
    state = reduceSelectionEditor(state, { type: "listLoaded", requestId: "page-2", page: {
      presets: [
        { slug: "alpha", name: "Changed", status: "active", designatedVersionId: "v2", updatedAt: "2026-09-20T00:00:01.000Z" },
        { slug: "saved-preset", name: "Saved", status: "active", designatedVersionId: "v3", updatedAt: "2026-09-20T00:00:02.000Z" }
      ], totalCount: 2, offset: 1, nextOffset: null
    } });

    expect(state.list.presets.map((preset) => preset.slug)).toEqual(["alpha", "saved-preset"]);
    expect(state.list.presets[0]?.name).toBe("Alpha");
    expect(state.savedChoiceAvailability).toBe("available");
  });

  it("retains an unavailable saved Preset as the active draft", () => {
    let state = reduceSelectionEditor(initialPresetState(), { type: "requestStarted", requestId: "list", mode: "preset", offset: 0 });
    state = reduceSelectionEditor(state, { type: "listLoaded", requestId: "list", page: emptyPage });
    expect(state.presetDraft.slug).toBe("saved-preset");
    expect(state.savedChoiceAvailability).toBe("unavailable");
  });

  it("preserves edits on finite discovery errors", () => {
    let state = reduceSelectionEditor(initialPresetState(), { type: "presetDraftChanged", slug: "edited-preset" });
    state = reduceSelectionEditor(state, { type: "requestStarted", requestId: "list", mode: "preset", offset: 0 });
    state = reduceSelectionEditor(state, { type: "requestFailed", requestId: "list", error: "authentication" });
    expect(state.presetDraft.slug).toBe("edited-preset");
    expect(state.list.error).toBe("authentication");
  });

  it("invalidates list and detail evidence on profile, configuration, or credential revision changes", () => {
    let state = reduceSelectionEditor(initialPresetState(), { type: "requestStarted", requestId: "list", mode: "preset", offset: 0 });
    state = reduceSelectionEditor(state, { type: "listLoaded", requestId: "list", page: emptyPage });
    state = reduceSelectionEditor(state, { type: "detailRequestStarted", requestId: "detail", slug: "saved-preset" });
    state = reduceSelectionEditor(state, { type: "detailLoaded", requestId: "detail", detail: {
      slug: "saved-preset", name: "Saved", versionId: "v1", version: 1, standardPrompt: "Owner-visible prompt.",
      candidateModelIds: ["route/model"], providerPolicy: {}, excludedProviderSlugs: [], parameters: {},
      limits: { configuredMaxTokens: null, configuredMaxCompletionTokens: null, effectiveMaxOutputTokens: null, contextWindowTokens: { status: "unknown", value: null } },
      responseFormat: { mode: "json_schema", assurance: "trusted_preset" }
    } });
    const revised = reduceSelectionEditor(state, {
      type: "authorityChanged", profileRevision: "profile-2", configurationRevision: "config-2", credentialRevision: "credential-2"
    });

    expect(revised.modelDraft).toEqual(state.modelDraft);
    expect(revised.presetDraft).toEqual(state.presetDraft);
    expect(revised.list).toMatchObject({ requestId: null, busy: false, presets: [], error: null });
    expect(revised.detail).toMatchObject({ requestId: null, busy: false, value: null, error: null });
    expect(revised).not.toHaveProperty("credential");
    expect(revised.authority).toEqual({ profileRevision: "profile-2", configurationRevision: "config-2", credentialRevision: "credential-2" });
  });

  it("ignores stale detail success, failure, and finally events", () => {
    const state = reduceSelectionEditor(initialPresetState(), { type: "detailRequestStarted", requestId: "new", slug: "saved-preset" });
    expect(reduceSelectionEditor(state, { type: "detailFailed", requestId: "old", error: "preset_missing" })).toEqual(state);
    expect(reduceSelectionEditor(state, { type: "detailRequestFinished", requestId: "old" })).toEqual(state);
    expect(reduceSelectionEditor(state, { type: "detailRequestFinished", requestId: "new" }).detail.busy).toBe(false);
  });

  it.each([
    ["changes the Preset draft", { type: "presetDraftChanged", slug: "preset-b" } as const, { mode: "inherit" }],
    ["switches to Model mode", { type: "modeChanged", mode: "model" } as const, { mode: "preserve", value: { parameters: { temperature: 0.4 } } }]
  ])("invalidates detail identity when the user %s", (_name, transition, expectedOverride) => {
    const started = reduceSelectionEditor(initialPresetState(), { type: "detailRequestStarted", requestId: "detail-a", slug: "preset-a" });
    const transitioned = reduceSelectionEditor(started, transition);
    expect(transitioned.detail).toEqual({ requestId: null, busy: false, slug: null, value: null, error: null, errorField: null });
    expect(reduceSelectionEditor(transitioned, { type: "detailLoaded", requestId: "detail-a", detail: detailA })).toEqual(transitioned);
    expect(reduceSelectionEditor(transitioned, { type: "detailFailed", requestId: "detail-a", error: "preset_missing" })).toEqual(transitioned);
    expect(reduceSelectionEditor(transitioned, { type: "detailRequestFinished", requestId: "detail-a" })).toEqual(transitioned);
    expect(transitioned.presetDraft.overrideIntent).toEqual(expectedOverride);
    expect(transitioned.modelDraft).toEqual(started.modelDraft);
  });

  it("serializes preserve, inherit, and explicit override intent without moving drafts between selections", () => {
    let state = createSelectionEditorState({
      savedSelection: { kind: "model", modelId: "historical-model" }, responseFormatPolicy: "legacy",
      textExecutionOverrides: { parameters: { temperature: 0.3 } }, profileRevision: "p", configurationRevision: "c", credentialRevision: "k"
    });
    expect(state.modelDraft.overrideIntent).toEqual({ mode: "preserve", value: { parameters: { temperature: 0.3 } } });
    expect(state.presetDraft.overrideIntent).toEqual({ mode: "preserve" });
    expect(serializeSelectionEditorPatch(state)).toEqual({
      defaultModel: "historical-model", textSelection: { kind: "model", modelId: "historical-model" },
      configuration: { textResponseFormatPolicy: "legacy" }
    });
    state = reduceSelectionEditor(state, { type: "modelOverrideIntentChanged", intent: { mode: "inherit" } });
    expect(serializeSelectionEditorPatch(state).configuration.textExecutionOverrides).toBeNull();
    state = reduceSelectionEditor(state, { type: "modelOverrideIntentChanged", intent: { mode: "explicit", value: { parameters: { temperature: 0.6 } } } });
    expect(serializeSelectionEditorPatch(state).configuration.textExecutionOverrides).toEqual({ parameters: { temperature: 0.6 } });
    state = reduceSelectionEditor(state, { type: "modeChanged", mode: "preset" });
    state = reduceSelectionEditor(state, { type: "presetDraftChanged", slug: "night-shift" });
    const presetPatch = serializeSelectionEditorPatch(state);
    expect(presetPatch).toEqual({
      defaultModel: "@preset/night-shift", textSelection: { kind: "openrouter_preset", slug: "night-shift" },
      configuration: { textResponseFormatPolicy: "required", textExecutionOverrides: null }
    });
  });
});
