import { describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import type { CastCharacter, CharacterFilter } from "@infinite-quest/contracts";
import { renderCastRoster } from "../../apps/web/src/character-editor/cast-roster-view.js";

const person = (id: string, name: string, kind = "manual"): CastCharacter => ({ id, name, aliases: [], origin: { kind } as CastCharacter["origin"], profile: { "story.role": "Guide" }, pinned: false, ignored: false, revision: 0, firstObservedTurn: 0, lastObservedTurn: 4, lastMentionedTurn: null });
function setup(changes: Partial<Parameters<typeof renderCastRoster>[1]> = {}) {
  const { document, Event } = parseHTML("<html><body><div id='host'></div></body></html>");
  const host = document.getElementById("host") as unknown as HTMLElement;
  const onQuery = vi.fn(); let pending: (() => void) | undefined;
  const options: Parameters<typeof renderCastRoster>[1] = { characters: [person("s", "<img src=x>"), person("m", "Main", "protagonist")], attention: { s: { review: true, conflict: false } }, tracking: null, attentionTotal: 5, filters: [["all", "All"], ["recent", "Recent"]], filter: "all", query: "", canAdd: false, addDisabledReason: "Unavailable", secondaryActions: [], tools: [], onQuery, onOpen: vi.fn(), onAdd: vi.fn(), onAttention: vi.fn(), schedule: fn => { pending = fn; return () => { pending = undefined; }; }, ...changes };
  const view = renderCastRoster(host, options);
  return { host, options, onQuery, view, event: (name: string) => new Event(name, { bubbles: true, cancelable: true }), flush: () => pending?.() };
}
describe("cast roster view", () => {
  it("renders status, actions, rows safely and main first", () => {
    const { host } = setup();
    expect(Array.from(host.firstElementChild!.children).map(e => e.className)).toEqual(["cast-roster-status", "cast-roster-toolbar", "cast-roster-list"]);
    expect(host.querySelector(".cast-roster-status")!.getAttribute("data-tone")).toBe("warning");
    expect(host.querySelector("details.cast-roster-tools")!.hasAttribute("open")).toBe(false);
    expect(Array.from(host.querySelectorAll(".cast-roster-row button")).map(e => e.textContent)).toEqual(["Main", "<img src=x>"]);
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector(".cast-roster-list")!.textContent).toContain("Added by you");
    expect(host.querySelector(".cast-badge")!.textContent).toBe("Main");
    expect(host.textContent).toContain("Needs attention (5)"); expect(host.textContent).toContain("Unavailable");
    expect((Array.from(host.querySelectorAll("button")).find(e => e.textContent === "Add character") as HTMLButtonElement).disabled).toBe(true);
  });
  it("debounces search, submits and filters immediately, and cancels on disposal", () => {
    const { host, onQuery, event, flush, view } = setup(); const input = host.querySelector("input") as HTMLInputElement;
    for (const value of ["m", "ma", "mar"]) { input.value = value; input.dispatchEvent(event("input")); }
    expect(onQuery).not.toHaveBeenCalled(); flush(); expect(onQuery).toHaveBeenCalledWith("mar", "all");
    const select = host.querySelector("select") as HTMLSelectElement; select.querySelector("option[selected]")?.removeAttribute("selected"); select.querySelector('option[value="recent"]')!.setAttribute("selected", ""); select.dispatchEvent(event("change"));
    expect(onQuery).toHaveBeenLastCalledWith("mar", "recent"); host.querySelector("form")!.dispatchEvent(event("submit")); expect(onQuery).toHaveBeenCalledTimes(3);
    input.dispatchEvent(event("input")); view.dispose(); flush(); expect(onQuery).toHaveBeenCalledTimes(3);
  });
  it("shows contextual empty copy", () => {
    expect(setup({ characters: [], query: "x" }).host.textContent).toContain("No characters match this search.");
    expect(setup({ characters: [] }).host.textContent).toContain("No supporting characters yet. Add someone from your story.");
  });
});
