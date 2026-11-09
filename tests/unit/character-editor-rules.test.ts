import { describe, expect, it, vi } from "vitest";
import { castOverrideProfileSchema } from "@infinite-quest/contracts";
import { createCastEditor, setCastEditorField } from "../../packages/client-core/src/campaign-cast-editor.js";
import { createNexusHttpClient } from "../../packages/client-web/src/http-client.js";
import { createNoopSessionPort } from "../../packages/client-web/src/index.js";
import { worldFictionCanon } from "../../packages/database/src/chronicle-context-repository.js";

describe("blank override rule", () => {
  it.each(["story.goals", "state.location", "state.condition", "state.clothing"])("rejects an empty %s", (field) => {
    expect(castOverrideProfileSchema.safeParse({ [field]: "  " }).success).toBe(false);
  });
  it("keeps the intentional empty observed appearance override", () => {
    expect(castOverrideProfileSchema.safeParse({ "appearance.description": "" }).success).toBe(true);
  });
  it("turns an emptied updating field into a clear", () => {
    const authority = { revision: 1, boundary: { turnNumber: 0, timelineRevision: 0 } } as never;
    const state = setCastEditorField(createCastEditor(authority), "state.location", "");
    expect(state.setOverrides).toEqual({});
    expect(state.clearOverrides).toEqual(["state.location"]);
  });
});

describe("HTTP error messages", () => {
  const failing = (body: unknown) => vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 500, headers: { "content-type": "application/json" } }));
  async function message(body: unknown) {
    const http = createNexusHttpClient({ basePath: "/api/v1", session: createNoopSessionPort(), fetchImpl: failing(body) as never });
    return http.request({ method: "GET", path: "/x" } as never).catch((error: Error) => error.message);
  }
  it("hides a message from an unrecognized JSON body", async () => {
    await expect(message({ message: "upstream proxy internals" })).resolves.toBe("Request failed with HTTP 500.");
  });
  it.each([{ error: "Nope", message: "Shown" }, { code: "x", message: "Shown" }, { details: { code: "x" }, message: "Shown" }])("keeps a recognized message", async (body) => {
    await expect(message(body)).resolves.toBe("Shown");
  });
});

describe("seeded NPC world entities (D6)", () => {
  it("drops linked entity prose and keeps the relationship endpoint", () => {
    const content = { world: { title: "T" }, entities: [
      { id: "e1", name: "Mara", kind: "character", linkedCharacterId: "a", description: "SEEDED PROSE about Mara" },
      { id: "e2", name: "Mara's Keep", kind: "place", description: "Unseeded prose about Mara" }
    ], relationships: [{ id: "r1", from: "e1", to: "e2", description: "Mara holds the keep" }] };
    const text = JSON.stringify(worldFictionCanon(content, {}, {}, "Mara", 20_000, new Set(["a"])));
    expect(text).not.toContain("SEEDED PROSE");
    expect(text).toContain("Unseeded prose");
    expect(text).toContain("Mara holds the keep");
    expect(text).toContain("e1");
  });
});
