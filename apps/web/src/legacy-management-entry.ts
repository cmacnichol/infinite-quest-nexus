export {
  createSelectionEditorState,
  reduceSelectionEditor,
  serializeSelectionEditorPatch
} from "@infinite-quest/client-core";
export { isExactStoryResponseFormatCapability } from "@infinite-quest/client-core";
export { providerReadinessForRole } from "@infinite-quest/client-core";
export type { ProviderInventoryObservation, ProviderInventoryStatus, ProviderReadinessCapabilityState, ProviderReadinessResult, ProviderReadinessRole, ProviderReadinessState } from "@infinite-quest/client-core";
export type {
  OverrideIntent,
  ResponseFormatPolicy,
  SelectionEditorEvent,
  SelectionEditorInput,
  SelectionEditorPatch,
  SelectionEditorState
} from "@infinite-quest/client-core";
export {
  ProviderPresetsUnsupportedError,
  createProviderPresetsApi,
  nativePresetSupport
} from "@infinite-quest/client-web";
export type {
  NativePresetSupport,
  ProviderPresetCandidateListOptions,
  ProviderPresetListOptions,
  ProviderPresetsApi
} from "@infinite-quest/client-web";
export { bindEditDialogDismissal, requestEditDismissal } from "./legacy-edit-session.js";
export { createLegacySectionLoader } from "./legacy-section-loader.js";
export type { LegacySectionLoader, LegacySectionLoaderRequest } from "./legacy-section-loader.js";
export { createEditSession } from "@infinite-quest/client-core";
export type { EditSession } from "@infinite-quest/client-core";
export { buildCampaignCreateRequest, createCampaignCreationDraft } from "@infinite-quest/client-core";
export { resolveResumeCampaign } from "@infinite-quest/client-core";
export { filterSortCampaigns, filterSortWorlds } from "@infinite-quest/client-core";
export type { CampaignCollectionOptions, WorldCollectionOptions } from "@infinite-quest/client-core";
export type { ResumeCampaign } from "@infinite-quest/client-core";
export type {
  CampaignCreationDraft,
  CampaignCreationUserSettings,
  CampaignCreationWorld
} from "@infinite-quest/client-core";

if (typeof document !== "undefined" && document.querySelector("#dashboard")) {
  const controllerUrl = "/nexus/nexus.js";
  void import(/* @vite-ignore */ controllerUrl);
}
