import type { StoryWidth } from "../../preferences/display-preferences.js";
import { storyWidthLimits } from "../../preferences/story-width.js";
import "./reader.css";

export interface ReaderLayoutState {
  readonly title: string;
  readonly context: string;
  readonly width: StoryWidth;
  readonly narration: readonly HTMLElement[];
  readonly history: HTMLElement | null;
  readonly artwork: HTMLElement | null;
}

export interface StoryReader {
  readonly composerRoot: HTMLElement;
  readonly footerRoot: HTMLElement;
  update(state: ReaderLayoutState): void;
  dispose(): void;
}

export function mountStoryReader(root: HTMLElement): StoryReader {
  const document = root.ownerDocument;
  const layout = document.createElement("section");
  layout.className = "quiet-leaf-layout";
  layout.dataset.readingLayout = "";
  layout.dataset.hasHistory = "false";

  const leaf = document.createElement("article");
  leaf.className = "quiet-leaf";
  leaf.dataset.readingLeaf = "";
  leaf.dataset.hasArtwork = "false";

  const prose = document.createElement("section");
  prose.className = "quiet-leaf-prose";
  prose.setAttribute("aria-label", "Story reading");

  const heading = document.createElement("header");
  heading.className = "quiet-leaf-heading";
  const title = document.createElement("h1");
  title.dataset.storyTitle = "";
  const context = document.createElement("p");
  context.className = "quiet-leaf-context";
  context.dataset.storyContext = "";
  heading.append(title, context);

  const narration = document.createElement("div");
  narration.className = "quiet-leaf-narration";
  narration.dataset.narration = "";

  const history = document.createElement("details");
  history.className = "quiet-leaf-history";
  history.dataset.recentHistory = "";
  history.dataset.readingHistoryRail = "";
  const historySummary = document.createElement("summary");
  historySummary.textContent = "Recent turns";
  historySummary.setAttribute("aria-label", "Show recent turns");
  history.append(historySummary);
  history.hidden = true;

  prose.append(heading, narration);

  const composerRoot = document.createElement("section");
  composerRoot.className = "quiet-leaf-composer";
  composerRoot.dataset.composerRoot = "";
  composerRoot.setAttribute("aria-label", "Story controls");

  const footerRoot = document.createElement("footer");
  footerRoot.className = "quiet-leaf-footer";
  footerRoot.dataset.footerRoot = "";
  footerRoot.setAttribute("aria-label", "Story actions");

  leaf.append(prose, composerRoot, footerRoot);
  layout.append(history, leaf);
  root.replaceChildren(layout);

  let artworkSlot: HTMLElement | null = null;
  let disposed = false;

  const applyWidth = (width: StoryWidth): void => {
    const limits = storyWidthLimits(width);
    leaf.dataset.storyWidth = width;
    leaf.style.setProperty("--story-leaf-max", limits.leaf);
    leaf.style.setProperty("--story-prose-max", limits.prose);
    layout.style.setProperty("--story-leaf-max", limits.leaf);
    layout.style.setProperty("--story-layout-max", limits.leaf);
    composerRoot.style.setProperty("--story-leaf-max", limits.leaf);
    composerRoot.style.setProperty("--story-prose-max", limits.prose);
  };

  const updateArtwork = (artwork: HTMLElement | null): void => {
    if (artwork === null) {
      artworkSlot?.remove();
      artworkSlot = null;
      leaf.dataset.hasArtwork = "false";
      return;
    }

    if (artworkSlot === null) {
      artworkSlot = document.createElement("aside");
      artworkSlot.className = "quiet-leaf-artwork";
      artworkSlot.dataset.artworkSlot = "";
      artworkSlot.setAttribute("aria-label", "Turn artwork");
      leaf.insertBefore(artworkSlot, composerRoot);
    }
    artworkSlot.replaceChildren(artwork);
    leaf.dataset.hasArtwork = "true";
  };

  return {
    composerRoot,
    footerRoot,
    update(state) {
      if (disposed) return;
      title.textContent = state.title;
      context.textContent = state.context;
      narration.replaceChildren(...state.narration);
      const hasHistory = state.history !== null;
      layout.dataset.hasHistory = String(hasHistory);
      history.hidden = !hasHistory;
      history.replaceChildren(historySummary, ...(hasHistory ? [state.history] : []));
      applyWidth(state.width);
      updateArtwork(state.artwork);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      layout.remove();
      artworkSlot = null;
    }
  };
}
