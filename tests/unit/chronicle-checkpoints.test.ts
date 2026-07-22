import { describe, expect, it } from "vitest";
import {
  buildChronicleCheckpoint,
  chronicleCheckpointSourceHash,
  parseChronicleCheckpoint,
  validateChronicleCheckpoint
} from "../../packages/domain/src/chronicle-checkpoints.js";

const sourceSnapshot = {
  continuitySummary: "Aster reached the observatory.",
  canonicalFacts: ["The brass key opens the eastern door."],
  supersededFacts: ["The eastern door was sealed."],
  canonicalFactUpdates: [{
    content: "The eastern door now stands open.",
    supersedesFactIds: ["fact-old"]
  }],
  openThreads: ["Who lit the observatory beacon?"],
  scratchpad: "Never store this private note.",
  trackers: { suspicion: 9 },
  mechanics: { result: 17 }
};

const factProjection = [{
  id: "fact-new",
  sourceTurnId: "turn-eight",
  sourceTurnNumber: 8,
  sourceFactIndex: 0,
  content: "The eastern door now stands open.",
  normalizedContent: "the eastern door now stands open.",
  entities: ["Eastern Door"],
  entityIds: ["door-east"],
  validFromTurn: 8,
  validUntilTurn: null,
  supersededByFactId: null,
  metadata: { generatedFromAcceptedTurn: true }
}];

describe("Chronicle checkpoint payloads", () => {
  it("builds and validates a versioned v2 fiction checkpoint", () => {
    const checkpoint = buildChronicleCheckpoint({
      throughTurn: 8,
      sourceSnapshot,
      continuitySummary: sourceSnapshot.continuitySummary,
      openThreads: sourceSnapshot.openThreads,
      factProjection
    });

    expect(checkpoint.schemaVersion).toBe(2);
    expect(checkpoint.factProjection).toEqual(factProjection);
    expect(validateChronicleCheckpoint(checkpoint, 8, sourceSnapshot)).toBe(true);
    expect(parseChronicleCheckpoint(checkpoint)).toEqual(checkpoint);
  });

  it("hashes only the turn number and allowlisted fiction-derived snapshot fields", () => {
    const original = chronicleCheckpointSourceHash(8, sourceSnapshot);
    const privateStateChanged = chronicleCheckpointSourceHash(8, {
      ...sourceSnapshot,
      scratchpad: "A different private note.",
      trackers: { suspicion: 100 },
      mechanics: { result: 1 }
    });
    const fictionChanged = chronicleCheckpointSourceHash(8, {
      ...sourceSnapshot,
      openThreads: ["The beacon mystery was resolved."]
    });

    expect(privateStateChanged).toBe(original);
    expect(fictionChanged).not.toBe(original);
    expect(chronicleCheckpointSourceHash(7, sourceSnapshot)).not.toBe(original);
  });

  it("rejects a checkpoint against a different accepted snapshot or turn", () => {
    const checkpoint = buildChronicleCheckpoint({
      throughTurn: 8,
      sourceSnapshot,
      continuitySummary: sourceSnapshot.continuitySummary,
      openThreads: sourceSnapshot.openThreads
    });
    expect(validateChronicleCheckpoint(checkpoint, 7, sourceSnapshot)).toBe(false);
    expect(validateChronicleCheckpoint(checkpoint, 8, {
      ...sourceSnapshot,
      canonicalFacts: ["The brass key was destroyed."]
    })).toBe(false);
    expect(validateChronicleCheckpoint({ ...checkpoint, continuitySummary: "A forged summary." }, 8, sourceSnapshot)).toBe(false);
  });

  it("reads the historical unversioned v1 summary body", () => {
    const parsed = parseChronicleCheckpoint({ summary: "Aster reached the observatory." }, 8);
    expect(parsed).toEqual({
      schemaVersion: 1,
      throughTurn: 8,
      sourceSnapshotHash: null,
      continuitySummary: "Aster reached the observatory.",
      openThreads: [],
      factProjection: []
    });
    expect(validateChronicleCheckpoint({ summary: "Aster reached the observatory." }, 8, sourceSnapshot)).toBe(true);
  });

  it("does not permit private state or mechanics in v2 content", () => {
    expect(() => buildChronicleCheckpoint({
      throughTurn: 8,
      sourceSnapshot,
      continuitySummary: "The skill check rolled 17.",
      openThreads: sourceSnapshot.openThreads
    })).toThrow(/mechanics or engine-only language/);

    expect(() => buildChronicleCheckpoint({
      throughTurn: 8,
      sourceSnapshot,
      continuitySummary: sourceSnapshot.continuitySummary,
      openThreads: sourceSnapshot.openThreads,
      factProjection: [{ ...factProjection[0]!, metadata: { scratchpad: "private" } }]
    })).toThrow(/private campaign state/);
  });
});
