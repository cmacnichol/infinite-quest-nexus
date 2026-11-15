import { describe, expect, it } from "vitest";
import { characterProfileSchema, type CastDetail, type CastObservation } from "../../packages/contracts/src/index.js";
import { buildCharacterSheet } from "../../packages/client-core/src/characters/sheet.js";
import { sheetRequest, sheetUndoOperation, sheetUndoRequest, sheetMatchesFence, conflictChoices, retractionRequest, clearEditLabel, sheetSavedMessage, sheetFieldLimit, castOverrideLimit } from "../../packages/client-core/src/characters/sheet-changes.js";

const id = "10000000-0000-4000-8000-000000000001";
const detail = (): CastDetail => ({ character: { id, name: "Mira", aliases: ["M"], origin: { kind: "manual" }, profile: {}, revision: 3, pinned: false, ignored: false, firstObservedTurn: 0, lastObservedTurn: 0, lastMentionedTurn: null }, revision: 4, boundary: { turnNumber: 20, timelineRevision: 0 }, observations: [], overrides: [], identityEvents: [], autoMatches: [], unresolvedCandidateIds: [], editorDestination: null });
const cast = (d: CastDetail) => ({ kind: "cast" as const, detail: d });
const seeded = () => { const d = detail(), profile = characterProfileSchema.parse({ story: { role: "Guide" } }); d.character.originProfile = { seedEventId: id, worldVersionId: id, entityId: "mira", rosterName: "Mira", rosterAliases: [], legacyCharacterText: "", profile, evidence: { kind: "world", worldVersionId: id, sourcePath: "/x" } }; d.character.campaignProfile = profile; d.character.fieldSources = { "story.role": "authored" }; d.character.profile["story.role"] = "Guide"; return d; };
const fence = { kind: "cast" as const, revision: 4, characterRevision: 3, boundary: { turnNumber: 20, timelineRevision: 0 } };
const base = { expectedCastRevision: 4, expectedCharacterRevision: 3, expectedBoundary: fence.boundary, idempotencyKey: "k" };
const change = (path: string, value: string | string[] | null) => ({ kind: "field" as const, path, value });

