import { describe, expect, it } from "vitest";
import { castGenerationSnapshotSchema, castGenerationSnapshotFingerprint } from "../../packages/contracts/src/campaign-cast-context.js";
import { selectCastContext } from "../../packages/domain/src/campaign-cast-context.js";
import { estimateTokens } from "../../packages/domain/src/text.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture() {
  const character = { id: id(1), name: "Mara", aliases: ["The Watcher"], origin: { kind: "discovered" as const },
    profile: { "appearance.description": "blue eyes", "state.location": "the gate" }, pinned: false, ignored: false,
    revision: 2, firstObservedTurn: 1, lastObservedTurn: 4 };
  const evidence = { kind: "turn" as const, turnId: id(10), turnNumber: 4, narrationRevision: 0,
    sourceHash: "a".repeat(64), paragraphId: "p1", quote: "Mara has blue eyes and waits at the gate." };
  return { version: "cast-context-v1" as const, scope: { ownerUserId: id(100), campaignId: id(101) }, worldVersionId: id(102),
    revision: 2, boundary: { turnNumber: 4, timelineRevision: 0 }, coverageStartTurn: 1, trackedThroughTurn: 4,
    discoveryStatus: "current" as const, characters: [character], details: [{ characterId: id(1), overrides: [], observations: [
      { id: id(11), characterId: id(1), field: "appearance.description" as const, value: "blue eyes", mode: "fact" as const,
        speakerCharacterId: null, supersedesObservationId: null, evidence },
      { id: id(12), characterId: id(1), field: "state.location" as const, value: "the gate", mode: "fact" as const,
        speakerCharacterId: null, supersedesObservationId: null, evidence }
    ] }] };
}
const select = (snapshot: unknown, budgetTokens = 3000, direction = "Visit The Watcher") => selectCastContext({
  snapshot: castGenerationSnapshotSchema.parse(snapshot), budgetTokens, direction, currentScene: "", openThreads: []
});

