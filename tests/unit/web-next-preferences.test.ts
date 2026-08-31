import { parseHTML } from "linkedom";
import { expect, it, vi } from "vitest";
import { createThemeController } from "../../apps/web-next/src/theme.js";
import { createDisplayPreferences } from "../../apps/web-next/src/preferences/display-preferences.js";
import { mountProfileEditor } from "../../apps/web-next/src/preferences/profile-editor.js";
import { mountPreferencesDialog } from "../../apps/web-next/src/preferences/preferences-dialog.js";

const PROFILE = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  systemKey: "initial-owner",
  displayName: "Initial Owner",
  settings: {
    autoSubmitTurnChoices: true,
    continuousReading: false,
    defaultTurnControlStyle: "flexible_auto" as const
  }
};

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function installDialogMethods(document: Document, window: Window): void {
  const prototype = Object.getPrototypeOf(document.createElement("dialog")) as {
    showModal?: () => void;
    close?: () => void;
  };
  prototype.showModal ??= function showModal(this: HTMLDialogElement): void {
    this.setAttribute("open", "");
  };
  prototype.close ??= function close(this: HTMLDialogElement): void {
    this.removeAttribute("open");
    this.dispatchEvent(new window.Event("close"));
  };
}

it("serializes profile saves without letting an older response replace newer typing", async () => {
  const { document, window } = parseHTML("<body></body>");
  const first = deferred<typeof PROFILE>();
  const second = deferred<typeof PROFILE>();
  const save = vi.fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const editor = mountProfileEditor(document, { load: vi.fn().mockResolvedValue(PROFILE), save });
  document.body.append(editor.element);
  await editor.load();

  const name = editor.element.querySelector<HTMLInputElement>("[data-profile=display-name]")!;
  name.value = "Older draft";
  name.dispatchEvent(new window.Event("input", { bubbles: true }));
  name.value = "Newer draft";
  name.dispatchEvent(new window.Event("input", { bubbles: true }));
  await Promise.resolve();

  first.resolve({ ...PROFILE, displayName: "Server older" });
  await Promise.resolve();
  await Promise.resolve();
  expect(name.value).toBe("Newer draft");
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));

  second.resolve({ ...PROFILE, displayName: "Server newer" });
  await vi.waitFor(() => expect(name.value).toBe("Server newer"));
  editor.dispose();
});

it("keeps a failed profile draft and retries the same validated update", async () => {
  const { document, window } = parseHTML("<body></body>");
  const save = vi.fn()
    .mockRejectedValueOnce(new Error("Network unavailable"))
    .mockResolvedValueOnce({ ...PROFILE, settings: { ...PROFILE.settings, continuousReading: true } });
  const editor = mountProfileEditor(document, { load: vi.fn().mockResolvedValue(PROFILE), save });
  document.body.append(editor.element);
  await editor.load();

  const reading = editor.element.querySelector<HTMLInputElement>("[data-profile=continuous-reading]")!;
  reading.checked = true;
  reading.dispatchEvent(new window.Event("change", { bubbles: true }));

  const retry = editor.element.querySelector<HTMLButtonElement>("[data-profile-retry]")!;
  await vi.waitFor(() => expect(retry.hidden).toBe(false));
  expect(reading.checked).toBe(true);
  retry.click();
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[0]?.[0]).toEqual(save.mock.calls[1]?.[0]);
  editor.dispose();
});

it("keeps profile fields disabled after a load failure until Retry loads a profile", async () => {
  const { document } = parseHTML("<body></body>");
  const next = deferred<typeof PROFILE>();
  const load = vi.fn().mockRejectedValueOnce(new Error("Session unavailable")).mockReturnValueOnce(next.promise);
  const editor = mountProfileEditor(document, { load, save: vi.fn() });
  document.body.append(editor.element);

  await editor.load();
  const fields = editor.element.querySelector<HTMLFieldSetElement>("[data-profile-fields]")!;
  const retry = editor.element.querySelector<HTMLButtonElement>("[data-profile-retry]")!;
  expect(fields.disabled).toBe(true);
  expect(retry.hidden).toBe(false);

  retry.click();
  next.resolve(PROFILE);
  await Promise.resolve();
  await Promise.resolve();
  expect(fields.disabled).toBe(false);
  editor.dispose();
});

it("rejects blank and overlong profile names without a network write", async () => {
  const { document, window } = parseHTML("<body></body>");
  const save = vi.fn();
  const editor = mountProfileEditor(document, { load: vi.fn().mockResolvedValue(PROFILE), save });
  document.body.append(editor.element);
  await editor.load();
  const name = editor.element.querySelector<HTMLInputElement>("[data-profile=display-name]")!;

  name.value = " ";
  name.dispatchEvent(new window.Event("input", { bubbles: true }));
  name.value = "x".repeat(121);
  name.dispatchEvent(new window.Event("input", { bubbles: true }));
  await Promise.resolve();

  expect(name.getAttribute("aria-invalid")).toBe("true");
  expect(save).not.toHaveBeenCalled();
  editor.dispose();
});

