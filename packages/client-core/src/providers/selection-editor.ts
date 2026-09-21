import {
  selectionCompatibilityId,
  type ProviderPresetDiagnosticCode,
  type SafePresetDetail,
  type SafePresetSummary,
  type TextExecutionOverrides,
  type TextModelSelection
} from "@infinite-quest/contracts";

export type ResponseFormatPolicy = "legacy" | "auto" | "required";
export type OverrideIntent =
  | Readonly<{ mode: "preserve"; value?: TextExecutionOverrides }>
  | Readonly<{ mode: "inherit" }>
  | Readonly<{ mode: "explicit"; value: TextExecutionOverrides }>;

type AuthorityRevision = Readonly<{ profileRevision: string; configurationRevision: string; credentialRevision: string }>;
type ModelDraft = Readonly<{ modelId: string; responseFormatPolicy: ResponseFormatPolicy; overrideIntent: OverrideIntent }>;
type PresetDraft = Readonly<{ slug: string; responseFormatPolicy: "required"; overrideIntent: OverrideIntent }>;

export type SelectionEditorState = Readonly<{
  mode: "model" | "preset";
  savedSelection: TextModelSelection;
  modelDraft: ModelDraft;
  presetDraft: PresetDraft;
  authority: AuthorityRevision;
  savedChoiceAvailability: "unknown" | "available" | "unavailable";
  list: Readonly<{ requestId: string | null; busy: boolean; requestedOffset: number; presets: readonly SafePresetSummary[]; totalCount: number; nextOffset: number | null; error: ProviderPresetDiagnosticCode | null }>;
  detail: Readonly<{ requestId: string | null; busy: boolean; slug: string | null; value: SafePresetDetail | null; error: ProviderPresetDiagnosticCode | null }>;
}>;

export type SelectionEditorInput = AuthorityRevision & Readonly<{
  savedSelection: TextModelSelection;
  responseFormatPolicy: ResponseFormatPolicy;
  textExecutionOverrides?: TextExecutionOverrides;
}>;

export type SelectionEditorEvent =
  | Readonly<{ type: "modeChanged"; mode: "model" | "preset" }>
  | Readonly<{ type: "modelDraftChanged"; modelId: string; responseFormatPolicy: ResponseFormatPolicy }>
  | Readonly<{ type: "presetDraftChanged"; slug: string }>
  | Readonly<{ type: "modelOverrideIntentChanged" | "presetOverrideIntentChanged"; intent: OverrideIntent }>
  | Readonly<{ type: "requestStarted"; requestId: string; mode: "preset"; offset: number }>
  | Readonly<{ type: "listLoaded"; requestId: string; page: import("@infinite-quest/contracts").SafePresetPage }>
  | Readonly<{ type: "requestFailed"; requestId: string; error: ProviderPresetDiagnosticCode }>
  | Readonly<{ type: "requestFinished"; requestId: string }>
  | Readonly<{ type: "detailRequestStarted"; requestId: string; slug: string }>
  | Readonly<{ type: "detailLoaded"; requestId: string; detail: SafePresetDetail }>
  | Readonly<{ type: "detailFailed"; requestId: string; error: ProviderPresetDiagnosticCode }>
  | Readonly<{ type: "detailRequestFinished"; requestId: string }>
  | (Readonly<{ type: "authorityChanged" }> & AuthorityRevision);

export type SelectionEditorPatch = Readonly<{
  defaultModel: string;
  textSelection: TextModelSelection;
  configuration: Readonly<{
    textResponseFormatPolicy: ResponseFormatPolicy;
    textExecutionOverrides?: TextExecutionOverrides | null;
  }>;
}>;

const emptyList = { requestId: null, busy: false, requestedOffset: 0, presets: [], totalCount: 0, nextOffset: null, error: null } as const;
const emptyDetail = { requestId: null, busy: false, slug: null, value: null, error: null } as const;

export function createSelectionEditorState(input: SelectionEditorInput): SelectionEditorState {
  const savedOverrides: OverrideIntent = input.textExecutionOverrides === undefined
    ? { mode: "preserve" }
    : { mode: "preserve", value: input.textExecutionOverrides };
  const emptyOverrides: OverrideIntent = { mode: "preserve" };
  return {
    mode: input.savedSelection.kind === "model" ? "model" : "preset", savedSelection: input.savedSelection,
    modelDraft: { modelId: input.savedSelection.kind === "model" ? input.savedSelection.modelId : "", responseFormatPolicy: input.responseFormatPolicy, overrideIntent: input.savedSelection.kind === "model" ? savedOverrides : emptyOverrides },
    presetDraft: { slug: input.savedSelection.kind === "openrouter_preset" ? input.savedSelection.slug : "", responseFormatPolicy: "required", overrideIntent: input.savedSelection.kind === "openrouter_preset" ? savedOverrides : emptyOverrides },
    authority: { profileRevision: input.profileRevision, configurationRevision: input.configurationRevision, credentialRevision: input.credentialRevision },
    savedChoiceAvailability: "unknown", list: emptyList, detail: emptyDetail
  };
}

