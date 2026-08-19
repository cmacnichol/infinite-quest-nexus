import {
  toggleChoiceDraftSelection,
  type CampaignProjection,
  type StoryTurnInputMode
} from "@infinite-quest/client-core";
import type { CampaignRuntimeStateResponse, CampaignSummary, TurnInputModeSource } from "@infinite-quest/contracts";
import { initializeAppTheme, renderAppShell } from "./app-shell";
import { createStoryPlayerComposition, type StoryPlayerComposition } from "./story-player-composition";
import { createStoryUiModel, type StoryUiPhase } from "./story-player-model";
import { createStoryHistoryController } from "./story-player-history";
import { renderStoryPlayerView } from "./story-player-view";
import type { StoryRoute } from "./story-route";
import type { MountedPage } from "./world-library-page";
import "./story-player.css";

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

export interface PreparedStoryTurnSubmission {
  readonly action: string;
  readonly requestedInputMode: StoryTurnInputMode;
  readonly resolvedInputMode: "action" | "scene";
  readonly inputModeSource: TurnInputModeSource;
  readonly classificationId?: string;
}

export interface StoryPlayerPageOptions {
  /** Task 7 test seam only. Durable generation belongs to Task 8. */
  readonly onSubmit?: (submission: PreparedStoryTurnSubmission) => void | Promise<void>;
}

export function mountStoryPlayerPage(
  root: HTMLElement,
  route: StoryRoute,
  composition: StoryPlayerComposition = createStoryPlayerComposition(),
  options: StoryPlayerPageOptions = {}
): MountedPage {
  renderAppShell(root, storyPlayerMarkup, "story");
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
  let inspectionRequestToken = 0;
  let autoSubmitTurnChoices = false;
  const history = createStoryHistoryController({
    campaigns: composition.api.campaigns,
    campaignStore: composition.campaignStore,
    model: ui
  });

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
  const focusDraft = () => root.querySelector<HTMLTextAreaElement>("[data-story-draft]")?.focus();
  const composerCampaign = () => projection.campaign !== null && selectedCampaign?.id === projection.campaign.id
    ? selectedCampaign : null;
  const campaignFallback = () => composerCampaign()?.turnControlStyle === "flexible_scene" ? "scene" as const : "action" as const;
  const invokeTestSubmission = async (submission: PreparedStoryTurnSubmission) => {
    await options.onSubmit?.(submission);
  };
  const submitComposer = async (): Promise<void> => {
    const campaign = projection.campaign;
    const current = ui.get();
    const action = current.draft.trim();
    if (!campaign || !action) {
      focusDraft();
      return;
    }
    if (current.requestedInputMode === "action" || current.requestedInputMode === "scene") {
      await invokeTestSubmission({
        action,
        requestedInputMode: current.requestedInputMode,
        resolvedInputMode: current.requestedInputMode,
        inputModeSource: "explicit"
      });
      return;
    }
    const classifyTurnInput = composition.api.campaigns.classifyTurnInput;
    if (typeof classifyTurnInput !== "function") {
      ui.setMessage("Prompt interpretation is unavailable. Choose Action or Scene Direction.");
      return;
    }
    try {
      const result = await classifyTurnInput(campaign.id, { text: action, preferredFallback: campaignFallback() });
      if (disposed || projection.campaign?.id !== campaign.id || ui.get().draft.trim() !== action) return;
      if (result.confidenceBand === "ambiguous") {
        ui.setIntentConfirmation({ action, classificationId: result.classificationId, requestedInputMode: "auto" });
        return;
      }
      await invokeTestSubmission({
        action,
        requestedInputMode: "auto",
        resolvedInputMode: result.resolvedMode,
        inputModeSource: "auto",
        classificationId: result.classificationId
      });
    } catch {
      if (!disposed) ui.setMessage("Prompt interpretation could not be completed. Choose Action or Scene Direction.");
    }
  };
  const confirmComposerIntent = async (resolvedInputMode: "action" | "scene"): Promise<void> => {
    const intent = ui.get().intentConfirmation;
    if (intent === null) return;
    ui.setIntentConfirmation(null);
    await invokeTestSubmission({
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
  function render(): void {
    retryControl?.removeEventListener("click", onRetry);
    renderStoryPlayerView(root, { route, ui: ui.get(), campaigns, selectedCampaign, projection, inspectedState });
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
          void history.inspect(turnNumber).then((result) => {
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
        const turnNumber = Number(control.dataset.turnNumber);
        const confirm = root.ownerDocument.defaultView?.confirm;
        if (Number.isSafeInteger(turnNumber) && turnNumber > 0 && typeof confirm === "function") {
          confirm(`Restart or branch from persisted Turn ${turnNumber}?`);
        }
      });
    }
    for (const control of root.querySelectorAll<HTMLButtonElement>("[data-input-mode]")) {
      control.addEventListener("click", () => {
        const mode = control.dataset.inputMode;
        if (mode === "auto" || mode === "action" || mode === "scene") ui.setRequestedInputMode(mode);
      });
    }
    for (const textarea of root.querySelectorAll<HTMLTextAreaElement>("[data-story-draft]")) {
      textarea.addEventListener("input", () => ui.setComposerDraft(textarea.value));
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
    bindHistoryDialog();
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
  root.addEventListener("click", onClick);
  const pollTimer = globalThis.setInterval(() => { void load(); }, 30_000);
  render();
  void load();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      controller?.abort();
      globalThis.clearInterval(pollTimer);
      root.removeEventListener("click", onClick);
      retryControl?.removeEventListener("click", onRetry);
      unsubscribeStore();
      unsubscribeUi();
      history.dispose();
      ui.dispose();
      theme.dispose();
    }
  };
}
