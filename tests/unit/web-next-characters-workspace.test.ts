import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { characterProfileSchema } from "../../packages/contracts/src/world-library.js";
import { createCharactersWorkspace } from "../../apps/web-next/src/characters-workspace.js";

const boundary = { turnNumber: 0, timelineRevision: 0 };
const person = { id: "11111111-1111-4111-8111-111111111111", name: "Mara", aliases: [], origin: { kind: "manual" as const }, profile: {}, pinned: false, ignored: false, revision: 1, firstObservedTurn: 0, lastObservedTurn: 0, lastMentionedTurn: null };
const status = { revision: 1, boundary, capabilities: { editing: true, discovery: false, autoMatch: false, backfill: false, context: false }, contextDisabledReason: null, counts: { identities: 0, details: 0, conflicts: 0 }, tracking: null };
const page = { revision: 1, boundary, characters: [person], nextCursor: null, capabilities: { castEditing: true } };
const detail = { ...page, character: person, observations: [], overrides: [], identityEvents: [], unresolvedCandidateIds: [], autoMatches: [], editorDestination: null, capabilities: { castEditing: true, castLifecycle: false } };
function setup(overrides: Record<string, unknown> = {}, options: { saveProfile?: any; getProfile?: any; generationActive?: () => boolean; schedule?: any } = {}) {
  const { document } = parseHTML("<html><body></body></html>");
  Object.defineProperty(document.defaultView!.HTMLSelectElement.prototype, "value", { configurable: true, get() { return this.getAttribute("value") ?? ""; }, set(value: string) { this.setAttribute("value", value); } });
  const proto = document.defaultView!.HTMLElement.prototype as any;
  proto.showModal = function () { this.open = true; }; proto.close = function () { this.open = false; }; proto.focus = function () {};
  const api = { workspaceStatus: vi.fn(async () => status), list: vi.fn(async () => page), detail: vi.fn(async () => detail), create: vi.fn(async () => detail), ...overrides };
  const confirm = vi.fn(() => false);
  const schedule = options.schedule ?? { set: () => 1, clear: () => {}, visible: () => true, onVisibilityChange: () => () => {} };
  const workspace = createCharactersWorkspace(document, options.generationActive ?? (() => false), options.saveProfile ?? vi.fn(), vi.fn(), options.getProfile ?? vi.fn(), undefined, { api: api as any, confirm, schedule });
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

it("offers inline character sheet editing", async () => {
  const { document, workspace, click } = setup(); workspace.open("one");
  await vi.waitFor(() => expect(document.body.textContent).toContain("Mara")); click("Mara");
  await vi.waitFor(() => expect(document.body.textContent).toContain("Sources and edit history"));
  expect([...document.querySelectorAll("button")].some(button => button.textContent === "Edit Name")).toBe(true);
  workspace.dispose();
});

it.each(["success", "before refresh", "after refresh", "refresh fails"] as const)("uses the cast write receipt for Undo: %s", async scenario => {
  let current = { ...detail, character: { ...person, profile: { "story.role": "Guard" } } }, reads = 0;
  const edit = vi.fn(async (_campaign: string, _id: string, body: any) => {
    if (scenario === "after refresh" && current.revision === 2) throw Object.assign(new Error("conflict"), { statusCode: 409 });
    current = { ...current, revision: current.revision + 1, character: { ...current.character, revision: current.character.revision + 1, profile: { "story.role": body.setOverrides?.["story.role"] ?? "Guard" } } };
    return current;
  });
  const read = vi.fn(async () => { reads++; if (reads === 2 && scenario === "refresh fails") throw new Error("offline"); if (reads === 2 && scenario === "before refresh") current = { ...current, revision: 3 }; return current; });
  const { document, workspace, click } = setup({ detail: read, edit, workspaceStatus: async () => ({ ...status, revision: current.revision }), list: async () => ({ ...page, revision: current.revision, characters: [current.character] }) });
  workspace.open("one"); await vi.waitFor(() => expect(document.body.textContent).toContain("Mara")); click("Mara");
  await vi.waitFor(() => expect(document.body.textContent).toContain("Edit Role")); click("Edit Role");
  const input = document.querySelector<HTMLTextAreaElement>('[data-path="story.role"] textarea')!; input.value = "Captain"; input.dispatchEvent(new document.defaultView!.Event("input")); click("Save");
  await vi.waitFor(() => expect(document.body.textContent).toContain(scenario === "before refresh" ? "Undo expired" : scenario === "refresh fails" ? "Could not refresh this character" : "Saved Role."));
  expect(edit.mock.calls[0]![2]).toEqual({ expectedCastRevision: 1, expectedCharacterRevision: 1, expectedBoundary: boundary, idempotencyKey: expect.any(String), setOverrides: { "story.role": "Captain" } });
  if (scenario === "before refresh") expect([...document.querySelectorAll("button")].some(button => button.textContent === "Undo")).toBe(false);
  else {
    if (scenario === "refresh fails") { expect([...document.querySelectorAll("button")].some(button => button.textContent === "Undo")).toBe(false); click("Reload"); await vi.waitFor(() => expect([...document.querySelectorAll("button")].some(button => button.textContent === "Undo")).toBe(true)); }
    click("Undo"); await vi.waitFor(() => expect(document.body.textContent).toContain(scenario === "after refresh" ? "Could not undo. The character changed" : "Undone"));
    expect(edit.mock.calls[1]![2]).toEqual({ expectedCastRevision: 2, expectedCharacterRevision: 2, expectedBoundary: boundary, idempotencyKey: expect.any(String), clearOverrides: ["story.role"] });
  }
  workspace.dispose();
});

it.each(["success", "before refresh", "after refresh"] as const)("uses the Main Character profile receipt for Undo: %s", async scenario => {
  const main = { ...person, origin: { kind: "protagonist" as const } };
  let profile = { name: "Mara", profile: characterProfileSchema.parse({ story: { role: "Scout" } }), revision: 1 }, reads = 0;
  const getProfile = vi.fn(async () => { reads++; if (reads === 2 && scenario === "before refresh") profile = { ...profile, revision: 3 }; return profile; });
  const saveProfile = vi.fn(async (_campaign: string, body: any) => { if (scenario === "after refresh" && profile.revision === 2) throw Object.assign(new Error("conflict"), { statusCode: 409 }); profile = { name: body.name, profile: body.profile, revision: profile.revision + 1 }; return profile; });
  const { document, workspace, click } = setup({ detail: async () => ({ ...detail, character: main }), list: async () => ({ ...page, characters: [main] }) }, { getProfile, saveProfile });
  workspace.open("one"); await vi.waitFor(() => expect(document.body.textContent).toContain("Mara")); click("Mara"); await vi.waitFor(() => expect(document.body.textContent).toContain("Edit Role"));
  click("Edit Role"); const input = document.querySelector<HTMLTextAreaElement>('[data-path="story.role"] textarea')!; input.value = "Guide"; input.dispatchEvent(new document.defaultView!.Event("input")); click("Save");
  await vi.waitFor(() => expect(document.body.textContent).toContain(scenario === "before refresh" ? "Undo expired" : "Saved Role."));
  expect(saveProfile.mock.calls[0]![1]).toEqual({ name: "Mara", profile: characterProfileSchema.parse({ story: { role: "Guide" } }), expectedRevision: 1, editSource: "manual" });
  if (scenario !== "before refresh") { click("Undo"); await vi.waitFor(() => expect(document.body.textContent).toContain(scenario === "after refresh" ? "Could not undo. The character changed" : "Undone")); expect(saveProfile.mock.calls[1]![1]).toEqual({ name: "Mara", profile: characterProfileSchema.parse({ story: { role: "Scout" } }), expectedRevision: 2, editSource: "manual" }); }
  workspace.dispose();
});

it("hides sheet write actions during generation", async () => {
  const { document, workspace, click } = setup({}, { generationActive: () => true }); workspace.open("one");
  await vi.waitFor(() => expect(document.body.textContent).toContain("Mara")); click("Mara"); await vi.waitFor(() => expect(document.body.textContent).toContain("Sources and edit history"));
  expect([...document.querySelectorAll("button")].some(button => button.textContent === "Edit Name")).toBe(false); workspace.dispose();
});

it("does not announce a late save after switching away and back", async () => {
  const other = { ...person, id: "22222222-2222-4222-8222-222222222222", name: "Nia" };
  let finish!: (value: any) => void;
  const edit = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const { document, workspace, click, confirm } = setup({ list: async () => ({ ...page, characters: [person, other] }), detail: async (_campaign: string, id: string) => ({ ...detail, character: id === person.id ? person : other }), edit });
  confirm.mockReturnValue(true);
  workspace.open("one"); await vi.waitFor(() => expect(document.body.textContent).toContain("Mara")); click("Mara"); await vi.waitFor(() => expect(document.body.textContent).toContain("Edit Name"));
  click("Edit Name"); const input = document.querySelector<HTMLInputElement>('[data-path="name"] input')!; input.value = "Marin"; input.dispatchEvent(new document.defaultView!.Event("input")); click("Save");
  click("Nia"); await vi.waitFor(() => expect(document.querySelector("dialog h2")?.textContent).toBe("Nia")); click("Mara"); await vi.waitFor(() => expect(document.querySelector("dialog h2")?.textContent).toBe("Mara"));
  finish({ ...detail, revision: 2, character: { ...person, revision: 2 } }); await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.body.textContent).not.toContain("Saved Name."); workspace.dispose();
});

