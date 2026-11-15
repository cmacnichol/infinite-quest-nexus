import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { createCharactersWorkspace } from "../../apps/web-next/src/characters-workspace.js";

const boundary = { turnNumber: 0, timelineRevision: 0 };
const person = { id: "11111111-1111-4111-8111-111111111111", name: "Mara", aliases: [], origin: { kind: "manual" as const }, profile: {}, pinned: false, ignored: false, revision: 1, firstObservedTurn: 0, lastObservedTurn: 0, lastMentionedTurn: null };
const status = { revision: 1, boundary, capabilities: { editing: true, discovery: false, autoMatch: false, backfill: false, context: false }, contextDisabledReason: null, counts: { identities: 0, details: 0, conflicts: 0 }, tracking: null };
const page = { revision: 1, boundary, characters: [person], nextCursor: null, capabilities: { castEditing: true } };
const detail = { ...page, character: person, observations: [], overrides: [], identityEvents: [], unresolvedCandidateIds: [], autoMatches: [], editorDestination: null, capabilities: { castEditing: true, castLifecycle: false } };
function setup(overrides: Record<string, unknown> = {}) {
  const { document } = parseHTML("<html><body></body></html>");
  Object.defineProperty(document.defaultView!.HTMLSelectElement.prototype, "value", { configurable: true, get() { return this.getAttribute("value") ?? ""; }, set(value: string) { this.setAttribute("value", value); } });
  const proto = document.defaultView!.HTMLElement.prototype as any;
  proto.showModal = function () { this.open = true; }; proto.close = function () { this.open = false; }; proto.focus = function () {};
  const api = { workspaceStatus: vi.fn(async () => status), list: vi.fn(async () => page), detail: vi.fn(async () => detail), create: vi.fn(async () => detail), ...overrides };
  const confirm = vi.fn(() => false);
  const schedule = { set: () => 1, clear: () => {}, visible: () => true, onVisibilityChange: () => () => {} };
  const workspace = createCharactersWorkspace(document, () => false, vi.fn(), vi.fn(), vi.fn(), undefined, { api: api as any, confirm, schedule });
  const click = (text: string) => [...document.querySelectorAll("button")].find(button => button.textContent === text)!.click();
  return { document, workspace, api, confirm, click };
}
describe("web-next characters workspace", () => {
  it("shows the cast and selected character sheet", async () => {
    const { document, workspace, click } = setup(); workspace.open("one");
    await vi.waitFor(() => expect(document.body.textContent).toContain("Mara")); click("Mara");
    await vi.waitFor(() => expect(document.body.textContent).toContain("Sources and edit history"));
    expect(document.body.textContent).toContain("Last observed turn 0"); workspace.dispose();
  });
  it("creates an added character and confirms before discarding a dirty draft", async () => {
    const { document, workspace, click, api, confirm } = setup(); workspace.open("one");
    await vi.waitFor(() => expect(document.body.textContent).toContain("Mara")); click("Add character");
    await vi.waitFor(() => expect(document.querySelector('[aria-label="Name"]')).not.toBeNull());
    const name = document.querySelector<HTMLInputElement>('[aria-label="Name"]')!; name.value = "Nia"; name.dispatchEvent(new document.defaultView!.Event("input"));
    document.querySelector("dialog")!.dispatchEvent(new document.defaultView!.Event("cancel", { cancelable: true })); expect(confirm).toHaveBeenCalled(); expect(document.body.textContent).toContain("Add character");
    document.querySelector("form")!.dispatchEvent(new document.defaultView!.Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(api.create).toHaveBeenCalled()); expect(api.create.mock.calls[0]![0]).toBe("one"); expect((api.create.mock.calls[0]![1] as any).name).toBe("Nia"); workspace.dispose();
  });
  it("ignores a response from a previously opened campaign", async () => {
    let release!: (value: typeof status) => void; const pending = new Promise<typeof status>(resolve => { release = resolve; });
    const { document, workspace } = setup({ workspaceStatus: (campaign: string) => campaign === "old" ? pending : Promise.resolve(status), list: async (campaign: string) => ({ ...page, characters: [{ ...person, name: campaign }] }) });
    workspace.open("old"); workspace.open("new"); await vi.waitFor(() => expect(document.body.textContent).toContain("new"));
    release(status); await Promise.resolve(); await Promise.resolve(); expect(document.body.textContent).not.toContain("old"); workspace.dispose();
  });
});
