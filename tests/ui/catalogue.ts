import { createDisplayPreferences, type StoryWidth } from "../../apps/web-next/src/preferences/display-preferences.js";
import { mountQuietLeafPresenter } from "../../apps/web-next/src/story/quiet-leaf-presenter.js";
import type { ComposerActions } from "../../apps/web-next/src/story/ui/composer.js";
import type { StoryPlayerViewState } from "../../apps/web-next/src/story-player-view.js";
import {
  campaignSummarySchema,
  campaignSyncStatusSchema,
  illustrationConfigResponseSchema,
  illustrationSegmentSchema,
  turnSummarySchema
} from "@infinite-quest/contracts";
import { applyTheme } from "../../apps/web-next/src/theme.js";
import "../../apps/web-next/src/styles.css";
import "../../apps/web-next/src/story-player.css";
import "./catalogue.css";

const campaignId = "11111111-1111-4111-8111-111111111111";
const turnId = "22222222-2222-4222-8222-222222222222";
const segmentId = "33333333-3333-4333-8333-333333333333";
const assetId = "44444444-4444-4444-8444-444444444444";

interface CataloguePanel {
  readonly id: string;
  readonly label: string;
  readonly width: StoryWidth;
  readonly artworkVisible: boolean;
  readonly draft: string;
  readonly disabled: boolean;
  readonly turnControlStyle: "action_only" | "flexible_auto" | "flexible_action" | "flexible_scene";
}

const panels: readonly CataloguePanel[] = [
  { id: "automatic", label: "Automatic / artwork", width: "auto", artworkVisible: true, draft: "", disabled: false, turnControlStyle: "flexible_auto" },
  { id: "comfortable", label: "Comfortable / tall field", width: "comfortable", artworkVisible: true, draft: "A tall fixture draft\nthat proves the composer keeps its shape.", disabled: false, turnControlStyle: "flexible_action" },
  { id: "wide", label: "Wide / no artwork", width: "wide", artworkVisible: false, draft: "", disabled: false, turnControlStyle: "flexible_scene" },
  { id: "full", label: "Full / disabled", width: "full", artworkVisible: true, draft: "Generation is in progress.", disabled: true, turnControlStyle: "action_only" }
];

const narration = [
  "A thin bell sounds somewhere beyond the empty platform, then falls silent before its echo can find the roof.",
  "At the far end, the weathered door waits beneath a painted number that has faded to a pale crescent. Three chalk marks point toward it, each laid down by a different hand.",
  "The air carries rain and old iron. Nothing moves on the tracks, but the station clock has begun to tick backward."
].join("\n\n");