it.each([true, false])("gates sheet Retraction on observation capability: %s", async supported => {
  const observationId = "22222222-2222-4222-8222-222222222222";
  const evidence = { kind: "turn" as const, turnNumber: 1, turnId: person.id, quote: "Mara is a guard", startOffset: 0, endOffset: 15, invalidated: false };
  const observation = { id: observationId, characterId: person.id, field: "story.role" as const, value: "Guard", mode: "fact" as const, speakerCharacterId: null, supersedesObservationId: null, evidence };
  const observed = { ...detail, character: { ...person, profile: { "story.role": "Guard" } }, observations: [observation], observationDecisionStatus: [{ observationId, state: "eligible" as const, retractionEventId: null, reason: null }] };
  const { document, workspace, click } = setup({ workspaceStatus: async () => ({ ...status, capabilities: { ...status.capabilities, observationDecisions: supported } }), detail: async () => observed });
  workspace.open("one"); await vi.waitFor(() => expect(document.body.textContent).toContain("Mara")); click("Mara"); await vi.waitFor(() => expect(document.body.textContent).toContain("Sources and edit history"));
  expect([...document.querySelectorAll(".character-sheet-view button")].some(button => button.textContent === "This is wrong")).toBe(supported); workspace.dispose();
});

it("uses the authored profile endpoint for a Starting Cast Character", async () => {
  const profile = characterProfileSchema.parse({ story: { role: "Scout" } });
  const starting = { ...person, origin: { kind: "world" as const, entityId: "mara", worldVersionId: person.id }, originProfile: { seedEventId: person.id, worldVersionId: person.id, entityId: "mara", rosterName: "Mara", rosterAliases: [], legacyCharacterText: "", profile, evidence: { kind: "world" as const, worldVersionId: person.id, sourcePath: "/characters/0" } }, campaignProfile: profile, profile: { "story.role": "Scout" } };
  const editAuthoredProfile = vi.fn(async (_campaign: string, _id: string, _body: unknown) => ({ revision: 2, boundary, character: { ...starting, revision: 2 } }));
  const { document, workspace, click } = setup({ list: async () => ({ ...page, characters: [starting] }), detail: async () => ({ ...detail, character: starting, authoredHistory: [] }), editAuthoredProfile });
  workspace.open("one"); await vi.waitFor(() => expect(document.body.textContent).toContain("Mara")); click("Mara"); await vi.waitFor(() => expect(document.body.textContent).toContain("Edit Role")); click("Edit Role");
  const input = document.querySelector<HTMLTextAreaElement>('[data-path="story.role"] textarea')!; input.value = "Guide"; input.dispatchEvent(new document.defaultView!.Event("input")); click("Save");
  await vi.waitFor(() => expect(editAuthoredProfile).toHaveBeenCalledOnce()); expect(editAuthoredProfile.mock.calls[0]![2]).toEqual({ expectedCastRevision: 1, expectedCharacterRevision: 1, expectedBoundary: boundary, idempotencyKey: expect.any(String), set: { "story.role": "Guide" } }); workspace.dispose();
});

