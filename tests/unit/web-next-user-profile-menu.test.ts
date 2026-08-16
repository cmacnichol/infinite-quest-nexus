import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderAppShell } from "../../apps/web-next/src/app-shell.js";

const profile = {
  id: "11111111-1111-4111-8111-111111111111",
  systemKey: "initial-owner",
  displayName: "Initial Owner",
  settings: {
    autoSubmitTurnChoices: true,
    continuousReading: false,
    defaultTurnControlStyle: "flexible_auto"
  }
};

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function setControlValue(control: HTMLInputElement | HTMLSelectElement, value: string): void {
  try {
    control.value = value;
  } catch {
    // The parsed test DOM falls through to the attribute update below.
  }
  control.setAttribute("value", value);
}

function controlValue(control: HTMLInputElement | HTMLSelectElement): string {
  return control.value || control.getAttribute("value") || "";
}

afterEach(() => vi.unstubAllGlobals());

describe("web-next user profile menu", () => {
  it("opens the legacy-profile-icon modal and persists each setting immediately", async () => {
    const { document, Event } = parseHTML('<html><body><div id="app"></div></body></html>').window;
    const root = document.querySelector<HTMLElement>("#app");
    if (!root) throw new Error("Shell fixture is missing.");
    const updates: unknown[] = [];
    let currentProfile = structuredClone(profile);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/session") return new Response(JSON.stringify({ user: currentProfile }), { status: 200 });
      if (url === "/api/v1/users/me/profile" && init?.method === "PATCH") {
        const update = JSON.parse(String(init.body));
        updates.push(update);
        currentProfile = {
          ...currentProfile,
          ...update,
          settings: { ...currentProfile.settings, ...update.settings }
        };
        return new Response(JSON.stringify({ user: currentProfile }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }));

    renderAppShell(root, '<main id="main-content">Page</main>', "world-library");
    const menuButton = document.querySelector<HTMLButtonElement>(".user-profile-toggle");
    const dialog = document.querySelector<HTMLDialogElement>(".user-profile-dialog");
    const name = document.querySelector<HTMLInputElement>("#user-profile-display-name");
    const autoSubmit = document.querySelector<HTMLInputElement>("#user-profile-auto-submit");
    const continuous = document.querySelector<HTMLInputElement>("#user-profile-continuous-reading");
    const turnStyle = document.querySelector<HTMLSelectElement>("#user-profile-turn-style");
    const closeButton = document.querySelector<HTMLButtonElement>("[data-user-profile-close]");
    if (!menuButton || !dialog || !name || !autoSubmit || !continuous || !turnStyle || !closeButton) throw new Error("Profile controls are missing.");

    expect(menuButton.getAttribute("aria-label")).toBe("User profile and settings");
    expect(menuButton.querySelector("svg path")?.getAttribute("d")).toBe("M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0");

    menuButton.dispatchEvent(new Event("click"));
    await settle();
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(controlValue(name)).toBe("Initial Owner");
    expect(autoSubmit.checked).toBe(true);
    expect(continuous.checked).toBe(false);
    expect(controlValue(turnStyle)).toBe("flexible_auto");

    setControlValue(name, "Atlas Keeper");
    name.dispatchEvent(new Event("input"));
    autoSubmit.checked = false;
    autoSubmit.dispatchEvent(new Event("change"));
    continuous.checked = true;
    continuous.dispatchEvent(new Event("change"));
    setControlValue(turnStyle, "flexible_scene");
    turnStyle.dispatchEvent(new Event("change"));
    await settle();

    expect(updates).toHaveLength(4);
    expect(updates.at(-1)).toEqual({
      displayName: "Atlas Keeper",
      settings: {
        autoSubmitTurnChoices: false,
        continuousReading: true,
        defaultTurnControlStyle: "flexible_scene"
      }
    });
    closeButton.dispatchEvent(new Event("click"));
    expect(dialog.hasAttribute("open")).toBe(false);
  });

  it("keeps an invalid display name in place and explains the recovery without saving", async () => {
    const { document, Event } = parseHTML('<html><body><div id="app"></div></body></html>').window;
    const root = document.querySelector<HTMLElement>("#app");
    if (!root) throw new Error("Shell fixture is missing.");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ user: profile }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    renderAppShell(root, '<main id="main-content">Page</main>', "world-library");
    const menuButton = document.querySelector<HTMLButtonElement>(".user-profile-toggle");
    const name = document.querySelector<HTMLInputElement>("#user-profile-display-name");
    const status = document.querySelector<HTMLElement>("[data-user-profile-status]");
    if (!menuButton || !name || !status) throw new Error("Profile controls are missing.");

    menuButton.dispatchEvent(new Event("click"));
    await settle();
    setControlValue(name, "   ");
    name.dispatchEvent(new Event("input"));
    await settle();

    expect(status.textContent).toContain("Display name is required");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
