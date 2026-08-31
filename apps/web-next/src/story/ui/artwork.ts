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

function prepareCoreArtwork(document: Document, content: HTMLElement): HTMLElement {
  if (
    content.querySelector("[data-story-artwork-visible]") !== null
    || content.querySelector("details[data-story-artwork-details]") !== null
  ) return content;

  const figure = content.querySelector<HTMLElement>(".story-illustration-figure");
  const image = figure?.querySelector<HTMLImageElement>("img");
  if (figure === undefined || figure === null || image === undefined || image === null || figure.parentElement !== content) {
    return content;
  }

  const crop = document.createElement("figure");
  crop.className = "story-artwork-visible";
  crop.dataset.storyArtworkVisible = "";
  const cropImage = image.cloneNode(true) as HTMLImageElement;
  crop.append(cropImage);

  const details = document.createElement("details");
  details.className = "story-artwork-details";
  details.dataset.storyArtworkDetails = "";
  const summary = document.createElement("summary");
  summary.textContent = "Artwork details";
  const contentChildren = Array.from(content.children);
  const figureIndex = contentChildren.indexOf(figure);
  const leadingContent = contentChildren.slice(0, figureIndex);
  const detailContent = contentChildren.slice(figureIndex);
  details.append(summary, ...detailContent);
  content.replaceChildren(...leadingContent, crop, details);
  return content;
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
      const preserveOpenDetails = current?.identity.campaignId === identity.campaignId
        && current.identity.turnId === identity.turnId
        && current.content.querySelector("details[data-story-artwork-details]")?.hasAttribute("open") === true;
      const preparedContent = prepareCoreArtwork(document, content);
      if (preserveOpenDetails) preparedContent.querySelector("details[data-story-artwork-details]")?.setAttribute("open", "");
      current = { identity, content: preparedContent };
      applyVisibility();
      if (visible) plate.replaceChildren(current.content);
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
