import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { createReviewSource } from "../../apps/web/src/character-review-source.js";

describe("character review source passage", () => {
  const source = { turnId: "turn-a", turnNumber: 8, narrationRevision: 0 };
  function setup(text: string, id = source.turnId) {
    const { document } = parseHTML("<html><body></body></html>");
    const read = vi.fn(async () => ({ campaignId: "campaign", turn: { id, turnNumber: 8, narration: text } }));
    const section = createReviewSource(document, "campaign", source, "Her eyes met his.", read, () => true, () => {});
    document.body.append(section);
    return { section, read };
  }
  it("reads just the cited turn when expanded and preserves the review card on repeated inspection", async () => {
    const { section, read } = setup("The guide turned.\n\nHer eyes met his.\n\nThey waited.");
    expect(read).not.toHaveBeenCalled();
    section.querySelector("button")!.click();
    await vi.waitFor(() => expect(section.querySelector("mark")?.textContent).toBe("Her eyes met his."));
    expect(section.textContent).toContain("The guide turned.");
    section.querySelector("button")!.click(); section.querySelector("button")!.click();
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("campaign", 8);
  });
  it("never shows text from a replaced turn", async () => {
    const { section } = setup("Unrelated text. Her eyes met his.", "replacement");
    section.querySelector("button")!.click();
    await vi.waitFor(() => expect(section.textContent).toContain("source has changed"));
    expect(section.textContent).not.toContain("Unrelated text");
  });
  it("rejects a corrected turn even when the quoted words remain", async () => {
    const { document } = parseHTML("<html><body></body></html>");
    const section = createReviewSource(document, "campaign", { ...source, sourceHash: "a".repeat(64) }, "Her eyes met his.",
      async () => ({ campaignId: "campaign", sourceHash: "b".repeat(64), turn: { id: source.turnId, turnNumber: 8, narration: "Changed context. Her eyes met his." } }), () => true, () => {});
    document.body.append(section); section.querySelector("button")!.click();
    await vi.waitFor(() => expect(section.textContent).toContain("source has changed"));
    expect(section.textContent).not.toContain("Changed context");
  });
  it("labels current text when an older server does not provide a fingerprint", async () => {
    const { section } = setup("Her eyes met his.");
    section.querySelector("button")!.click();
    await vi.waitFor(() => expect(section.textContent).toContain("Current text may differ from the original reviewed source."));
  });

});