it("expires Undo 30 seconds after the write even when refresh is delayed", async () => {
  let current = { ...detail, character: { ...person, profile: { "story.role": "Guard" } } }, reads = 0;
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const edit = vi.fn(async (_campaign: string, _id: string, body: any) => {
    current = { ...current, revision: 2, character: { ...current.character, revision: 2, profile: { "story.role": body.setOverrides["story.role"] } } };
    return current;
  });
  const read = vi.fn(async () => { reads++; if (reads === 2) await delayed; return current; });
  const { document, workspace, click } = setup({ detail: read, edit, workspaceStatus: async () => ({ ...status, revision: current.revision }), list: async () => ({ ...page, revision: current.revision, characters: [current.character] }) });
  try {
    workspace.open("one"); await vi.waitFor(() => expect(document.body.textContent).toContain("Mara")); click("Mara"); await vi.waitFor(() => expect(document.body.textContent).toContain("Edit Role"));
    vi.useFakeTimers(); click("Edit Role"); const input = document.querySelector<HTMLTextAreaElement>('[data-path="story.role"] textarea')!; input.value = "Captain"; input.dispatchEvent(new document.defaultView!.Event("input")); click("Save");
    await vi.advanceTimersByTimeAsync(0); expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20_000); release(); await vi.advanceTimersByTimeAsync(0);
    const undo = [...document.querySelectorAll("button")].find(button => button.textContent === "Undo")!; expect(undo).toBeTruthy();
    await vi.advanceTimersByTimeAsync(9_999); expect([...document.querySelectorAll("button")].some(button => button.textContent === "Undo")).toBe(true);
    await vi.advanceTimersByTimeAsync(1); expect([...document.querySelectorAll("button")].some(button => button.textContent === "Undo")).toBe(false);
    undo.click(); await vi.advanceTimersByTimeAsync(0); expect(edit).toHaveBeenCalledTimes(1); expect(document.body.textContent).toContain("Saved Role.");
  } finally { workspace.dispose(); vi.useRealTimers(); }
});

