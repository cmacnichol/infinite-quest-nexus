import { describe, expect, it } from "vitest";
import { buildCharacterSheet } from "../../packages/client-core/src/characters/sheet.js";
import { characterProfileSchema, type CastDetail, type CastObservation } from "../../packages/contracts/src/index.js";

const id = "10000000-0000-4000-8000-000000000001";
const fact = (id: string, field: CastObservation["field"], value: string, turn: number, supersedesObservationId: string | null = null): CastObservation => ({ id, characterId: id, field, value, mode: "fact", speakerCharacterId: null, supersedesObservationId, evidence: { kind: "turn", turnId: id, turnNumber: turn, narrationRevision: 0, sourceHash: "a".repeat(64), paragraphId: "p", quote: value } });
const detail = (): CastDetail => ({ character: { id, name: "Mira", aliases: [], origin: { kind: "manual" }, profile: {}, revision: 1, pinned: false, ignored: false, firstObservedTurn: 0, lastObservedTurn: 0, lastMentionedTurn: null }, revision: 1, boundary: { turnNumber: 20, timelineRevision: 0 }, observations: [], overrides: [], identityEvents: [], autoMatches: [], unresolvedCandidateIds: [], editorDestination: null });
const field = (d: CastDetail, path: string) => buildCharacterSheet({ kind: "supporting", detail: d }).sections.flatMap(s => s.fields).find(f => f.path === path)!;
const edit = (path: "state.location" | "story.role") => ({ field: path, value: "Jones", evidence: { kind: "user" as const, editId: id, effectiveTurnNumber: 12 } });
const status = (observationId: string, state: "eligible" | "retracted" | "read_only") => ({ observationId, state, retractionEventId: null, reason: null });

describe("sheet provenance", () => {
  it("tracks State Edit replacement and retraction without reviving superseded history", () => {
    const d = detail(), old = fact("old", "state.location", "Jones", 13), newer = fact("new", "state.location", "Smith", 20, "old");
    d.overrides = [edit("state.location")]; d.character.profile["state.location"] = "Smith"; d.observations = [old, newer]; d.observationDecisionStatus = [status("old", "eligible"), status("new", "eligible")];
    expect(field(d, "state.location")).toMatchObject({ origin: "observed", observedTurn: 20, replacedEditTurn: 12, retractable: { id: "new" } });
    d.observationDecisionStatus[1] = status("new", "retracted"); d.character.profile["state.location"] = "Jones";
    expect(field(d, "state.location")).toMatchObject({ origin: "user", editTurn: 12, retractable: null, observations: [] });
  });
  it("uses latest active equal fact and shows only eligible actions", () => {
    const d = detail(); d.character.profile["story.role"] = "Smith";
    d.observations = [fact("a", "story.role", "Smith", 10), fact("b", "story.role", "Smith", 20), fact("c", "story.role", "Smith", 21)];
    d.observationDecisionStatus = [status("a", "eligible"), status("b", "read_only"), status("c", "retracted")];
    expect(field(d, "story.role")).toMatchObject({ observedTurn: 20, retractable: null, retractableObservationIds: ["a"] });
  });
  it("shows a later disagreement under a Correction and filters conflict choices", () => {
    const d = detail(); d.overrides = [edit("story.role")]; d.character.profile["story.role"] = "Jones";
    d.observations = [fact("a", "story.role", "Smith", 20), fact("b", "story.role", "Other", 21)]; d.observationDecisionStatus = [status("a", "eligible"), status("b", "retracted")];
    expect(field(d, "story.role")).toMatchObject({ origin: "user", editTurn: 12, storyDiffers: { value: "Smith", turn: 20 } });
    d.overrides = []; delete d.character.profile["story.role"]; d.observationDecisionStatus[1] = status("b", "eligible");
    expect(field(d, "story.role")).toMatchObject({ origin: "conflicted", retractable: null, retractableObservationIds: ["a", "b"] });
  });
  it("uses the full Starting Cast profile and authored edit history", () => {
    const d = detail(), profile = characterProfileSchema.parse({ story: { role: "Guide" } });
    d.character.originProfile = { seedEventId: id, worldVersionId: id, entityId: "mira", rosterName: "Mira", rosterAliases: [], legacyCharacterText: "", profile, evidence: { kind: "world", worldVersionId: id, sourcePath: "/x" } };
    d.character.campaignProfile = profile; d.character.fieldSources = { "story.role": "campaign_edit" }; d.character.profile["story.role"] = "Guide";
    d.authoredHistory = [{ eventId: id, seedEventId: id, effectiveTurnNumber: 12, set: { "story.role": "Guide" }, reset: [] }]; d.observations = [fact("a", "story.role", "Smith", 20)];
    expect(field(d, "story.role")).toMatchObject({ origin: "user", editTurn: 12, storyDiffers: null });
    expect(field(d, "appearance.eyes")).toBeDefined();
  });
  it("shows later differing story under a Starting Cast non-fixed Correction", () => {
    const d = detail(), profile = characterProfileSchema.parse({});
    d.character.originProfile = { seedEventId: id, worldVersionId: id, entityId: "mira", rosterName: "Mira", rosterAliases: [], legacyCharacterText: "", profile, evidence: { kind: "world", worldVersionId: id, sourcePath: "/x" } };
    d.character.campaignProfile = profile; d.character.profile["appearance.description"] = "Cloaked";
    d.overrides = [{ field: "appearance.description", value: "Cloaked", evidence: { kind: "user", editId: id, effectiveTurnNumber: 12 } }];
    d.observations = [fact("a", "appearance.description", "Armored", 20)];
    expect(field(d, "appearance.description")).toMatchObject({ origin: "user", storyDiffers: { value: "Armored", turn: 20 } });
  });
  it("leaves Main Character provenance empty", () => {
    const profile = { name: "Mira", profile: characterProfileSchema.parse({}) } as any;
    for (const f of buildCharacterSheet({ kind: "protagonist", profile, revision: 1 }).sections.flatMap(s => s.fields)) expect(f).toMatchObject({ editTurn: null, observedTurn: null, replacedEditTurn: null, storyDiffers: null, retractable: null, retractableObservationIds: [] });
  });
});
