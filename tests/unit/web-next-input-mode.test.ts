import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { inputModeOptions, mountInputMode } from "../../apps/web-next/src/story/ui/input-mode.js";

function fixture() {
  return parseHTML("<body></body>");
}

it("keeps Action campaigns explicit and locks Story Direction campaigns to scene input", () => {
  expect(inputModeOptions("flexible_action")).toEqual([
    { value: "action", label: "Story Action" },
    { value: "scene", label: "Story Direction" }
  ]);
  expect(inputModeOptions("action_only")).toEqual([{ value: "action", label: "Story Action" }]);
  expect(inputModeOptions("flexible_scene")).toEqual([{ value: "scene", label: "Story Direction" }]);
});

describe("Story interpretation control", () => {
  it("does not offer an automatic turn type", () => {
    expect(inputModeOptions("flexible_action").map((option) => option.value)).toEqual(["action", "scene"]);
    expect(inputModeOptions("flexible_scene").map((option) => option.value)).toEqual(["scene"]);
  });

  it("normalizes action-only updates and never emits unavailable or invalid values", () => {
    const { document, window } = fixture();
    const onChange = vi.fn();
    const control = mountInputMode(document, onChange);
    document.body.append(control.element);
    control.update({ style: "action_only", value: "scene", disabled: false });
    const group = control.element.querySelector<HTMLElement>("wa-radio-group");
    if (!group) throw new Error("Interpretation group is missing.");

    expect((group as unknown as { value: unknown }).value).toBe("action");
    expect([...group.querySelectorAll("wa-radio")].map((radio) => radio.getAttribute("value"))).toEqual(["action"]);
    (group as unknown as { value: unknown }).value = "scene";
    group.dispatchEvent(new window.Event("change", { bubbles: true }));
    (group as unknown as { value: unknown }).value = "unexpected";
    group.dispatchEvent(new window.Event("change", { bubbles: true }));
    expect(onChange).not.toHaveBeenCalled();
    control.dispose();
  });

  it("renders the labelled horizontal button group and applies updates without duplicate callbacks", () => {
    const { document, window } = fixture();
    const onChange = vi.fn();
    const control = mountInputMode(document, onChange);
    document.body.append(control.element);
    control.update({ style: "flexible_action", value: "action", disabled: false });
    const group = control.element.querySelector<HTMLElement>("wa-radio-group");
    if (!group) throw new Error("Interpretation group is missing.");

    expect(group.getAttribute("label")).toBe("Interpret prompt as");
    expect(group.getAttribute("orientation")).toBe("horizontal");
    expect([...group.querySelectorAll("wa-radio")].map((radio) => [radio.getAttribute("value"), radio.textContent, radio.getAttribute("appearance")]))
      .toEqual([["action", "Story Action", "button"], ["scene", "Story Direction", "button"]]);
    expect(control.element.textContent).not.toContain("classification");

    const originalRadios = [...group.querySelectorAll("wa-radio")];
    control.update({ style: "flexible_action", value: "action", disabled: false });
    expect(group.querySelector("wa-radio")).toBe(originalRadios[0]);
    (group as unknown as { value: unknown }).value = "scene";
    group.dispatchEvent(new window.Event("change", { bubbles: true }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith("scene");
    control.dispose();
  });

  it("suppresses changes while disabled and releases its listener on disposal", () => {
    const { document, window } = fixture();
    const onChange = vi.fn();
    const control = mountInputMode(document, onChange);
    document.body.append(control.element);
    control.update({ style: "flexible_scene", value: "scene", disabled: true });
    const group = control.element.querySelector<HTMLElement>("wa-radio-group");
    if (!group) throw new Error("Interpretation group is missing.");

    expect(group.hasAttribute("disabled")).toBe(true);
    (group as unknown as { value: unknown }).value = "action";
    group.dispatchEvent(new window.Event("change", { bubbles: true }));
    expect(onChange).not.toHaveBeenCalled();
    control.update({ style: "flexible_scene", value: "scene", disabled: false });
    expect(group.hasAttribute("disabled")).toBe(false);
    (group as unknown as { value: unknown }).value = "scene";
    group.dispatchEvent(new window.Event("change", { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith("scene");
    control.dispose();
    group.dispatchEvent(new window.Event("change", { bubbles: true }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