it("keeps a Main Character save and its receipt when the profile refresh fails", async () => {
  const main = { ...person, origin: { kind: "protagonist" as const } };
  let profile = { name: "Mara", profile: characterProfileSchema.parse({ story: { role: "Scout" } }), revision: 1 }, reads = 0;
  const getProfile = vi.fn(async () => { if (++reads === 2) throw new Error("offline"); return profile; });
  const saveProfile = vi.fn(async (_campaign: string, body: any) => { profile = { name: body.name, profile: body.profile, revision: profile.revision + 1 }; return profile; });
  const { document, workspace, click } = setup({ detail: async () => ({ ...detail, character: main }), list: async () => ({ ...page, characters: [main] }) }, { getProfile, saveProfile });
  try {
    workspace.open("one"); await vi.waitFor(() => expect(document.body.textContent).toContain("Mara")); click("Mara"); await vi.waitFor(() => expect(document.body.textContent).toContain("Edit Role"));
    click("Edit Role"); const input = document.querySelector<HTMLTextAreaElement>('[data-path="story.role"] textarea')!; input.value = "Guide"; input.dispatchEvent(new document.defaultView!.Event("input")); click("Save");
    await vi.waitFor(() => expect(document.body.textContent).toContain("Saved Role. Could not refresh this character."));
    expect(saveProfile).toHaveBeenCalledTimes(1); expect([...document.querySelectorAll("button")].some(button => button.textContent === "Undo")).toBe(false);
    click("Reload"); await vi.waitFor(() => expect([...document.querySelectorAll("button")].some(button => button.textContent === "Undo")).toBe(true));
    expect(saveProfile).toHaveBeenCalledTimes(1); click("Undo"); await vi.waitFor(() => expect(document.body.textContent).toContain("Undone"));
    expect(saveProfile.mock.calls[1]![1]).toEqual({ name: "Mara", profile: characterProfileSchema.parse({ story: { role: "Scout" } }), expectedRevision: 2, editSource: "manual" });
  } finally { workspace.dispose(); }
});

