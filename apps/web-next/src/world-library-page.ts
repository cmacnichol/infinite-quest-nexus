import { initializeAppTheme, renderAppShell } from "./app-shell";
import { worldCreationPath } from "./world-creation-model";
import {
  filterWorlds,
  installArtworkFallback,
  parseWorldListResponse,
  safeArtworkUrl,
  worldDescription,
  worldEditorPath,
  type WorldSummary
} from "./world-library";

export interface WorldLibraryPageDependencies {
  fetchWorlds?: (signal?: AbortSignal) => Promise<Response>;
}

export interface MountedPage {
  dispose(): void;
}

function requiredElement<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error("The World Library interface could not be initialized.");
  return element;
}

const libraryMarkup = `
  <main id="main-content" data-page="world-library">
    <section class="library-heading" aria-labelledby="library-title">
      <div class="title-block">
        <h1 id="library-title"><span>World</span> <span>Library</span></h1>
        <span class="title-slash" aria-hidden="true"></span>
      </div>
      <p>Browse the worlds that hold your lore, characters, and campaigns.</p>
    </section>

    <section class="library-tools" aria-label="Find or create a world">
      <label class="search-control" for="world-search">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>
        <span class="visually-hidden">Search worlds</span>
        <input id="world-search" type="search" autocomplete="off" placeholder="Search by title or description" />
        <kbd aria-hidden="true">/</kbd>
      </label>
      <p id="result-count" class="result-count" aria-live="polite">Loading worlds…</p>
      <a class="library-create-action" href="${worldCreationPath()}">
        <span>Create world</span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
      </a>
    </section>

    <section class="world-region" aria-labelledby="results-heading">
      <div class="results-label">
        <h2 id="results-heading">Available worlds</h2>
        <span aria-hidden="true">Live index</span>
      </div>
      <div id="world-grid" class="world-grid" aria-busy="true">
        <div class="skeleton" aria-hidden="true"></div>
        <div class="skeleton" aria-hidden="true"></div>
        <div class="skeleton" aria-hidden="true"></div>
      </div>
    </section>
  </main>
`;

function campaignLabel(count: number): string {
  return `${count} ${count === 1 ? "campaign" : "campaigns"}`;
}

