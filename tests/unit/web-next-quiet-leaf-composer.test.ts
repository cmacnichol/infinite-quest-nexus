import { parseHTML } from "linkedom";
import { expect, it, vi } from "vitest";
import { mountComposer, type ComposerState } from "../../apps/web-next/src/story/ui/composer.js";

function fixture() {
  const { document, window } = parseHTML("<body></body>");
  const actions = {
    draft: vi.fn(),
    clearDraft: vi.fn(),
    mode: vi.fn(),
    choose: vi.fn(),
    length: vi.fn(),
    continueStory: vi.fn(),
    retryTurn: vi.fn(),
    history: vi.fn(),
    confirm: vi.fn(),
    returnToEditor: vi.fn()
  };
  const composer = mountComposer(document, actions);
  document.body.append(composer.element);
  return { document, window, actions, composer };
}

const state: ComposerState = {
  draft: { ownerKey: "a:1", value: "Test", disabled: false },
  input: { style: "flexible_auto", value: "auto", disabled: false },
  choices: { choices: [], selected: [], disabled: false },
  length: { campaignDefault: "standard", override: null, disabled: false },
  canContinue: true,
  canRetry: true,
  status: null,
  confirmation: null
};

it("keeps Retry isolated and retains the draft node on status updates", () => {
  const { document, composer } = fixture();
  composer.update(state);
  const input = composer.element.querySelector("wa-textarea");
  composer.update({ ...state, status: "Connection recovered" });

  expect(composer.element.querySelector("wa-textarea")).toBe(input);
  expect(composer.element.querySelector("[data-retry-zone] [data-retry-turn]")).not.toBeNull();
  expect(composer.element.querySelector("[data-primary-zone] [data-retry-turn]")).toBeNull();
  expect(document.querySelector("[data-composer-status]")?.textContent).toBe("Connection recovered");
  composer.dispose();
});

it("keeps the footer functional after the reader moves it outside the composer root", () => {
  const { document, window, actions, composer } = fixture();
  composer.update(state);
  document.body.append(composer.footer);
  composer.update({ ...state, canRetry: false, status: "Generating next turn" });

  const retry = composer.footer.querySelector<HTMLButtonElement>("[data-retry-turn]");
  const continueStory = composer.footer.querySelector<HTMLButtonElement>("[data-continue-story]");
  if (!retry || !continueStory) throw new Error("Composer footer controls are missing.");
  expect(retry.disabled).toBe(true);
  expect(composer.footer.querySelector("[data-composer-status]")?.textContent).toBe("Generating next turn");
  continueStory.dispatchEvent(new window.Event("click", { bubbles: true }));
  expect(actions.continueStory).toHaveBeenCalledExactlyOnceWith();

  composer.dispose();
  expect(document.body.contains(composer.element)).toBe(false);
  expect(document.body.contains(composer.footer)).toBe(false);
});

it("blocks unavailable turn controls and does not invent an idle status", () => {
  const { document, window, actions, composer } = fixture();
  composer.update({ ...state, canContinue: false, canRetry: false, status: null });
  const retry = composer.footer.querySelector<HTMLButtonElement>("[data-retry-turn]");
  const continueStory = composer.footer.querySelector<HTMLButtonElement>("[data-continue-story]");
  if (!retry || !continueStory) throw new Error("Composer turn controls are missing.");

  retry.dispatchEvent(new window.Event("click", { bubbles: true }));
  continueStory.dispatchEvent(new window.Event("click", { bubbles: true }));
  expect(actions.retryTurn).not.toHaveBeenCalled();
  expect(actions.continueStory).not.toHaveBeenCalled();
  expect(document.querySelector("[data-composer-status]")?.textContent).toBe("");
  expect(document.querySelector("[data-composer-status]")?.textContent).not.toContain("Ready");
  composer.dispose();
});

it("renders captured ambiguity as text and confirms without rereading the draft", () => {
  const { document, window, actions, composer } = fixture();
  const captured = '<img src=x onerror="alert(1)"> Decide later';
  composer.update({ ...state, confirmation: { action: captured } });
  composer.update({ ...state, draft: { ...state.draft, value: "A newer draft" }, confirmation: { action: captured } });

  const confirmation = composer.element.querySelector<HTMLElement>("[data-story-intent-confirmation]");
  const action = confirmation?.querySelector<HTMLButtonElement>("[data-confirm-intent-action]");
  const scene = confirmation?.querySelector<HTMLButtonElement>("[data-confirm-intent-scene]");
  if (!confirmation || !action || !scene) throw new Error("Composer confirmation controls are missing.");
  expect(confirmation.textContent).toContain(captured);
  expect(confirmation.querySelector("img")).toBeNull();

  action.dispatchEvent(new window.Event("click", { bubbles: true }));
  scene.dispatchEvent(new window.Event("click", { bubbles: true }));
  expect(actions.confirm).toHaveBeenNthCalledWith(1, "action");
  expect(actions.confirm).toHaveBeenNthCalledWith(2, "scene");
  composer.dispose();
});

it("returns focus to the existing draft after leaving confirmation", () => {
  const { window, actions, composer } = fixture();
  composer.update({ ...state, confirmation: { action: "Keep the lamp lit" } });
  const input = composer.element.querySelector<HTMLElement>("wa-textarea");
  const returnToEditor = composer.element.querySelector<HTMLButtonElement>("[data-return-to-editor]");
  if (!input || !returnToEditor) throw new Error("Composer editor controls are missing.");
  const focus = vi.spyOn(input, "focus");

  returnToEditor.dispatchEvent(new window.Event("click", { bubbles: true }));
  expect(actions.returnToEditor).toHaveBeenCalledExactlyOnceWith();
  expect(focus).toHaveBeenCalledOnce();
  composer.dispose();
});

it("keeps hidden confirmations out of the accessibility tree and labels each composer uniquely", () => {
  const { document, composer } = fixture();
  const second = mountComposer(document, {
    draft: vi.fn(), clearDraft: vi.fn(), mode: vi.fn(), choose: vi.fn(), length: vi.fn(),
    continueStory: vi.fn(), retryTurn: vi.fn(), history: vi.fn(), confirm: vi.fn(), returnToEditor: vi.fn()
  });
  document.body.append(second.element);
  composer.update(state);
  second.update(state);

  const confirmations = document.querySelectorAll<HTMLElement>("[data-story-intent-confirmation]");
  expect(confirmations).toHaveLength(2);
  expect(confirmations[0]?.hidden).toBe(true);
  expect(confirmations[0]?.getAttribute("aria-labelledby")).not.toBe(confirmations[1]?.getAttribute("aria-labelledby"));

  composer.dispose();
  second.dispose();
});