it.each([false, true])("preserves an active inline editor on refresh and confirms discarding it when dirty: %s", async dirty => {
  const other = { ...person, id: "22222222-2222-4222-8222-222222222222", name: "Nia" };
  let poll!: () => void, revision = 1;
  const schedule = { set: (callback: () => void) => { poll = callback; return 1; }, clear: () => {}, visible: () => true, onVisibilityChange: () => () => {} };
  const { document, workspace, click, confirm, api } = setup({ workspaceStatus: async () => ({ ...status, revision }), list: async () => ({ ...page, revision, characters: [person, other] }), detail: vi.fn(async (_campaign: string, id: string) => ({ ...detail, revision, character: id === person.id ? person : other })) }, { schedule });
  const proto = document.defaultView!.HTMLElement.prototype as any;
  proto.focus = function () { Object.defineProperty(document, "activeElement", { configurable: true, value: this }); };
  try {
    workspace.open("one"); await vi.waitFor(() => expect(document.body.textContent).toContain("Mara")); click("Mara"); await vi.waitFor(() => expect(document.body.textContent).toContain("Edit Name")); click("Edit Name");
    const input = document.querySelector<HTMLInputElement>('[data-path="name"] input')!;
    if (dirty) { input.value = "Draft Mara"; input.dispatchEvent(new document.defaultView!.Event("input")); }
    input.focus(); const previousReads = api.detail.mock.calls.length; revision = 2; poll();
    await vi.waitFor(() => expect(api.detail.mock.calls.length).toBeGreaterThan(previousReads)); await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.querySelector('[data-path="name"] input')).toBe(input); expect(document.activeElement).toBe(input); expect(input.value).toBe(dirty ? "Draft Mara" : "Mara");
    if (dirty) {
      click("Nia"); expect(confirm).toHaveBeenCalledTimes(1); expect(document.querySelector('[data-path="name"] input')).toBe(input);
      click("Close"); expect(confirm).toHaveBeenCalledTimes(2); expect(document.querySelector("dialog")!.open).toBe(true);
      confirm.mockReturnValue(true); click("Nia"); await vi.waitFor(() => expect(document.querySelector("dialog h2")?.textContent).toBe("Nia"));
    }
  } finally { workspace.dispose(); }
});

