import type { CampaignProjection } from "@infinite-quest/client-core";
import type { CampaignSummary } from "@infinite-quest/contracts";
import { initializeAppTheme, renderAppShell } from "./app-shell";
import { createStoryPlayerComposition, type StoryPlayerComposition } from "./story-player-composition";
import { createStoryUiModel, type StoryUiPhase } from "./story-player-model";
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

  const onRetry = () => { void load(); };
  function render(): void {
    retryControl?.removeEventListener("click", onRetry);
    renderStoryPlayerView(root, { route, ui: ui.get(), campaigns, selectedCampaign, projection });
    retryControl = root.querySelector<HTMLButtonElement>('[data-action="retry-story"]');
    retryControl?.addEventListener("click", onRetry);
  }
  const unsubscribeStore = composition.campaignStore.store.subscribe((next) => {
    projection = next;
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
      const [listed, sync] = await Promise.all([
        listedRequest,
        composition.api.generation.syncStatus(route.campaignId, nextController.signal)
      ]);
      if (disposed || nextController.signal.aborted) return;
      campaigns = listed.campaigns;
      selectedCampaign = campaigns.find((campaign) => campaign.id === route.campaignId) ?? null;
      composition.campaignStore.load(sync);
      ui.setViewTurnNumber(route.turnNumber ?? sync.campaign.activeTurnNumber);
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
      return;
    }
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
      ui.dispose();
      theme.dispose();
    }
  };
}
