import {
  toggleChoiceDraftSelection,
  type CampaignProjection,
  type StoryTurnInputMode
} from "@infinite-quest/client-core";
import type {
  CampaignRuntimeStateResponse,
  CampaignSummary,
  TurnInputClassificationResponse,
  TurnInputModeSource
} from "@infinite-quest/contracts";
import { initializeAppTheme, renderAppShell } from "./app-shell";
import { createStoryPlayerComposition, type StoryPlayerComposition } from "./story-player-composition";
import { createStoryGenerationController } from "./story-player-generation";
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
  let submittedDraft: string | null = null;
  let followingProgrammatically = false;
  let programmaticFollowResetTimer: ReturnType<typeof setTimeout> | null = null;
  const refreshCompletionResources = (campaignId: string, turnNumber: number) => {
    void composition.api.campaigns.state(campaignId, turnNumber).then((runtime) => {
      if (!disposed && projection.campaign?.id === campaignId && runtime.campaignId === campaignId) {
        composition.campaignStore.loadRuntimeState(runtime);
      }
    }).catch(() => undefined);
    // Illustration refresh is deliberately independent: failures never alter accepted narration.
    void composition.illustrations.segments(campaignId).catch(() => undefined);
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
  const scrollWindow = root.ownerDocument.defaultView;
  const onDocumentScroll = () => {
    if (followingProgrammatically) {
      followingProgrammatically = false;
      if (programmaticFollowResetTimer !== null) globalThis.clearTimeout(programmaticFollowResetTimer);
      programmaticFollowResetTimer = null;
      return;
    }
    if (!followingProgrammatically && projection.generation !== null && ui.get().generationFollowing) {
      ui.setGenerationFollowing(false);
    }
  };
  scrollWindow?.addEventListener("scroll", onDocumentScroll, { passive: true });
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
  const submitPreparedTurn = async (submission: PreparedStoryTurnSubmission) => {
    submittedDraft = submission.action;
    const accepted = await generation.submitAppend(submission);
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
    bindHistoryDialog();
    if (projection.generation !== null && ui.get().generationFollowing) {
      const preview = root.querySelector<HTMLElement>("[data-story-generation-preview]");
      if (preview && typeof preview.scrollIntoView === "function") {
        followingProgrammatically = true;
        preview.scrollIntoView({ block: "end" });
        if (programmaticFollowResetTimer !== null) globalThis.clearTimeout(programmaticFollowResetTimer);
        programmaticFollowResetTimer = globalThis.setTimeout(() => {
          followingProgrammatically = false;
          programmaticFollowResetTimer = null;
        }, 0);
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
  root.addEventListener("click", onClick);
  render();
  void load();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      controller?.abort();
      generation.dispose();
      scrollWindow?.removeEventListener("scroll", onDocumentScroll);
      if (programmaticFollowResetTimer !== null) globalThis.clearTimeout(programmaticFollowResetTimer);
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