it("keeps a successful receipt when refresh is skipped while hidden", async () => {
  let onVisibilityChange!: () => void;
  let visible = true, current = { ...detail, character: { ...person, profile: { "story.role": "Guard" } } };
  const schedule = { set: () => 1, clear: () => {}, visible: () => visible, onVisibilityChange: (callback: () => void) => { onVisibilityChange = callback; return () => {}; } };
  const edit = vi.fn(async (_campaign: string, _id: string, body: any) => { current = { ...current, revision: 2, character: { ...current.character, revision: 2, profile: { "story.role": body.setOverrides["story.role"] } } }; visible = false; onVisibilityChange(); return current; });
  const { document, workspace, click } = setup({ detail: async () => current, edit, workspaceStatus: async () => ({ ...status, revision: current.revision }), list: async () => ({ ...page, revision: current.revision, characters: [current.character] }) }, { schedule });
  try {
    workspace.open("one"); await vi.waitFor(() => expect(document.body.textContent).toContain("Mara")); click("Mara"); await vi.waitFor(() => expect(document.body.textContent).toContain("Edit Role")); click("Edit Role");
    const input = document.querySelector<HTMLTextAreaElement>('[data-path="story.role"] textarea')!; input.value = "Captain"; input.dispatchEvent(new document.defaultView!.Event("input")); click("Save");
    await vi.waitFor(() => expect(document.body.textContent).toContain("Saved Role. Could not refresh this character."));
    expect(document.body.textContent).not.toContain("Undo expired"); expect([...document.querySelectorAll("button")].some(button => button.textContent === "Undo")).toBe(false);
    visible = true; click("Reload"); await vi.waitFor(() => expect([...document.querySelectorAll("button")].some(button => button.textContent === "Undo")).toBe(true));
    expect(edit).toHaveBeenCalledTimes(1);
  } finally { workspace.dispose(); }
});

it("reconciles a competing refresh after cancelling an inline edit and restores field focus", async () => {
  let poll!: () => void, revision = 1;
  const schedule = { set: (callback: () => void) => { poll = callback; return 1; }, clear: () => {}, visible: () => true, onVisibilityChange: () => () => {} };
  const latest = () => ({ ...person, name: revision === 1 ? "Mara" : "Updated Mara", revision });
  const read = vi.fn(async () => ({ ...detail, revision, character: latest() }));
  const { document, workspace, click, confirm } = setup({ workspaceStatus: async () => ({ ...status, revision }), list: async () => ({ ...page, revision, characters: [latest()] }), detail: read }, { schedule });
  const proto = document.defaultView!.HTMLElement.prototype as any;
  proto.focus = function () { Object.defineProperty(document, "activeElement", { configurable: true, value: this }); };
  try {
    workspace.open("one"); await vi.waitFor(() => expect(document.body.textContent).toContain("Mara")); click("Mara"); await vi.waitFor(() => expect(document.body.textContent).toContain("Edit Name")); click("Edit Name");
    const input = document.querySelector<HTMLInputElement>('[data-path="name"] input')!; input.value = "Unsaved draft"; input.dispatchEvent(new document.defaultView!.Event("input")); input.focus();
    revision = 2; poll(); await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2)); await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.querySelector('[data-path="name"] input')).toBe(input); expect(input.value).toBe("Unsaved draft");
    confirm.mockReturnValue(true); const cancel = [...document.querySelectorAll("button")].find(button => button.textContent === "Cancel")!; cancel.click();
    await vi.waitFor(() => expect(document.querySelector('[data-path="name"]')?.textContent).toContain("Updated Mara"));
    expect((document.activeElement as HTMLElement)?.textContent).toBe("Edit Name");
    click("Edit Name"); expect(document.querySelector<HTMLInputElement>('[data-path="name"] input')!.value).toBe("Updated Mara");
  } finally { workspace.dispose(); }
});

