import type { CampaignProjection } from "@infinite-quest/client-core";
import type { CampaignRuntimeStateResponse, CampaignSummary } from "@infinite-quest/contracts";
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

export function mountStoryPlayerPage(
  root: HTMLElement,
  route: StoryRoute,
  composition: StoryPlayerComposition = createStoryPlayerComposition()
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
  let historyDialogOpener = false;
  let focusHistoryDialog = false;
  let inspectedState: CampaignRuntimeStateResponse | null = null;
  const history = createStoryHistoryController({
    campaigns: composition.api.campaigns,
    campaignStore: composition.campaignStore,
    model: ui
  });

  const onRetry = () => { void load(); };
  const restoreHistoryFocus = () => {
    if (!historyDialogOpener) return;
    historyDialogOpener = false;
    root.querySelector<HTMLButtonElement>("[data-action='open-complete-history']")?.focus();
  };
  const closeHistoryDialog = () => {
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
    if (focusHistoryDialog) {
      focusHistoryDialog = false;
      dialog.querySelector<HTMLElement>("[data-story-history-focus]")?.focus();
    }
  };
  function render(): void {
    retryControl?.removeEventListener("click", onRetry);
    renderStoryPlayerView(root, { route, ui: ui.get(), campaigns, selectedCampaign, projection, inspectedState });
    retryControl = root.querySelector<HTMLButtonElement>('[data-action="retry-story"]');
    retryControl?.addEventListener("click", onRetry);
    for (const control of root.querySelectorAll<HTMLElement>("[data-turn-number]")) {
      const turnNumber = Number(control.dataset.turnNumber);
      control.addEventListener("click", (event) => {
        event.stopPropagation();
        inspectedState = null;
        history.jump(turnNumber);
      });
    }
    for (const control of root.querySelectorAll<HTMLElement>("[data-action='previous-turn']")) {
      control.addEventListener("click", (event) => { event.stopPropagation(); void history.previous(); });
    }
    for (const control of root.querySelectorAll<HTMLElement>("[data-action='next-turn']")) {
      control.addEventListener("click", (event) => { event.stopPropagation(); void history.next(); });
    }
    for (const control of root.querySelectorAll<HTMLElement>("[data-action='open-complete-history']")) {
      control.addEventListener("click", (event) => {
        event.stopPropagation();
        historyDialogOpener = true;
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
          inspectedState = null;
          history.jump(turnNumber);
        }
        closeHistoryDialog();
      });
    }
    for (const control of root.querySelectorAll<HTMLElement>("[data-action='inspect-state']")) {
      control.addEventListener("click", (event) => {
        event.stopPropagation();
        const turnNumber = ui.get().viewTurnNumber;
        if (turnNumber !== null) {
          void history.inspect(turnNumber).then((result) => {
            if (disposed || result === null) return;
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
    bindHistoryDialog();
  }
  const unsubscribeStore = composition.campaignStore.store.subscribe((next) => {
    projection = next;
    history.sync(next);
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
      ui.setViewTurnNumber(route.turnNumber ?? sync.campaign.activeTurnNumber);
      const continuousReading = session?.user?.settings?.continuousReading === true;
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
