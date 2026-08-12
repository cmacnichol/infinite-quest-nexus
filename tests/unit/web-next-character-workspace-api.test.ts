import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditableWorldDraft } from "../../apps/web-next/src/world-editor-model.js";
import {
  CharacterWorkspaceApiError,
  generateCharacterPreview,
  loadCharacterGenerationProgress,
  sanitizeCharacterGenerationContent
} from "../../apps/web-next/src/character-workspace-api.js";

const draft = {
  schemaVersion: 4,
  ownerUserId: "spoofed-draft-owner",
  safeRootLore: { ownerUserId: "nested provenance stays" },
  world: {
    title: "The Glass Observatory",
    genre: "Science fantasy",
    tone: "Numinous",
    premise: "A glass observatory watches impossible stars.",
    backgroundStory: "Its astronomers vanished.",
    firstAction: "Open the western dome.",
    rules: "Reflections remember.",
    owner_user_id: "spoofed-world-owner",
    cosmology: { ownerUserId: "nested world provenance stays", moons: 3 }
  },
  playableCharacters: [{
    id: "trusted-edit-id",
    name: "Mara",
    characterText: "A patient observer.",
    ownerUserId: "spoofed-character-owner",
    source: { ownerUserId: "nested source provenance stays" }
  }],
  entities: [{ id: "lore-1", text: "The mirrors sing." }],
  relationships: [],
  rpgStats: [],
  defaultTriggers: [],
  eventTriggers: [],
  assets: [],
  defaults: {}
} as unknown as EditableWorldDraft;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Character Workspace API boundary", () => {
  it("posts only sanitized current content, prompt, trusted edit ID, and progress key to the preview route", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({
      character: {
        id: "trusted-edit-id",
        name: "Mara Vale",
        characterText: "She reads impossible stars.",
        ownerUserId: "server-internal-owner",
        source: { ownerUserId: "safe nested provenance" }
      }
    }));
    vi.stubGlobal("fetch", fetch);

    const result = await generateCharacterPreview({
      content: draft,
      prompt: "Deepen her connection to the mirrors.",
      characterId: "trusted-edit-id",
      progressKey: "character-preview:unique-1"
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/api/v1/worlds/playable-characters/generate-preview");
    expect(init).toMatchObject({
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      signal: undefined
    });
    const body = JSON.parse(String(init.body));
    expect(Object.keys(body)).toEqual(["content", "prompt", "characterId", "progressKey"]);
    expect(body.prompt).toBe("Deepen her connection to the mirrors.");
    expect(body.characterId).toBe("trusted-edit-id");
    expect(body.progressKey).toBe("character-preview:unique-1");
    expect(body.content.schemaVersion).toBe(5);
    expect(body.content).not.toHaveProperty("ownerUserId");
    expect(body.content.world).not.toHaveProperty("owner_user_id");
    expect(body.content.playableCharacters[0]).not.toHaveProperty("ownerUserId");
    expect(body.content.safeRootLore.ownerUserId).toBe("nested provenance stays");
    expect(body.content.world.cosmology).toEqual({ ownerUserId: "nested world provenance stays", moons: 3 });
    expect(body.content.playableCharacters[0].source.ownerUserId).toBe("nested source provenance stays");
    expect(body.content.entities).toEqual([{ id: "lore-1", text: "The mirrors sing." }]);
    expect(result.character).toMatchObject({ id: "trusted-edit-id", name: "Mara Vale" });
    expect(result.character).not.toHaveProperty("ownerUserId");
    expect(result.character.source.ownerUserId).toBe("safe nested provenance");
    expect(draft).toHaveProperty("ownerUserId", "spoofed-draft-owner");
  });

  it("sanitizes creation requests without inventing a character ID field", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({
      character: { id: "server-generated-id", name: "Ilya", characterText: "A lenswright." }
    }));
    vi.stubGlobal("fetch", fetch);

    await generateCharacterPreview({
      content: draft,
      prompt: "Create a lenswright.",
      progressKey: "character-preview:unique-2"
    });

    const body = JSON.parse(String(fetch.mock.calls[0]![1].body));
    expect(body).not.toHaveProperty("characterId");
  });

  it("encodes a progress key and strictly parses bounded world-generation progress", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({
      status: "processing",
      phase: "validating",
      progressPercent: 80,
      message: "Validating generated character."
    }));
    vi.stubGlobal("fetch", fetch);

    await expect(loadCharacterGenerationProgress("character:key / 1")).resolves.toEqual({
      status: "processing",
      phase: "validating",
      progressPercent: 80,
      message: "Validating generated character."
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/worlds/generate-progress?key=character%3Akey%20%2F%201",
      { headers: { Accept: "application/json" }, signal: undefined }
    );
  });

  it.each([
    ["preview", () => generateCharacterPreview({ content: draft, prompt: "Create", progressKey: "key" }), {
      character: { id: "x", name: "X", characterText: "Guidance" }, extra: true
    }],
    ["character", () => generateCharacterPreview({ content: draft, prompt: "Create", progressKey: "key" }), {
      character: { id: "", name: "X", characterText: "Guidance" }
    }],
    ["progress", () => loadCharacterGenerationProgress("key"), {
      status: "processing", phase: "generating", progressPercent: 35, message: "Generating.", extra: true
    }]
  ])("rejects a malformed successful %s response", async (_boundary, request, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));

    await expect(request()).rejects.toMatchObject({
      name: "CharacterWorkspaceApiError",
      kind: "invalid_response",
      status: 200
    });
  });

  it("classifies provider unavailability without exposing it as a successful preview", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      message: "Add a text provider before generating a character.",
      details: { code: "default_text_provider_unavailable" }
    }, 409)));

    const error = await generateCharacterPreview({ content: draft, prompt: "Create", progressKey: "key" })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(CharacterWorkspaceApiError);
    expect(error).toMatchObject({
      kind: "unavailable",
      status: 409,
      message: "Add a text provider before generating a character.",
      details: { code: "default_text_provider_unavailable" }
    });
  });

  it("propagates abort without wrapping or falling back to any persistence route", async () => {
    const controller = new AbortController();
    const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetch);

    const pending = generateCharacterPreview({ content: draft, prompt: "Create", progressKey: "key" }, controller.signal);
    const reason = new DOMException("Workspace closed", "AbortError");
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe("/api/v1/worlds/playable-characters/generate-preview");
  });

  it("rejects malformed drafts before calling any API route", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    expect(() => sanitizeCharacterGenerationContent({ ...draft, entities: {} } as unknown as EditableWorldDraft)).toThrow();
    expect(() => sanitizeCharacterGenerationContent({
      ...draft,
      playableCharacters: [null]
    } as unknown as EditableWorldDraft)).toThrow();
    await expect(generateCharacterPreview({
      content: { ...draft, entities: {} } as unknown as EditableWorldDraft,
      prompt: "Create",
      progressKey: "key"
    })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