export function mountWorldLibraryPage(
  root: HTMLElement,
  dependencies: WorldLibraryPageDependencies = {}
): MountedPage {
  renderAppShell(root, libraryMarkup, "world-library");
  const theme = initializeAppTheme(root);
  const document = root.ownerDocument;
  const view = document.defaultView;
  if (!view) {
    theme.dispose();
    throw new Error("The World Library interface could not be initialized.");
  }
  const pageView = view;
  const searchInput = requiredElement<HTMLInputElement>(root, "#world-search");
  const resultCount = requiredElement<HTMLElement>(root, "#result-count");
  const worldGrid = requiredElement<HTMLElement>(root, "#world-grid");

  const controller = new AbortController();
  const fetchWorlds = dependencies.fetchWorlds ?? ((signal?: AbortSignal) =>
    fetch("/api/v1/worlds", { headers: { Accept: "application/json" }, signal }));
  let worlds: WorldSummary[] = [];
  let disposed = false;

  function createFallbackArt(title: string): HTMLElement {
    const fallback = document.createElement("div");
    fallback.className = "cover-fallback";
    fallback.setAttribute("aria-hidden", "true");
    const glyph = document.createElement("span");
    glyph.textContent = title.trim().slice(0, 1).toLocaleUpperCase() || "W";
    fallback.append(glyph);
    return fallback;
  }

  function createWorldCard(world: WorldSummary, index: number): HTMLElement {
    const article = document.createElement("article");
    article.className = "world-entry";
    article.style.setProperty("--entry-order", String(index));
    const link = document.createElement("a");
    link.className = "world-link";
    link.href = worldEditorPath(world.id);
    link.setAttribute("aria-label", `Open ${world.title}, ${campaignLabel(world.campaignCount)}`);

    const cover = document.createElement("div");
    cover.className = "world-cover";
    const origin = pageView.location?.origin ?? "http://localhost";
    const artworkUrl = safeArtworkUrl(world.imageUrl, origin);
    if (artworkUrl) {
      const image = document.createElement("img");
      image.alt = "";
      image.loading = index < 6 ? "eager" : "lazy";
      image.decoding = "async";
      installArtworkFallback(image, () => createFallbackArt(world.title));
      image.src = artworkUrl;
      cover.append(image);
    } else {
      cover.append(createFallbackArt(world.title));
    }

    const coordinate = document.createElement("span");
    coordinate.className = "coordinate";
    coordinate.setAttribute("aria-hidden", "true");
    coordinate.textContent = `${String(index + 1).padStart(2, "0")} / W`;
    cover.append(coordinate);

    const body = document.createElement("div");
    body.className = "world-copy";
    const title = document.createElement("h3");
    title.textContent = world.title;
    const description = document.createElement("p");
    description.textContent = worldDescription(world);
    const meta = document.createElement("div");
    meta.className = "world-meta";
    const count = document.createElement("span");
    count.textContent = campaignLabel(world.campaignCount);
    const action = document.createElement("span");
    action.className = "open-action";
    action.innerHTML = `Open world <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9" /></svg>`;
    meta.append(count, action);
    body.append(title, description, meta);
    link.append(cover, body);
    article.append(link);
    return article;
  }

  function renderWorlds(): void {
    if (disposed) return;
    const query = searchInput.value;
    const visibleWorlds = filterWorlds(worlds, query);
    const normalizedQuery = query.trim();
    const update = () => {
      worldGrid.replaceChildren();
      worldGrid.setAttribute("aria-busy", "false");
      resultCount.textContent = normalizedQuery
        ? `${visibleWorlds.length} ${visibleWorlds.length === 1 ? "world" : "worlds"} found`
        : `${visibleWorlds.length} ${visibleWorlds.length === 1 ? "world" : "worlds"} available`;

      if (!visibleWorlds.length) {
        const empty = document.createElement("div");
        empty.className = "library-message";
        const heading = document.createElement("h3");
        heading.textContent = normalizedQuery ? "No worlds match that search." : "Your World Library is empty.";
        const guidance = document.createElement("p");
        guidance.textContent = normalizedQuery
          ? "Try a world title, setting, or phrase from its description."
          : "Create or import a world in World Management to begin your library.";
        empty.append(heading, guidance);
        worldGrid.append(empty);
        return;
      }
      visibleWorlds.forEach((world, index) => worldGrid.append(createWorldCard(world, index)));
    };

    if ("startViewTransition" in document && !pageView.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      (document as Document & { startViewTransition(callback: () => void): void }).startViewTransition(update);
    } else {
      update();
    }
  }

  async function loadWorlds(): Promise<void> {
    try {
      const response = await fetchWorlds(controller.signal);
      if (!response.ok) throw new Error(`Request failed with status ${response.status}.`);
      worlds = parseWorldListResponse(await response.json()).worlds;
      renderWorlds();
    } catch (error) {
      if (disposed || controller.signal.aborted) return;
      console.error("World Library request failed", error);
      worldGrid.setAttribute("aria-busy", "false");
      resultCount.textContent = "Worlds unavailable";
      const message = document.createElement("div");
      message.className = "library-message error-message";
      const heading = document.createElement("h3");
      heading.textContent = "The World Library could not be loaded.";
      const guidance = document.createElement("p");
      guidance.textContent = "Check that Nexus is running, then try again.";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.dataset.action = "retry-worlds";
      retry.textContent = "Try again";
      retry.addEventListener("click", () => {
        worldGrid.replaceChildren();
        worldGrid.setAttribute("aria-busy", "true");
        resultCount.textContent = "Loading worldsâ€¦";
        void loadWorlds();
      }, { once: true });
      message.append(heading, guidance, retry);
      worldGrid.replaceChildren(message);
    }
  }

  const onSearch = () => renderWorlds();
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "/" && document.activeElement !== searchInput && !(document.activeElement instanceof view.HTMLInputElement)) {
      event.preventDefault();
      searchInput.focus();
    }
  };
  searchInput.addEventListener("input", onSearch);
  document.addEventListener("keydown", onKeyDown);
  void loadWorlds();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      controller.abort(new DOMException("World Library closed", "AbortError"));
      searchInput.removeEventListener("input", onSearch);
      document.removeEventListener("keydown", onKeyDown);
      theme.dispose();
    }
  };
}
