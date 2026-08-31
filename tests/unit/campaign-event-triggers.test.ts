import { describe, expect, it } from "vitest";
import { playerEventTriggerSchema } from "../../packages/contracts/src/generation.js";
import { normalizeCampaignEventTriggers } from "../../packages/domain/src/campaign-event-triggers.js";

describe("campaign event trigger compatibility", () => {
  it("preserves a plain-text conditional rule for assessment and execution", () => {
    const rule = "When the gate opens, the keeper greets the traveler.\nKeep the lantern lit.";
    expect(normalizeCampaignEventTriggers([rule])).toEqual([{
      id: "world-event-1", label: "World event 1", timing: "before",
      condition: rule, effect: rule, addTextAfter: false,
      triggeredCount: 0, lastTriggeredTurn: null, lastTriggeredAt: null
    }]);
    expect(playerEventTriggerSchema.array().safeParse(normalizeCampaignEventTriggers([rule])).success).toBe(true);
  });

  it("reserves structured IDs and retains their execution metadata across repeated reads", () => {
    const structured = {
      id: "world-event-1", label: "Keeper", timing: "after", condition: "The gate opens.",
      effect: "The keeper waves.", addTextAfter: true, triggeredCount: 2,
      lastTriggeredTurn: 7, lastTriggeredAt: "2026-08-31T00:00:00Z"
    };
    const source = ["When the bell rings, light the lantern.", structured];
    const result = normalizeCampaignEventTriggers(source);
    expect(result[0]).toMatchObject({ id: "world-event-1-2" });
    expect(result[1]).toEqual(structured);
    expect(normalizeCampaignEventTriggers(result)).toEqual(result);
    expect(source).toEqual(["When the bell rings, light the lantern.", structured]);
  });

  it("does not silently erase unsupported or oversized authored rules", () => {
    const invalid = [null, 42, { condition: "Incomplete rule" }, "", "x".repeat(4001)];
    const result = normalizeCampaignEventTriggers(invalid);
    expect(result).toHaveLength(invalid.length);
    expect(result.slice(0, 3)).toEqual(invalid.slice(0, 3));
    expect(result[4]).toMatchObject({ effect: "x".repeat(4001) });
    expect(playerEventTriggerSchema.array().safeParse(result).success).toBe(false);
    expect(normalizeCampaignEventTriggers([])).toEqual([]);
  });
});
