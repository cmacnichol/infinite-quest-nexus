import "./styles.css";
import { initializeAppTheme, renderAppShell } from "./app-shell";
import { generateWorldPreview } from "./world-creation-api";
import { mountCampaignEditorPage } from "./campaign-editor-page";
import { campaignRouteFromPath } from "./campaign-editor-model";
import { mountCharacterWorkspacePage } from "./character-workspace-page";
import { characterSessionKeyFromPath } from "./character-workspace-session";
import { isWorldCreationPath } from "./world-creation-model";
import { mountWorldCreationPage } from "./world-creation-page";
import { worldIdFromPath } from "./world-editor-model";
import { mountWorldEditorPage } from "./world-editor-page";
import { mountWorldLibraryPage, type MountedPage } from "./world-library-page";
import { storyRouteFromLocation } from "./story-route";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("The replacement app root is missing.");

const characterSessionKey = characterSessionKeyFromPath(window.location.pathname);
const storyRoute = storyRouteFromLocation(window.location.pathname, window.location.search);
const campaignRoute = campaignRouteFromPath(window.location.pathname);
const worldId = worldIdFromPath(window.location.pathname);
const mountedPage: MountedPage = characterSessionKey !== null
  ? mountCharacterWorkspacePage(root, characterSessionKey)
  : storyRoute !== null
    ? mountStoryRoute(root)
    : campaignRoute !== null
    ? mountCampaignEditorPage(root, campaignRoute)
  : isWorldCreationPath(window.location.pathname)
    ? mountWorldCreationPage(root, { generateWorldPreview })
    : worldId === null
      ? mountWorldLibraryPage(root)
      : mountWorldEditorPage(root, worldId);

function mountStoryRoute(root: HTMLElement): MountedPage {
  renderAppShell(root, `<main id="main-content" data-page="story" aria-busy="true"><p class="campaign-loading">Loading Story…</p></main>`, "story");
  const theme = initializeAppTheme(root);
  return { dispose: () => theme.dispose() };
}

function onPageHide(event: PageTransitionEvent): void {
  if (event.persisted) return;
  window.removeEventListener("pagehide", onPageHide);
  mountedPage.dispose();
}

window.addEventListener("pagehide", onPageHide);
