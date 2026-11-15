import { describe, expect, it } from "vitest";
import { activeRetractedObservationIds } from "../../packages/domain/src/campaign-cast-observation-decisions.js";
import { observationDecisionRequestSchema, observationDecisionPreviewSchema, observationDecisionResultSchema } from "../../packages/contracts/src/campaign-cast-observation-decisions.js";
import { castCommandSchema, portableCampaignCastSchema, type CastCommand } from "../../packages/contracts/src/campaign-cast.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const boundary = { turnNumber: 2, timelineRevision: 0 };
const base = { expectedCastRevision: 2, expectedCharacterRevision: 1, expectedBoundary: boundary, idempotencyKey: "one" };

describe("observation decisions", () => {
  it("folds only a restore that references the active retraction", () => {
    const event = (n: number, command: CastCommand) => ({ id: id(n), payload: [{ command }] });
    const retract = { kind: "retract_observation", characterId: id(1), observationId: id(2) } as const;
    const restore = { kind: "restore_observation", characterId: id(1), observationId: id(2), retractionEventId: id(3) } as const;
    expect([...activeRetractedObservationIds([event(3, retract), event(4, restore), event(5, retract), event(6, restore)])]).toEqual([id(2)]);
    expect([...activeRetractedObservationIds([event(3, retract), event(4, restore)])]).toEqual([]);
    expect(castCommandSchema.safeParse(retract).success).toBe(true);
    expect(castCommandSchema.safeParse(restore).success).toBe(true);
  });
  it("requires restore's exact retraction and complete public fences", () => {
    expect(observationDecisionRequestSchema.safeParse({ ...base, action: "retract" }).success).toBe(true);
    expect(observationDecisionRequestSchema.safeParse({ ...base, action: "restore" }).success).toBe(false);
    expect(observationDecisionRequestSchema.safeParse({ ...base, action: "restore", retractionEventId: id(3) }).success).toBe(true);
    expect(observationDecisionRequestSchema.safeParse({ ...base, action: "retract", retractionEventId: id(3) }).success).toBe(false);
    expect(observationDecisionPreviewSchema.safeParse({}).success).toBe(false);
    expect(observationDecisionResultSchema.safeParse({}).success).toBe(false);
  });
});


it("rejects correction commands in all supported old archive formats", () => {
  for (const formatVersion of [1, 2, 3, 4]) {
    const archive = { formatVersion, revision: 1, characters: [{ id: id(1), origin: { kind: "manual" }, firstObservedTurn: 0 }],
      events: [{ id: id(3), effectiveTurnNumber: 0, revision: 1, commands: [{ characterId: id(1), command: { kind: "create", name: "Mara", aliases: [], origin: { kind: "manual" } } }] }] };
    expect(portableCampaignCastSchema.safeParse(archive).success).toBe(true);
    const correction = { command: { kind: "retract_observation", characterId: id(1), observationId: id(2) } };
    expect(portableCampaignCastSchema.safeParse({ ...archive, events: [...archive.events, { id: id(4), effectiveTurnNumber: 0, revision: 2, commands: [correction] }] }).success).toBe(false);
  }
});
