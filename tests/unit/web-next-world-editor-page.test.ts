import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import type { EditableWorldDraft, WorldAggregate } from "../../apps/web-next/src/world-editor-model.js";
import {
  WorldEditorApiError,
  type WorldCoverAssetResponse,
  type WorldDraftSaveResponse
} from "../../apps/web-next/src/world-editor-api.js";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
    expect([...document.querySelectorAll(".overview-form label > span")].map((label) => label.textContent)).toEqual([
      "Title",
      "Genre",
      "Tone",
      "Premise",
      "Background story",
      "First action",
      "Rules"
    ]);
    const finalCommandCell = document.querySelector(".editor-command-row > :last-child");
    expect(finalCommandCell?.classList.contains("editor-save-cell")).toBe(true);
    expect(finalCommandCell?.querySelector("button")?.textContent).toBe("Save draft");
    expect(document.querySelectorAll('[data-section-index] [aria-current="page"]')).toHaveLength(1);
    expect(document.querySelector('[data-draft-ledger]')?.textContent).toContain("Revision 8");
    expect(document.querySelector('[data-draft-ledger]')?.textContent).toContain("Ready");
  });

  it("shows the loaded title and immutable version and campaign context with management links", async () => {
    const { document, root } = editorFixture();
    const contextualWorld: WorldAggregate = {
      ...world,
      title: "Loaded aggregate title",
      versions: [{
        id: "version-2",
        versionNumber: 2,
        sourceHash: null,
        releaseNotes: "Second edition",
        createdFromRevision: 7,
        publishedAt: "2026-08-10T12:00:00.000Z",
        createdAt: "2026-08-10T12:00:00.000Z",
        deletable: false,
        deletionBlockers: {
          currentCampaigns: 1,
          campaignMigrations: 0,
          campaignTransfers: 0,
          chronicleMemories: 0,
          modelChains: 0
        },
        detachments: { drafts: 1, forks: 0, imports: 0 }
      }],
      campaigns: [{
        id: "campaign-1",
        title: "The Western Dome",
        status: "active",
        activeTurnNumber: 12,
        worldVersionId: "version-2",
        worldVersionNumber: 2,
        selectedCharacterId: null,
        selectedCharacterName: null,
        turnControlStyle: "action_only",
        updatedAt: "2026-08-11T12:00:00.000Z"
      }]
    };
    mountWorldEditorPage(root, worldId, { loadWorld: vi.fn().mockResolvedValue(contextualWorld) });

    await settle();

    expect(document.querySelector("#editor-title")?.textContent).toBe("Loaded aggregate title");
    expect(document.querySelector("[data-version-context]")?.textContent).toContain("1 published version · Latest v2");
    expect(document.querySelector("[data-campaign-context]")?.textContent).toContain("1 active campaign · Turn 12");
    expect(document.querySelector<HTMLAnchorElement>('[data-version-context] a')?.href).toContain("/nexus/#world-library");
    expect(document.querySelector<HTMLAnchorElement>('[data-campaign-context] a')?.href).toContain("/nexus/#campaigns");
    expect(document.querySelector("[data-version-context] button, [data-campaign-context] button")).toBeNull();
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

  it("blocks editing when the aggregate has no editable draft", async () => {
    const { document, root } = editorFixture();
    mountWorldEditorPage(root, worldId, {
      loadWorld: vi.fn().mockResolvedValue({ ...world, draftRevision: null, draftContent: null, draftUpdatedAt: null })
    });

    await settle();

    expect(document.querySelector('[data-no-editable-draft]')?.textContent).toContain("No editable draft is available");
    expect(document.querySelector('[data-no-editable-draft]')?.textContent).toContain("cannot be edited");
    expect(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(".overview-form input, .overview-form textarea")
      .every((field) => field.disabled)).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[data-action="save-draft"]')?.disabled).toBe(true);
    expect(document.querySelector('[data-draft-ledger]')?.textContent).toContain("Not created");
    expect(document.querySelector('[data-editor-state]')?.textContent).toContain("No editable draft");
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
    expect(title.getAttribute("aria-invalid")).toBe("true");
    const titleErrorId = title.getAttribute("aria-describedby");
    expect(titleErrorId).not.toBeNull();
    expect(document.getElementById(titleErrorId!)?.textContent).toContain("World title is required");
    expect(document.querySelector('[data-save-announcement]')?.textContent).toContain("World title is required");
    for (const field of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(".overview-form input, .overview-form textarea")) {
      expect(document.getElementById(field.getAttribute("aria-describedby") ?? "")).not.toBeNull();
    }
  });

  it("keeps dirty protection and editing locks active until a pending save is adopted", async () => {
    const { document, root, window } = editorFixture();
    const pendingSave = deferred<WorldDraftSaveResponse>();
    const saveWorldDraft = vi.fn().mockReturnValue(pendingSave.promise);
    mountWorldEditorPage(root, worldId, { loadWorld: vi.fn().mockResolvedValue(world), saveWorldDraft });
    await settle();
    const title = document.querySelector<HTMLInputElement>('[name="world.title"]');
    if (!title) throw new Error("Title field missing.");
    title.value = "Locked local title";
    title.dispatchEvent(new window.Event("input", { bubbles: true }));

    document.querySelector<HTMLButtonElement>('[data-action="save-draft"]')?.click();

    const pendingUnload = new window.Event("beforeunload", { cancelable: true });
    window.dispatchEvent(pendingUnload);
    expect(pendingUnload.defaultPrevented).toBe(true);
    expect(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(".overview-form input, .overview-form textarea")
      .every((field) => field.disabled)).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[data-action="save-draft"]')?.disabled).toBe(true);

    pendingSave.resolve(savedResponse({ ...structuredClone(draft), world: { ...draft.world, title: "Adopted title" } }));
    await settle();

    expect(title.value).toBe("Adopted title");
    expect(title.disabled).toBe(false);
    const cleanUnload = new window.Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);
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
    expect(premise.disabled).toBe(false);
    expect(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(".overview-form input, .overview-form textarea")
      .every((field) => !field.disabled)).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[data-action="save-draft"]')?.disabled).toBe(false);
    const dirtyUnload = new window.Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirtyUnload);
    expect(dirtyUnload.defaultPrevented).toBe(true);
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
    expect(document.querySelector('[data-editor-state]')?.textContent).toContain("Conflict");
    expect(document.querySelector('[data-ledger-state]')?.textContent).toContain("Conflict");
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

  it("ignores a stale load response even when the dependency ignores abort", async () => {
    const { document, root, window } = editorFixture();
    const firstReload = deferred<WorldAggregate>();
    const secondReload = deferred<WorldAggregate>();
    const loadWorld = vi.fn()
      .mockResolvedValueOnce(world)
      .mockReturnValueOnce(firstReload.promise)
      .mockReturnValueOnce(secondReload.promise);
    const saveWorldDraft = vi.fn().mockRejectedValue(
      new WorldEditorApiError("conflict", "The draft changed elsewhere.", 409)
    );
    mountWorldEditorPage(root, worldId, {
      loadWorld,
      saveWorldDraft,
      confirmReload: () => true
    });
    await settle();
    const title = document.querySelector<HTMLInputElement>('[name="world.title"]');
    if (!title) throw new Error("Title field missing.");
    title.value = "Unsaved title";
    title.dispatchEvent(new window.Event("input", { bubbles: true }));
    document.querySelector<HTMLButtonElement>('[data-action="save-draft"]')?.click();
    await settle();

    const reload = document.querySelector<HTMLButtonElement>('[data-action="reload-authoritative-draft"]');
    reload?.click();
    reload?.click();
    const newestWorld = {
      ...world,
      draftRevision: 10,
      draftContent: { ...structuredClone(draft), world: { ...draft.world, title: "Newest title" } }
    };
    secondReload.resolve(newestWorld);
    await settle();
    expect(title.value).toBe("Newest title");

    firstReload.resolve({
      ...world,
      draftRevision: 9,
      draftContent: { ...structuredClone(draft), world: { ...draft.world, title: "Stale title" } }
    });
    await settle();

    expect(loadWorld).toHaveBeenCalledTimes(3);
    expect(title.value).toBe("Newest title");
    expect(document.querySelector('[data-draft-ledger]')?.textContent).toContain("Revision 10");
  });

  it("switches all five sections and edits character structure through one master-detail editor", async () => {
    const { document, root, window } = editorFixture();
    const authoredDraft: EditableWorldDraft = {
      ...structuredClone(draft),
      playableCharacters: [{
        id: "mara",
        name: "Mara",
        characterText: "A patient observer.",
        profile: { identity: { pronouns: "she/her" } },
        rpgStats: [{ id: "resolve", value: 7 }],
        defaultTriggers: [{ id: "torch", value: "lit" }],
        importedExtension: { keep: true }
      }]
    };
    mountWorldEditorPage(root, worldId, {
      loadWorld: vi.fn().mockResolvedValue({ ...world, draftContent: authoredDraft })
    });
    await settle();

    const sections = ["overview", "characters", "canon", "mechanics", "assets"];
    for (const section of sections) {
      document.querySelector<HTMLButtonElement>(`[data-section-target="${section}"]`)?.click();
      expect(document.querySelector(`[data-editor-section="${section}"]`)?.hasAttribute("hidden")).toBe(false);
      expect(document.querySelector(`[data-section-target="${section}"]`)?.getAttribute("aria-current")).toBe("page");
    }

    document.querySelector<HTMLButtonElement>('[data-section-target="characters"]')?.click();
    expect(document.querySelectorAll("[data-collection-editor]")).toHaveLength(1);
    expect(document.querySelector<HTMLInputElement>('[name="structured.name"]')?.value).toBe("Mara");
    expect(document.querySelector<HTMLTextAreaElement>('[name="structured.characterText"]')?.value)
      .toBe("A patient observer.");
    expect(document.querySelector('[name="structured.profile"]')).not.toBeNull();
    expect(document.querySelector('[name="structured.rpgStats"]')).not.toBeNull();
    expect(document.querySelector('[name="structured.defaultTriggers"]')).not.toBeNull();
    expect(document.querySelector('[name="structured.narrativeGuidance"]')).toBeNull();
    expect(document.querySelector('[name="structured.profileGroups"]')).toBeNull();
    expect(document.querySelector('[name="structured.stats"]')).toBeNull();
    expect(document.querySelector('[name="structured.defaultTrackers"]')).toBeNull();

    const guidance = document.querySelector<HTMLTextAreaElement>('[name="structured.characterText"]');
    if (!guidance) throw new Error("Character guidance field missing.");
    guidance.value = "A decisive observer.";
    guidance.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(document.querySelector('[data-editor-state]')?.textContent).toContain("Unsaved changes");
  });

  it("switches Canon and Mechanics collections and supports add, reversible remove, and advanced JSON errors", async () => {
    const { document, root } = editorFixture();
    const authoredDraft: EditableWorldDraft = {
      ...structuredClone(draft),
      entities: [{ id: "dome", title: "Western Dome", kind: "location", imported: { keep: true } }],
      relationships: [{ from: "dome", to: "star", kind: "observes" }],
      rpgStats: [{ skill: "Resolve", score: 7 }],
      defaultTriggers: [{ label: "Torch", when: "lit", then: "Reveal path" }],
      eventTriggers: [{ label: "Dusk", when: "sunset", rules: "Open dome" }]
    };
    mountWorldEditorPage(root, worldId, {
      loadWorld: vi.fn().mockResolvedValue({ ...world, draftContent: authoredDraft })
    });
    await settle();

    document.querySelector<HTMLButtonElement>('[data-section-target="canon"]')?.click();
    expect(document.querySelector('[data-collection-name]')?.textContent).toContain("Entities");
    document.querySelector<HTMLButtonElement>('[data-collection-target="relationships"]')?.click();
    expect(document.querySelector('[data-collection-name]')?.textContent).toContain("Relationships");
    expect(document.querySelector('[data-collection-list]')?.textContent).toContain("dome → star");

    document.querySelector<HTMLButtonElement>('[data-action="add-item"]')?.click();
    expect(document.querySelector('[data-result-count]')?.textContent).toContain("2 of 2");
    document.querySelector<HTMLButtonElement>('[data-action="remove-item"]')?.click();
    expect(document.querySelector('[data-pending-removals]')?.textContent).toContain("removed");
    document.querySelector<HTMLButtonElement>('[data-action="undo-removal"]')?.click();
    expect(document.querySelector('[data-result-count]')?.textContent).toContain("2 of 2");

    const advanced = document.querySelector<HTMLTextAreaElement>('[data-advanced-json]');
    if (!advanced) throw new Error("Advanced JSON field missing.");
    advanced.value = "{";
    document.querySelector<HTMLButtonElement>('[data-action="apply-advanced-json"]')?.click();
    expect(document.getElementById(advanced.getAttribute("aria-describedby") ?? "")?.textContent).toContain("valid JSON");
    expect(document.querySelector('[data-editor-state]')?.textContent).toContain("Invalid input");

    document.querySelector<HTMLButtonElement>('[data-section-target="mechanics"]')?.click();
    for (const collection of ["rpgStats", "defaultTriggers", "eventTriggers"]) {
      document.querySelector<HTMLButtonElement>(`[data-collection-target="${collection}"]`)?.click();
      expect(document.querySelector(`[data-active-collection="${collection}"]`)).not.toBeNull();
    }
  });

  it("preserves numeric stat primitives when structured values are edited", async () => {
    const { document, root, window } = editorFixture();
    const authoredDraft = { ...structuredClone(draft), rpgStats: [{ skill: "Resolve", score: 7, imported: { keep: true } }] };
    const saveWorldDraft = vi.fn().mockResolvedValue(savedResponse(authoredDraft));
    mountWorldEditorPage(root, worldId, {
      loadWorld: vi.fn().mockResolvedValue({ ...world, draftContent: authoredDraft }),
      saveWorldDraft
    });
    await settle();
    document.querySelector<HTMLButtonElement>('[data-section-target="mechanics"]')?.click();
    const value = document.querySelector<HTMLInputElement>('[name="structured.value"]');
    if (!value) throw new Error("Structured stat value is missing.");

    value.value = "8.5";
    value.dispatchEvent(new window.Event("input", { bubbles: true }));
    document.querySelector<HTMLButtonElement>('[data-action="save-draft"]')?.click();
    await settle();

    expect(saveWorldDraft).toHaveBeenCalledWith(worldId, 8, expect.objectContaining({
      rpgStats: [{ skill: "Resolve", score: 8.5, imported: { keep: true } }]
    }), expect.any(AbortSignal));
  });

  it("rejects a non-numeric structured edit for an existing numeric stat", async () => {
    const { document, root, window } = editorFixture();
    const authoredDraft = { ...structuredClone(draft), rpgStats: [{ name: "Resolve", value: 7 }] };
    mountWorldEditorPage(root, worldId, {
      loadWorld: vi.fn().mockResolvedValue({ ...world, draftContent: authoredDraft })
    });
    await settle();
    document.querySelector<HTMLButtonElement>('[data-section-target="mechanics"]')?.click();
    const value = document.querySelector<HTMLInputElement>('[name="structured.value"]');
    if (!value) throw new Error("Structured stat value is missing.");

    value.value = "many";
    value.dispatchEvent(new window.Event("input", { bubbles: true }));

    const describedError = document.getElementById(value.getAttribute("aria-describedby") ?? "");
    expect(describedError?.textContent).toContain("number");
    expect(value.getAttribute("aria-invalid")).toBe("true");
    expect(document.querySelector('[data-editor-state]')?.textContent).toContain("Invalid input");
    expect(document.querySelector('[data-ledger-state]')?.textContent).toContain("Invalid");
    expect(document.querySelector<HTMLButtonElement>('[data-action="save-draft"]')?.disabled).toBe(false);
  });

  it("keeps Save actionable and recovers a pending structured error after the user navigates away", async () => {
    const { document, root, window } = editorFixture();
    const authoredDraft = { ...structuredClone(draft), rpgStats: [{ name: "Resolve", value: 7 }] };
    const saveWorldDraft = vi.fn().mockResolvedValue(savedResponse(authoredDraft));
    mountWorldEditorPage(root, worldId, {
      loadWorld: vi.fn().mockResolvedValue({ ...world, draftContent: authoredDraft }),
      saveWorldDraft
    });
    await settle();
    document.querySelector<HTMLButtonElement>('[data-section-target="mechanics"]')?.click();
    const value = document.querySelector<HTMLInputElement>('[name="structured.value"]');
    const name = document.querySelector<HTMLInputElement>('[name="structured.name"]');
    const save = document.querySelector<HTMLButtonElement>('[data-action="save-draft"]');
    if (!value || !name || !save) throw new Error("Structured stat fixture is incomplete.");

    name.value = "Determination";
    name.dispatchEvent(new window.Event("input", { bubbles: true }));
    value.value = "many";
    value.dispatchEvent(new window.Event("input", { bubbles: true }));
    document.querySelector<HTMLButtonElement>('[data-section-target="canon"]')?.click();

    expect(save.disabled).toBe(false);
    save.click();
    await settle();

    expect(saveWorldDraft).not.toHaveBeenCalled();
    expect(document.querySelector('[data-section-target="mechanics"]')?.getAttribute("aria-current")).toBe("page");
    const recoveredValue = document.querySelector<HTMLInputElement>('[name="structured.value"]');
    if (!recoveredValue) throw new Error("Structured stat value was not recovered.");
    expect(recoveredValue.value).toBe("many");
    expect(recoveredValue.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(recoveredValue);
    expect(document.querySelector('[data-save-announcement]')?.textContent).toContain("valid number");

    recoveredValue.value = "8";
    recoveredValue.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(document.querySelector('[data-structured-error]')?.textContent).toBe("");
    expect(save.disabled).toBe(false);
  });

  it("clears a pending structured error when its invalid record is removed", async () => {
    const { document, root, window } = editorFixture();
    const authoredDraft = { ...structuredClone(draft), rpgStats: [{ name: "Resolve", value: 7 }, { name: "Focus", value: 4 }] };
    const saveWorldDraft = vi.fn().mockResolvedValue(savedResponse(authoredDraft));
    mountWorldEditorPage(root, worldId, {
      loadWorld: vi.fn().mockResolvedValue({ ...world, draftContent: authoredDraft }),
      saveWorldDraft
    });
    await settle();
    document.querySelector<HTMLButtonElement>('[data-section-target="mechanics"]')?.click();
    const value = document.querySelector<HTMLInputElement>('[name="structured.value"]');
    if (!value) throw new Error("Structured stat value is missing.");
    value.value = "many";
    value.dispatchEvent(new window.Event("input", { bubbles: true }));

    document.querySelector<HTMLButtonElement>('[data-action="remove-item"]')?.click();
    const save = document.querySelector<HTMLButtonElement>('[data-action="save-draft"]');
    if (!save) throw new Error("Save action is missing.");
    expect(save.disabled).toBe(false);
    save.click();
    await settle();

    expect(saveWorldDraft).toHaveBeenCalledTimes(1);
    expect(saveWorldDraft.mock.calls[0]?.[2].rpgStats).toEqual([{ name: "Focus", value: 4 }]);
  });

  it("keeps a pending error attached to its record when an earlier record is removed", async () => {
    const { document, root, window } = editorFixture();
    const authoredDraft = { ...structuredClone(draft), rpgStats: [{ name: "Resolve", value: 7 }, { name: "Focus", value: 4 }] };
    const saveWorldDraft = vi.fn();
    mountWorldEditorPage(root, worldId, {
      loadWorld: vi.fn().mockResolvedValue({ ...world, draftContent: authoredDraft }),
      saveWorldDraft
    });
    await settle();
    document.querySelector<HTMLButtonElement>('[data-section-target="mechanics"]')?.click();
    document.querySelector<HTMLButtonElement>('[data-action="select-item"][data-item-index="1"]')?.click();
    const invalidValue = document.querySelector<HTMLInputElement>('[name="structured.value"]');
    if (!invalidValue) throw new Error("Second structured stat value is missing.");
    invalidValue.value = "many";
    invalidValue.dispatchEvent(new window.Event("input", { bubbles: true }));
    document.querySelector<HTMLButtonElement>('[data-action="select-item"][data-item-index="0"]')?.click();
    document.querySelector<HTMLButtonElement>('[data-action="remove-item"]')?.click();

    const save = document.querySelector<HTMLButtonElement>('[data-action="save-draft"]');
    if (!save) throw new Error("Save action is missing.");
    expect(save.disabled).toBe(false);
    save.click();
    await settle();

    expect(saveWorldDraft).not.toHaveBeenCalled();
    const recoveredValue = document.querySelector<HTMLInputElement>('[name="structured.value"]');
    expect(recoveredValue?.value).toBe("many");
    expect(document.querySelector('[data-record-detail]')?.textContent).toContain("Focus");
    expect(document.activeElement).toBe(recoveredValue);
  });

  it("does not restore a rejected structured value when an invalid record is removed and undone", async () => {
    const { document, root, window } = editorFixture();
    const authoredDraft = { ...structuredClone(draft), rpgStats: [{ name: "Resolve", value: 7 }] };
    const saveWorldDraft = vi.fn().mockResolvedValue(savedResponse(authoredDraft));
    mountWorldEditorPage(root, worldId, {
      loadWorld: vi.fn().mockResolvedValue({ ...world, draftContent: authoredDraft }),
      saveWorldDraft
    });
    await settle();
    document.querySelector<HTMLButtonElement>('[data-section-target="mechanics"]')?.click();
    const value = document.querySelector<HTMLInputElement>('[name="structured.value"]');
    if (!value) throw new Error("Structured stat value is missing.");
    value.value = "many";
    value.dispatchEvent(new window.Event("input", { bubbles: true }));
    document.querySelector<HTMLButtonElement>('[data-action="remove-item"]')?.click();
    document.querySelector<HTMLButtonElement>('[data-action="undo-removal"]')?.click();

    expect(document.querySelector<HTMLInputElement>('[name="structured.value"]')?.value).toBe("7");
    expect(document.querySelector('[data-structured-error]')?.textContent).toBe("");
    const save = document.querySelector<HTMLButtonElement>('[data-action="save-draft"]');
    if (!save) throw new Error("Save action is missing.");
    save.click();
    await settle();
    expect(saveWorldDraft).toHaveBeenCalledTimes(1);
  });

  it("keeps a pending structured error attached to its record when another record is added", async () => {
    const { document, root, window } = editorFixture();
    const authoredDraft = { ...structuredClone(draft), rpgStats: [{ name: "Resolve", value: 7 }] };
    const saveWorldDraft = vi.fn();
    mountWorldEditorPage(root, worldId, {
      loadWorld: vi.fn().mockResolvedValue({ ...world, draftContent: authoredDraft }),
      saveWorldDraft
    });
    await settle();
    document.querySelector<HTMLButtonElement>('[data-section-target="mechanics"]')?.click();
    const value = document.querySelector<HTMLInputElement>('[name="structured.value"]');
    if (!value) throw new Error("Structured stat value is missing.");
    value.value = "many";
    value.dispatchEvent(new window.Event("input", { bubbles: true }));
    document.querySelector<HTMLButtonElement>('[data-action="add-item"]')?.click();

    const save = document.querySelector<HTMLButtonElement>('[data-action="save-draft"]');
    if (!save) throw new Error("Save action is missing.");
    expect(save.disabled).toBe(false);
    save.click();
    await settle();

    expect(saveWorldDraft).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>('[name="structured.value"]')?.value).toBe("many");
    expect(document.querySelector('[data-record-detail]')?.textContent).toContain("Resolve");
  });

  it("preserves unrelated pending recovery when the assets collection is replaced through advanced JSON", async () => {
    const { document, root, window } = editorFixture();
    const authoredDraft = {
      ...structuredClone(draft),
      rpgStats: [{ name: "Resolve", value: 7 }],
      assets: [{ id: "old-asset", filename: "old.webp" }]
    };
    const saveWorldDraft = vi.fn();
    mountWorldEditorPage(root, worldId, {
      loadWorld: vi.fn().mockResolvedValue({ ...world, draftContent: authoredDraft }),
      saveWorldDraft
    });
    await settle();
    document.querySelector<HTMLButtonElement>('[data-section-target="mechanics"]')?.click();
    const value = document.querySelector<HTMLInputElement>('[name="structured.value"]');
    if (!value) throw new Error("Structured stat value is missing.");
    value.value = "many";
    value.dispatchEvent(new window.Event("input", { bubbles: true }));
    document.querySelector<HTMLButtonElement>('[data-section-target="assets"]')?.click();
    const assetsJson = document.querySelector<HTMLTextAreaElement>('[data-collection-json]');
    if (!assetsJson) throw new Error("Assets collection JSON is missing.");
    assetsJson.value = '[{"id":"new-asset","filename":"new.webp"}]';
    document.querySelector<HTMLButtonElement>('[data-action="apply-collection-json"]')?.click();

    const save = document.querySelector<HTMLButtonElement>('[data-action="save-draft"]');
    if (!save) throw new Error("Save action is missing.");
    expect(save.disabled).toBe(false);
    save.click();
    await settle();

    expect(saveWorldDraft).not.toHaveBeenCalled();
    expect(document.querySelector('[data-section-target="mechanics"]')?.getAttribute("aria-current")).toBe("page");
    expect(document.querySelector<HTMLInputElement>('[name="structured.value"]')?.value).toBe("many");
  });

  it("updates only collection results during sequential search input while retaining focus and unapplied detail DOM", async () => {
    const { document, root, window } = editorFixture();
    const entities = Array.from({ length: 150 }, (_, index) => ({
      id: `entity-${index}`,
      name: index === 149 ? "Needle Observatory" : `Atlas Entity ${index}`,
      type: "location"
    }));
    mountWorldEditorPage(root, worldId, {
      loadWorld: vi.fn().mockResolvedValue({ ...world, draftContent: { ...structuredClone(draft), entities } })
    });
    await settle();
    document.querySelector<HTMLButtonElement>('[data-section-target="canon"]')?.click();

    expect(document.querySelectorAll("[data-collection-row]")).toHaveLength(100);
    expect(document.querySelector('[data-result-count]')?.textContent).toContain("100 of 150");
    const search = document.querySelector<HTMLInputElement>('[data-collection-search]');
    const detail = document.querySelector<HTMLElement>('[data-record-detail]');
    const advanced = document.querySelector<HTMLTextAreaElement>('[data-advanced-json]');
    if (!search || !detail || !advanced) throw new Error("Collection search fixture is incomplete.");
    advanced.value = '{"unapplied":true}';
    search.focus();

    for (const query of ["N", "Needle"]) {
      search.value = query;
      search.dispatchEvent(new window.Event("input", { bubbles: true }));
      expect(document.querySelector('[data-collection-search]')).toBe(search);
      expect(document.activeElement).toBe(search);
      expect(document.querySelector('[data-record-detail]')).toBe(detail);
      expect(document.querySelector<HTMLTextAreaElement>('[data-advanced-json]')).toBe(advanced);
      expect(advanced.value).toBe('{"unapplied":true}');
    }

    expect(document.querySelectorAll("[data-collection-row]")).toHaveLength(1);
    expect(document.querySelector('[data-result-count]')?.textContent).toContain("1 of 150");
    expect(document.querySelector('[data-collection-list]')?.textContent).toContain("Needle Observatory");
  });

  it("preserves invalid selected-record JSON and its error while collection search changes", async () => {
    const { document, root, window } = editorFixture();
    const entities = [{ name: "Western Dome" }, { name: "Eastern Dome" }];
    mountWorldEditorPage(root, worldId, {
      loadWorld: vi.fn().mockResolvedValue({ ...world, draftContent: { ...structuredClone(draft), entities } })
    });
    await settle();
    document.querySelector<HTMLButtonElement>('[data-section-target="canon"]')?.click();
    const detail = document.querySelector<HTMLElement>('[data-record-detail]');
    const advanced = document.querySelector<HTMLTextAreaElement>('[data-advanced-json]');
    const search = document.querySelector<HTMLInputElement>('[data-collection-search]');
    if (!detail || !advanced || !search) throw new Error("Collection detail fixture is incomplete.");
    advanced.value = "{";
    document.querySelector<HTMLButtonElement>('[data-action="apply-advanced-json"]')?.click();
    const errorId = advanced.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(errorId)?.textContent).toContain("valid JSON");

    search.value = "Eastern";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));

    expect(document.querySelector('[data-record-detail]')).toBe(detail);
    expect(advanced.value).toBe("{");
    expect(document.getElementById(errorId)?.textContent).toContain("valid JSON");
  });

  it("edits defaults and assets JSON and reports cover failure independently after the draft saves", async () => {
    const { document, root, window } = editorFixture();
    const authoredDraft: EditableWorldDraft = {
      ...structuredClone(draft),
      assets: [{ id: "asset-1", filename: "observatory.webp", retained: true }],
      defaults: { startingLocation: "dome", imported: { keep: true } }
    };
    const saveWorldDraft = vi.fn().mockResolvedValue(savedResponse(authoredDraft));
    const setWorldCoverAsset = vi.fn<(id: string, assetId: string | null, signal?: AbortSignal) => Promise<WorldCoverAssetResponse>>()
      .mockRejectedValue(new WorldEditorApiError("not_found", "Asset is not authorized.", 404));
    mountWorldEditorPage(root, worldId, {
      loadWorld: vi.fn().mockResolvedValue({ ...world, imageUrl: "/api/v1/assets/current", draftContent: authoredDraft }),
      saveWorldDraft,
      setWorldCoverAsset
    });
    await settle();

    document.querySelector<HTMLButtonElement>('[data-section-target="mechanics"]')?.click();
    const defaults = document.querySelector<HTMLTextAreaElement>('[data-defaults-json]');
    if (!defaults) throw new Error("Defaults JSON field missing.");
    expect(defaults.value).toContain('"imported"');
    defaults.value = '{"startingLocation":"western-dome","imported":{"keep":true}}';
    document.querySelector<HTMLButtonElement>('[data-action="apply-defaults-json"]')?.click();

    document.querySelector<HTMLButtonElement>('[data-section-target="assets"]')?.click();
    expect(document.querySelector<HTMLImageElement>('[data-cover-art]')?.src).toContain("/api/v1/assets/current");
    expect(document.querySelector('[data-collection-list]')?.textContent).toContain("observatory.webp");
    const assetsJson = document.querySelector<HTMLTextAreaElement>('[data-collection-json]');
    if (!assetsJson) throw new Error("Assets JSON field missing.");
    assetsJson.value = '[{"id":"asset-1","filename":"observatory.webp","retained":true},{"legacy":"preserved"}]';
    document.querySelector<HTMLButtonElement>('[data-action="apply-collection-json"]')?.click();
    expect(document.querySelector('[data-result-count]')?.textContent).toContain("2 of 2");
    const assetId = document.querySelector<HTMLInputElement>('[name="coverAssetId"]');
    const selectCover = document.querySelector<HTMLInputElement>('[name="coverChoice"][value="select"]');
    if (!assetId || !selectCover) throw new Error("Cover controls missing.");
    selectCover.checked = true;
    selectCover.dispatchEvent(new window.Event("change", { bubbles: true }));
    assetId.value = "asset-1";
    assetId.dispatchEvent(new window.Event("input", { bubbles: true }));

    expect(setWorldCoverAsset).not.toHaveBeenCalled();
    document.querySelector<HTMLButtonElement>('[data-action="save-draft"]')?.click();
    await settle();

    expect(saveWorldDraft).toHaveBeenCalledTimes(1);
    expect(saveWorldDraft).toHaveBeenCalledWith(worldId, 8, expect.objectContaining({
      assets: [
        { id: "asset-1", filename: "observatory.webp", retained: true },
        { legacy: "preserved" }
      ],
      defaults: { startingLocation: "western-dome", imported: { keep: true } }
    }), expect.any(AbortSignal));
    expect(setWorldCoverAsset).toHaveBeenCalledWith(worldId, "asset-1", expect.any(AbortSignal));
    expect(document.querySelector('[data-editor-state]')?.textContent).toContain("Draft saved");
    expect(document.querySelector('[data-save-announcement]')?.textContent).toContain("Draft saved");
    expect(document.querySelector('[data-save-announcement]')?.textContent).toContain("cover");
    expect(document.querySelector('[data-save-announcement]')?.textContent).toContain("not attached");
    expect(document.querySelector<HTMLButtonElement>('[data-action="save-draft"]')?.disabled).toBe(false);
  });

  it("retries a failed cover attachment with the retained intent", async () => {
    const { document, root, window } = editorFixture();
    const saveWorldDraft = vi.fn().mockResolvedValue(savedResponse());
    const setWorldCoverAsset = vi.fn()
      .mockRejectedValueOnce(new WorldEditorApiError("network", "offline", null))
      .mockResolvedValueOnce({ assetUrl: "/api/v1/assets/asset-1" });
    mountWorldEditorPage(root, worldId, {
      loadWorld: vi.fn().mockResolvedValue(world),
      saveWorldDraft,
      setWorldCoverAsset
    });
    await settle();
    document.querySelector<HTMLButtonElement>('[data-section-target="assets"]')?.click();
    const select = document.querySelector<HTMLInputElement>('[name="coverChoice"][value="select"]');
    const assetId = document.querySelector<HTMLInputElement>('[name="coverAssetId"]');
    if (!select || !assetId) throw new Error("Cover attachment controls are missing.");
    select.checked = true;
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
    assetId.value = "asset-1";
    assetId.dispatchEvent(new window.Event("input", { bubbles: true }));

    document.querySelector<HTMLButtonElement>('[data-action="save-draft"]')?.click();
    await settle();

    expect(document.querySelector<HTMLInputElement>('[name="coverChoice"][value="select"]')?.checked).toBe(true);
    expect(document.querySelector<HTMLInputElement>('[name="coverAssetId"]')?.value).toBe("asset-1");
    document.querySelector<HTMLButtonElement>('[data-action="save-draft"]')?.click();
    await settle();

    expect(saveWorldDraft).toHaveBeenCalledTimes(1);
    expect(setWorldCoverAsset).toHaveBeenCalledTimes(2);
    expect(setWorldCoverAsset).toHaveBeenNthCalledWith(1, worldId, "asset-1", expect.any(AbortSignal));
    expect(setWorldCoverAsset).toHaveBeenNthCalledWith(2, worldId, "asset-1", expect.any(AbortSignal));
    expect(document.querySelector('[data-save-announcement]')?.textContent).toContain("Cover updated");
  });

  it("does not call the cover endpoint when the draft save fails", async () => {
    const { document, root, window } = editorFixture();
    const saveWorldDraft = vi.fn().mockRejectedValue(new WorldEditorApiError("network", "offline", null));
    const setWorldCoverAsset = vi.fn();
    mountWorldEditorPage(root, worldId, {
      loadWorld: vi.fn().mockResolvedValue(world),
      saveWorldDraft,
      setWorldCoverAsset
    });
    await settle();
    document.querySelector<HTMLButtonElement>('[data-section-target="assets"]')?.click();
    const select = document.querySelector<HTMLInputElement>('[name="coverChoice"][value="select"]');
    const assetId = document.querySelector<HTMLInputElement>('[name="coverAssetId"]');
    if (!select || !assetId) throw new Error("Cover attachment controls are missing.");
    select.checked = true;
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
    assetId.value = "asset-1";
    assetId.dispatchEvent(new window.Event("input", { bubbles: true }));

    document.querySelector<HTMLButtonElement>('[data-action="save-draft"]')?.click();
    await settle();

    expect(saveWorldDraft).toHaveBeenCalledTimes(1);
    expect(setWorldCoverAsset).not.toHaveBeenCalled();
    expect(document.querySelector('[data-save-announcement]')?.textContent).toContain("draft could not be saved");
  });

  it("reports a failed cover removal with removal-specific recovery copy", async () => {
    const { document, root, window } = editorFixture();
    mountWorldEditorPage(root, worldId, {
      loadWorld: vi.fn().mockResolvedValue({ ...world, imageUrl: "/api/v1/assets/current" }),
      saveWorldDraft: vi.fn().mockResolvedValue(savedResponse()),
      setWorldCoverAsset: vi.fn().mockRejectedValue(new WorldEditorApiError("network", "offline", null))
    });
    await settle();
    document.querySelector<HTMLButtonElement>('[data-section-target="assets"]')?.click();
    const remove = document.querySelector<HTMLInputElement>('[name="coverChoice"][value="remove"]');
    if (!remove) throw new Error("Remove cover choice is missing.");
    remove.checked = true;
    remove.dispatchEvent(new window.Event("change", { bubbles: true }));

    document.querySelector<HTMLButtonElement>('[data-action="save-draft"]')?.click();
    await settle();

    expect(document.querySelector('[data-save-announcement]')?.textContent).toContain("cover was not removed");
    expect(document.querySelector('[data-save-announcement]')?.textContent).not.toContain("retained asset");
  });

  it("keeps the cover by default and performs removal only after the draft save succeeds", async () => {
    const first = editorFixture();
    const keepSave = vi.fn().mockResolvedValue(savedResponse());
    const keepCover = vi.fn();
    mountWorldEditorPage(first.root, worldId, {
      loadWorld: vi.fn().mockResolvedValue({ ...world, imageUrl: "/api/v1/assets/current" }),
      saveWorldDraft: keepSave,
      setWorldCoverAsset: keepCover
    });
    await settle();
    const title = first.document.querySelector<HTMLInputElement>('[name="world.title"]');
    if (!title) throw new Error("Title field missing.");
    title.value = "Edited while keeping cover";
    title.dispatchEvent(new first.window.Event("input", { bubbles: true }));
    first.document.querySelector<HTMLButtonElement>('[data-action="save-draft"]')?.click();
    await settle();
    expect(keepSave).toHaveBeenCalledTimes(1);
    expect(keepCover).not.toHaveBeenCalled();

    const second = editorFixture();
    const sequence: string[] = [];
    const removeSave = vi.fn(async () => {
      sequence.push("draft");
      return savedResponse();
    });
    const removeCover = vi.fn(async () => {
      sequence.push("cover");
      return { assetUrl: "" };
    });
    mountWorldEditorPage(second.root, worldId, {
      loadWorld: vi.fn().mockResolvedValue({ ...world, imageUrl: "/api/v1/assets/current" }),
      saveWorldDraft: removeSave,
      setWorldCoverAsset: removeCover
    });
    await settle();
    second.document.querySelector<HTMLButtonElement>('[data-section-target="assets"]')?.click();
    const remove = second.document.querySelector<HTMLInputElement>('[name="coverChoice"][value="remove"]');
    if (!remove) throw new Error("Remove cover choice missing.");
    remove.checked = true;
    remove.dispatchEvent(new second.window.Event("change", { bubbles: true }));
    expect(removeCover).not.toHaveBeenCalled();
    second.document.querySelector<HTMLButtonElement>('[data-action="save-draft"]')?.click();
    await settle();

    expect(sequence).toEqual(["draft", "cover"]);
    expect(removeCover).toHaveBeenCalledWith(worldId, null, expect.any(AbortSignal));
    expect(second.document.querySelector('[data-save-announcement]')?.textContent).toContain("Cover updated");
  });

  it("edits root and world extras without exposing or mutating known schema fields", async () => {
    const { document, root } = editorFixture();
    const authoredDraft: EditableWorldDraft = {
      ...structuredClone(draft),
      importedRoot: { source: "archive" },
      world: { ...draft.world, importedWorld: { constellation: "glass" } }
    };
    const saveWorldDraft = vi.fn().mockImplementation(async (_id, _revision, content) => savedResponse(content));
    mountWorldEditorPage(root, worldId, {
      loadWorld: vi.fn().mockResolvedValue({ ...world, draftContent: authoredDraft }),
      saveWorldDraft
    });
    await settle();

    const rootJson = document.querySelector<HTMLTextAreaElement>("[data-root-extras-json]");
    const worldJson = document.querySelector<HTMLTextAreaElement>("[data-world-extras-json]");
    if (!rootJson || !worldJson) throw new Error("Unknown-property editors are missing.");
    expect(rootJson.value).toContain('"importedRoot"');
    expect(rootJson.value).not.toContain('"schemaVersion"');
    expect(rootJson.value).not.toContain('"world"');
    expect(worldJson.value).toContain('"importedWorld"');
    expect(worldJson.value).not.toContain('"title"');

    rootJson.value = '{"schemaVersion":99,"world":{"title":"Injected"},"importedRoot":{"source":"edited"},"newRoot":true}';
    document.querySelector<HTMLButtonElement>('[data-action="apply-root-extras-json"]')?.click();
    worldJson.value = '{"title":"Injected","importedWorld":{"constellation":"edited"},"newWorld":["kept"]}';
    document.querySelector<HTMLButtonElement>('[data-action="apply-world-extras-json"]')?.click();
    document.querySelector<HTMLButtonElement>('[data-action="save-draft"]')?.click();
    await settle();

    expect(saveWorldDraft).toHaveBeenCalledWith(worldId, 8, expect.objectContaining({
      schemaVersion: 5,
      importedRoot: { source: "edited" },
      newRoot: true,
      world: expect.objectContaining({
        title: "The Glass Observatory",
        importedWorld: { constellation: "edited" },
        newWorld: ["kept"]
      })
    }), expect.any(AbortSignal));
  });

  it("associates structured and every advanced JSON error with its invalid control", async () => {
    const { document, root, window } = editorFixture();
    const authoredDraft: EditableWorldDraft = {
      ...structuredClone(draft),
      playableCharacters: [{ name: "Mara", profile: {}, rpgStats: [], defaultTriggers: [] }],
      entities: [{ name: "Western Dome" }],
      rpgStats: [{ name: "Resolve", value: 7 }],
      assets: [{ id: "asset-1" }]
    };
    mountWorldEditorPage(root, worldId, {
      loadWorld: vi.fn().mockResolvedValue({ ...world, draftContent: authoredDraft })
    });
    await settle();

    const assertInvalidAssociation = (control: HTMLTextAreaElement | HTMLInputElement) => {
      expect(control.getAttribute("aria-invalid")).toBe("true");
      const describedBy = control.getAttribute("aria-describedby");
      expect(describedBy).not.toBeNull();
      expect(document.getElementById(describedBy!)?.textContent).not.toBe("");
    };

    for (const selector of ["[data-root-extras-json]", "[data-world-extras-json]"]) {
      const control = document.querySelector<HTMLTextAreaElement>(selector);
      if (!control) throw new Error(`Missing JSON control ${selector}.`);
      control.value = "{";
      control.dispatchEvent(new window.Event("input", { bubbles: true }));
      assertInvalidAssociation(control);
    }

    document.querySelector<HTMLButtonElement>('[data-section-target="characters"]')?.click();
    for (const control of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-structured-field]")) {
      expect(document.getElementById(control.getAttribute("aria-describedby") ?? "")).not.toBeNull();
    }
    const profile = document.querySelector<HTMLTextAreaElement>('[name="structured.profile"]');
    if (!profile) throw new Error("Profile JSON field missing.");
    profile.value = "{";
    profile.dispatchEvent(new window.Event("input", { bubbles: true }));
    assertInvalidAssociation(profile);

    document.querySelector<HTMLButtonElement>('[data-section-target="canon"]')?.click();
    const recordJson = document.querySelector<HTMLTextAreaElement>("[data-advanced-json]");
    if (!recordJson) throw new Error("Record JSON field missing.");
    recordJson.value = "{";
    recordJson.dispatchEvent(new window.Event("input", { bubbles: true }));
    assertInvalidAssociation(recordJson);

    document.querySelector<HTMLButtonElement>('[data-section-target="mechanics"]')?.click();
    const defaultsJson = document.querySelector<HTMLTextAreaElement>("[data-defaults-json]");
    if (!defaultsJson) throw new Error("Defaults JSON field missing.");
    defaultsJson.value = "{";
    defaultsJson.dispatchEvent(new window.Event("input", { bubbles: true }));
    assertInvalidAssociation(defaultsJson);

    document.querySelector<HTMLButtonElement>('[data-section-target="assets"]')?.click();
    const assetsJson = document.querySelector<HTMLTextAreaElement>("[data-collection-json]");
    if (!assetsJson) throw new Error("Assets JSON field missing.");
    assetsJson.value = "{";
    assetsJson.dispatchEvent(new window.Event("input", { bubbles: true }));
    assertInvalidAssociation(assetsJson);
  });

  it("returns to and focuses the first invalid advanced JSON control", async () => {
    const { document, root, window } = editorFixture();
    const authoredDraft = { ...structuredClone(draft), entities: [{ name: "Western Dome" }] };
    const saveWorldDraft = vi.fn();
    mountWorldEditorPage(root, worldId, {
      loadWorld: vi.fn().mockResolvedValue({ ...world, draftContent: authoredDraft }),
      saveWorldDraft
    });
    await settle();
    document.querySelector<HTMLButtonElement>('[data-section-target="canon"]')?.click();
    const advanced = document.querySelector<HTMLTextAreaElement>("[data-advanced-json]");
    if (!advanced) throw new Error("Advanced JSON field missing.");
    advanced.value = "{";
    advanced.dispatchEvent(new window.Event("input", { bubbles: true }));
    document.querySelector<HTMLButtonElement>('[data-section-target="overview"]')?.click();

    document.querySelector<HTMLButtonElement>('[data-action="save-draft"]')?.click();
    await settle();

    const recovered = document.querySelector<HTMLTextAreaElement>("[data-advanced-json]");
    expect(saveWorldDraft).not.toHaveBeenCalled();
    expect(document.querySelector('[data-section-target="canon"]')?.getAttribute("aria-current")).toBe("page");
    expect(recovered?.value).toBe("{");
    expect(recovered?.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(recovered);
  });

  it("treats raw advanced JSON as protected local work until it is applied or discarded", async () => {
    const { document, root, window } = editorFixture();
    const authoredDraft = { ...structuredClone(draft), entities: [{ name: "Western Dome" }] };
    const saveWorldDraft = vi.fn();
    mountWorldEditorPage(root, worldId, {
      loadWorld: vi.fn().mockResolvedValue({ ...world, draftContent: authoredDraft }),
      saveWorldDraft
    });
    await settle();
    document.querySelector<HTMLButtonElement>('[data-section-target="canon"]')?.click();
    const advanced = document.querySelector<HTMLTextAreaElement>("[data-advanced-json]");
    if (!advanced) throw new Error("Advanced JSON field missing.");
    advanced.value = '{"name":"Unapplied local name"}';
    advanced.dispatchEvent(new window.Event("input", { bubbles: true }));

    expect(document.querySelector('[data-editor-state]')?.textContent).toContain("Unsaved JSON");
    const dirtyUnload = new window.Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirtyUnload);
    expect(dirtyUnload.defaultPrevented).toBe(true);

    document.querySelector<HTMLButtonElement>('[data-section-target="overview"]')?.click();
    document.querySelector<HTMLButtonElement>('[data-section-target="canon"]')?.click();
    const recovered = document.querySelector<HTMLTextAreaElement>("[data-advanced-json]");
    expect(recovered?.value).toBe('{"name":"Unapplied local name"}');

    document.querySelector<HTMLButtonElement>('[data-action="save-draft"]')?.click();
    await settle();
    expect(saveWorldDraft).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(recovered);
    expect(recovered?.value).toBe('{"name":"Unapplied local name"}');
    expect(document.getElementById(recovered?.getAttribute("aria-describedby") ?? "")?.textContent)
      .toContain("Apply or discard");

    document.querySelector<HTMLButtonElement>('[data-action="discard-advanced-json"]')?.click();
    expect(document.querySelector<HTMLTextAreaElement>("[data-advanced-json]")?.value).toContain('"Western Dome"');
    const cleanUnload = new window.Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);
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
