import { initializeAppTheme, renderAppShell } from "./app-shell";
import type { MountedPage } from "./world-library-page";

const creationMarkup = `
  <main id="main-content" data-page="world-creation">
    <section class="editor-load-state" aria-labelledby="creation-loading-title" aria-busy="true">
      <h1 id="creation-loading-title">Create world</h1>
      <p>The creation workspace is loading.</p>
      <button type="button" disabled>Loading creation workspace…</button>
    </section>
  </main>
`;

export function mountWorldCreationPage(root: HTMLElement): MountedPage {
  renderAppShell(root, creationMarkup, "world-library");
  const theme = initializeAppTheme(root);
  return {
    dispose() {
      theme.dispose();
    }
  };
}