function mergePresets(existing: readonly SafePresetSummary[], next: readonly SafePresetSummary[]): readonly SafePresetSummary[] {
  const seen = new Set(existing.map((preset) => preset.slug));
  return [...existing, ...next.filter((preset) => !seen.has(preset.slug) && seen.add(preset.slug))];
}

export function reduceSelectionEditor(state: SelectionEditorState, event: SelectionEditorEvent): SelectionEditorState {
  switch (event.type) {
    case "modeChanged": return event.mode === state.mode ? state : { ...state, mode: event.mode, detail: emptyDetail };
    case "modelDraftChanged": return { ...state, modelDraft: { ...state.modelDraft, modelId: event.modelId, responseFormatPolicy: event.responseFormatPolicy } };
    case "presetDraftChanged": return event.slug === state.presetDraft.slug
      ? state
      : { ...state, presetDraft: { ...state.presetDraft, slug: event.slug }, detail: emptyDetail };
    case "modelOverrideIntentChanged": return { ...state, modelDraft: { ...state.modelDraft, overrideIntent: event.intent } };
    case "presetOverrideIntentChanged": return { ...state, presetDraft: { ...state.presetDraft, overrideIntent: event.intent } };
    case "requestStarted": return { ...state, list: { ...state.list, requestId: event.requestId, busy: true, requestedOffset: event.offset, error: null } };
    case "listLoaded": {
      if (state.list.requestId !== event.requestId) return state;
      const presets = event.page.offset === 0 ? event.page.presets : mergePresets(state.list.presets, event.page.presets);
      const savedSlug = state.savedSelection.kind === "openrouter_preset" ? state.savedSelection.slug : null;
      const complete = event.page.nextOffset === null;
      return { ...state, savedChoiceAvailability: savedSlug === null ? "unknown" : presets.some((preset) => preset.slug === savedSlug) ? "available" : complete ? "unavailable" : "unknown", list: { ...state.list, presets, totalCount: event.page.totalCount, nextOffset: event.page.nextOffset, error: null } };
    }
    case "requestFailed": return state.list.requestId === event.requestId ? { ...state, list: { ...state.list, error: event.error } } : state;
    case "requestFinished": return state.list.requestId === event.requestId ? { ...state, list: { ...state.list, busy: false } } : state;
    case "detailRequestStarted": return { ...state, detail: { requestId: event.requestId, busy: true, slug: event.slug, value: null, error: null } };
    case "detailLoaded": return state.detail.requestId === event.requestId ? { ...state, detail: { ...state.detail, value: event.detail, error: null } } : state;
    case "detailFailed": return state.detail.requestId === event.requestId ? { ...state, detail: { ...state.detail, error: event.error } } : state;
    case "detailRequestFinished": return state.detail.requestId === event.requestId ? { ...state, detail: { ...state.detail, busy: false } } : state;
    case "authorityChanged": return { ...state, authority: { profileRevision: event.profileRevision, configurationRevision: event.configurationRevision, credentialRevision: event.credentialRevision }, savedChoiceAvailability: "unknown", list: emptyList, detail: emptyDetail };
  }
}

function serializedOverrides(intent: OverrideIntent): Record<string, unknown> {
  return intent.mode === "preserve" ? {} : { textExecutionOverrides: intent.mode === "inherit" ? null : intent.value };
}

export function serializeSelectionEditorPatch(state: SelectionEditorState): SelectionEditorPatch {
  const selection: TextModelSelection = state.mode === "model"
    ? { kind: "model", modelId: state.modelDraft.modelId }
    : { kind: "openrouter_preset", slug: state.presetDraft.slug };
  const draft = state.mode === "model" ? state.modelDraft : state.presetDraft;
  return {
    defaultModel: selectionCompatibilityId(selection), textSelection: selection,
    configuration: { textResponseFormatPolicy: draft.responseFormatPolicy, ...serializedOverrides(draft.overrideIntent) }
  };
}
