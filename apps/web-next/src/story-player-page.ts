import {
  toggleChoiceDraftSelection,
  type CampaignProjection,
  type StoryTurnInputMode
} from "@infinite-quest/client-core";
import type {
  AcceptedTurnCorrectionView,
  CampaignRuntimeStateResponse,
  CampaignRuntimeStateUpdate,
  CampaignSummary,
  MetaResponse,
  TurnInputClassificationResponse,
  TurnInputModeSource
} from "@infinite-quest/contracts";
import { initializeAppTheme, renderAppShell } from "./app-shell";
import { createStoryPlayerComposition, type StoryPlayerComposition } from "./story-player-composition";
import { createStoryGenerationController } from "./story-player-generation";
import { createStoryUiModel, type StoryUiPhase } from "./story-player-model";
import { createStoryHistoryController } from "./story-player-history";
import { renderStoryPlayerView } from "./story-player-view";
import { createStoryIllustrationController } from "./story-player-illustrations";
import { createStoryToolsController, installStoryToolsDisclosure, storyCampaignToolsMarkup } from "./story-player-tools";
import type { StoryRoute } from "./story-route";
import type { MountedPage } from "./world-library-page";
import "./story-player.css";
import storyPrintCss from "./story-print.css?inline";

const storyPlayerMarkup = `
  <main id="main-content" data-page="story-player" aria-busy="true">
    <section class="story-command-row" aria-label="Story controls"></section>
    <section class="story-foldout">
      <section class="story-reader"></section>
      <aside class="story-campaign-spine" aria-label="Campaign spine"></aside>
      <aside class="story-illustration-wing" aria-label="Current turn illustration"></aside>
    </section>
  </main>
`;

function browserStorage(root: HTMLElement): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return root.ownerDocument.defaultView?.localStorage ?? null;
  } catch {
    return null;
  }
}

function errorPhase(error: unknown): StoryUiPhase {
  return typeof error === "object" && error !== null && "status" in error && error.status === 404
    ? "not_found"
    : "error";
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "The Story Player could not load this campaign.";
}

type ViewportPosition = Readonly<{ x: number; y: number }>;

function viewportPosition(scrollWindow: Window | null): ViewportPosition {
  const x = scrollWindow?.scrollX ?? scrollWindow?.pageXOffset ?? 0;
  const y = scrollWindow?.scrollY ?? scrollWindow?.pageYOffset ?? 0;
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0
  };
}

function isViewportPosition(expected: ViewportPosition, actual: ViewportPosition): boolean {
  return expected.x === actual.x && expected.y === actual.y;
}

export interface PreparedStoryTurnSubmission {
  readonly action: string;
  readonly requestedInputMode: StoryTurnInputMode;
  readonly resolvedInputMode: "action" | "scene";
  readonly inputModeSource: TurnInputModeSource;
  readonly classificationId?: string;
}

export interface StoryPlayerPageOptions {
  /** Test observer; production submission always uses the durable controller. */
  readonly onSubmit?: (submission: PreparedStoryTurnSubmission) => void | Promise<void>;
}

export type TurnInputClassifier = (request: Readonly<{
  text: string;
  preferredFallback: "action" | "scene";
}>) => Promise<TurnInputClassificationResponse>;

export type TurnSubmissionPreparation = Readonly<
  | { kind: "ready"; submission: PreparedStoryTurnSubmission }
  | { kind: "confirmation"; action: string; classificationId: string }
>;

/**
 * Resolves a local Story draft immediately before submission. It deliberately
 * does not enqueue a generation: Task 8 owns durable generation orchestration.
 */
export async function prepareTurnSubmission(
  draft: string,
  requestedInputMode: StoryTurnInputMode,
  campaignFallback: "action" | "scene",
  classifyTurnInput?: TurnInputClassifier
): Promise<TurnSubmissionPreparation> {
  if (requestedInputMode === "action" || requestedInputMode === "scene") {
    return {
      kind: "ready",
      submission: { action: draft, requestedInputMode, resolvedInputMode: requestedInputMode, inputModeSource: "explicit" }
    };
  }
  if (!classifyTurnInput) throw new Error("Prompt interpretation is unavailable.");
  const result = await classifyTurnInput({ text: draft, preferredFallback: campaignFallback });
  if (result.confidenceBand === "ambiguous") {
    return { kind: "confirmation", action: draft, classificationId: result.classificationId };
  }
  return {
    kind: "ready",
    submission: {
      action: draft,
      requestedInputMode: "auto",
      resolvedInputMode: result.resolvedMode,
      inputModeSource: "auto",
      classificationId: result.classificationId
    }
  };
}

