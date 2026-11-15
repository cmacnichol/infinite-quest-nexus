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
  it("applies list limits per entry and validates them on save", async () => {
    const onChange = vi.fn().mockResolvedValue({ ok: true });
    const { host, click, Event } = setup({ onChange, limit: path => path === "identity.aliases" ? { maxLength: 5, maxItems: 2 } : { maxLength: 2000 } });
    click("Edit Aliases"); const area = host.querySelector("textarea") as HTMLTextAreaElement;
    // linkedom leaves maxLength undefined unless it was set; a browser reports -1.
    expect(area.maxLength === undefined || area.maxLength < 0).toBe(true);
    area.value = "One\nTwo\nThree"; area.dispatchEvent(new Event("input", { bubbles: true })); click("Save"); await Promise.resolve();
    expect(onChange).not.toHaveBeenCalled(); expect(host.textContent).toContain("Aliases can have at most 2 entries.");
    area.value = "One\nToolong"; click("Save"); await Promise.resolve();
    expect(onChange).not.toHaveBeenCalled(); expect(host.textContent).toContain("Each Aliases entry can be at most 5 characters.");
    area.value = "One\nTwo"; click("Save"); await Promise.resolve();
    expect(onChange).toHaveBeenCalledWith({ kind: "field", path: "identity.aliases", value: ["One", "Two"] });
  });
  it("asks before Escape discards a dirty inline edit", () => {
    const confirmDiscard = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { host, click, Event } = setup({ confirmDiscard });
    click("Edit Pronouns"); const input = host.querySelector("input:not([type=checkbox])") as HTMLInputElement; input.value = "changed"; input.dispatchEvent(new Event("input", { bubbles: true }));
    const escape = () => { const event = new Event("keydown", { bubbles: true }) as any; event.key = "Escape"; input.dispatchEvent(event); };
    escape(); expect(confirmDiscard).toHaveBeenCalledTimes(1); expect(host.querySelector("input:not([type=checkbox])")).toBe(input);
    escape(); expect(confirmDiscard).toHaveBeenCalledTimes(2); expect(host.querySelector("input:not([type=checkbox])")).toBeNull();
  });
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
    click("This is wrong"); await Promise.resolve(); await Promise.resolve(); expect(host.textContent).toContain("Pronouns now reads: Tinker"); expect(host.textContent).toContain("After this, Pronouns will read: Unknown"); expect(host.querySelector("img")).toBeNull(); click("Confirm"); await Promise.resolve(); expect(apply).toHaveBeenCalledWith("a");
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
  it("protects dirty edits before refresh actions", () => {
    const onChange = vi.fn(), onShowEmpty = vi.fn(), undo = vi.fn();
    const a = setup({ onChange, onShowEmpty, feedback: { message: "Saved", undo }, toggles: { pinned: false, ignored: false }, confirmDiscard: () => false });
    a.click("Edit Aliases"); const input = a.host.querySelector("textarea") as HTMLTextAreaElement; input.value = "unsaved";
    a.click("Pin"); a.click("Reset to world"); a.click("Undo"); a.click("Hide empty fields");
    expect(onChange).not.toHaveBeenCalled(); expect(onShowEmpty).not.toHaveBeenCalled(); expect(undo).not.toHaveBeenCalled(); expect(input.value).toBe("unsaved");
  });
  it("focuses the editor and returns focus to the field after cancel", () => {
    const a = setup(); const proto = Object.getPrototypeOf(a.host.ownerDocument.createElement("input"));
    const focus = vi.spyOn(proto, "focus"); a.click("Edit Pronouns"); expect(focus).toHaveBeenCalled(); focus.mockRestore();
    const buttonProto = Object.getPrototypeOf(a.host.ownerDocument.createElement("button")); const buttonFocus = vi.spyOn(buttonProto, "focus"); a.click("Cancel"); expect(buttonFocus.mock.instances.at(-1)?.textContent).toBe("Edit Pronouns"); buttonFocus.mockRestore();
  });
  it("invokes conflict choices and keeps controller feedback across refresh", async () => {
    const f = field("identity.pronouns", null); f.origin = "conflicted";
    f.observations = [{ id: "a", field: f.path, value: "Tinker", mode: "fact", supersedesObservationId: null, evidence: { kind: "turn", turnNumber: 7, quote: "q7", invalidated: false } } as unknown as CharacterField["observations"][number]];
    const onChange = vi.fn().mockResolvedValue({ ok: true }), undo = vi.fn().mockResolvedValue({ ok: true });
    const sheet: CharacterSheet = { name: "A", kind: "supporting", sections: [{ name: "Identity", fields: [f] }], sources: [], locks: [], attention: [] };
    const a = setup({ sheet, onChange, feedback: { message: "Saved Pronouns", undo } }); a.click("Resolve conflict"); a.click("Use this"); await Promise.resolve(); expect(onChange).toHaveBeenCalledWith({ kind: "field", path: f.path, value: "Tinker" });
    a.view.dispose(); renderCharacterSheetView(a.host, a.options); expect(a.host.textContent).toContain("Saved Pronouns"); a.click("Undo"); await Promise.resolve(); expect(undo).toHaveBeenCalledOnce();
  });
  it("leaves toggle state unchanged after failure and ignores results after switching", async () => {
    let current = true; let finish!: (value: { ok: false; conflict: boolean; message: string }) => void;
    const onChange = vi.fn().mockImplementationOnce(async () => ({ ok: false, conflict: false, message: "failed" })).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const a = setup({ toggles: { pinned: false, ignored: false }, onChange, isCurrent: () => current }); a.click("Pin"); await Promise.resolve(); await Promise.resolve(); expect(a.host.querySelector('[aria-pressed]')!.getAttribute("aria-pressed")).toBe("false"); expect(a.host.textContent).toContain("failed");
    a.click("Ignore"); current = false; a.host.textContent = "new sheet"; finish({ ok: false, conflict: true, message: "late" }); await Promise.resolve(); await Promise.resolve(); expect(a.host.textContent).toBe("new sheet");
  });
  it("labels clear actions and submits the displayed story value choice", async () => {
    const world = field("identity.pronouns"); const story = field("story.role", "Guide"); story.label = "Role"; story.storyDiffers = { value: "Smith", turn: 20 }; story.override = {} as NonNullable<CharacterField["override"]>;
    const sheet: CharacterSheet = { name: "A", kind: "supporting", sections: [{ name: "Identity", fields: [world, story] }], sources: [], locks: [], attention: [] };
    const onChange = vi.fn().mockResolvedValue({ ok: true }); const a = setup({ sheet, onChange }); expect(a.host.textContent).toContain("Reset to world"); expect(a.host.textContent).toContain("Story differs: Smith · turn 20"); a.click("Use story value"); await Promise.resolve(); expect(onChange).toHaveBeenCalledWith({ kind: "field", path: "story.role", value: null });
  });
});