it("does not update a disposed profile editor when an authorized save resolves", async () => {
  const { document, window } = parseHTML("<body></body>");
  const pending = deferred<typeof PROFILE>();
  const editor = mountProfileEditor(document, {
    load: vi.fn().mockResolvedValue(PROFILE),
    save: vi.fn().mockReturnValue(pending.promise)
  });
  document.body.append(editor.element);
  await editor.load();
  const name = editor.element.querySelector<HTMLInputElement>("[data-profile=display-name]")!;
  name.value = "Draft retained";
  name.dispatchEvent(new window.Event("input", { bubbles: true }));
  await Promise.resolve();
  editor.dispose();
  pending.resolve({ ...PROFILE, displayName: "Server response" });
  await Promise.resolve();
  await Promise.resolve();

  expect(name.value).toBe("Draft retained");
});

it("preserves a pending draft through reopen when its save later fails", async () => {
  const { document, window } = parseHTML("<body></body>");
  const pending = deferred<typeof PROFILE>();
  const save = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(PROFILE);
  const load = vi.fn()
    .mockResolvedValueOnce(PROFILE)
    .mockResolvedValueOnce({ ...PROFILE, displayName: "Older server profile" });
  const editor = mountProfileEditor(document, { load, save });
  document.body.append(editor.element);
  await editor.load();

  const name = editor.element.querySelector<HTMLInputElement>("[data-profile=display-name]")!;
  name.value = "Pending draft";
  name.dispatchEvent(new window.Event("input", { bubbles: true }));
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));

  await editor.load();
  expect(name.value).toBe("Pending draft");

  pending.reject(new Error("Network unavailable"));
  const retry = editor.element.querySelector<HTMLButtonElement>("[data-profile-retry]")!;
  await vi.waitFor(() => expect(retry.hidden).toBe(false));
  expect(name.value).toBe("Pending draft");
  retry.click();
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[1]?.[0]).toEqual(save.mock.calls[0]?.[0]);
  editor.dispose();
});

it("persists Story width locally without patching a user profile", () => {
  const { document, window } = parseHTML("<body></body>");
  const display = createDisplayPreferences(null);
  const save = vi.fn();
  const theme = createThemeController({ root: document.documentElement, storage: null, mediaQuery: null });
  const panel = mountPreferencesDialog(document.body, {
    theme,
    display,
    campaignId: null,
    profile: { load: vi.fn(), save }
  });
  const control = document.querySelector<HTMLElement & { value: string }>("[data-preference=story-width]")!;
  control.value = "full";
  control.dispatchEvent(new window.Event("change", { bubbles: true }));

  expect(display.get().storyWidth).toBe("full");
  expect(save).not.toHaveBeenCalled();

  panel.dispose();
  theme.dispose();
  display.dispose();
});

it("keeps device display changes usable when browser storage is denied", () => {
  const { document, window } = parseHTML("<body></body>");
  const display = createDisplayPreferences({
    getItem: () => { throw new Error("storage denied"); },
    setItem: () => { throw new Error("storage denied"); }
  });
  const theme = createThemeController({ root: document.documentElement, storage: null, mediaQuery: null });
  const panel = mountPreferencesDialog(document.body, {
    theme,
    display,
    campaignId: null,
    profile: { load: vi.fn().mockResolvedValue(PROFILE), save: vi.fn() }
  });
  const control = document.querySelector<HTMLElement & { value: string }>("[data-preference=story-width]")!;
  control.value = "comfortable";
  control.dispatchEvent(new window.Event("change", { bubbles: true }));

  expect(display.get().storyWidth).toBe("comfortable");
  panel.dispose();
  theme.dispose();
  display.dispose();
});

it("allows an already open preferences dialog to be opened again safely", async () => {
  const { document, window } = parseHTML("<body><button>Preferences</button></body>");
  installDialogMethods(document, window);
  const display = createDisplayPreferences(null);
  const theme = createThemeController({ root: document.documentElement, storage: null, mediaQuery: null });
  const load = vi.fn().mockResolvedValue(PROFILE);
  const panel = mountPreferencesDialog(document.body, {
    theme,
    display,
    campaignId: null,
    profile: { load, save: vi.fn() }
  });

  await panel.open();
  await panel.open();

  expect(document.querySelector("dialog")?.hasAttribute("open")).toBe(true);
  expect(load).toHaveBeenCalledTimes(2);
  panel.close();
  panel.dispose();
  theme.dispose();
  display.dispose();
});
