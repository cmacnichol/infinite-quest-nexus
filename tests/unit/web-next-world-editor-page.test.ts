import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import type { EditableWorldDraft, WorldAggregate } from "../../apps/web-next/src/world-editor-model.js";
import { WorldEditorApiError, type WorldDraftSaveResponse } from "../../apps/web-next/src/world-editor-api.js";
import { mountWorldEditorPage } from "../../apps/web-next/src/world-editor-page.js";

const worldId = "22222222-2222-4222-8222-222222222222";
const draft: EditableWorldDraft = {
  schemaVersion: 5,
  world: {
    title: "The Glass Observatory",
    genre: "Science fantasy",
    tone: "Numinous",
    premise: "A glass observatory watches impossible stars.",
    backgroundStory: "Its astronomers vanished.",
    firstAction: "Open the western dome.",
    rules: "Reflections remember."
  },
  playableCharacters: [],
  entities: [],
  relationships: [],
  rpgStats: [],
  defaultTriggers: [],
  eventTriggers: [],
  assets: [],
  defaults: {}
};
const world: WorldAggregate = {
  id: worldId,
  title: draft.world.title,
  status: "draft",
  imageUrl: "",
  forkedFromWorldId: null,
  forkedFromWorldVersionId: null,
  createdAt: "2026-08-11T12:00:00.000Z",
  updatedAt: "2026-08-11T12:30:00.000Z",
  draftRevision: 8,
  draftContent: draft,
  draftBasedOnWorldVersionId: null,
  draftUpdatedAt: "2026-08-11T12:30:00.000Z",
  versions: [],
  campaigns: []
};