it("reports an open sheet interaction independently of dirty state", () => {
  const { view, click } = setup();
  expect(view.active()).toBe(false); click("Edit Pronouns"); expect(view.active()).toBe(true); expect(view.dirty()).toBe(false);
  click("Cancel"); expect(view.active()).toBe(false); view.dispose();
});

it("notifies the host only after an inline edit is actually cancelled", () => {
  const onInteractionEnd = vi.fn(), confirmDiscard = vi.fn(() => false);
  const { host, click, Event } = setup({ onInteractionEnd, confirmDiscard });
  click("Edit Pronouns"); const input = host.querySelector<HTMLInputElement>('input')!; input.value = "she/her"; input.dispatchEvent(new Event("input"));
  click("Cancel"); expect(onInteractionEnd).not.toHaveBeenCalled();
  confirmDiscard.mockReturnValue(true); click("Cancel"); expect(onInteractionEnd).toHaveBeenCalledExactlyOnceWith("identity.pronouns");
});


it("exposes pending work and discards an accepted inline draft", async () => {
  let finish!: (result: { ok: false; conflict: boolean; message: string }) => void;
  const a = setup({ onChange: () => new Promise(resolve => { finish = resolve; }) });
  a.click("Edit Pronouns"); const input = a.host.querySelector<HTMLInputElement>("input")!; input.value = "unsaved";
  expect(a.view.dirty()).toBe(true); a.view.discard();
  expect(a.view.dirty()).toBe(false); expect(a.host.querySelector("input")).toBeNull();
  a.click("Edit Pronouns"); a.click("Save"); expect(a.view.pending()).toBe(true);
  a.view.discard(); expect(a.host.querySelector("input")).not.toBeNull();
  finish({ ok: false, conflict: false, message: "retry" }); await Promise.resolve(); await Promise.resolve();
  expect(a.view.pending()).toBe(false); expect(a.host.textContent).toContain("retry");
});