describe("sheet writes", () => {
  it("builds sparse Supporting Character edits and identity changes", () => {
    const d = detail();
    expect(sheetRequest(cast(d), change("story.role", "Guide"), "k")).toEqual({ endpoint: "edit", body: { ...base, setOverrides: { "story.role": "Guide" } } });
    expect(sheetRequest(cast(d), change("story.role", null), "k").body).toEqual({ ...base, clearOverrides: ["story.role"] });
    expect(sheetRequest(cast(d), change("name", "Ada"), "k").body).toEqual({ ...base, name: "Ada" });
    expect(sheetRequest(cast(d), change("identity.aliases", ["A"]), "k").body).toEqual({ ...base, aliases: ["A"] });
  });
  it("uses one authored reset or state clear and sparse toggles for Starting Cast", () => {
    const d = seeded();
    expect(sheetRequest(cast(d), change("story.role", "Captain"), "k").body).toEqual({ ...base, set: { "story.role": "Captain" } });
    expect(sheetRequest(cast(d), change("story.role", null), "k").body).toEqual({ ...base, reset: ["story.role"] });
    expect(sheetRequest(cast(d), change("state.location", "Port"), "k").body).toEqual({ ...base, setOverrides: { "state.location": "Port" } });
    expect(sheetRequest(cast(d), change("state.location", null), "k").body).toEqual({ ...base, clearOverrides: ["state.location"] });
    expect(sheetRequest(cast(d), { kind: "toggle", key: "ignored", value: true }, "k").body).toEqual({ ...base, ignored: true });
  });
  it("inverts only the prior active edit, identity, and authored source", () => {
    const d = detail(); d.overrides = [{ field: "state.location", value: "Docks", evidence: { kind: "user", editId: id, effectiveTurnNumber: 10 } }];
    expect(sheetUndoOperation(cast(d), change("state.location", "Port"))).toEqual({ kind: "restoreOverride", path: "state.location", value: "Docks" });
    d.observations = [{ id, characterId: id, field: "state.location", value: "Palace", mode: "fact", speakerCharacterId: null, supersedesObservationId: null, evidence: { kind: "turn", turnId: id, turnNumber: 11, narrationRevision: 0, sourceHash: "a".repeat(64), paragraphId: "p", quote: "Palace" } }];
    expect(sheetUndoOperation(cast(d), change("state.location", "Port"))).toEqual({ kind: "restoreOverride", path: "state.location", value: null });
    expect(sheetUndoOperation(cast(d), change("identity.aliases", ["A"]))).toEqual({ kind: "restoreValue", path: "identity.aliases", value: ["M"] });
    const s = seeded(); expect(sheetUndoOperation(cast(s), change("story.role", "Captain"))).toEqual({ kind: "restoreAuthored", path: "story.role", value: null });
    s.character.fieldSources!["story.role"] = "campaign_edit";
    expect(sheetUndoOperation(cast(s), change("story.role", null))).toEqual({ kind: "restoreAuthored", path: "story.role", value: "Guide" });
    s.character.aliases = ["A"]; expect(sheetUndoRequest(cast(s), { kind: "restoreValue", path: "identity.aliases", value: ["M"] }, fence, "k").body).toEqual({ ...base, aliases: ["M"] });
  });
  it("uses authored history when field sources are missing and rejects unknown authority", () => {
    for (const sources of [undefined, { "story.background": "authored" as const }]) {
      const d = seeded(); d.character.fieldSources = sources;
      d.authoredHistory = [{ eventId: id, seedEventId: id, effectiveTurnNumber: 3, set: { "story.role": "Captain" }, reset: [] }];
      const undo = sheetUndoOperation(cast(d), change("story.role", "Sailor"));
      expect(undo).toEqual({ kind: "restoreAuthored", path: "story.role", value: "Captain" });
      expect(sheetUndoRequest(cast(d), undo, fence, "k").body).toEqual({ ...base, set: { "story.role": "Captain" } });
      d.authoredHistory.push({ eventId: id, seedEventId: id, effectiveTurnNumber: 4, set: {}, reset: ["story.role"] });
      expect(sheetUndoOperation(cast(d), change("story.role", "Sailor"))).toEqual({ kind: "restoreAuthored", path: "story.role", value: null });
      d.authoredHistory = undefined;
      expect(() => sheetUndoOperation(cast(d), change("story.role", "Sailor"))).toThrow();
    }
  });
  it("restores only the changed identity or toggle and respects retracted replacement evidence", () => {
    const d = detail(); d.character.name = "Ada"; d.character.aliases = ["A"];
    expect(sheetUndoRequest(cast(d), { kind: "restoreValue", path: "name", value: "Mira" }, fence, "k").body).toEqual({ ...base, name: "Mira" });
    expect(sheetUndoRequest(cast(d), { kind: "restoreValue", path: "identity.aliases", value: ["M"] }, fence, "k").body).toEqual({ ...base, aliases: ["M"] });
    d.character.pinned = true;
    expect(sheetUndoRequest(cast(d), { kind: "toggle", key: "pinned", value: false }, fence, "k").body).toEqual({ ...base, pinned: false });
    const s = seeded(); s.character.name = "Ada"; s.character.aliases = ["A"];
    expect(sheetUndoRequest(cast(s), { kind: "restoreValue", path: "name", value: "Mira" }, fence, "k").body).toEqual({ ...base, name: "Mira" });
    expect(sheetUndoRequest(cast(s), { kind: "restoreValue", path: "identity.aliases", value: ["M"] }, fence, "k").body).toEqual({ ...base, aliases: ["M"] });
    expect(sheetUndoRequest(cast(s), { kind: "restoreAuthored", path: "story.role", value: null }, fence, "k").body).toEqual({ ...base, reset: ["story.role"] });
    expect(sheetUndoRequest(cast(s), { kind: "restoreAuthored", path: "story.role", value: "Captain" }, fence, "k").body).toEqual({ ...base, set: { "story.role": "Captain" } });
    expect(sheetUndoRequest(cast(s), { kind: "restoreOverride", path: "appearance.description", value: "" }, fence, "k").body).toEqual({ ...base, setOverrides: { "appearance.description": "" } });
    d.overrides = [{ field: "state.location", value: "Docks", evidence: { kind: "user", editId: id, effectiveTurnNumber: 10 } }];
    d.observations = [{ id, characterId: id, field: "state.location", value: "Palace", mode: "fact", speakerCharacterId: null, supersedesObservationId: null, evidence: { kind: "turn", turnId: id, turnNumber: 11, narrationRevision: 0, sourceHash: "a".repeat(64), paragraphId: "p", quote: "Palace" } }];
    d.observationDecisionStatus = [{ observationId: id, state: "retracted", retractionEventId: id, reason: null }];
    expect(sheetUndoOperation(cast(d), change("state.location", null))).toEqual({ kind: "restoreOverride", path: "state.location", value: "Docks" });
  });
  it("requires the exact write receipt for Undo", () => {
    const d = detail(), undo = { kind: "restoreOverride" as const, path: "story.role" as const, value: null };
    expect(sheetMatchesFence(cast(d), fence)).toBe(true);
    expect(sheetUndoRequest(cast(d), undo, fence, "k").body).toEqual({ ...base, clearOverrides: ["story.role"] });
    for (const bad of [{ ...fence, revision: 5 }, { ...fence, characterRevision: 4 }, { ...fence, boundary: { ...fence.boundary, turnNumber: 21 } }, { ...fence, boundary: { ...fence.boundary, timelineRevision: 1 } }]) expect(() => sheetUndoRequest(cast(d), undo, bad, "k")).toThrow();
  });
  it("restores Main Character text and lists with untouched values and the receipt revision", () => {
    const prior = { name: "Mira", profile: characterProfileSchema.parse({ story: { goals: "Escape", role: "Guide" }, identity: { aliases: ["M"] } }), revision: 2 };
    const target = { kind: "main" as const, profile: { ...prior, revision: 3, profile: { ...prior.profile, story: { ...prior.profile.story, goals: "Stay" }, identity: { ...prior.profile.identity, aliases: ["New"] } } } };
    const textUndo = sheetUndoOperation({ kind: "main", profile: prior }, change("story.goals", "Stay"));
    const listUndo = sheetUndoOperation({ kind: "main", profile: prior }, change("identity.aliases", ["New"]));
    expect(sheetUndoRequest(target, textUndo, { kind: "main", revision: 3 }, "k")).toEqual({ endpoint: "profile", body: { name: "Mira", profile: { ...target.profile.profile, story: { ...target.profile.profile.story, goals: "Escape" } }, expectedRevision: 3, editSource: "manual" } });
    expect(sheetUndoRequest(target, listUndo, { kind: "main", revision: 3 }, "k").body).toEqual({ name: "Mira", profile: { ...target.profile.profile, identity: { ...target.profile.profile.identity, aliases: ["M"] } }, expectedRevision: 3, editSource: "manual" });
    expect(() => sheetUndoRequest(target, textUndo, { kind: "main", revision: 2 }, "k")).toThrow();
  });
  it("groups active facts and builds fenced Retraction requests", () => {
    const d = detail(); const fact = (oid: string, value: string, turn: number): CastObservation => ({ id: oid, characterId: id, field: "story.role", value, mode: "fact", speakerCharacterId: null, supersedesObservationId: null, evidence: { kind: "turn", turnId: id, turnNumber: turn, narrationRevision: 0, sourceHash: "a".repeat(64), paragraphId: "p", quote: value } });
    const invalid = fact("invalid", "Invalid", 8); if (invalid.evidence.kind === "turn") invalid.evidence.invalidated = true;
    d.observations = [fact("a", "Guard", 2), fact("b", "Guard", 3), { ...fact("c", "Guide", 4), supersedesObservationId: "old" }, fact("old", "Old", 1), { ...fact("claim", "Claim", 7), mode: "claim" }, invalid, fact("retracted", "Retracted", 9)];
    d.observationDecisionStatus = [...["a", "c"].map(observationId => ({ observationId, state: "eligible" as const, retractionEventId: null, reason: null })), { observationId: "retracted", state: "retracted", retractionEventId: id, reason: null }];
    const f = buildCharacterSheet({ kind: "supporting", detail: d }).sections.flatMap(s => s.fields).find(x => x.path === "story.role")!;
    expect(conflictChoices(f)).toEqual([{ value: "Guide", observationIds: ["c"], latestTurn: 4, quote: "Guide", retractableObservationId: "c" }, { value: "Guard", observationIds: ["a", "b"], latestTurn: 3, quote: "Guard", retractableObservationId: "a" }]);
    expect(retractionRequest(d, "c", "k")).toEqual({ ...base, action: "retract" });
    expect(clearEditLabel(f, "plain")).toBe("Use discovered value");
    expect(clearEditLabel(f, "startingCast")).toBe("Reset to world");
    expect(clearEditLabel({ ...f, path: "state.location" }, "plain")).toBe("Use story value");
    expect(clearEditLabel({ ...f, observations: [] }, "plain")).toBe("Clear my edit");
    expect(clearEditLabel({ ...f, observations: f.observations.filter(item => item.mode === "claim") }, "plain")).toBe("Clear my edit");
  });
  it("limits each field to what its write path accepts", () => {
    expect(castOverrideLimit("story.goals")).toBe(20000); expect(castOverrideLimit("story.role")).toBe(2000);
    expect(sheetFieldLimit(null, "identity.aliases")).toEqual({ maxLength: 200, maxItems: 20 });
    expect(sheetFieldLimit({ kind: "cast", detail: detail() }, "story.role").maxLength).toBe(2000);
    expect(sheetFieldLimit({ kind: "cast", detail: detail() }, "story.goals").maxLength).toBe(20000);
  });
  it("clears a current-state edit saved empty instead of sending an empty override", () => {
    const request = sheetRequest({ kind: "cast", detail: detail() }, { kind: "field", path: "state.location", value: "" }, "k");
    expect(request.body).toMatchObject({ clearOverrides: ["state.location"] }); expect(request.body).not.toHaveProperty("setOverrides");
  });
  it("reads toggle feedback as the new state", () => {
    expect(sheetSavedMessage({ kind: "field", path: "story.role", value: "Guide" }, "Role")).toBe("Saved Role.");
    expect([true, false].map(value => sheetSavedMessage({ kind: "toggle", key: "pinned", value }, ""))).toEqual(["Pinned.", "Unpinned."]);
    expect([true, false].map(value => sheetSavedMessage({ kind: "toggle", key: "ignored", value }, ""))).toEqual(["Ignored.", "No longer ignored."]);
  });
});
