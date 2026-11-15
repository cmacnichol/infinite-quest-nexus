import { describe, expect, it } from "vitest";
import { worldContentSchema } from "../../packages/contracts/src/world-library.js";
import { applyRefinedSection, authoringJobLabel, refinedSectionDiff, refineSectionPaths, sectionRefineRequest } from "../../packages/client-core/src/characters/section-refine.js";

const content = () => worldContentSchema.parse({ world: { title: "World" }, playableCharacters: [{ id: "hero", name: "Hero", profile: { appearance: { eyes: "Silver" }, story: { role: "Guide" } }, rpgStats: [{ name: "Strength" }], source: { origin: "test" } }, { id: "other", name: "Other" }] });

describe("section refinement", () => {
  it("limits sections and preserves identity, mechanics, and flags", () => {
    const current = content().playableCharacters[0]!;
    const generated = structuredClone(current);
    generated.id = "different"; generated.name = "Different"; generated.rpgStats = []; generated.campaignUse = "supporting";
    generated.profile!.story.role = "Sailor"; generated.profile!.unclassifiedNotes = "Notes"; generated.profile!.appearance.eyes = "Red";
    expect(refineSectionPaths("identity")).toEqual(["profile.identity.aliases", "profile.identity.pronouns"]);
    const result = applyRefinedSection(current, generated, "story");
    expect(result).toEqual({ ...current, profile: { ...current.profile, story: generated.profile!.story, unclassifiedNotes: "Notes" } });
    expect(refinedSectionDiff(current, generated, "appearance")).toEqual([{ path: "profile.appearance.eyes", label: "Eyes", current: "Silver", proposed: "Red" }]);
  });
  it("upserts a cloned unsaved candidate and validates before dispatch", () => {
    const world = content(); const before = structuredClone(world); const candidate = structuredClone(world.playableCharacters[0]!);
    candidate.profile!.story.role = "Unsaved"; candidate.campaignUse = "supporting";
    const request = sectionRefineRequest(world, candidate, "story", "More detail", "progress");
    expect(request.characterId).toBe("hero"); expect(request.campaignUse).toBe("supporting");
    expect(request.content.playableCharacters[0]!.profile!.story.role).toBe("Unsaved");
    expect(world).toEqual(before); expect(request.content.playableCharacters[1]).toEqual(world.playableCharacters[1]);
    const fresh = { ...candidate, id: "new", campaignUse: "both" as const };
    const appended = sectionRefineRequest(world, fresh, "identity", "Refine", "progress");
    expect(appended.characterId).toBe("new"); expect(appended.content.playableCharacters).toHaveLength(3); expect(appended.campaignUse).toBeUndefined();
    expect(() => sectionRefineRequest(world, { ...candidate, name: "" }, "story", "Refine", "p")).toThrow();
    expect(() => sectionRefineRequest({ ...world, playableCharacters: [candidate, candidate] }, candidate, "story", "Refine", "p")).toThrow(/duplicate/i);
    expect(() => sectionRefineRequest({ ...world, playableCharacters: Array.from({ length: 1000 }, (_, i) => ({ ...candidate, id: `id-${i}` })) }, fresh, "story", "Refine", "p")).toThrow();
  });
  it("labels proposals", () => {
    expect(authoringJobLabel({ status: "awaiting_review", target: { kind: "new_world" }, expiresAt: "2026-11-20T10:00:00.000Z" }, "en-US")).toBe("New character · awaiting review · expires 11/20/2026");
    expect(authoringJobLabel({ status: "queued", target: { kind: "world_draft", characterId: "hero" }, expiresAt: "2026-11-20T10:00:00.000Z" }, "en-US")).toMatch(/^Edit existing character · /);
  });
});