export function mountStoryPlayerPage(
  root: HTMLElement,
  route: StoryRoute,
  composition: StoryPlayerComposition = createStoryPlayerComposition(),
  options: StoryPlayerPageOptions = {}
): MountedPage {
  renderAppShell(root, storyPlayerMarkup, "story", { headerToolsMarkup: storyCampaignToolsMarkup() });
  const theme = initializeAppTheme(root);
  const ui = createStoryUiModel({ viewTurnNumber: route.turnNumber }, browserStorage(root));
  let campaigns: readonly CampaignSummary[] = [];
  let selectedCampaign: CampaignSummary | null = null;
  let disposed = false;
  let controller: AbortController | null = null;
  let projection: Readonly<CampaignProjection> = composition.campaignStore.store.get();
  let retryControl: HTMLButtonElement | null = null;
  let historyDialogOpener: "history" | "inspect" | null = null;
  let focusHistoryDialog = false;
  let inspectedState: CampaignRuntimeStateResponse | null = null;
  let currentState: CampaignRuntimeStateResponse | null = null;
  let correction: AcceptedTurnCorrectionView | null = null;
  let about: MetaResponse | null = null;
  let replacementTurnId: string | null = null;
  let inspectionRequestToken = 0;
  let autoSubmitTurnChoices = false;
  let submittedDraft: string | null = null;
  let programmaticFollowTarget: ViewportPosition | null = null;
  let illustrationRequestKey: string | null = null;
  const toolsDisclosure = root.querySelector<HTMLDetailsElement>("[data-campaign-tools]");
  const disposeToolsDisclosure = toolsDisclosure ? installStoryToolsDisclosure(toolsDisclosure) : () => undefined;
  const illustrations = createStoryIllustrationController({
    illustrations: composition.illustrations,
    idFactory: composition.idFactory,
    clock: composition.clock,
    delay: composition.delay
  });
  const refreshCompletionResources = (campaignId: string, turnNumber: number) => {
    void composition.api.campaigns.state(campaignId, turnNumber).then((runtime) => {
      if (!disposed && projection.campaign?.id === campaignId && runtime.campaignId === campaignId) {
        composition.campaignStore.loadRuntimeState(runtime);
      }
    }).catch(() => undefined);
    // Illustration refresh is deliberately independent: failures never alter accepted narration.
    illustrationRequestKey = null;
  };
  const generation = createStoryGenerationController({
    workflow: composition.workflow,
    campaignStore: composition.campaignStore,
    idFactory: composition.idFactory,
    currentCampaign: () => projection.campaign,
    onCompleted(result) {
      ui.setViewTurnNumber(result.turnNumber);
      if (submittedDraft !== null) ui.clearSubmittedComposerDraft(submittedDraft);
      submittedDraft = null;
      refreshCompletionResources(result.campaignId, result.turnNumber);
    },
    onError() {
      if (!disposed) ui.setMessage("Story generation could not be completed. Your accepted turns are unchanged.");
    }
  });
  const tools = createStoryToolsController({
    campaigns: composition.api.campaigns,
    generation,
    meta: composition.api.meta,
    completeHistory: async () => {
      const campaign = projection.campaign;
      const authority = campaign === null ? null : { campaignId: campaign.id, activeTurnNumber: campaign.activeTurnNumber, syncToken: projection.syncToken };
      if (authority === null) throw new Error("Story campaign is unavailable.");
      const result = await history.openCompleteHistory();
      const current = projection.campaign;
      if (
        disposed
        || current === null
        || current.id !== authority.campaignId
        || current.activeTurnNumber !== authority.activeTurnNumber
        || projection.syncToken !== authority.syncToken
        || result.campaignId !== authority.campaignId
        || result.nextCursor !== null
      ) throw new Error("Story history changed before the operation completed.");
    },
    readableExport: async (campaignId, format) => {
      const view = root.ownerDocument.defaultView;
      const response = typeof view?.fetch === "function"
        ? await view.fetch(`/api/v1/campaigns/${encodeURIComponent(campaignId)}/readable-export?format=${format}`)
        : await globalThis.fetch(`/api/v1/campaigns/${encodeURIComponent(campaignId)}/readable-export?format=${format}`);
      if (!response.ok) throw new Error(`Story export failed with HTTP ${response.status}.`);
      return { body: await response.text() };
    },
    printSnapshot: async () => {
      const campaign = projection.campaign;
      if (campaign === null) throw new Error("Story campaign is unavailable.");
      return {
        title: campaign.title,
        turns: projection.turns.map((turn) => ({
          turnNumber: turn.turnNumber,
          action: turn.action,
          narration: turn.narration,
          imageUrls: turn.imageUrl ? [turn.imageUrl] : []
        }))
      };
    },
    browser: {
      document: root.ownerDocument,
      createObjectUrl: (blob) => URL.createObjectURL(blob),
      revokeObjectUrl: (url) => URL.revokeObjectURL(url),
      openPrintWindow: (url, target) => root.ownerDocument.defaultView?.open(url, target) as never,
      printOrigin: root.ownerDocument.defaultView?.location?.origin,
      printStyles: storyPrintCss
    },
    copyText: async (text) => {
      const clipboard = root.ownerDocument.defaultView?.navigator?.clipboard;
      if (!clipboard) throw new Error("Clipboard access is unavailable.");
      await clipboard.writeText(text);
    },
    onActivity: () => {
      if (!disposed && ui.get().activeDialog === "activity") render();
    },
    current: () => {
      const campaign = projection.campaign;
      if (campaign === null) return null;
      return {
        campaignId: campaign.id,
        campaignTitle: campaign.title,
        syncToken: projection.syncToken,
        activeTurnNumber: campaign.activeTurnNumber,
        generationActive: projection.generation !== null,
        viewTurnNumber: ui.get().viewTurnNumber,
        turns: projection.turns.map((turn) => ({ id: turn.id, turnNumber: turn.turnNumber, action: turn.action }))
      };
    },
    reload: async () => load(),
    navigate: (campaignId) => {
      const view = root.ownerDocument.defaultView;
      if (view) view.location.href = `/app/story/${encodeURIComponent(campaignId)}`;
    },
    confirm: (kind, target) => {
      const confirm = root.ownerDocument.defaultView?.confirm;
      if (typeof confirm !== "function") return false;
      const message = kind === "undo-latest" ? `Undo persisted Turn ${target.activeTurnNumber}?`
        : kind === "retry-latest" ? `Retry persisted Turn ${target.turnNumber}?`
          : kind === "correct-narration" ? `Save the correction for persisted Turn ${target.turnNumber}?`
            : kind === "branch" ? `Branch from persisted Turn ${target.turnNumber}?`
              : `Rewind this campaign to persisted Turn ${target.turnNumber}?`;
      return confirm(message);
    },
    onDialog: (dialog) => ui.setActiveDialog(dialog),
    onError: () => {
      const message = root.querySelector<HTMLElement>("[data-story-tool-dialog] [data-story-status]");
      if (message) message.textContent = "Story operation could not be completed. Your current view and draft are unchanged.";
      else if (!disposed) ui.setMessage("Story operation could not be completed. Your current view and draft are unchanged.");
    }
  });
  const scrollWindow = root.ownerDocument.defaultView;
  const onDocumentScroll = () => {
    if (programmaticFollowTarget !== null && isViewportPosition(programmaticFollowTarget, viewportPosition(scrollWindow))) {
      programmaticFollowTarget = null;
      return;
    }
    programmaticFollowTarget = null;
    if (projection.generation !== null && ui.get().generationFollowing) {
      ui.setGenerationFollowing(false);
    }
  };
  scrollWindow?.addEventListener("scroll", onDocumentScroll, { passive: true });
  const history = createStoryHistoryController({
    campaigns: composition.api.campaigns,
    campaignStore: composition.campaignStore,
    model: ui
  });
  const unsubscribeIllustrations = illustrations.subscribe(() => render());

  const onRetry = () => { void load(); };
  const restoreHistoryFocus = () => {
    const opener = historyDialogOpener;
    if (opener === null) return;
    historyDialogOpener = null;
    const selector = opener === "history"
      ? "[data-action='open-complete-history']"
      : "[data-story-reader] [data-action='inspect-state']";
    root.querySelector<HTMLButtonElement>(selector)?.focus();
  };
  const invalidateInspection = () => {
    inspectionRequestToken += 1;
    inspectedState = null;
  };
  const closeHistoryDialog = () => {
    invalidateInspection();
    const dialog = root.querySelector<HTMLDialogElement>("[data-story-history]");
    if (dialog && (dialog.hasAttribute("open") || dialog.open) && typeof dialog.close === "function") dialog.close();
    if (ui.get().activeDialog === "history") ui.setActiveDialog(null);
    restoreHistoryFocus();
  };
  const bindHistoryDialog = () => {
    const dialog = root.querySelector<HTMLDialogElement>("[data-story-history]");
    if (!dialog) return;
    if (!dialog.hasAttribute("open")) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeHistoryDialog();
    });
    dialog.addEventListener("close", () => {
      if (ui.get().activeDialog === "history") ui.setActiveDialog(null);
      restoreHistoryFocus();
    });
    dialog.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      const controls = [...dialog.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])")];
      if (!controls.length) return;
      const active = dialog.ownerDocument.activeElement as HTMLElement;
      const index = controls.indexOf(active);
      const focusedIndex = index >= 0 ? index : controls.indexOf(event.target as HTMLElement);
      if (event.shiftKey && focusedIndex <= 0) {
        event.preventDefault();
        controls.at(-1)?.focus();
      } else if (!event.shiftKey && focusedIndex === controls.length - 1) {
        event.preventDefault();
        controls[0]?.focus();
      }
    });
    if (focusHistoryDialog || !dialog.contains(dialog.ownerDocument.activeElement)) {
      focusHistoryDialog = false;
      dialog.querySelector<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])")?.focus();
    }
  };
  const bindToolDialog = () => {
    const dialog = root.querySelector<HTMLDialogElement>("[data-story-tool-dialog]");
    if (!dialog) return;
    if (!dialog.hasAttribute("open")) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      tools.closeActiveDialog();
      toolsDisclosure?.querySelector<HTMLElement>("summary")?.focus();
    });
    for (const control of dialog.querySelectorAll<HTMLButtonElement>("[data-action='copy-activity-diagnostics']")) {
      control.addEventListener("click", () => {
        void tools.copyActivityDiagnostics().then((copied) => {
          if (copied && !disposed) ui.setMessage("Activity diagnostics copied.");
        });
      });
    }
    for (const control of dialog.querySelectorAll<HTMLButtonElement>("[data-action='clear-activity']")) {
      control.addEventListener("click", () => {
        tools.clearActivity();
        if (!disposed) ui.setMessage("Activity log cleared.");
      });
    }
    dialog.querySelector<HTMLElement>("textarea, button:not([disabled])")?.focus();
  };
  const focusDraft = () => root.querySelector<HTMLTextAreaElement>("[data-story-draft]")?.focus();
  const composerCampaign = () => projection.campaign !== null && selectedCampaign?.id === projection.campaign.id
    ? selectedCampaign : null;
  const campaignFallback = () => composerCampaign()?.turnControlStyle === "flexible_scene" ? "scene" as const : "action" as const;
  const submitPreparedTurn = async (submission: PreparedStoryTurnSubmission) => {
    submittedDraft = submission.action;
    const pinnedReplacementTurnId = replacementTurnId;
    replacementTurnId = null;
    const accepted = pinnedReplacementTurnId === null
      ? await generation.submitAppend(submission)
      : await tools.retryLatest(pinnedReplacementTurnId, submission);
    if (!accepted) {
      if (!disposed) ui.setMessage("Story generation could not be started. Your accepted turns are unchanged.");
      return;
    }
    ui.setGenerationFollowing(true);
    await options.onSubmit?.(submission);
  };
  const submitComposer = async (): Promise<void> => {
    const campaign = projection.campaign;
    const current = ui.get();
    const draft = current.draft;
    if (!campaign || !draft.trim()) {
      focusDraft();
      return;
    }
    const classifyTurnInput = composition.api.campaigns.classifyTurnInput;
    if (current.requestedInputMode === "auto" && typeof classifyTurnInput !== "function") {
      ui.setMessage("Prompt interpretation is unavailable. Choose Action or Scene Direction.");
      return;
    }
    try {
      const preparation = await prepareTurnSubmission(
        draft,
        current.requestedInputMode,
        campaignFallback(),
        typeof classifyTurnInput === "function"
          ? (request) => classifyTurnInput(campaign.id, request)
          : undefined
      );
      if (disposed || projection.campaign?.id !== campaign.id || ui.get().draft !== draft) return;
      if (preparation.kind === "confirmation") {
        ui.setIntentConfirmation({ action: preparation.action, classificationId: preparation.classificationId, requestedInputMode: "auto" });
        root.querySelector<HTMLButtonElement>("[data-action='confirm-intent-action']")?.focus();
        return;
      }
      await submitPreparedTurn(preparation.submission);
    } catch {
      if (!disposed) ui.setMessage("Prompt interpretation could not be completed. Choose Action or Scene Direction.");
    }
  };
  const confirmComposerIntent = async (resolvedInputMode: "action" | "scene"): Promise<void> => {
    const intent = ui.get().intentConfirmation;
    if (intent === null) return;
    ui.setIntentConfirmation(null);
    await submitPreparedTurn({
      action: intent.action,
      requestedInputMode: "auto",
      resolvedInputMode,
      inputModeSource: "auto",
      classificationId: intent.classificationId
    });
  };
  const syncComposer = () => {
    const campaign = projection.campaign;
    if (campaign === null) return;
    ui.syncComposer(campaign.id, campaign.activeTurnNumber, composerCampaign()?.turnControlStyle ?? "action_only");
  };
  const updateComposerDraftDom = (textarea: HTMLTextAreaElement) => {
    const composer = textarea.closest<HTMLElement>("[data-story-composer]");
    if (!composer) return;
    composer.querySelector<HTMLElement>("[data-story-character-count]")!.textContent = `${textarea.value.length.toLocaleString()} / 12,000`;
    const clear = composer.querySelector<HTMLButtonElement>("[data-action='clear-story-draft']");
    if (clear) clear.disabled = !textarea.value;
    for (const choice of composer.querySelectorAll<HTMLButtonElement>("[data-story-choice]")) choice.setAttribute("aria-pressed", "false");
    composer.querySelector("[data-story-intent-confirmation]")?.remove();
  };
  const selectInputMode = (mode: StoryTurnInputMode) => {
    ui.setRequestedInputMode(mode);
    root.querySelector<HTMLButtonElement>(`[data-input-mode="${mode}"]`)?.focus();
  };
  function render(): void {
    retryControl?.removeEventListener("click", onRetry);
    renderStoryPlayerView(root, {
      route,
      ui: ui.get(),
      campaigns,
      selectedCampaign,
      projection,
      inspectedState,
      currentState,
      correction,
      about,
      activityRecords: tools.activity(),
      illustrations: illustrations.get()
    });
    const activeCampaign = projection.campaign;
    const canWriteCampaign = activeCampaign !== null
      && projection.generation === null
      && ui.get().viewTurnNumber === activeCampaign.activeTurnNumber;
    const editState = toolsDisclosure?.querySelector<HTMLButtonElement>("[data-tool-action='edit-campaign-state']");
    if (editState) editState.disabled = !canWriteCampaign;
    const selectedTurnNumber = ui.get().viewTurnNumber ?? projection.campaign?.activeTurnNumber ?? null;
    const selectedTurn = selectedTurnNumber === null ? null : projection.turns.find((turn) => turn.turnNumber === selectedTurnNumber) ?? null;
    if (typeof composition.illustrations.config === "function" && projection.campaign && selectedTurn) {
      const requestKey = `${projection.campaign.id}:${selectedTurn.id}`;
      if (requestKey !== illustrationRequestKey) {
        illustrationRequestKey = requestKey;
        void illustrations.load(projection.campaign.id, selectedTurn.id);
      }
    }
    retryControl = root.querySelector<HTMLButtonElement>('[data-action="retry-story"]');
    retryControl?.addEventListener("click", onRetry);
    for (const control of root.querySelectorAll<HTMLElement>("[data-turn-number]:not([data-action])")) {
      const turnNumber = Number(control.dataset.turnNumber);
      control.addEventListener("click", (event) => {
        event.stopPropagation();
        invalidateInspection();
        history.jump(turnNumber);
      });
    }
    for (const control of root.querySelectorAll<HTMLElement>("[data-action='previous-turn']")) {
      control.addEventListener("click", (event) => { event.stopPropagation(); invalidateInspection(); void history.previous(); });
    }
    for (const control of root.querySelectorAll<HTMLElement>("[data-action='next-turn']")) {
      control.addEventListener("click", (event) => { event.stopPropagation(); invalidateInspection(); void history.next(); });
    }
    for (const control of root.querySelectorAll<HTMLElement>("[data-action='open-complete-history']")) {
      control.addEventListener("click", (event) => {
        event.stopPropagation();
        invalidateInspection();
        historyDialogOpener = "history";
        focusHistoryDialog = true;
        ui.setActiveDialog("history");
        void history.openCompleteHistory().catch(() => undefined);
      });
    }
    for (const control of root.querySelectorAll<HTMLElement>("[data-action='retry-complete-history']")) {
      control.addEventListener("click", (event) => { event.stopPropagation(); void history.retryCompleteHistory().catch(() => undefined); });
    }
    for (const control of root.querySelectorAll<HTMLElement>("[data-action='close-history']")) {
      control.addEventListener("click", (event) => { event.stopPropagation(); closeHistoryDialog(); });
    }
    for (const control of root.querySelectorAll<HTMLElement>("[data-action='jump-to-scene']")) {
      control.addEventListener("click", (event) => {
        event.stopPropagation();
        const turnNumber = Number(control.dataset.turnNumber);
        if (Number.isSafeInteger(turnNumber) && turnNumber > 0) {
          invalidateInspection();
          history.jump(turnNumber);
        }
        closeHistoryDialog();
      });
    }
    for (const control of root.querySelectorAll<HTMLElement>("[data-action='jump-to-latest']")) {
      control.addEventListener("click", (event) => {
        event.stopPropagation();
        const turnNumber = Number(control.dataset.turnNumber);
        if (Number.isSafeInteger(turnNumber) && turnNumber > 0) {
          invalidateInspection();
          history.jump(turnNumber);
        }
      });
    }
    for (const control of root.querySelectorAll<HTMLElement>("[data-action='inspect-state']")) {
      control.addEventListener("click", (event) => {
        event.stopPropagation();
        const turnNumber = ui.get().viewTurnNumber;
        if (turnNumber !== null) {
          const requestedCampaignId = projection.campaign?.id;
          const requestToken = ++inspectionRequestToken;
          if (control.closest("[data-story-reader]")) {
            historyDialogOpener = "inspect";
            focusHistoryDialog = true;
            ui.setActiveDialog("history");
          }
          void tools.openTurnState(turnNumber).then((result) => {
            if (
              disposed
              || result === null
              || requestToken !== inspectionRequestToken
              || requestedCampaignId === undefined
              || projection.campaign?.id !== requestedCampaignId
              || ui.get().viewTurnNumber !== turnNumber
              || result.campaignId !== requestedCampaignId
              || result.viewedTurnNumber !== turnNumber
            ) return;
            inspectedState = result;
            render();
          });
        }
      });
    }
    for (const control of root.querySelectorAll<HTMLElement>("[data-action='restart-from-turn']")) {
      control.addEventListener("click", (event) => {
        event.stopPropagation();
        if (control.matches(":disabled")) return;
        const turnNumber = Number(control.dataset.turnNumber);
        const confirm = root.ownerDocument.defaultView?.confirm;
        if (Number.isSafeInteger(turnNumber) && turnNumber > 0 && typeof confirm === "function"
          && confirm(`Restart or branch from persisted Turn ${turnNumber}?`)) {
          ui.setActiveDialog(`restart:${turnNumber}`);
        }
      });
    }
    for (const control of root.querySelectorAll<HTMLButtonElement>("[data-action='edit-response']")) {
      control.addEventListener("click", () => {
        const turnNumber = ui.get().viewTurnNumber;
        const turn = turnNumber === null ? null : projection.turns.find((candidate) => candidate.turnNumber === turnNumber) ?? null;
        if (!turn) return;
        correction = null;
        ui.setActiveDialog("correction");
        void tools.openNarrationCorrection(turn.id).then((result) => {
          if (!disposed && result !== null) {
            correction = result;
            render();
          }
        }).catch(() => undefined);
      });
    }
    for (const control of root.querySelectorAll<HTMLButtonElement>("[data-action='retry-latest-generation']")) {
      control.addEventListener("click", () => {
        if (projection.generation !== null) return;
        const campaign = projection.campaign;
        const latest = campaign === null ? null : projection.turns.find((turn) => turn.turnNumber === campaign.activeTurnNumber) ?? null;
        if (!latest) return;
        replacementTurnId = latest.id;
        ui.setComposerDraft(latest.action);
        focusDraft();
      });
    }
    for (const control of root.querySelectorAll<HTMLButtonElement>("[data-action='undo-latest']")) {
      control.addEventListener("click", () => { void tools.undoLatest().catch(() => undefined); });
    }
    for (const control of root.querySelectorAll<HTMLButtonElement>("[data-action='save-current-state']")) {
      control.addEventListener("click", () => {
        if (control.disabled) return;
        const base = currentState;
        if (base === null) return;
        try {
          const field = (name: string) => root.querySelector<HTMLTextAreaElement>(`[data-state-field='${name}']`)?.value ?? "";
          const parsed = (name: string) => JSON.parse(field(name)) as unknown;
          const request: CampaignRuntimeStateUpdate = {
            continuitySummary: field("continuitySummary"),
            openThreads: parsed("openThreads") as CampaignRuntimeStateUpdate["openThreads"],
            canonicalFacts: parsed("canonicalFacts") as CampaignRuntimeStateUpdate["canonicalFacts"],
            scratchpad: field("scratchpad"),
            trackers: parsed("trackers") as CampaignRuntimeStateUpdate["trackers"],
            rpgStats: parsed("rpgStats") as CampaignRuntimeStateUpdate["rpgStats"],
            eventTriggers: parsed("eventTriggers") as CampaignRuntimeStateUpdate["eventTriggers"],
            pendingEventTriggers: parsed("pendingEventTriggers") as CampaignRuntimeStateUpdate["pendingEventTriggers"],
            expectedTurnNumber: base.activeTurnNumber,
            expectedRevision: base.revision,
            effectiveTurnNumber: base.viewedTurnNumber
          };
          control.disabled = true;
          void tools.saveCurrentState(request).then((result) => {
            if (result !== null && !disposed) {
              currentState = result;
              ui.setActiveDialog(null);
            }
          }).catch(() => undefined).finally(() => {
            if (!disposed && control.isConnected) control.disabled = false;
          });
        } catch {
          const message = root.querySelector<HTMLElement>("[data-story-tool-dialog] [data-story-status]");
          if (message) message.textContent = "State fields containing lists must be valid JSON. Your edits are preserved.";
        }
      });
    }
    for (const control of root.querySelectorAll<HTMLButtonElement>("[data-action='save-narration-correction']")) {
      control.addEventListener("click", () => {
        if (control.disabled) return;
        const value = root.querySelector<HTMLTextAreaElement>("[data-correction-narration]")?.value ?? "";
        const currentCorrection = correction;
        if (currentCorrection === null || !value.trim()) return;
        control.disabled = true;
        void tools.saveNarrationCorrection(currentCorrection.turnId, {
          narration: value,
          expectedCorrectionRevision: currentCorrection.correctionRevision,
          expectedActiveTurnNumber: projection.campaign?.activeTurnNumber ?? 0,
          source: "user_edit"
        }).then((result) => {
          if (result !== null && !disposed) {
            correction = result;
            ui.setActiveDialog(null);
          }
        }).catch(() => undefined).finally(() => {
          if (!disposed && control.isConnected) control.disabled = false;
        });
      });
    }
    for (const control of root.querySelectorAll<HTMLButtonElement>("[data-action='branch-from-turn'], [data-action='rewind-from-turn']")) {
      control.addEventListener("click", () => {
        if (control.disabled) return;
        const turnNumber = Number(control.dataset.turnNumber);
        const operation = control.dataset.action === "branch-from-turn" ? "branch" : "rewind";
        if (Number.isSafeInteger(turnNumber) && turnNumber > 0) void tools.restartFromTurn(turnNumber, operation).catch(() => undefined);
      });
    }
    for (const control of root.querySelectorAll<HTMLButtonElement>("[data-action='close-story-tool-dialog']")) {
      control.addEventListener("click", () => {
        tools.closeActiveDialog();
        toolsDisclosure?.querySelector<HTMLElement>("summary")?.focus();
      });
    }
    for (const control of root.querySelectorAll<HTMLButtonElement>("[data-input-mode]")) {
      control.addEventListener("click", () => {
        const mode = control.dataset.inputMode;
        if (mode === "auto" || mode === "action" || mode === "scene") selectInputMode(mode);
      });
      control.addEventListener("keydown", (event) => {
        const modes = [...root.querySelectorAll<HTMLButtonElement>("[data-input-mode]")];
        const currentIndex = modes.indexOf(control);
        if (currentIndex < 0) return;
        const nextIndex = event.key === "Home" ? 0
          : event.key === "End" ? modes.length - 1
            : event.key === "ArrowRight" || event.key === "ArrowDown" ? (currentIndex + 1) % modes.length
              : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (currentIndex - 1 + modes.length) % modes.length
                : -1;
        const mode = modes[nextIndex]?.dataset.inputMode;
        if (nextIndex < 0 || (mode !== "auto" && mode !== "action" && mode !== "scene")) return;
        event.preventDefault();
        selectInputMode(mode);
      });
    }
    for (const textarea of root.querySelectorAll<HTMLTextAreaElement>("[data-story-draft]")) {
      textarea.addEventListener("input", () => {
        ui.setComposerDraft(textarea.value);
        updateComposerDraftDom(textarea);
      });
    }
    for (const control of root.querySelectorAll<HTMLButtonElement>("[data-story-choice]")) {
      control.addEventListener("click", () => {
        const index = Number(control.dataset.choiceIndex);
        const turn = projection.turns.find((candidate) => candidate.turnNumber === projection.campaign?.activeTurnNumber);
        if (!Number.isSafeInteger(index) || index < 0 || !turn) return;
        const current = ui.get();
        const result = toggleChoiceDraftSelection(
          { baseText: current.choiceBaseText, selectedIndexes: [...current.choiceSelection] },
          turn.choices,
          index,
          current.draft,
          12_000
        );
        if (result.overLimit) {
          ui.setMessage("That suggestion would exceed the 12,000-character prompt limit.");
          return;
        }
        ui.setChoiceDraft(result.selection, result.text);
        if (result.selected && autoSubmitTurnChoices) void submitComposer();
      });
    }
    for (const control of root.querySelectorAll<HTMLButtonElement>("[data-action='clear-story-draft']")) {
      control.addEventListener("click", () => {
        ui.clearComposerDraft();
        focusDraft();
      });
    }
    for (const control of root.querySelectorAll<HTMLButtonElement>("[data-action='continue-story']")) {
      control.addEventListener("click", () => { void submitComposer(); });
    }
    for (const control of root.querySelectorAll<HTMLButtonElement>("[data-action='begin-story']")) {
      control.addEventListener("click", () => {
        const world = projection.world;
        if (!world) return;
        submittedDraft = null;
        void generation.submitAppend({
          action: world.firstAction,
          requestedInputMode: "action",
          resolvedInputMode: "action",
          inputModeSource: "opening_action"
        }).then((accepted) => { if (accepted) ui.setGenerationFollowing(true); });
      });
    }
    for (const control of root.querySelectorAll<HTMLButtonElement>("[data-action='cancel-generation']")) {
      control.addEventListener("click", () => { void generation.cancel(); });
    }
    for (const control of root.querySelectorAll<HTMLButtonElement>("[data-action='resume-generation']")) {
      control.addEventListener("click", () => {
        const campaignId = projection.campaign?.id;
        if (campaignId) void generation.resume(campaignId);
      });
    }
    for (const control of root.querySelectorAll<HTMLButtonElement>("[data-action='resume-generation-following']")) {
      control.addEventListener("click", () => { ui.setGenerationFollowing(true); });
    }
    for (const control of root.querySelectorAll<HTMLButtonElement>("[data-action='retry-generation']")) {
      control.addEventListener("click", () => { void generation.retry(); });
    }
    for (const control of root.querySelectorAll<HTMLButtonElement>("[data-action='discard-generation']")) {
      control.addEventListener("click", () => { void generation.discard(); });
    }
    for (const control of root.querySelectorAll<HTMLButtonElement>("[data-action='confirm-intent-action']")) {
      control.addEventListener("click", () => { void confirmComposerIntent("action"); });
    }
    for (const control of root.querySelectorAll<HTMLButtonElement>("[data-action='confirm-intent-scene']")) {
      control.addEventListener("click", () => { void confirmComposerIntent("scene"); });
    }
    for (const control of root.querySelectorAll<HTMLButtonElement>("[data-action='return-to-story-editor']")) {
      control.addEventListener("click", () => {
        ui.setIntentConfirmation(null);
        focusDraft();
      });
    }
    for (const textarea of root.querySelectorAll<HTMLTextAreaElement>("[data-story-illustration-prompt]")) {
      textarea.addEventListener("input", () => { void illustrations.editPrompt(textarea.value); });
    }
    for (const control of root.querySelectorAll<HTMLButtonElement>("[data-action='previous-image']")) {
      control.addEventListener("click", () => illustrations.selectPrevious());
    }
    for (const control of root.querySelectorAll<HTMLButtonElement>("[data-action='next-image']")) {
      control.addEventListener("click", () => illustrations.selectNext());
    }
    for (const [action, operation] of [
      ["regenerate-image", () => illustrations.regenerate()],
      ["retry-image-job", () => illustrations.retryJob()],
      ["generate-missing-images", () => illustrations.generateMissing()],
      ["rebuild-images", () => illustrations.rebuild()],
      ["load-image-provenance", () => illustrations.loadProvenance()],
      ["rematch-image", () => illustrations.rematch()]
    ] as const) {
      for (const control of root.querySelectorAll<HTMLButtonElement>(`[data-action='${action}']`)) {
        control.addEventListener("click", () => { void operation(); });
      }
    }
    bindHistoryDialog();
    bindToolDialog();
    if (projection.generation !== null && ui.get().generationFollowing) {
      const preview = root.querySelector<HTMLElement>("[data-story-generation-preview]");
      if (preview && typeof preview.scrollIntoView === "function") {
        preview.scrollIntoView({ block: "end" });
        programmaticFollowTarget = viewportPosition(scrollWindow);
      }
    }
  }
  const unsubscribeStore = composition.campaignStore.store.subscribe((next) => {
    projection = next;
    inspectionRequestToken += 1;
    history.sync(next);
    syncComposer();
    render();
  });
  const unsubscribeUi = ui.subscribe(() => render());

  async function load(): Promise<void> {
    controller?.abort();
    const nextController = new AbortController();
    controller = nextController;
    ui.setPhase("loading");
    ui.setMessage(null);
    try {
      const listedRequest = composition.api.campaigns.list(nextController.signal);
      if (route.campaignId === null) {
        const listed = await listedRequest;
        if (disposed || nextController.signal.aborted) return;
        campaigns = listed.campaigns;
        ui.setPhase("chooser");
        return;
      }
      const sessionRequest = composition.api.session?.get?.(nextController.signal) ?? Promise.resolve(null);
      const [listed, sync, session] = await Promise.all([
        listedRequest,
        composition.api.generation.syncStatus(route.campaignId, nextController.signal),
        sessionRequest
      ]);
      if (disposed || nextController.signal.aborted) return;
      campaigns = listed.campaigns;
      selectedCampaign = campaigns.find((campaign) => campaign.id === route.campaignId) ?? null;
      composition.campaignStore.load(sync);
      syncComposer();
      ui.setViewTurnNumber(route.turnNumber ?? sync.campaign.activeTurnNumber);
      const continuousReading = session?.user?.settings?.continuousReading === true;
      autoSubmitTurnChoices = session?.user?.settings?.autoSubmitTurnChoices === true;
      ui.setContinuousReading(continuousReading);
      if (typeof composition.workflow.resume === "function") await generation.resume(route.campaignId);
      if (continuousReading && sync.turnWindowMode === "replace" && sync.turns.nextCursor !== null) {
        await history.openCompleteHistory().catch(() => undefined);
        if (disposed || nextController.signal.aborted) return;
      }
      ui.setPhase("loaded");
    } catch (error) {
      if (disposed || nextController.signal.aborted) return;
      ui.setMessage(errorMessage(error));
      ui.setPhase(errorPhase(error));
    }
  }

  const onClick = (event: Event) => {
    const target = event.target;
    if (!target || typeof (target as Element).closest !== "function") return;
    const actionTarget = target as Element;
    const width = actionTarget.closest<HTMLButtonElement>("[data-reading-width]")?.dataset.readingWidth;
    if (width === "narrow" || width === "standard" || width === "wide") {
      ui.setReadingWidth(width);
      const activated = root.querySelector<HTMLButtonElement>(`[data-reading-width="${width}"]`);
      root.querySelector<HTMLElement>("[data-reading-width-status]")!.textContent = `Reading width set to ${width[0].toUpperCase() + width.slice(1)}.`;
      activated?.focus();
      return;
    }
    const action = actionTarget.closest<HTMLElement>("[data-action]")?.dataset.action;
    if (action === "previous-turn") {
      void history.previous();
      return;
    }
    if (action === "next-turn") {
      void history.next();
      return;
    }
    const turnNumber = Number(actionTarget.closest<HTMLElement>("[data-turn-number]")?.dataset.turnNumber);
    if (Number.isSafeInteger(turnNumber) && turnNumber > 0) history.jump(turnNumber);
  };
  const onToolsClick = (event: Event) => {
    const target = event.target;
    if (!target || typeof (target as Element).closest !== "function") return;
    const action = (target as Element).closest<HTMLElement>("[data-tool-action]")?.dataset.toolAction;
    if (!action) return;
    event.preventDefault();
    if (toolsDisclosure) toolsDisclosure.open = false;
    if (action === "open-world-setup") {
      tools.openWorldSetup();
      return;
    }
    if (action === "edit-campaign-state") {
      currentState = null;
      ui.setActiveDialog("current-state");
      void tools.openCurrentState().then((result) => {
        if (!disposed && result !== null) {
          currentState = result;
          render();
        }
      }).catch(() => undefined);
      return;
    }
    if (action === "open-campaign-history") {
      historyDialogOpener = "history";
      focusHistoryDialog = true;
      ui.setActiveDialog("history");
      void history.openCompleteHistory().catch(() => undefined);
      return;
    }
    if (action === "open-activity") {
      tools.openActivity();
      return;
    }
    if (action === "open-about") {
      about = null;
      void tools.openAbout().then((result) => {
        if (!disposed && result !== null) {
          about = result;
          render();
        }
      }).catch(() => undefined);
      return;
    }
    if (action === "export-markdown") {
      void tools.exportMarkdown().then((downloaded) => {
        if (!downloaded || disposed) return;
        tools.recordActivity("markdown_export_downloaded", { campaignId: projection.campaign?.id });
        ui.setMessage("Markdown export downloaded.");
      });
      return;
    }
    if (action === "export-html") {
      void tools.exportStandaloneHtml().then((downloaded) => {
        if (!downloaded || disposed) return;
        tools.recordActivity("html_export_downloaded", { campaignId: projection.campaign?.id });
        ui.setMessage("Standalone HTML export downloaded.");
      });
      return;
    }
    if (action === "export-pdf") {
      void tools.printStory().then((printed) => {
        if (!printed || disposed) return;
        tools.recordActivity("story_print_prepared", { campaignId: projection.campaign?.id });
        ui.setMessage("Print dialog opened.");
      });
    }
  };
  root.addEventListener("click", onClick);
  toolsDisclosure?.addEventListener("click", onToolsClick);
  render();
  void load();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      controller?.abort();
      generation.dispose();
      scrollWindow?.removeEventListener("scroll", onDocumentScroll);
      programmaticFollowTarget = null;
      root.removeEventListener("click", onClick);
      toolsDisclosure?.removeEventListener("click", onToolsClick);
      retryControl?.removeEventListener("click", onRetry);
      unsubscribeStore();
      unsubscribeUi();
      history.dispose();
      unsubscribeIllustrations();
      illustrations.dispose();
      disposeToolsDisclosure();
      tools.dispose();
      ui.dispose();
      theme.dispose();
    }
  };
}
