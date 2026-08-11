import "./styles.css";
import { worldIdFromPath } from "./world-editor-model";
import { mountWorldEditorPage } from "./world-editor-page";
import { mountWorldLibraryPage, type MountedPage } from "./world-library-page";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("The replacement app root is missing.");

const worldId = worldIdFromPath(window.location.pathname);
const mountedPage: MountedPage = worldId === null
  ? mountWorldLibraryPage(root)
  : mountWorldEditorPage(root, worldId);

function onPageHide(event: PageTransitionEvent): void {
  if (event.persisted) return;
  window.removeEventListener("pagehide", onPageHide);
  mountedPage.dispose();
}

window.addEventListener("pagehide", onPageHide);
