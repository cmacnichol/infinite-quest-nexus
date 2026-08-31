import { parseHTML } from "linkedom";
import { expect, it, vi } from "vitest";
import { mountAppShell } from "../../apps/web-next/src/app-shell-lifecycle.js";
import { createDisplayPreferences } from "../../apps/web-next/src/preferences/display-preferences.js";

it("does not dispose borrowed preferences on shell remount", () => {
  const { document } = parseHTML("<body><div id=app></div></body>");
  const display = createDisplayPreferences(null);
  const dispose = vi.spyOn(display, "dispose");
  const root = document.querySelector<HTMLElement>("#app")!;

  const shell = mountAppShell(root, "<main>Page body</main>", "world-library", {
    uiImplementation: "native",
    displayPreferences: display
  });

  shell.dispose();
  shell.dispose();

  expect(dispose).not.toHaveBeenCalled();
  expect(root.querySelector("main")?.textContent).toBe("Page body");
});
