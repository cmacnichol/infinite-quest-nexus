import type { DisplayPreferencesStore } from "../../preferences/display-preferences.js";
import "./artwork.css";

export interface ArtworkIdentity {
  readonly campaignId: string;
  readonly turnId: string;
}

export interface StoryArtwork {
  element(): HTMLElement | null;
  update(identity: ArtworkIdentity, content: HTMLElement): void;
  setTurnVisible(visible: boolean | null): void;
  dispose(): void;
}

interface ArtworkState {
  readonly identity: ArtworkIdentity;
  readonly content: HTMLElement;
}

export function mountStoryArtwork(
  document: Document,
  display: DisplayPreferencesStore,
  onLayoutChange: () => void
): StoryArtwork {
  const plate = document.createElement("aside");
  plate.className = "story-artwork-plate";
  plate.dataset.storyArtwork = "";
  plate.setAttribute("aria-label", "Turn artwork");

  let current: ArtworkState | null = null;
  let visible = false;
  let disposed = false;

  const applyVisibility = (): void => {
    const nextVisible = current !== null
      && display.artworkVisible(current.identity.campaignId, current.identity.turnId);
    if (nextVisible === visible) return;

    visible = nextVisible;
    if (visible && current !== null) plate.replaceChildren(current.content);
    else plate.replaceChildren();
    onLayoutChange();
  };

  const unsubscribe = display.subscribe(() => applyVisibility());

  return {
    element() {
      return !disposed && visible ? plate : null;
    },
    update(identity, content) {
      if (disposed) return;
      current = { identity, content };
      applyVisibility();
      if (visible) plate.replaceChildren(content);
    },
    setTurnVisible(nextVisible) {
      if (disposed || current === null) return;
      display.setTurnArtwork(current.identity.campaignId, current.identity.turnId, nextVisible);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      current = null;
      visible = false;
      plate.replaceChildren();
    }
  };
}