function stateFor(panel: CataloguePanel): StoryPlayerViewState {
  const variant = {
    assetId,
    url: "/ui-test/quiet-leaf-door.png",
    variantIndex: 0,
    prompt: "A quiet, weathered door at the end of an empty platform.",
    providerType: null,
    model: null,
    createdAt: "2026-08-30T12:00:00.000Z",
    selectionReason: "fixture",
    matchScore: null,
    matchThreshold: null,
    matchingAlgorithm: null
  } as const;
  const segment = illustrationSegmentSchema.parse({
    setId: "55555555-5555-4555-8555-555555555555",
    turnId,
    setStatus: "completed",
    segmentWordCount: 120,
    imagesPerSegment: 1,
    promptMode: "direct",
    id: segmentId,
    ordinal: 0,
    startOffset: 0,
    endOffset: 54,
    startWord: 0,
    endWord: 10,
    text: "The platform is quiet, with three marked paths ahead.",
    status: "completed",
    promptSource: null,
    directPrompt: variant.prompt,
    resolvedPrompt: variant.prompt,
    variants: [variant],
    imageJobId: null,
    imageJobStatus: null,
    providerStatus: null,
    providerProgress: null,
    errorMessage: null,
    promptJobStatus: null
  });
  const selectedCampaign = campaignSummarySchema.parse({
    id: campaignId,
    title: "Fixture Story",
    status: "active",
    activeTurnNumber: 1,
    createdAt: "2026-08-30T12:00:00.000Z",
    updatedAt: "2026-08-30T12:00:00.000Z",
    storyLengthProfile: "standard",
    storyContextBudgetTokens: 4096,
    turnControlStyle: panel.turnControlStyle,
    selectedCharacterId: null,
    selectedCharacterName: null,
    worldId: "66666666-6666-4666-8666-666666666666",
    worldTitle: "Fixture World",
    worldVersionId: "77777777-7777-4777-8777-777777777777",
    textProviderProfileId: null,
    imageProviderProfileId: null,
    worldVersionNumber: 1,
    latestWorldVersionNumber: 1,
    worldUpdateAvailable: false,
    costInformation: []
  });
  const turn = turnSummarySchema.parse({
    id: turnId,
    turnNumber: 1,
    action: "Survey the empty platform.",
    inputMode: "action",
    inputModeSource: "explicit",
    narration,
    choices: ["Cross the threshold", "Cross the threshold", "Wait for a signal"],
    customActionSuggestion: "Listen at the weathered door.",
    imagePrompt: variant.prompt,
    imageUrl: variant.url,
    acceptedAt: "2026-08-30T12:00:00.000Z",
    chronicleRetrieval: null,
    reportedCost: null
  });
  const sync = campaignSyncStatusSchema.parse({
    id: campaignId,
    title: "Fixture Story",
    activeTurnNumber: 1,
    worldVersionId: "77777777-7777-4777-8777-777777777777",
    storyLengthProfile: "standard",
    storyContextBudgetTokens: 4096,
    turnControlStyle: panel.turnControlStyle,
    updatedAt: "2026-08-30T12:00:00.000Z",
    selectedCharacterId: null,
    selectedCharacterName: "",
    characterSnapshot: null,
    characterProfile: null,
    characterProfileRevision: 0,
    status: "active",
    campaign: {
      id: campaignId,
      title: "Fixture Story",
      activeTurnNumber: 1,
      worldVersionId: "77777777-7777-4777-8777-777777777777",
      storyLengthProfile: "standard",
      storyContextBudgetTokens: 4096,
      turnControlStyle: panel.turnControlStyle,
      updatedAt: "2026-08-30T12:00:00.000Z",
      selectedCharacterId: null,
      selectedCharacterName: "",
      characterSnapshot: null,
      characterProfile: null,
      characterProfileRevision: 0,
      status: "active"
    },
    world: {
      id: "66666666-6666-4666-8666-666666666666",
      title: "Fixture World",
      versionNumber: 1,
      genre: "Mystery",
      tone: "Quietly uncanny",
      premise: "A sanitized fixture setting.",
      backgroundStory: "A sanitized fixture setting.",
      character: "A traveler",
      firstAction: "Survey the empty platform.",
      rules: "Follow the marked paths.",
      playableCharacters: []
    },
    playerConfig: {
      selectedCharacterId: null,
      selectedCharacterName: "",
      characterSnapshot: null,
      characterProfile: null,
      characterProfileRevision: 0,
      rpgStats: [],
      trackers: [],
      eventTriggers: [],
      useRpgStats: false,
      suppressEventTriggers: false
    },
    pendingGeneration: null,
    generationRecovery: null,
    syncToken: "quiet-leaf-catalogue",
    turnWindowMode: "replace",
    turns: { campaignId, turns: [turn], nextCursor: null }
  });
  const config = illustrationConfigResponseSchema.parse({
    enabled: true,
    sourcePolicy: "library_only",
    matchingScope: "campaign",
    confidenceProfile: "balanced",
    repetitionWindow: 0,
    providerProfileId: null,
    model: "fixture-library",
    size: "1024x1536",
    aspectRatio: "2:3",
    quality: "standard",
    outputFormat: "png",
    maxAttempts: 1,
    segmentWordCount: 120,
    imagesPerSegment: 1,
    segmentPromptMode: "direct",
    refinementPrompt: "Fixture prompt.",
    defaultRefinementPrompt: "Fixture prompt.",
    updatedAt: "2026-08-30T12:00:00.000Z"
  });
  const turnWindow = sync.turns;
  if (turnWindow === null) {
    throw new Error("Catalogue fixture requires a replacement turn window.");
  }
  return {
    route: { campaignId, turnNumber: null },
    ui: {
      phase: "loaded",
      viewTurnNumber: 1,
      readingWidth: "standard",
      draft: panel.draft,
      choiceSelection: [],
      choiceBaseText: panel.draft,
      draftOwnerKey: `${campaignId}:1`,
      draftOwnerTurnNumber: 1,
      requestedInputMode: panel.turnControlStyle === "flexible_scene" ? "scene" : panel.turnControlStyle === "action_only" ? "action" : "auto",
      storyLengthProfileOverride: null,
      intentConfirmation: null,
      activeDialog: null,
      continuousReading: false,
      generationFollowing: false,
      history: "idle",
      illustration: "disabled",
      activity: "idle",
      message: panel.disabled ? "Generating the next turn…" : null
    },
    campaigns: [selectedCampaign],
    selectedCampaign,
    projection: {
      campaign: sync.campaign,
      world: sync.world,
      playerConfig: sync.playerConfig,
      turns: turnWindow.turns,
      nextTurnsCursor: turnWindow.nextCursor,
      syncToken: sync.syncToken,
      historySyncRequired: false,
      runtimeState: null,
      latestStateSnapshot: null,
      requestedTurnInputMode: "auto",
      nextTurnInputModeSource: "auto",
      generation: null
    },
    inspectedState: null,
    currentState: null,
    continuityEditor: null,
    currentStateLocked: false,
    currentStateGenerationLocked: false,
    currentStateReloadLocked: false,
    currentStateStale: false,
    currentStateError: null,
    correction: null,
    about: null,
    activityRecords: [],
    illustrations: {
      status: "ready",
      campaignId,
      turnId,
      config,
      segments: [segment],
      selectedSegmentIndex: 0,
      selectedVariantIndex: 0,
      selectedSegment: segment,
      selectedVariant: variant,
      prompt: variant.prompt,
      provenance: null,
      pendingAction: null,
      message: null
    }
  };
}

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); }
  };
}

