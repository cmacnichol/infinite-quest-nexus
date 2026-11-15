import { describe, expect, it } from "vitest";
import { playableCharacterSchema } from "@infinite-quest/contracts";
import { stageEditorOrganize } from "../../packages/client-core/src/characters/editor-model.js";
import { createWorldFormSession } from "../../apps/web/src/character-editor/world-form-session.js";
const fixture = () => playableCharacterSchema.parse({ id: "mira", name: "Mira", profile: { story: { role: "Guide" }, appearance: { hair: "Silver", extension: { raw: true } } }, source: { nested: { imported: true } }, rpgStats: [{ id: "s", skill: "Resolve", score: 12, covers: "Fear", extension: [1] }], defaultTriggers: [{ id: "t", label: "Oil", initialValue: "old", updateRules: "At night", extension: true }] });
describe("world form session", () => {
  it("retains unknown story extensions without counting them as authored guidance", () => {
    const original = playableCharacterSchema.parse({ id: "extension", name: "Mira", profile: { story: { extension: "import marker" } } });
    const session = createWorldFormSession(original);
    expect(() => session.projectForCommit()).toThrow("at least one story detail");
    const capture = session.read(); capture.campaignUse = "supporting"; session.capture(capture);
    expect(session.projectForCommit().profile!.story.extension).toBe("import marker");
  });
  it("retains hidden generated profile, source and untouched mechanics exactly", () => {
    const original = fixture(); const session = createWorldFormSession(original);
    const capture = session.read(); capture.campaignUse = "supporting"; session.capture(capture);
    const result = session.projectForCommit();
    expect(result.profile!.appearance).toEqual(original.profile!.appearance);
    expect(result.source).toEqual({ nested: { imported: true } });
    expect(result.rpgStats).toEqual(original.rpgStats); expect(result.defaultTriggers).toEqual(original.defaultTriggers);
  });
  it("keeps edited mechanics through Supporting and retains raw invalid input until commit", () => {
    const session = createWorldFormSession(fixture()); const capture = session.read();
    capture.statRows[0]!.value = "55"; capture.trackerRows[0]!.value = "edited"; capture.campaignUse = "supporting"; session.capture(capture);
    expect(session.projectForCommit().rpgStats[0]).toMatchObject({ id: "s", value: 55, extension: [1] });
    expect(session.projectForCommit().defaultTriggers[0]).toMatchObject({ id: "t", value: "edited" });
    capture.statRows[0]!.value = "1e"; session.capture(capture);
    expect(session.read().statRows[0]!.value).toBe("1e"); expect(() => session.projectForCommit()).toThrow("whole number");
  });
  it("restores exact removal position and replaces the single undo slot", () => {
    const session = createWorldFormSession(fixture()); const capture = session.read();
    capture.statRows.push({ ...capture.statRows[0]!, rowId: "second", name: "Second" }); session.capture(capture);
    session.removeMechanic("stat", capture.statRows[0]!.rowId); expect(session.undoRemoval()).toBe(true);
    expect(session.read()).toEqual(capture);
    session.removeMechanic("stat", capture.statRows[0]!.rowId); session.removeMechanic("tracker", capture.trackerRows[0]!.rowId);
    session.undoRemoval(); expect(session.read().statRows).toHaveLength(1); expect(session.undoRemoval()).toBe(false);
  });
  it("retains selected Organize provenance and allocates identity once", () => {
    const session = createWorldFormSession(null); const capture = session.read(); capture.name = "New";
    capture.profileDraft = stageEditorOrganize(capture.profileDraft, { "story.role": "Guide" }, "organizer-v2"); session.capture(capture);
    expect(session.read().profileDraft.acceptedOrganize).toMatchObject({ paths: ["story.role"], protocolVersion: "organizer-v2" });
    const applied = session.projectForCommit(); expect(session.projectForCommit().id).toBe(applied.id);
    session.markApplied(applied); expect(session.read().profileDraft.changedPaths).toEqual([]); expect(session.undoRemoval()).toBe(false);
  });
  it("isolates captured snapshots and preserves new mechanic IDs across retries without UI keys", () => {
    const session = createWorldFormSession(fixture()); const capture = session.read();
    capture.statRows.push({ rowId: "new-row", name: "Focus", value: "30", note: "", original: null }); session.capture(capture);
    capture.name = "External mutation";
    const first = session.projectForCommit(); const second = session.projectForCommit();
    expect(first.name).toBe("Mira"); expect(first.rpgStats[1]).toEqual(second.rpgStats[1]);
    expect(first.rpgStats[1]).not.toHaveProperty("rowId"); expect(first.rpgStats[1]).not.toHaveProperty("original");
  });
});
