import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditableWorldDraft } from "../../apps/web-next/src/world-editor-model.js";
import {
  WorldCreationApiError,
  attachCreatedWorldCover,
  createWorld,
  generateCreatedWorldCover,
  generateWorldPreview,
  loadWorldGenerationProgress
} from "../../apps/web-next/src/world-creation-api.js";

const worldId = "22222222-2222-4222-8222-222222222222";
const draft: EditableWorldDraft = {
  schemaVersion: 4,
  world: {
    title: "The Glass Observatory",
    genre: "Science fantasy",
    tone: "Numinous",
    premise: "A glass observatory watches impossible stars.",
    backgroundStory: "Its astronomers vanished.",
    firstAction: "Open the western dome.",
    rules: "Reflections remember."
  },
  playableCharacters: [{ id: "forbidden", name: "A generated character" }],
  entities: [],
  relationships: [],
  rpgStats: [],
  defaultTriggers: [],
  eventTriggers: [],
  assets: [],
  defaults: {}
};

const createdResponse = {
  id: worldId,
  title: draft.world.title,
  status: "draft",
  imageUrl: "",
  draftRevision: 1,
  draftContent: { ...draft, schemaVersion: 5, playableCharacters: [] },
  draftBasedOnWorldVersionId: null,
  createdAt: "2026-08-11T12:00:00.000Z",
  updatedAt: "2026-08-11T12:00:00.000Z"
};

const coverJobResponse = {
  id: "33333333-3333-4333-8333-333333333333",
  worldId,
  targetType: "world_cover",
  status: "queued",
  duplicate: false
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

describe("World Creation API boundary", () => {
  it("posts the exact generation preview request and canonicalizes generated content without characters", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ title: "Glass City", content: draft }));
    vi.stubGlobal("fetch", fetch);

    const result = await generateWorldPreview({
      title: "",
      prompt: "A glass city",
      progressKey: "world-gen:key"
    });

    expect(fetch).toHaveBeenCalledWith("/api/v1/worlds/generate-preview", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ title: "", prompt: "A glass city", progressKey: "world-gen:key" }),
      signal: undefined
    });
    expect(result.title).toBe("Glass City");
    expect(result.content.schemaVersion).toBe(5);
    expect(result.content.playableCharacters).toEqual([]);
    expect(draft.playableCharacters).toHaveLength(1);
  });

  it("encodes a generation progress key and parses a strict progress response", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({
      status: "processing",
      phase: "building_world",
      progressPercent: 42,
      message: "Building world canon."
    }));
    vi.stubGlobal("fetch", fetch);

    await expect(loadWorldGenerationProgress("world-gen:key / 1")).resolves.toEqual({
      status: "processing",
      phase: "building_world",
      progressPercent: 42,
      message: "Building world canon."
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/worlds/generate-progress?key=world-gen%3Akey%20%2F%201",
      { headers: { Accept: "application/json" }, signal: undefined }
    );
  });

  it.each([
    ["generated preview", () => generateWorldPreview({ title: "", prompt: "Glass", progressKey: "key" }), { title: "Glass", content: { schemaVersion: 5 } }],
    ["generation progress", () => loadWorldGenerationProgress("key"), { status: "processing", progressPercent: "42" }],
    ["created world", () => createWorld(draft), { ...createdResponse, draftRevision: 0 }],
    ["cover attachment", () => attachCreatedWorldCover(worldId, "asset-1"), { assetUrl: 42 }],
    ["generated cover", () => generateCreatedWorldCover(worldId, "Moonlit glass"), { ...coverJobResponse, duplicate: "false" }]
  ])("rejects a malformed successful %s response", async (_boundary, request, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));

    const error = await request().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(WorldCreationApiError);
    expect(error).toMatchObject({ kind: "invalid_response", status: 200 });
  });

  it("classifies provider unavailability separately from ordinary request failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      message: "The configured text provider is unavailable.",
      details: { providerRole: "text" }
    }, 503)));

    const error = await generateWorldPreview({ title: "", prompt: "Glass", progressKey: "key" })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(WorldCreationApiError);
    expect(error).toMatchObject({
      kind: "unavailable",
      status: 503,
      message: "The configured text provider is unavailable.",
      details: { providerRole: "text" }
    });
  });

  it("preserves an ordinary failed request as a typed request failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "The prompt was rejected." }, 422)));

    const error = await generateWorldPreview({ title: "", prompt: "Glass", progressKey: "key" })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(WorldCreationApiError);
    expect(error).toMatchObject({ kind: "request_failed", status: 422, message: "The prompt was rejected." });
  });

  it("wraps transport failures as typed network errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    const error = await loadWorldGenerationProgress("key").catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(WorldCreationApiError);
    expect(error).toMatchObject({ kind: "network", status: null, message: "fetch failed" });
  });

  it("propagates request abortion without wrapping it as an API error", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })));

    const pending = loadWorldGenerationProgress("key", controller.signal);
    const reason = new DOMException("Wizard closed", "AbortError");
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it("rejects a malformed creation snapshot before making an authoritative request", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(createdResponse, 201));
    vi.stubGlobal("fetch", fetch);
    const malformed = { ...structuredClone(draft), entities: {} } as unknown as EditableWorldDraft;

    await expect(createWorld(malformed)).rejects.toThrow("unexpected world response");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("creates with only title and owner-safe canonical content while forcing characters empty", async () => {
    const adversarial = {
      ...structuredClone(draft),
      user_id: "attacker-1",
      userId: "attacker-2",
      owner_user_id: "attacker-3",
      ownerUserId: "attacker-4",
      importedLore: { ownerUserId: "nested-provenance" }
    } as EditableWorldDraft;
    const fetch = vi.fn().mockResolvedValue(jsonResponse({
      ...createdResponse,
      ownerUserId: "server-only-owner",
      internalGenerationMetadata: { hidden: true }
    }, 201));
    vi.stubGlobal("fetch", fetch);

    const result = await createWorld(adversarial);

    expect(result).toEqual(createdResponse);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/api/v1/worlds");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(Object.keys(body)).toEqual(["title", "content"]);
    expect(body.title).toBe(draft.world.title);
    expect(body.content.schemaVersion).toBe(5);
    expect(body.content.playableCharacters).toEqual([]);
    expect(body.content).not.toHaveProperty("user_id");
    expect(body.content).not.toHaveProperty("userId");
    expect(body.content).not.toHaveProperty("owner_user_id");
    expect(body.content).not.toHaveProperty("ownerUserId");
    expect(body.content.importedLore.ownerUserId).toBe("nested-provenance");
    expect(adversarial.playableCharacters).toHaveLength(1);
  });

  it("attaches a retained cover through an independent encoded PUT", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ assetUrl: "/api/v1/assets/asset-1" }));
    vi.stubGlobal("fetch", fetch);

    await expect(attachCreatedWorldCover("world / 1", "asset-1")).resolves.toEqual({
      assetUrl: "/api/v1/assets/asset-1"
    });
    expect(fetch).toHaveBeenCalledWith("/api/v1/worlds/world%20%2F%201/cover-asset", {
      method: "PUT",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ assetId: "asset-1" }),
      signal: undefined
    });
  });

  it("posts a fiction-only prompt to the created world's independent cover endpoint", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(coverJobResponse, 202));
    vi.stubGlobal("fetch", fetch);

    await expect(generateCreatedWorldCover("world / 1", "Moonlit glass towers")).resolves.toEqual(coverJobResponse);
    expect(fetch).toHaveBeenCalledWith("/api/v1/worlds/world%20%2F%201/cover", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Moonlit glass towers" }),
      signal: undefined
    });
  });
});