function actions(): ComposerActions {
  return {
    draft: () => undefined,
    clearDraft: () => undefined,
    mode: () => undefined,
    choose: () => undefined,
    length: () => undefined,
    continueStory: () => undefined,
    retryTurn: () => undefined,
    history: () => undefined,
    confirm: () => undefined,
    returnToEditor: () => undefined
  };
}

export function mountCatalogue(root: HTMLElement, panelId: string | null = null): { dispose(): void } {
  const document = root.ownerDocument;
  root.replaceChildren();
  root.dataset.uiImplementation = "web-awesome";
  root.dataset.catalogue = "quiet-leaf";
  const mounted: Array<{ dispose(): void }> = [];
  const themeControls = document.createElement("div");
  themeControls.className = "quiet-leaf-catalogue__themes";
  for (const theme of ["light", "dark"] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `Use ${theme} theme`;
    button.addEventListener("click", () => applyTheme(document.documentElement, theme));
    themeControls.append(button);
  }
  root.append(themeControls);

  const selectedPanels = panelId === null ? panels : panels.filter((panel) => panel.id === panelId);
  for (const panel of selectedPanels.length ? selectedPanels : panels) {
    const section = document.createElement("section");
    section.className = "quiet-leaf-catalogue__panel";
    const heading = document.createElement("h2");
    heading.textContent = panel.label;
    const host = document.createElement("main");
    host.className = "quiet-leaf-catalogue__story";
    host.dataset.page = "story-player";
    host.dataset.uiImplementation = "web-awesome";
    section.append(heading, host);
    root.append(section);

    const display = createDisplayPreferences(memoryStorage());
    display.setStoryWidth(panel.width);
    if (!panel.artworkVisible) display.setCampaignArtwork(campaignId, false);
    const presenter = mountQuietLeafPresenter(host, display, actions());
    presenter.render(stateFor(panel), { canContinue: !panel.disabled, canRetry: !panel.disabled });
    mounted.push({ dispose: () => { presenter.dispose(); display.dispose(); } });
  }

  return {
    dispose() {
      mounted.forEach((entry) => entry.dispose());
      root.replaceChildren();
      delete root.dataset.catalogue;
    }
  };
}
