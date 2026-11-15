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

describe("shared roster", () => {
  it("shows status before badge rows and capability-gated actions", async () => {
    const list = { ...page, characters: [{ ...person, pinned: true }], capabilities: { castEditing: true, castPresets: true, castLifecycle: false } };
    const { document, workspace } = setup({ list: vi.fn(async () => list) }); workspace.open("one");
    await vi.waitFor(() => expect(document.querySelector(".cast-roster-row")).not.toBeNull());
    expect(document.querySelector(".cast-roster-view")!.firstElementChild!.className).toBe("cast-roster-status");
    expect(document.querySelector(".cast-roster-badges")!.textContent).toContain("Pinned");
    expect(document.body.textContent).toContain("Add from world");
    expect([...document.querySelectorAll("option")].map(option => option.textContent)).toContain("Removed"); workspace.dispose();
  });
  it("debounces live search into one request", async () => {
    const { document, workspace, api } = setup(); workspace.open("one");
    await vi.waitFor(() => expect(document.body.textContent).toContain("Mara"));
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    const initial = api.list.mock.calls.length; search.value = "Ma"; search.dispatchEvent(new document.defaultView!.Event("input"));
    search.value = "Mara"; search.dispatchEvent(new document.defaultView!.Event("input"));
    await new Promise(resolve => setTimeout(resolve, 150)); expect(api.list.mock.calls.length).toBe(initial);
    await vi.waitFor(() => expect(api.list.mock.calls.length).toBe(initial + 1));
    expect((api.list.mock.calls.at(-1) as any)[1].query).toBe("Mara"); workspace.dispose();
  });
});

describe("world picker", () => {
  it("opens an added world character sheet", async () => {
    const worldId = "22222222-2222-4222-8222-222222222222";
    const preview = { worldVersionId: worldId, castRevision: 1, boundary, previewFingerprint: "fixture", changes: [], eligibleTargets: [] };
    const api = { list: vi.fn(async () => ({ ...page, capabilities: { castEditing: true, castPresets: true, castLifecycle: true } })),
      worldChoices: vi.fn(async () => ({ characters: [{ characterId: worldId, name: "World Mara", alwaysInContext: false }] })),
      fromWorldPreview: vi.fn(async () => preview), fromWorld: vi.fn(async () => ({ character: person })) };
    const { document, workspace, click } = setup(api);
    const originalOption = globalThis.Option;
    (globalThis as any).Option = function (label: string, value: string) { const option = document.createElement("option"); option.textContent = label; option.value = value; return option; };
    try {
      workspace.open("one"); await vi.waitFor(() => expect(document.body.textContent).toContain("Add from world")); click("Add from world");
      await vi.waitFor(() => expect(document.body.textContent).toContain("World Mara"));
      const select = document.querySelector("select")!; select.value = worldId; select.dispatchEvent(new document.defaultView!.Event("change"));
      await vi.waitFor(() => expect(document.body.textContent).toContain("Add to campaign")); click("Add to campaign");
      await vi.waitFor(() => expect(document.body.textContent).toContain("Sources and edit history"));
      expect(api.fromWorld).toHaveBeenCalledTimes(1);
    } finally { (globalThis as any).Option = originalOption; workspace.dispose(); }
  });
  it("hides world actions and Removed on older servers", async () => {
    const { document, workspace } = setup(); workspace.open("one");
    await vi.waitFor(() => expect(document.querySelector(".cast-roster-row")).not.toBeNull());
    expect(document.body.textContent).not.toContain("Add from world");
    expect([...document.querySelectorAll("option")].map(option => option.textContent)).not.toContain("Removed"); workspace.dispose();
  });
});

it("keeps the search query when opening and returning from the world picker during debounce", async () => {
  const list = vi.fn(async () => ({ ...page, capabilities: { castEditing: true, castPresets: true } }));
  const { document, workspace, api, click } = setup({ list, worldChoices: vi.fn(async () => ({ characters: [] })) });
  workspace.open("one"); await vi.waitFor(() => expect(document.body.textContent).toContain("Add from world"));
  const search = document.querySelector<HTMLInputElement>('input[type="search"]')!; search.value = "Mar"; search.dispatchEvent(new document.defaultView!.Event("input"));
  click("Add from world"); click("Back to characters");
  await vi.waitFor(() => expect((api.list.mock.calls.at(-1) as any)[1].query).toBe("Mar"));
  await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe("Mar"));
  workspace.dispose();
});