function editorFixture() {
  const { document, window } = parseHTML('<html><body><div id="app"></div></body></html>');
  const root = document.querySelector<HTMLElement>("#app");
  if (!root) throw new Error("Editor fixture is missing.");
  window.HTMLElement.prototype.focus = function focus() {
    Object.defineProperty(document, "activeElement", { configurable: true, value: this });
  };
  return { document, root, window };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function savedResponse(content = draft, revision = 9): WorldDraftSaveResponse {
  return {
    worldId,
    title: content.world.title,
    revision,
    content,
    updatedAt: "2026-08-11T12:35:00.000Z"
  };
}

describe("World Editor Overview page", () => {
  it("renders the routed shell and loading state before the aggregate arrives", () => {
    const { document, root } = editorFixture();
    const loadWorld = vi.fn(() => new Promise<WorldAggregate>(() => undefined));

    mountWorldEditorPage(root, worldId, { loadWorld });

    expect(document.querySelector('[data-page="world-editor"]')).not.toBeNull();
    expect(document.querySelector('a[href="/app/"]')?.textContent).toContain("World Library");
    expect(document.querySelector<HTMLButtonElement>('[data-action="save-draft"]')?.disabled).toBe(true);
    expect(document.querySelector('[data-editor-section="overview"]')).not.toBeNull();
    expect(document.querySelector('[data-draft-ledger]')).not.toBeNull();
    expect(document.querySelector(".theme-toggle")).not.toBeNull();
    expect(document.querySelector('[data-editor-state]')?.textContent).toContain("Loading world");
  });

  it("populates every Overview field and exposes one current section", async () => {
    const { document, root } = editorFixture();
    mountWorldEditorPage(root, worldId, { loadWorld: vi.fn().mockResolvedValue(world) });

    await settle();

    expect(document.querySelector<HTMLInputElement>('[name="world.title"]')?.value).toBe(draft.world.title);
    expect(document.querySelector<HTMLInputElement>('[name="world.genre"]')?.value).toBe(draft.world.genre);
    for (const field of ["tone", "premise", "backgroundStory", "firstAction", "rules"] as const) {
      expect(document.querySelector<HTMLTextAreaElement>(`[name="world.${field}"]`)?.value).toBe(draft.world[field]);
    }
    expect(document.querySelectorAll('[data-section-index] [aria-current="page"]')).toHaveLength(1);
    expect(document.querySelector('[data-draft-ledger]')?.textContent).toContain("Revision 8");
    expect(document.querySelector('[data-draft-ledger]')?.textContent).toContain("Ready");
  });

  it("renders retryable load failures without replacing the shared shell", async () => {
    const { document, root } = editorFixture();
    const loadWorld = vi.fn()
      .mockRejectedValueOnce(new WorldEditorApiError("network", "offline", null))
      .mockResolvedValueOnce(world);
    mountWorldEditorPage(root, worldId, { loadWorld });
    await settle();

    expect(document.querySelector('[data-editor-state]')?.textContent).toContain("could not be loaded");
    const retry = document.querySelector<HTMLButtonElement>('[data-action="retry-load"]');
    expect(retry).not.toBeNull();
    retry?.click();
    await settle();

    expect(loadWorld).toHaveBeenCalledTimes(2);
    expect(document.querySelector<HTMLInputElement>('[name="world.title"]')?.value).toBe(draft.world.title);
    expect(document.querySelector(".theme-toggle")).not.toBeNull();
  });

  it("renders an owner-scoped not-found state without offering a misleading retry", async () => {
    const { document, root } = editorFixture();
    mountWorldEditorPage(root, worldId, {
      loadWorld: vi.fn().mockRejectedValue(new WorldEditorApiError("not_found", "World not found.", 404))
    });

    await settle();

    expect(document.querySelector('[data-editor-state]')?.textContent).toContain("World not found");
    expect(document.querySelector('[data-action="retry-load"]')).toBeNull();
    expect(document.querySelector('a[href="/app/"]')).not.toBeNull();
  });

  it("initializes a blank Overview when the aggregate has no draft", async () => {
    const { document, root } = editorFixture();
    mountWorldEditorPage(root, worldId, {
      loadWorld: vi.fn().mockResolvedValue({ ...world, draftRevision: null, draftContent: null, draftUpdatedAt: null })
    });

    await settle();

    expect(document.querySelector<HTMLInputElement>('[name="world.title"]')?.value).toBe("");
    expect(document.querySelector('[data-draft-ledger]')?.textContent).toContain("Not created");
    expect(document.querySelector('[data-editor-state]')?.textContent).toContain("Start the first draft");
  });

  it("makes archived worlds read-only while preserving their Overview", async () => {
    const { document, root } = editorFixture();
    mountWorldEditorPage(root, worldId, { loadWorld: vi.fn().mockResolvedValue({ ...world, status: "archived" }) });

    await settle();

    expect(document.querySelector<HTMLInputElement>('[name="world.title"]')?.readOnly).toBe(true);
    expect(document.querySelectorAll<HTMLTextAreaElement>("textarea").every((field) => field.readOnly)).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[data-action="save-draft"]')?.disabled).toBe(true);
    expect(document.querySelector('[data-editor-state]')?.textContent).toContain("Archived worlds are read-only");
  });

  it("tracks input immutably without fetching and guards navigation only while dirty", async () => {
    const { document, root, window } = editorFixture();
    const loadWorld = vi.fn().mockResolvedValue(world);
    mountWorldEditorPage(root, worldId, { loadWorld });
    await settle();
    const premise = document.querySelector<HTMLTextAreaElement>('[name="world.premise"]');
    if (!premise) throw new Error("Premise field missing.");

    premise.value = "A changed local premise.";
    premise.dispatchEvent(new window.Event("input", { bubbles: true }));
    const dirtyUnload = new window.Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirtyUnload);

    expect(loadWorld).toHaveBeenCalledTimes(1);
    expect(document.querySelector<HTMLButtonElement>('[data-action="save-draft"]')?.disabled).toBe(false);
    expect(document.querySelector('[data-editor-state]')?.textContent).toContain("Unsaved changes");
    expect(dirtyUnload.defaultPrevented).toBe(true);
  });

  it("focuses the first invalid field and does not call save", async () => {
    const { document, root, window } = editorFixture();
    const saveWorldDraft = vi.fn();
    mountWorldEditorPage(root, worldId, { loadWorld: vi.fn().mockResolvedValue(world), saveWorldDraft });
    await settle();
    const title = document.querySelector<HTMLInputElement>('[name="world.title"]');
    if (!title) throw new Error("Title field missing.");
    title.value = " ";
    title.dispatchEvent(new window.Event("input", { bubbles: true }));

    document.querySelector<HTMLButtonElement>('[data-action="save-draft"]')?.click();
    await settle();

    expect(saveWorldDraft).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(title);
    expect(document.querySelector('[data-save-announcement]')?.textContent).toContain("World title is required");
  });

  it("saves exactly once and adopts the returned revision and content", async () => {
    const { document, root, window } = editorFixture();
    const savedDraft = { ...structuredClone(draft), world: { ...draft.world, title: "Server-normalized title" } };
    const saveWorldDraft = vi.fn().mockResolvedValue(savedResponse(savedDraft));
    mountWorldEditorPage(root, worldId, { loadWorld: vi.fn().mockResolvedValue(world), saveWorldDraft });
    await settle();
    const title = document.querySelector<HTMLInputElement>('[name="world.title"]');
    if (!title) throw new Error("Title field missing.");
    title.value = "Edited title";
    title.dispatchEvent(new window.Event("input", { bubbles: true }));

    document.querySelector<HTMLButtonElement>('[data-action="save-draft"]')?.click();
    expect(document.querySelector('[data-save-announcement]')?.textContent).toContain("Saving");
    await settle();

    expect(saveWorldDraft).toHaveBeenCalledTimes(1);
    expect(saveWorldDraft).toHaveBeenCalledWith(worldId, 8, expect.objectContaining({
      world: expect.objectContaining({ title: "Edited title" })
    }), expect.any(AbortSignal));
    expect(title.value).toBe("Server-normalized title");
    expect(document.querySelector('[data-draft-ledger]')?.textContent).toContain("Revision 9");
    expect(document.querySelector<HTMLButtonElement>('[data-action="save-draft"]')?.disabled).toBe(true);
    const cleanUnload = new window.Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);
  });

  it("keeps local fields and the save action available after a retryable save failure", async () => {
    const { document, root, window } = editorFixture();
    const saveWorldDraft = vi.fn().mockRejectedValue(new WorldEditorApiError("network", "offline", null));
    mountWorldEditorPage(root, worldId, { loadWorld: vi.fn().mockResolvedValue(world), saveWorldDraft });
    await settle();
    const premise = document.querySelector<HTMLTextAreaElement>('[name="world.premise"]');
    if (!premise) throw new Error("Premise field missing.");
    premise.value = "Local work survives.";
    premise.dispatchEvent(new window.Event("input", { bubbles: true }));

    document.querySelector<HTMLButtonElement>('[data-action="save-draft"]')?.click();
    await settle();

    expect(premise.value).toBe("Local work survives.");
    expect(document.querySelector<HTMLButtonElement>('[data-action="save-draft"]')?.disabled).toBe(false);
    expect(document.querySelector('[data-save-announcement]')?.textContent).toContain("try again");
  });

  it("recovers from conflict in-page while preserving and exporting the local draft", async () => {
    const { document, root, window } = editorFixture();
    const authoritative = {
      ...world,
      draftRevision: 9,
      draftContent: { ...structuredClone(draft), world: { ...draft.world, title: "Authoritative title" } }
    };
    const loadWorld = vi.fn().mockResolvedValueOnce(world).mockResolvedValueOnce(authoritative);
    const saveWorldDraft = vi.fn().mockRejectedValue(
      new WorldEditorApiError("conflict", "The draft changed elsewhere.", 409)
    );
    const copyUnsavedDraft = vi.fn().mockResolvedValue(undefined);
    const downloadUnsavedDraft = vi.fn();
    const confirmReload = vi.fn().mockReturnValue(true);
    mountWorldEditorPage(root, worldId, {
      loadWorld,
      saveWorldDraft,
      copyUnsavedDraft,
      downloadUnsavedDraft,
      confirmReload
    });
    await settle();
    const title = document.querySelector<HTMLInputElement>('[name="world.title"]');
    if (!title) throw new Error("Title field missing.");
    title.value = "Unsaved local title";
    title.dispatchEvent(new window.Event("input", { bubbles: true }));
    document.querySelector<HTMLButtonElement>('[data-action="save-draft"]')?.click();
    await settle();

    const conflict = document.querySelector<HTMLElement>('[data-save-conflict]');
    expect(conflict).not.toBeNull();
    expect(conflict?.contains(document.activeElement)).toBe(true);
    expect(title.value).toBe("Unsaved local title");
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    document.querySelector<HTMLButtonElement>('[data-action="copy-unsaved-draft"]')?.click();
    document.querySelector<HTMLButtonElement>('[data-action="download-unsaved-draft"]')?.click();
    await settle();
    expect(copyUnsavedDraft).toHaveBeenCalledWith(expect.stringContaining('"Unsaved local title"'));
    expect(downloadUnsavedDraft).toHaveBeenCalledWith(
      expect.stringContaining('"Unsaved local title"'),
      expect.stringMatching(/\.json$/)
    );

    document.querySelector<HTMLButtonElement>('[data-action="reload-authoritative-draft"]')?.click();
    await settle();
    expect(confirmReload).toHaveBeenCalledTimes(1);
    expect(loadWorld).toHaveBeenCalledTimes(2);
    expect(title.value).toBe("Authoritative title");
    expect(document.querySelector('[data-save-conflict]')).toBeNull();
  });

  it("expands the ledger drawer and aborts active requests when disposed", async () => {
    const { document, root } = editorFixture();
    let signal: AbortSignal | undefined;
    const loadWorld = vi.fn((_id: string, requestSignal?: AbortSignal) => {
      signal = requestSignal;
      return new Promise<WorldAggregate>(() => undefined);
    });
    const mounted = mountWorldEditorPage(root, worldId, { loadWorld });
    const drawer = document.querySelector<HTMLButtonElement>('[data-action="toggle-ledger"]');

    drawer?.click();
    expect(drawer?.getAttribute("aria-expanded")).toBe("true");
    mounted.dispose();

    expect(signal?.aborted).toBe(true);
  });
});
