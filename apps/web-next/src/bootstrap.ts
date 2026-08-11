import "./styles.css";
import {
  filterWorlds,
  installArtworkFallback,
  parseWorldListResponse,
  safeArtworkUrl,
  worldDescription,
  type WorldSummary
} from "./world-library";

const root = document.querySelector("#app");

if (!(root instanceof HTMLElement)) {
  throw new Error("The replacement app root is missing.");
}

root.innerHTML = `
  <div class="app-shell">
    <header class="site-header">
      <a class="brand" href="/app/" aria-label="Infinite Quest Nexus home">
        <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
        <span>Infinite Quest <b>Nexus</b></span>
      </a>
      <nav class="site-nav" aria-label="Primary navigation">
        <a href="/app/" aria-current="page">World Library</a>
        <a href="/nexus/?view=campaigns">Campaigns</a>
        <a href="/story">Story</a>
        <a href="/nexus/?view=setup">Setup</a>
      </nav>
      <a class="story-link" href="/story">
        Enter story
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9" /></svg>
      </a>
    </header>

    <main id="main-content">
      <section class="library-heading" aria-labelledby="library-title">
        <div class="title-block">
          <h1 id="library-title"><span>World</span> <span>Library</span></h1>
          <span class="title-slash" aria-hidden="true"></span>
        </div>
        <p>Browse the worlds that hold your lore, characters, and campaigns.</p>
      </section>

      <section class="library-tools" aria-label="Find a world">
        <label class="search-control" for="world-search">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>
          <span class="visually-hidden">Search worlds</span>
          <input id="world-search" type="search" autocomplete="off" placeholder="Search by title or description" />
          <kbd aria-hidden="true">/</kbd>
        </label>
        <p id="result-count" class="result-count" aria-live="polite">Loading worlds…</p>
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

    <footer>
      <p>Infinite Quest Nexus</p>
      <p>Worlds remain separate from the campaigns they inspire.</p>
    </footer>
  </div>
`;

const searchInput = root.querySelector("#world-search");
const resultCount = root.querySelector("#result-count");
const worldGrid = root.querySelector("#world-grid");

if (!(searchInput instanceof HTMLInputElement) || !(resultCount instanceof HTMLElement) || !(worldGrid instanceof HTMLElement)) {
  throw new Error("The World Library interface could not be initialized.");
}

const searchField = searchInput;
const countOutput = resultCount;
const grid = worldGrid;
let worlds: WorldSummary[] = [];

function campaignLabel(count: number): string {
  return `${count} ${count === 1 ? "campaign" : "campaigns"}`;
}

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
  link.href = `/nexus/?view=worlds&worldId=${encodeURIComponent(world.id)}`;
  link.setAttribute("aria-label", `Open ${world.title}, ${campaignLabel(world.campaignCount)}`);

  const cover = document.createElement("div");
  cover.className = "world-cover";
  const artworkUrl = safeArtworkUrl(world.imageUrl, window.location.origin);
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
  const query = searchField.value;
  const visibleWorlds = filterWorlds(worlds, query);
  const normalizedQuery = query.trim();
  const update = () => {
    grid.replaceChildren();
    grid.setAttribute("aria-busy", "false");
    countOutput.textContent = normalizedQuery
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
      grid.append(empty);
      return;
    }

    visibleWorlds.forEach((world, index) => grid.append(createWorldCard(world, index)));
  };

  if ("startViewTransition" in document && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    (document as Document & { startViewTransition(callback: () => void): void }).startViewTransition(update);
  } else {
    update();
  }
}

async function loadWorlds(): Promise<void> {
  try {
    const response = await fetch("/api/v1/worlds", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Request failed with status ${response.status}.`);
    worlds = parseWorldListResponse(await response.json()).worlds;
    renderWorlds();
  } catch (error) {
    console.error("World Library request failed", error);
    grid.setAttribute("aria-busy", "false");
    countOutput.textContent = "Worlds unavailable";
    const message = document.createElement("div");
    message.className = "library-message error-message";
    const heading = document.createElement("h3");
    heading.textContent = "The World Library could not be loaded.";
    const guidance = document.createElement("p");
    guidance.textContent = "Check that Nexus is running, then try again.";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Try again";
    retry.addEventListener("click", () => {
      grid.replaceChildren();
      grid.setAttribute("aria-busy", "true");
      countOutput.textContent = "Loading worlds…";
      void loadWorlds();
    });
    message.append(heading, guidance, retry);
    grid.replaceChildren(message);
  }
}

searchField.addEventListener("input", renderWorlds);
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && document.activeElement !== searchField && !(document.activeElement instanceof HTMLInputElement)) {
    event.preventDefault();
    searchField.focus();
  }
});

void loadWorlds();
