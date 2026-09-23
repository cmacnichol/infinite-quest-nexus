import { describe, expect, it } from "vitest";
import { canSaveCastEditor, createCastEditor, changeCastEditor, setCastEditorField, prepareCastSubmission,
  failCastSubmission, reapplyCastDraft, reapplyNewCastDraft } from "../../packages/client-core/src/campaign-cast-editor.js";

const boundary = { turnNumber: 4, timelineRevision: 1 };
describe("cast editor draft authority", () => {
  it("blocks empty, pristine, saving and conflicted drafts", () => {
    const empty = createCastEditor({ revision: 2, boundary });
    expect(canSaveCastEditor(empty)).toBe(false);
    const named = changeCastEditor(empty, { name: "Mara" });
    expect(canSaveCastEditor(named)).toBe(true);
    expect(canSaveCastEditor({ ...named, saving: true })).toBe(false);
    expect(canSaveCastEditor({ ...named, conflict: true })).toBe(false);
    expect(canSaveCastEditor(changeCastEditor(named, { name: "  " }))).toBe(false);
  });
  it("preserves blank overrides and reuses the exact failed submission until input changes", () => {
    let state = changeCastEditor(createCastEditor({ revision: 2, boundary }), { name: "Mara" });
    state = setCastEditorField(state, "appearance.description", "");
    const first = prepareCastSubmission(state, "first-key");
    expect(first.submission).toEqual({ expectedCastRevision: 2, expectedBoundary: boundary, idempotencyKey: "first-key",
      name: "Mara", aliases: [], profile: { "appearance.description": "" } });
    const failed = failCastSubmission(first, "Network unavailable", false);
    expect(failed.draft.name).toBe("Mara");
    expect(prepareCastSubmission(failed, "ignored-key").submission).toEqual(first.submission);
    const changed = changeCastEditor(failed, { name: "Mara Reed" });
    expect(prepareCastSubmission(changed, "new-key").submission?.idempotencyKey).toBe("new-key");
  });
  it("requires explicit reapplication after conflict and distinguishes reset from blank", () => {
    const detail = { revision: 3, boundary, character: { id: "11111111-1111-4111-8111-111111111111", name: "Mara", aliases: [],
      origin: { kind: "manual" as const }, profile: { "appearance.description": "blue eyes" }, pinned: false, ignored: false,
      revision: 2, firstObservedTurn: 0, lastObservedTurn: 4 }, observations: [], overrides: [], identityEvents: [], unresolvedCandidateIds: [], editorDestination: null };
    let state = setCastEditorField(createCastEditor(detail, detail), "appearance.description", null);
    state = failCastSubmission(prepareCastSubmission(state, "reset"), "Changed elsewhere", true);
    expect(canSaveCastEditor(state)).toBe(false);
    const latest = { ...detail, revision: 5, character: { ...detail.character, revision: 4, name: "Latest name" } };
    state = reapplyCastDraft(state, latest);
    const request = prepareCastSubmission(state, "reapply").submission;
    expect(request).toMatchObject({ expectedCastRevision: 5, expectedCharacterRevision: 4,
      clearOverrides: ["appearance.description"], idempotencyKey: "reapply" });
    expect(request).not.toHaveProperty("setOverrides");
    expect(request).not.toHaveProperty("name");
    expect(createCastEditor(latest, latest).dirty).toBe(false);
  });
  it("reapplies an unsaved new identity against fresh cast authority without discarding its draft", () => {
    const draft = changeCastEditor(createCastEditor({ revision: 1, boundary }), { name: "Mara" });
    const failed = failCastSubmission(prepareCastSubmission(draft, "old"), "Conflict", true);
    const updated = reapplyNewCastDraft(failed, { revision: 4, boundary: { ...boundary, turnNumber: 5 } });
    expect(prepareCastSubmission(updated, "new").submission).toEqual({ expectedCastRevision: 4,
      expectedBoundary: { turnNumber: 5, timelineRevision: 1 }, idempotencyKey: "new", name: "Mara", aliases: [], profile: {} });
  });
});
