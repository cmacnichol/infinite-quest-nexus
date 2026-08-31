import "./styles.css";
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
import { mountStoryPlayerPage } from "./story-player-page";
import { createStoryPlayerComposition } from "./story-player-composition";
import { storyRouteFromLocation } from "./story-route";
import { createStoryResumeStore, isAppEntryPath, resumeStoredStoryCampaign } from "./navigation/story-resume";
import { mountDataTransferPage } from "./data-transfer-page";
import { uiImplementation } from "./ui/feature-policy";
import { ensureWebAwesome } from "./ui/web-awesome";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("The replacement app root is missing.");
const appRoot: HTMLElement = root;

let mountedPage: MountedPage | null = null;
let pageDisposed = false;
const startupController = new AbortController();

function browserResumeStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

async function start(): Promise<MountedPage | null> {
  if (uiImplementation() === "web-awesome") await ensureWebAwesome();
  if (pageDisposed) return null;
  if (isAppEntryPath(window.location.pathname)) {
    const result = await resumeStoredStoryCampaign({
      store: createStoryResumeStore(browserResumeStorage()),
      list(signal) {
        try {
          return createStoryPlayerComposition().api.campaigns.list(signal);
        } catch (error) {
          return Promise.reject(error);
        }
      },
      replace(path) {
        if (pageDisposed || startupController.signal.aborted) return;
        window.location.replace(path);
      },
      signal: startupController.signal
    });
    if (result === "resumed") return null;
    if (pageDisposed) return null;
  }
  const characterSessionKey = characterSessionKeyFromPath(window.location.pathname);
  const storyRoute = storyRouteFromLocation(window.location.pathname, window.location.search);
  const campaignRoute = campaignRouteFromPath(window.location.pathname);
  const worldId = worldIdFromPath(window.location.pathname);
  return characterSessionKey !== null
    ? mountCharacterWorkspacePage(appRoot, characterSessionKey)
    : storyRoute !== null
      ? mountStoryPlayerPage(appRoot, storyRoute)
      : campaignRoute !== null
        ? mountCampaignEditorPage(appRoot, campaignRoute)
        : window.location.pathname === "/app/data-transfer" || window.location.pathname === "/app/data-transfer/"
          ? mountDataTransferPage(appRoot)
          : isWorldCreationPath(window.location.pathname)
            ? mountWorldCreationPage(appRoot, { generateWorldPreview })
            : window.location.pathname === "/app/worlds" || window.location.pathname === "/app/worlds/"
              ? mountWorldLibraryPage(appRoot)
              : worldId === null
              ? mountWorldLibraryPage(appRoot)
              : mountWorldEditorPage(appRoot, worldId);
}

function showLoading(): void {
  appRoot.replaceChildren();
  const loading = document.createElement("main");
  loading.id = "main-content";
  loading.setAttribute("aria-busy", "true");
  loading.setAttribute("aria-live", "polite");
  loading.textContent = "Loading application interface…";
  appRoot.append(loading);
}

function showStartFailure(error: unknown): void {
  appRoot.replaceChildren();
  const main = document.createElement("main");
  main.id = "main-content";
  const heading = document.createElement("h1");
  heading.textContent = "Application interface unavailable";
  const message = document.createElement("p");
  message.setAttribute("role", "alert");
  message.textContent = error instanceof Error && error.message ? error.message : "The interface could not be loaded. Try again.";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "Retry";
  retry.addEventListener("click", () => { void boot(); }, { once: true });
  main.append(heading, message, retry);
  appRoot.append(main);
}

async function boot(): Promise<void> {
  if (pageDisposed || mountedPage) return;
  if (uiImplementation() === "web-awesome") showLoading();
  try {
    const page = await start();
    if (page === null || pageDisposed) {
      page?.dispose();
      return;
    }
    mountedPage = page;
  } catch (error) {
    if (!pageDisposed) showStartFailure(error);
  }
}

function onPageHide(event: PageTransitionEvent): void {
  if (event.persisted) return;
  window.removeEventListener("pagehide", onPageHide);
  pageDisposed = true;
  startupController.abort();
  mountedPage?.dispose();
  mountedPage = null;
}

window.addEventListener("pagehide", onPageHide);
void boot();
