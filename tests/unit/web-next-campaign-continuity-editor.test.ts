import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { createCampaignContinuityDraft } from "../../packages/client-core/src/index.js";
import { createCampaignContinuityEditor } from "../../apps/web-next/src/campaign-continuity-editor.js";
import { currentStateFixture } from "../fixtures/current-state-corrections.js";

describe("web-next campaign continuity editor", () => {
  it("keeps an existing fact identity while editing its multiline content", () => {
    const { document } = parseHTML("<main></main>");
    const base = currentStateFixture();
    const onChange = vi.fn();
    const editor = createCampaignContinuityEditor(
      document,
      createCampaignContinuityDraft(base),
      { idPrefix: "campaign-state", onChange }
    );
    document.querySelector("main")!.append(editor.element);

    const fact = editor.element.querySelector<HTMLTextAreaElement>("[data-fact-content]")!;
    fact.value = "The lens is clear glass.\nIt catches the moonlight.";
    fact.dispatchEvent(new document.defaultView!.Event("input", { bubbles: true }));

    expect(editor.readDraft().canonicalFacts[0]!.id).toBe(base.canonicalFacts[0]!.id);
    expect(editor.readDraft().canonicalFacts[0]!.content).toBe("The lens is clear glass.\nIt catches the moonlight.");
    expect(editor.element.querySelector("[data-edit-fact-id]")).toBeNull();
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("adds and removes individual rows without turning a newline into another row", () => {
    const { document } = parseHTML("<main></main>");
    let focused: HTMLElement | null = null;
    Object.defineProperty(document.defaultView!.HTMLElement.prototype, "focus", {
      value: function focus(this: HTMLElement) { focused = this; },
      configurable: true
    });
    const editor = createCampaignContinuityEditor(
      document,
      createCampaignContinuityDraft(currentStateFixture()),
      { idPrefix: "story-state", onChange: () => undefined }
    );
    document.querySelector("main")!.append(editor.element);

    editor.element.querySelector<HTMLButtonElement>("[data-add-thread]")!.click();
    const threads = editor.element.querySelectorAll<HTMLTextAreaElement>("[data-thread-content]");
    threads[1]!.value = "Ask the keeper.\nDo not wake the bell.";
    threads[1]!.dispatchEvent(new document.defaultView!.Event("input", { bubbles: true }));
    const remove = editor.element.querySelector<HTMLButtonElement>("[data-remove-thread]")!;
    expect(remove.getAttribute("aria-label")).toBe("Remove open thread 1");
    remove.click();

    expect(editor.readDraft().openThreads).toEqual([{ key: "thread:1", content: "Ask the keeper.\nDo not wake the bell." }]);
    expect(focused).toBe(editor.element.querySelector("[data-thread-content]"));
  });
});
