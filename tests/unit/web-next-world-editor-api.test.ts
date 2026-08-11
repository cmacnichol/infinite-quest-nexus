import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditableWorldDraft } from "../../apps/web-next/src/world-editor-model.js";
import {
  WorldEditorApiError,
  loadWorld,
  saveWorldDraft,
  setWorldCoverAsset
} from "../../apps/web-next/src/world-editor-api.js";

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

const aggregateResponse = {
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("World Editor API boundary", () => {
  it("loads an encoded world id with JSON acceptance and parses the aggregate", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ ...aggregateResponse, id: "world / 1" }));
    vi.stubGlobal("fetch", fetch);

    const world = await loadWorld("world / 1");

    expect(world.id).toBe("world / 1");
    expect(fetch).toHaveBeenCalledWith("/api/v1/worlds/world%20%2F%201", {
      headers: { Accept: "application/json" },
      signal: undefined
    });
  });

  it("strips root identity keys while preserving all other imported draft properties", async () => {
    const adversarialDraft = {
      ...structuredClone(draft),
      user_id: "attacker-1",
      userId: "attacker-2",
      owner_user_id: "attacker-3",
      ownerUserId: "attacker-4",
      importedLore: { source: "portable-export", ownerUserId: "nested-provenance" },
      futureRootProperty: ["preserve", "verbatim"]
    } as EditableWorldDraft;
    const expectedContent = {
      ...structuredClone(draft),
      importedLore: adversarialDraft.importedLore,
      futureRootProperty: adversarialDraft.futureRootProperty
    };
    const fetch = vi.fn().mockResolvedValue(jsonResponse({
      worldId,
      title: draft.world.title,
      revision: 9,
      content: expectedContent,
      updatedAt: "2026-08-11T12:35:00.000Z"
    }));
    vi.stubGlobal("fetch", fetch);

    const result = await saveWorldDraft(worldId, 8, adversarialDraft);

    expect(result.content).toEqual(expectedContent);
    const [, init] = fetch.mock.calls[0]!;
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ expectedRevision: 8, title: draft.world.title, content: expectedContent });
    expect(body.content).not.toHaveProperty("user_id");
    expect(body.content).not.toHaveProperty("userId");
    expect(body.content).not.toHaveProperty("owner_user_id");
    expect(body.content).not.toHaveProperty("ownerUserId");
    expect(body.content.importedLore.ownerUserId).toBe("nested-provenance");
    expect(adversarialDraft).toHaveProperty("ownerUserId", "attacker-4");
  });

  it("propagates request abortion without wrapping it as an API error", async () => {
    const controller = new AbortController();
    const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetch);

    const request = loadWorld(worldId, controller.signal);
    const reason = new DOMException("Editor closed", "AbortError");
    controller.abort(reason);

    await expect(request).rejects.toBe(reason);
  });

  it("parses a 409 conflict while leaving the caller's local draft untouched", async () => {
    const conflict = {
      message: "The world draft changed before this save completed.",
      details: { expectedDraftRevision: 8, actualDraftRevision: 9 }
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(conflict, 409)));
    const before = structuredClone(draft);

    const error = await saveWorldDraft(worldId, 8, draft).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(WorldEditorApiError);
    expect(error).toMatchObject({ kind: "conflict", status: 409, message: conflict.message, details: conflict.details });
    expect(draft).toEqual(before);
  });

  it("distinguishes an owner-scoped not-found response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "World not found." }, 404)));

    const error = await loadWorld(worldId).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(WorldEditorApiError);
    expect(error).toMatchObject({ kind: "not_found", status: 404, message: "World not found." });
  });

  it.each([
    ["world aggregate", () => loadWorld(worldId), { id: worldId }],
    ["draft save", () => saveWorldDraft(worldId, 8, draft), { revision: "9", content: draft }],
    ["cover selection", () => setWorldCoverAsset(worldId, "asset-1"), { assetUrl: 42 }]
  ])("rejects a malformed successful %s response", async (_boundary, request, response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(response)));

    const error = await request().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(WorldEditorApiError);
    expect(error).toMatchObject({ kind: "invalid_response", status: 200 });
  });

  it("removes a cover independently with a null retained asset selection", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ assetUrl: "" }));
    vi.stubGlobal("fetch", fetch);

    await expect(setWorldCoverAsset(worldId, null)).resolves.toEqual({ assetUrl: "" });
    const [, init] = fetch.mock.calls[0]!;
    expect(JSON.parse(String(init.body))).toEqual({ assetId: null });
  });

  it("sets a cover through its independent encoded endpoint", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ assetUrl: "/api/v1/assets/asset-1" }));
    vi.stubGlobal("fetch", fetch);

    await expect(setWorldCoverAsset("world / 1", "asset-1")).resolves.toEqual({
      assetUrl: "/api/v1/assets/asset-1"
    });
    expect(fetch).toHaveBeenCalledWith("/api/v1/worlds/world%20%2F%201/cover-asset", {
      method: "PUT",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ assetId: "asset-1" }),
      signal: undefined
    });
  });
});