it("uses refreshed values when switching directly to another field", async () => {
  let poll!: () => void, revision = 1;
  const schedule = { set: (callback: () => void) => { poll = callback; return 1; }, clear: () => {}, visible: () => true, onVisibilityChange: () => () => {} };
  const latest = () => ({ ...person, revision, profile: { "story.role": revision === 1 ? "Guard" : "Captain" } });
  const read = vi.fn(async () => ({ ...detail, revision, character: latest() }));
  const { document, workspace, click, confirm } = setup({ workspaceStatus: async () => ({ ...status, revision }), list: async () => ({ ...page, revision, characters: [latest()] }), detail: read }, { schedule });
  try {
    workspace.open("one"); await vi.waitFor(() => expect(document.body.textContent).toContain("Mara")); click("Mara"); await vi.waitFor(() => expect(document.body.textContent).toContain("Edit Role")); click("Edit Name");
    const input = document.querySelector<HTMLInputElement>('[data-path="name"] input')!; input.value = "Draft"; input.dispatchEvent(new document.defaultView!.Event("input"));
    revision = 2; poll(); await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2)); await new Promise(resolve => setTimeout(resolve, 0));
    confirm.mockReturnValue(true); click("Edit Role");
    expect(document.querySelector<HTMLTextAreaElement>('[data-path="story.role"] textarea')!.value).toBe("Captain");
  } finally { workspace.dispose(); }
});


it.each([
  ["available", {}, ["Merge with another character", "Remove from cast", "Add to world draft"]],
  ["removed", { removed: true }, ["Restore"]],
  ["main", { origin: { kind: "protagonist" } }, []],
  ["merged away", { mergedIntoCharacterId: "other" }, []],
] as const)("shows lifecycle actions for %s", async (_label, changes, expected) => {
  const character = { ...person, ...changes };
  const { document, workspace, click } = setup({ detail: async () => ({ ...detail, character, capabilities: { castEditing: true, castLifecycle: true } }), lifecycle: {} });
  try {
    workspace.open("one"); await vi.waitFor(() => expect(document.body.textContent).toContain("Mara")); click("Mara");
    await vi.waitFor(() => expect(document.body.textContent).toContain("Sources and edit history"));
    const labels = [...document.querySelectorAll(".cast-lifecycle-actions button")].map(button => button.textContent);
    expect(labels).toEqual(expected);
  } finally { workspace.dispose(); }
});

it.each(["none", "clean", "dirty"] as const)("handles a deferred poll after a failed Pin write with %s editor", async editor => {
  let poll!: () => void, revision = 1, reject!: (error: Error) => void;
  const schedule = { set: (callback: () => void) => { poll = callback; return 1; }, clear: () => {}, visible: () => true, onVisibilityChange: () => () => {} };
  const latest = () => ({ ...person, name: revision === 1 ? "Mara" : "Updated Mara", revision });
  const read = vi.fn(async () => ({ ...detail, revision, character: latest() }));
  const edit = vi.fn(() => new Promise((_resolve, fail) => { reject = fail; }));
  const { document, workspace, click, confirm } = setup({ workspaceStatus: async () => ({ ...status, revision }), list: async () => ({ ...page, revision, characters: [latest()] }), detail: read, edit }, { schedule });
  try {
    workspace.open("one"); await vi.waitFor(() => expect(document.body.textContent).toContain("Mara")); click("Mara"); await vi.waitFor(() => expect(document.body.textContent).toContain("Pin"));
    if (editor !== "none") { click("Edit Name"); if (editor === "dirty") { const input = document.querySelector<HTMLInputElement>('[data-path="name"] input')!; input.value = "Draft"; input.dispatchEvent(new document.defaultView!.Event("input")); confirm.mockReturnValue(true); } }
    click("Pin"); revision = 2; poll(); await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2)); await new Promise(resolve => setTimeout(resolve, 0));
    reject(new Error("offline"));
    if (editor === "dirty") { await vi.waitFor(() => expect(document.body.textContent).toContain("Could not save.")); expect(document.querySelector<HTMLInputElement>('[data-path="name"] input')!.value).toBe("Draft"); expect(document.querySelector("dialog h2")?.textContent).toBe("Mara"); }
    else await vi.waitFor(() => expect(document.querySelector("dialog h2")?.textContent).toBe("Updated Mara"));
  } finally { workspace.dispose(); }
});


