import { describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { renderCharacterSheetView } from "../../apps/web/src/character-editor/character-sheet-view.js";
import type { CharacterField, CharacterSheet } from "../../packages/client-core/src/characters/sheet.js";

const field = (path: string, value: string | string[] | null = "they/them"): CharacterField => ({ path, label: path === "identity.pronouns" ? "Pronouns" : "Aliases", value, origin: "user", observations: [], editTurn: 12, observedTurn: null, replacedEditTurn: null, storyDiffers: null, retractable: null, retractableObservationIds: [] });
function setup(extra: Partial<Parameters<typeof renderCharacterSheetView>[1]> = {}) {
  const { document, Event } = parseHTML("<html><body><div id='host'></div></body></html>");
  const host = document.getElementById("host") as unknown as HTMLElement;
  const sheet: CharacterSheet = { name: "A", kind: "supporting", sections: [{ name: "Identity", fields: [field("identity.pronouns"), field("identity.aliases", ["One"])] }], sources: [], locks: [], attention: [] };
  const options: Parameters<typeof renderCharacterSheetView>[1] = { sheet, kind: "supporting", editable: () => true, lockedReason: null, onChange: vi.fn().mockResolvedValue({ ok: true }), onCompareLatest: vi.fn(), compareLabel: "Compare latest", showEmpty: true, onShowEmpty: vi.fn(), confirmDiscard: () => true, isCurrent: () => true, ...extra };
  const view = renderCharacterSheetView(host, options);
  const click = (text: string) => { const button = Array.from(host.querySelectorAll("button")).find(b => b.textContent === text); expect(button).toBeTruthy(); button!.dispatchEvent(new Event("click", { bubbles: true })); };
  return { host, options, view, click, Event };
}
describe("character sheet view", () => {
  it("edits with descriptor controls and preserves text on conflict", async () => {
    const onChange = vi.fn().mockResolvedValue({ ok: false, conflict: true, message: "stale" });
    const { host, click, Event } = setup({ onChange });
    expect(host.textContent).toContain("Your edit · turn 12");
    click("Edit Pronouns"); const input = host.querySelector("input:not([type=checkbox])") as HTMLInputElement;
    input.value = "  she/her  "; input.dispatchEvent(new Event("input", { bubbles: true })); click("Save"); await Promise.resolve(); await Promise.resolve();
    expect(onChange).toHaveBeenCalledWith({ kind: "field", path: "identity.pronouns", value: "she/her" });
    expect(input.value).toBe("  she/her  "); expect(host.textContent).toContain("This character changed. Your edit is kept; compare the latest before saving.");
  });
  it("renders hostile values safely and keeps a dirty editor when discard is declined", () => {
    const f = field("identity.pronouns", "<img src=x>"); const { host, click, Event } = setup({ sheet: { name: "A", kind: "supporting", sections: [{ name: "Identity", fields: [f, field("identity.aliases")] }], sources: [], locks: [], attention: [] }, confirmDiscard: () => false });
    expect(host.querySelector("img")).toBeNull(); click("Edit Pronouns"); const input = host.querySelector("input:not([type=checkbox])") as HTMLInputElement; input.value = "changed"; input.dispatchEvent(new Event("input")); click("Edit Aliases"); expect(host.querySelector("input:not([type=checkbox])")).toBe(input);
  });
  it("renders controller feedback and safely ignores late failures", async () => {
    let finish!: (result: { ok: false; conflict: boolean; message: string }) => void;
    const pending = new Promise<{ ok: false; conflict: boolean; message: string }>(resolve => { finish = resolve; });
    const undo = vi.fn().mockResolvedValue({ ok: true }); const a = setup({ feedback: { message: "Saved Pronouns", undo }, onChange: () => pending });
    expect(a.host.textContent).toContain("Saved Pronouns"); a.click("Undo"); await Promise.resolve(); await Promise.resolve(); expect(undo).toHaveBeenCalledOnce();
    a.click("Edit Pronouns"); a.click("Save"); a.view.dispose(); a.host.textContent = "replacement"; finish({ ok: false, conflict: true, message: "stale" }); await Promise.resolve(); await Promise.resolve(); expect(a.host.textContent).toBe("replacement");
  });
  it("retracts only eligible displayed facts and renders preview as text", async () => {
    const observed = field("identity.pronouns", "Tinker");
    const observation = { id: "a", field: "identity.pronouns", value: "Tinker", mode: "fact", supersedesObservationId: null, evidence: { kind: "turn", turnNumber: 7, quote: "<img src=x>", invalidated: false } } as unknown as CharacterField["observations"][number];
    observed.origin = "observed"; observed.observedTurn = 7; observed.retractable = observation; observed.retractableObservationIds = ["a"]; observed.observations = [observation];
    const apply = vi.fn().mockResolvedValue({ ok: true });
    const { host, click } = setup({ sheet: { name: "A", kind: "supporting", sections: [{ name: "Identity", fields: [observed] }], sources: [], locks: [], attention: [] }, retraction: { preview: vi.fn().mockResolvedValue({ currentValue: "Tinker", projectedValue: null, quote: "<img src=x>", turn: 7 }), apply } });
    click("This is wrong"); await Promise.resolve(); await Promise.resolve(); expect(host.textContent).toContain("After this, Pronouns will read: Unknown"); expect(host.querySelector("img")).toBeNull(); click("Confirm"); await Promise.resolve(); expect(apply).toHaveBeenCalledWith("a");
  });
  it("splits list edits and hides actions when locked", async () => {
    const onChange = vi.fn().mockResolvedValue({ ok: true }); const a = setup({ onChange }); a.click("Edit Aliases"); const input = a.host.querySelector("textarea") as HTMLTextAreaElement; input.value = " One \n\n Two "; a.click("Save"); await Promise.resolve(); expect(onChange).toHaveBeenCalledWith({ kind: "field", path: "identity.aliases", value: ["One", "Two"] });
    const b = setup({ editable: () => false, lockedReason: "Locked" }); expect(b.host.textContent).toContain("Locked"); expect(b.host.textContent).not.toContain("Edit Pronouns");
  });
  it("provides conflict choices without retracting an older eligible fact", () => {
    const f = field("identity.pronouns", null); f.origin = "conflicted";
    const obs = (id: string, value: string, turn: number) => ({ id, field: f.path, value, mode: "fact", supersedesObservationId: null, evidence: { kind: "turn", turnNumber: turn, quote: `q${turn}`, invalidated: false } }) as unknown as CharacterField["observations"][number];
    f.observations = [obs("older", "Tinker", 7), obs("latest", "Tinker", 8), obs("other", "Smith", 9)]; f.retractableObservationIds = ["older"];
    const sheet: CharacterSheet = { name: "A", kind: "supporting", sections: [{ name: "Identity", fields: [f] }], sources: [], locks: [], attention: [] };
    const a = setup({ sheet, retraction: { preview: vi.fn(), apply: vi.fn() } }); a.click("Resolve conflict"); expect(a.host.textContent).toContain("Tinker · turn 8 · “q8”"); expect(a.host.textContent).not.toContain("This is wrong"); expect(a.host.textContent).toContain("Write my own");
    const b = setup({ sheet }); b.click("Resolve conflict"); expect(b.host.textContent).toContain("Use this");
  });
});
