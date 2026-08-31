import type { StoryLengthProfile } from "@infinite-quest/contracts";
import type { DisplayPreferencesStore } from "../preferences/display-preferences.js";
import {
  renderIllustrationWing,
  renderStoryContent,
  renderStoryNavigation,
  type StoryPlayerViewState
} from "../story-player-view.js";
import { mountStoryArtwork } from "./ui/artwork.js";
import { mountComposer, type ComposerActions } from "./ui/composer.js";
import { mountStoryReader } from "./ui/reader.js";
import "./ui/secondary-controls.css";

export interface StoryAvailability {
  readonly canContinue: boolean;
  readonly canRetry: boolean;
}

export interface QuietLeafPresenter {
  render(state: StoryPlayerViewState, availability: StoryAvailability): void;
  focusDraft(): void;
  setTurnArtwork(visible: boolean | null): void;
  dispose(): void;
}

function selectedTurn(state: StoryPlayerViewState) {
  const campaign = state.projection.campaign;
  if (!campaign) return null;
  const number = state.ui.viewTurnNumber ?? campaign.activeTurnNumber;
  return state.projection.turns.find((turn) => turn.turnNumber === number)
    ?? state.projection.turns.at(-1)
    ?? null;
}

function activeTurn(state: StoryPlayerViewState) {
  const campaign = state.projection.campaign;
  return campaign === null ? null : state.projection.turns.find((turn) => turn.turnNumber === campaign.activeTurnNumber) ?? null;
}

function readerTitle(state: StoryPlayerViewState): Readonly<{ title: string; context: string }> {
  const campaign = state.projection.campaign;
  const turn = selectedTurn(state);
  if (campaign && turn) return { title: campaign.title, context: `Turn ${turn.turnNumber}` };
  if (campaign) return { title: campaign.title, context: "Beginning" };
  if (state.ui.phase === "not_found") return { title: "Story not found", context: "" };
  if (state.ui.phase === "error") return { title: "Story unavailable", context: "" };
  return { title: "Story", context: "" };
}

function lengthProfile(state: StoryPlayerViewState): StoryLengthProfile {
  return state.selectedCampaign?.storyLengthProfile ?? "standard";
}

export function mountQuietLeafPresenter(
  root: HTMLElement,
  display: DisplayPreferencesStore,
  actions: ComposerActions,
  onDisplayRefresh: (() => void) | undefined = undefined
): QuietLeafPresenter {
  root.dataset.quietLeafPresenter = "";
  root.dataset.storyReader = "";
  const document = root.ownerDocument;
  const reader = mountStoryReader(root);
  const composer = mountComposer(document, actions);
  reader.composerRoot.append(composer.element);
  reader.footerRoot.append(composer.footer);

  let current: Readonly<{ state: StoryPlayerViewState; availability: StoryAvailability }> | null = null;
  let disposed = false;
  let rendering = false;
  let queued = false;

  const artwork = mountStoryArtwork(document, display, () => requestRender());
  const unsubscribeDisplay = display.subscribe(() => {
    requestRender();
    onDisplayRefresh?.();
  });

  function apply(): void {
    if (disposed || current === null) return;
    const { state, availability } = current;
    const displayedTurn = selectedTurn(state);
    const selectableTurn = activeTurn(state);
    if (state.projection.campaign && displayedTurn) {
      artwork.update(
        { campaignId: state.projection.campaign.id, turnId: displayedTurn.id },
        renderIllustrationWing(document, state.illustrations)
      );
    }
    const heading = readerTitle(state);
    reader.update({
      title: heading.title,
      context: heading.context,
      width: display.get().storyWidth,
      narration: renderStoryContent(document, state),
      history: renderStoryNavigation(document, state),
      artwork: displayedTurn ? artwork.element() : null
    });
    const composerDisabled = !availability.canContinue;
    composer.update({
      draft: {
        ownerKey: state.ui.draftOwnerKey ?? "story-empty",
        value: state.ui.draft,
        disabled: composerDisabled
      },
      input: {
        style: state.selectedCampaign?.turnControlStyle ?? "action_only",
        value: state.ui.requestedInputMode,
        disabled: composerDisabled
      },
      choices: {
        choices: selectableTurn?.choices ?? [],
        selected: state.ui.choiceSelection,
        disabled: composerDisabled
      },
      length: {
        campaignDefault: lengthProfile(state),
        override: state.ui.storyLengthProfileOverride,
        disabled: composerDisabled
      },
      canContinue: availability.canContinue,
      canRetry: availability.canRetry,
      status: state.ui.message,
      confirmation: state.ui.intentConfirmation === null ? null : { action: state.ui.intentConfirmation.action }
    });
  }

  function requestRender(): void {
    if (disposed || current === null) return;
    if (rendering) {
      queued = true;
      return;
    }
    do {
      queued = false;
      rendering = true;
      apply();
      rendering = false;
    } while (queued && !disposed);
  }

  return {
    render(state, availability) {
      if (disposed) return;
      current = { state, availability };
      requestRender();
    },
    focusDraft() {
      if (!disposed) composer.focusDraft();
    },
    setTurnArtwork(visible) {
      if (!disposed) artwork.setTurnVisible(visible);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeDisplay();
      artwork.dispose();
      composer.dispose();
      reader.dispose();
      current = null;
    }
  };
}