it.each([false, true])("gates undo and lifecycle actions during generation: %s", async active => {
  const merged = { ...person, activeMerges: [{ mergeEventId: "event", sourceCharacterId: "other", sourceName: "<Sera>", canUndo: false }] };
  const { document, workspace, click } = setup({ detail: async () => ({ ...detail, character: merged, capabilities: { castEditing: true, castLifecycle: true } }), lifecycle: {} }, { generationActive: () => active });
  try {
    workspace.open("one"); await vi.waitFor(() => expect(document.body.textContent).toContain("Mara")); click("Mara"); await vi.waitFor(() => expect(document.body.textContent).toContain("Merged from <Sera>"));
    expect(document.querySelector(".cast-lifecycle-actions p")!.textContent).toBe("Merged from <Sera>");
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".cast-lifecycle-actions button")];
    expect(buttons.find(button => button.textContent === "Undo merge")!.disabled).toBe(true);
    expect(buttons.find(button => button.textContent === "Remove from cast")!.disabled).toBe(active);
  } finally { workspace.dispose(); }
});

it("explains disabled lifecycle capabilities", async () => {
  const { document, workspace, click } = setup();
  try { workspace.open("one"); await vi.waitFor(() => expect(document.body.textContent).toContain("Mara")); click("Mara"); await vi.waitFor(() => expect(document.body.textContent).toContain("Removing and restoring characters is disabled on this server. Character merging is disabled on this server.")); }
  finally { workspace.dispose(); }
});


it.each([false, true])("reconciles a deferred poll after a failed retraction preview in conflict mode: %s", async conflict => {
  let poll!: () => void, revision = 1, reject!: (error: Error) => void;
  const schedule = { set: (callback: () => void) => { poll = callback; return 1; }, clear: () => {}, visible: () => true, onVisibilityChange: () => () => {} };
  const observationId = "22222222-2222-4222-8222-222222222222";
  const observation = { id: observationId, characterId: person.id, field: "story.role" as const, value: "Guard", mode: "fact" as const, speakerCharacterId: null, supersedesObservationId: null, evidence: { kind: "turn" as const, turnNumber: 1, turnId: person.id, quote: "Mara is a guard", startOffset: 0, endOffset: 15, invalidated: false } };
  const other = { ...observation, id: "33333333-3333-4333-8333-333333333333", value: "Captain" };
  const latest = () => ({ ...person, name: revision === 1 ? "Mara" : "Updated Mara", revision, profile: conflict ? {} : { "story.role": "Guard" } });
  const read = vi.fn(async () => ({ ...detail, revision, character: latest(), observations: conflict ? [observation, other] : [observation], observationDecisionStatus: (conflict ? [observation, other] : [observation]).map(item => ({ observationId: item.id, state: "eligible" as const, retractionEventId: null, reason: null })) }));
  const { document, workspace, click } = setup({ workspaceStatus: async () => ({ ...status, revision, capabilities: { ...status.capabilities, observationDecisions: true } }), list: async () => ({ ...page, revision, characters: [latest()] }), detail: read, previewObservationDecision: () => new Promise((_resolve, fail) => { reject = fail; }) }, { schedule });
  try {
    workspace.open("one"); await vi.waitFor(() => expect(document.body.textContent).toContain("Mara")); click("Mara");
    if (conflict) { await vi.waitFor(() => expect(document.body.textContent).toContain("Resolve conflict")); click("Resolve conflict"); }
    await vi.waitFor(() => expect(document.body.textContent).toContain("This is wrong")); click("This is wrong"); revision = 2; poll(); await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2)); await new Promise(resolve => setTimeout(resolve, 0));
    reject(new Error("offline")); await vi.waitFor(() => expect(document.querySelector("dialog h2")?.textContent).toBe("Updated Mara")); expect(document.body.textContent).toContain("Could not preview this change.");
  } finally { workspace.dispose(); }
});
