import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const screenshotDirectory = resolve(".superpowers/sdd/legacy-ui-2026-10-03/evidence/screenshots");

test("native Escape, Cancel, and backdrop use one dismissal policy with nested focus restoration", async ({ page }) => {
  mkdirSync(screenshotDirectory, { recursive: true });
  await page.goto(`${origin}/nexus/legacy-management.js`);
  await page.setContent(`
    <button id="openEditor">Open editor</button>
    <dialog id="editor">
      <label>Title <input id="editorField" value="Draft"></label>
      <button id="cancelEdit">Cancel</button>
    </dialog>
    <dialog id="confirmDismissal">
      <p>Save your changes?</p>
      <button id="save">Save</button>
      <button id="stay">Keep editing</button>
      <button id="discard">Discard</button>
    </dialog>
    <output id="counts"></output>
  `);

  await page.evaluate(async () => {
    const adapterUrl = new URL("/nexus/legacy-management.js", location.origin).href;
    const { bindEditDialogDismissal, requestEditDismissal } = await import(adapterUrl);
    const editor = document.querySelector<HTMLDialogElement>("#editor")!;
    const confirmDialog = document.querySelector<HTMLDialogElement>("#confirmDismissal")!;
    const opener = document.querySelector<HTMLButtonElement>("#openEditor")!;
    const editorField = document.querySelector<HTMLInputElement>("#editorField")!;
    const cancel = document.querySelector<HTMLButtonElement>("#cancelEdit")!;
    const stay = document.querySelector<HTMLButtonElement>("#stay")!;
    const discard = document.querySelector<HTMLButtonElement>("#discard")!;
    const save = document.querySelector<HTMLButtonElement>("#save")!;
    const counts = document.querySelector<HTMLOutputElement>("#counts")!;
    const state = { dirty: true, busy: false, prompts: 0, writes: 0, discards: 0, epoch: 0, deferConfirm: false };
    let resolvePendingDecision: ((decision: "save" | "discard" | "stay") => void) | undefined;
    const confirm = () => {
      state.prompts += 1;
      counts.value = `${state.prompts}:${state.writes}`;
      if (state.deferConfirm) {
        return new Promise<"save" | "discard" | "stay">((resolveChoice) => { resolvePendingDecision = resolveChoice; });
      }
      confirmDialog.returnValue = "";
      confirmDialog.showModal();
      return new Promise<"save" | "discard" | "stay">((resolveChoice) => {
        confirmDialog.addEventListener("close", () => resolveChoice(confirmDialog.returnValue === "discard" ? "discard" : confirmDialog.returnValue === "save" ? "save" : "stay"), { once: true });
      });
    };
    const getOptions = () => {
      const epoch = state.epoch;
      return {
        isDirty: () => state.dirty,
        isBusy: () => state.busy,
        isCurrent: () => state.epoch === epoch,
        confirm,
        save: async () => { state.writes += 1; state.dirty = false; },
        discard: () => { state.discards += 1; state.dirty = false; },
        returnFocusTo: opener
      };
    };

    bindEditDialogDismissal(editor, getOptions);
    document.querySelector<HTMLButtonElement>("#openEditor")!.addEventListener("click", () => {
      state.epoch += 1;
      state.dirty = true;
      editor.showModal();
      editorField.focus();
    });
    cancel.addEventListener("click", () => { void requestEditDismissal({ ...getOptions(), dialog: editor }); });
    editor.addEventListener("click", (event) => {
      if (event.target === editor) void requestEditDismissal({ ...getOptions(), dialog: editor });
    });
    stay.addEventListener("click", () => confirmDialog.close("stay"));
    discard.addEventListener("click", () => confirmDialog.close("discard"));
    save.addEventListener("click", () => confirmDialog.close("save"));
    Object.assign(window, { editDismissalTestState: state, resolveEditDismissalDecision: (decision: "save" | "discard" | "stay") => resolvePendingDecision?.(decision) });
  });

  await page.locator("#openEditor").click();
  await page.keyboard.press("Escape");
  await expect(page.locator("#confirmDismissal")).toBeVisible();
  await expect(page.locator("#save")).toBeVisible();
  await page.screenshot({ path: resolve(screenshotDirectory, "t02-nested-dismissal-desktop.png") });
  await page.keyboard.press("Escape");
  await expect(page.locator("#confirmDismissal")).toBeHidden();
  await expect(page.locator("#editor")).toBeVisible();
  await expect(page.locator("#editorField")).toBeFocused();
  await expect(page.locator("#counts")).toHaveText("1:0");

  await page.evaluate(() => (window as unknown as Window & { editDismissalTestState: { deferConfirm: boolean } }).editDismissalTestState.deferConfirm = true);
  await page.locator("#cancelEdit").click();
  await expect(page.locator("#counts")).toHaveText("2:0");
  await page.evaluate(() => {
    const state = (window as unknown as Window & { editDismissalTestState: { dirty: boolean; epoch: number } }).editDismissalTestState;
    const editor = document.querySelector<HTMLDialogElement>("#editor")!;
    editor.close();
    state.epoch += 1;
    state.dirty = true;
    editor.showModal();
    document.querySelector<HTMLInputElement>("#editorField")!.focus();
  });
  await page.evaluate(() => (window as unknown as Window & { resolveEditDismissalDecision: (decision: "save" | "discard" | "stay") => void }).resolveEditDismissalDecision("discard"));
  await expect(page.locator("#editor")).toBeVisible();
  await expect(page.locator("#editorField")).toBeFocused();
  await expect.poll(() => page.evaluate(() => (window as unknown as Window & { editDismissalTestState: { discards: number } }).editDismissalTestState.discards)).toBe(0);

  await page.evaluate(() => (window as unknown as Window & { editDismissalTestState: { deferConfirm: boolean } }).editDismissalTestState.deferConfirm = false);
  await page.locator("#cancelEdit").click();
  await expect(page.locator("#confirmDismissal")).toBeVisible();
  await page.locator("#discard").click();
  await expect(page.locator("#editor")).toBeHidden();
  await expect(page.locator("#openEditor")).toBeFocused();

  await page.locator("#openEditor").click();
  const editorBounds = await page.locator("#editor").boundingBox();
  if (!editorBounds) throw new Error("Editor dialog did not open");
  await page.mouse.click(4, 4);
  await expect(page.locator("#confirmDismissal")).toBeVisible();
  await page.locator("#discard").click();
  await expect(page.locator("#editor")).toBeHidden();
  await expect(page.locator("#openEditor")).toBeFocused();
  await expect(page.locator("#counts")).toHaveText("4:0");
  await expect.poll(() => page.evaluate(() => (window as Window & { editDismissalTestState?: { writes: number; discards: number } }).editDismissalTestState?.writes)).toBe(0);
  await expect.poll(() => page.evaluate(() => (window as Window & { editDismissalTestState?: { discards: number } }).editDismissalTestState?.discards)).toBe(2);
});
