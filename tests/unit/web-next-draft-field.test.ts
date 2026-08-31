import { parseHTML } from "linkedom";
import { expect, it, vi } from "vitest";
import { mountDraftField } from "../../apps/web-next/src/story/ui/draft-field.js";

type DraftInput = HTMLElement & { value: string; disabled: boolean };

function fixture() {
  const { document, window } = parseHTML("<body></body>");
  const changed = vi.fn();
  const field = mountDraftField(document, changed);
  document.body.append(field.element);
  return { document, window, changed, field };
}

function inputOf(root: ParentNode): DraftInput {
  const input = root.querySelector<DraftInput>("wa-textarea");
  if (!input) throw new Error("Draft field is missing its textarea.");
  return input;
}

it("retains its field across input and unrelated updates", () => {
  const { document, window, changed, field } = fixture();
  field.update({ ownerKey: "campaign:turn", value: "", disabled: false });
  const input = inputOf(document);

  input.value = "New typing";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  field.update({ ownerKey: "campaign:turn", value: "New typing", disabled: true });

  expect(document.querySelector("wa-textarea")).toBe(input);
  expect(input.value).toBe("New typing");
  expect(input.disabled).toBe(true);
  expect(changed).toHaveBeenCalledExactlyOnceWith("New typing");
  field.dispose();
});

it("uses the current owner draft when the active turn changes", () => {
  const { document, field } = fixture();
  field.update({ ownerKey: "campaign:one", value: "First draft", disabled: false });
  const input = inputOf(document);

  field.update({ ownerKey: "campaign:two", value: "Second draft", disabled: false });

  expect(document.querySelector("wa-textarea")).toBe(input);
  expect(input.value).toBe("Second draft");
  field.dispose();
});

it("keeps help and count descriptions distinct for simultaneous fields", () => {
  const { document, field } = fixture();
  const second = mountDraftField(document, vi.fn());
  document.body.append(second.element);

  const firstInput = inputOf(field.element);
  const secondInput = inputOf(second.element);
  const firstDescriptions = firstInput.getAttribute("aria-describedby")?.split(" ") ?? [];
  const secondDescriptions = secondInput.getAttribute("aria-describedby")?.split(" ") ?? [];

  expect(firstDescriptions).toHaveLength(2);
  expect(secondDescriptions).toHaveLength(2);
  expect(firstDescriptions).not.toEqual(secondDescriptions);
  expect(firstDescriptions.every((id) => document.getElementById(id)?.parentElement === field.element)).toBe(true);
  expect(secondDescriptions.every((id) => document.getElementById(id)?.parentElement === second.element)).toBe(true);
  second.dispose();
  field.dispose();
});

it("clears locally, delegates model clearing, and restores editor focus", () => {
  const { document, field } = fixture();
  const cleared = vi.fn();
  const withClear = mountDraftField(document, vi.fn(), cleared);
  document.body.append(withClear.element);
  withClear.update({ ownerKey: "campaign:turn", value: "Keep no text", disabled: false });
  const input = inputOf(withClear.element);
  const focused = vi.spyOn(input, "focus");

  withClear.clear();

  expect(input.value).toBe("");
  expect(cleared).toHaveBeenCalledExactlyOnceWith();
  expect(focused).toHaveBeenCalled();
  withClear.dispose();
  field.dispose();
});

it("reports an empty draft when no model clear callback is supplied", () => {
  const { document, changed, field } = fixture();
  field.update({ ownerKey: "campaign:turn", value: "Retreat to the gate", disabled: false });

  field.clear();

  expect(inputOf(document).value).toBe("");
  expect(changed).toHaveBeenCalledExactlyOnceWith("");
  field.dispose();
});

it("uses ordinary input events for pasted draft changes and ignores change events", () => {
  const { document, window, changed, field } = fixture();
  field.update({ ownerKey: "campaign:turn", value: "", disabled: false });
  const input = inputOf(document);

  input.value = "Pasted action";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  input.dispatchEvent(new window.Event("change", { bubbles: true }));

  expect(changed).toHaveBeenCalledExactlyOnceWith("Pasted action");
  field.dispose();
});

it("keeps an active composition when an older same-owner snapshot arrives", () => {
  const { document, window, changed, field } = fixture();
  field.update({ ownerKey: "campaign:turn", value: "Before composing", disabled: false });
  const input = inputOf(document);

  input.dispatchEvent(new window.Event("compositionstart", { bubbles: true }));
  input.value = "Composing a new action";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  field.update({ ownerKey: "campaign:turn", value: "Before composing", disabled: false });
  input.dispatchEvent(new window.Event("compositionend", { bubbles: true }));

  expect(input.value).toBe("Composing a new action");
  expect(changed).toHaveBeenLastCalledWith("Composing a new action");
  field.dispose();
});

it("stops notifying its owner after disposal", () => {
  const { document, window, changed, field } = fixture();
  field.update({ ownerKey: "campaign:turn", value: "", disabled: false });
  const input = inputOf(document);
  field.dispose();

  input.value = "Detached";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));

  expect(changed).not.toHaveBeenCalled();
});