describe("captured cast context", () => {
  it("preserves its fingerprint across JSON persistence of absent optional fields", () => {
    const input = fixture();
    const snapshot = { ...input, details: input.details.map((detail) => ({ ...detail,
      observations: detail.observations.map((observation) => ({ ...observation,
        evidence: { ...observation.evidence, invalidated: undefined } })) })) };
    expect(castGenerationSnapshotFingerprint(snapshot)).toBe(castGenerationSnapshotFingerprint(JSON.parse(JSON.stringify(snapshot))));
  });
  it("keeps the snapshot closed and rejects foreign or duplicate evidence bindings", () => {
    const input = fixture();
    expect(castGenerationSnapshotSchema.safeParse({ ...input, secret: "no" }).success).toBe(false);
    input.details[0]!.observations[0]!.characterId = id(9);
    expect(castGenerationSnapshotSchema.safeParse(input).success).toBe(false);
    const duplicate = fixture(); duplicate.details.push(duplicate.details[0]!);
    expect(castGenerationSnapshotSchema.safeParse(duplicate).success).toBe(false);
    const future = fixture(); future.characters[0]!.lastObservedTurn = 5;
    expect(castGenerationSnapshotSchema.safeParse(future).success).toBe(false);
  });
  it("selects an alias with complete dated fields and exact serialized token accounting", () => {
    const result = select(fixture());
    expect(result.records.map((record) => record.characterId)).toEqual([id(1)]);
    expect(result.records[0]!.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "appearance.description", value: "blue eyes", authority: "observation", evidenceId: id(11) }),
      expect.objectContaining({ field: "state.location", value: "the gate" })
    ]));
    expect(result.content).toContain('"turnNumber":4');
    expect(result.estimatedTokens).toBe(estimateTokens(result.content));
  });
  it("retains user portrayal authority during lag and omits stale dynamic observations", () => {
    const input = fixture();
    const snapshot = { ...input, boundary: { turnNumber: 8, timelineRevision: 0 }, discoveryStatus: "pending", details: [{
      ...input.details[0], overrides: [{ field: "appearance.description", value: "green eyes",
        evidence: { kind: "user", editId: id(20), effectiveTurnNumber: 7 } }]
    }] };
    const result = select(snapshot);
    expect(result.content).toContain("green eyes"); expect(result.content).not.toContain("blue eyes");
    expect(result.content).not.toContain("the gate"); expect(result.content).toContain("historical");
    expect(result.records[0]!.fields[0]).toMatchObject({ authority: "user", evidenceId: id(20) });
    expect(result.omittedFieldCount).toBe(1);
    const stable = select({ ...input, boundary: { turnNumber: 8, timelineRevision: 0 }, discoveryStatus: "pending" });
    expect(stable.content).toContain("blue eyes"); expect(stable.content).not.toContain("the gate");
    const correctedState = select({ ...snapshot, details: [{ ...input.details[0], overrides: [{ field: "state.location", value: "the harbor",
      evidence: { kind: "user", editId: id(21), effectiveTurnNumber: 7 } }] }] });
    expect(correctedState.content).toContain("the harbor"); expect(correctedState.content).not.toContain("the gate");
  });
  it("drops whole fields and records at budget boundaries without restoring overridden values", () => {
    const input = fixture();
    const snapshot = { ...input, details: [{ ...input.details[0], overrides: [{ field: "appearance.description", value: "green ".repeat(300),
      evidence: { kind: "user", editId: id(20), effectiveTurnNumber: 4 } }] }] };
    const result = select(snapshot, 220);
    expect(result.estimatedTokens).toBeLessThanOrEqual(220);
    expect(result.content).not.toContain("blue eyes"); expect(result.content).not.toContain("green");
    expect(result.omittedFieldCount).toBeGreaterThan(0);
    const zero = select(snapshot, 0);
    expect(zero.records).toEqual([]); expect(zero.content).toBe(""); expect(zero.estimatedTokens).toBe(0);
  });
  it("excludes ignored and duplicate protagonist cards and does not resolve a shared alias", () => {
    const input = fixture();
    input.characters.push({ ...input.characters[0]!, id: id(2), name: "Iven" });
    input.details.push({ characterId: id(2), overrides: [], observations: [] });
    expect(select(input).records).toEqual([]);
    input.characters[0]!.ignored = true;
    expect(select(input, 3000, "Mara").records.some((record) => record.characterId === id(1))).toBe(false);
    const hero = fixture();
    expect(select({ ...hero, characters: [{ ...hero.characters[0], origin: { kind: "protagonist", selectedCharacterId: null } }] }).records).toEqual([]);
  });
  it("never asserts claims, invalidated observations, future evidence or unsourced profile fields", () => {
    const input = fixture();
    const snapshot = { ...input, details: [{ ...input.details[0], observations: [
      { ...input.details[0]!.observations[0], mode: "claim", speakerCharacterId: id(1) },
      { ...input.details[0]!.observations[1], evidence: { ...input.details[0]!.observations[1]!.evidence, invalidated: true } }
    ] }] };
    expect(select(snapshot).records[0]!.fields).toEqual([]);
    const future = fixture(); future.details[0]!.observations[0]!.evidence.turnNumber = 5;
    expect(select(future).content).not.toContain("blue eyes");
  });
  it("withdraws dependent supersessions when the supporting source is invalidated", () => {
    const input = fixture();
    const prior = input.details[0]!.observations[0]!;
    const snapshot = { ...input, details: [{ ...input.details[0], observations: [
      { ...prior, evidence: { ...prior.evidence, invalidated: true } },
      { ...prior, id: id(13), value: "green eyes", supersedesObservationId: prior.id }
    ] }] };
    expect(select(snapshot).content).not.toContain("green eyes");
  });
  it("does not turn a previous world's dynamic facts into current state", () => {
    const input = fixture();
    const snapshot = { ...input, details: [{ ...input.details[0], observations: [{ ...input.details[0]!.observations[1],
      evidence: { kind: "historical_world", sourceWorldVersionId: id(99), sourcePath: "/entities/mara/location" }
    }] }] };
    expect(select(snapshot).content).not.toContain("the gate");
  });
  it("prioritizes direct scene references, active threads, pins and recent characters deterministically", () => {
    const input = fixture();
    for (const [number, name, pinned] of [[2, "Iven", true], [3, "Sela", false], [4, "Zeta", false]] as const) {
      input.characters.push({ ...input.characters[0]!, id: id(number), name, aliases: [], pinned });
      input.details.push({ characterId: id(number), observations: [], overrides: [] });
    }
    const result = selectCastContext({ snapshot: castGenerationSnapshotSchema.parse(input), budgetTokens: 3000,
      direction: "Mara", currentScene: "", openThreads: ["Find Sela"] });
    expect(result.records.map((record) => record.characterId)).toEqual([id(1), id(3), id(2), id(4)]);
    expect(selectCastContext({ snapshot: castGenerationSnapshotSchema.parse(input), budgetTokens: 3000,
      direction: "Mara", currentScene: "", openThreads: ["Find Sela"] })).toEqual(result);
  });
});
