import { describe, expect, it } from "vitest";
import {
  normalizeCampaignStateSnapshot,
  normalizeCampaignTrackers
} from "../../packages/domain/src/campaign-trackers.js";

describe("campaign tracker normalization", () => {
  it("assigns deterministic IDs to legacy trackers and preserves aliases", () => {
    const input = [
      { name: "Keeper trust", value: "wary", rules: "Update after honest exchanges." },
      { label: "Moon gate", currentValue: "sealed", updateRules: "Change when the lens is lit." }
    ];

    expect(normalizeCampaignTrackers(input)).toEqual([
      {
        id: "Keeper trust",
        name: "Keeper trust",
        value: "wary",
        rules: "Update after honest exchanges."
      },
      {
        id: "Moon gate",
        name: "Moon gate",
        value: "sealed",
        rules: "Change when the lens is lit."
      }
    ]);
    expect(normalizeCampaignTrackers(input)).toEqual(normalizeCampaignTrackers(input));
    expect(input).toEqual([
      { name: "Keeper trust", value: "wary", rules: "Update after honest exchanges." },
      { label: "Moon gate", currentValue: "sealed", updateRules: "Change when the lens is lit." }
    ]);
  });

  it("preserves valid IDs and resolves collisions deterministically", () => {
    expect(normalizeCampaignTrackers([
      { id: "trust", name: "First", value: "", rules: "" },
      { id: "trust", name: "Second", value: "", rules: "" },
      { name: "First", value: "", rules: "" },
      { name: "First", value: "", rules: "" }
    ]).map((tracker) => tracker.id)).toEqual([
      "trust",
      "trust-2",
      "First",
      "First-2"
    ]);
  });

  it("drops malformed rows and enforces contract lengths", () => {
    const trackers = normalizeCampaignTrackers([
      null,
      "not an object",
      { value: "missing a name" },
      {
        id: ` id ${"x".repeat(250)} `,
        title: ` title ${"y".repeat(350)} `,
        value: "v".repeat(10_050),
        rules: "r".repeat(4_050)
      }
    ]);

    expect(trackers).toHaveLength(1);
    expect(trackers[0]).toMatchObject({
      id: expect.any(String),
      name: expect.any(String),
      value: expect.any(String),
      rules: expect.any(String)
    });
    expect(trackers[0]?.id).toHaveLength(200);
    expect(trackers[0]?.name).toHaveLength(300);
    expect(trackers[0]?.value).toHaveLength(10_000);
    expect(trackers[0]?.rules).toHaveLength(4_000);
  });

  it("normalizes only the tracker field in a state snapshot", () => {
    const snapshot = normalizeCampaignStateSnapshot({
      scratchpad: "Keep this.",
      continuitySummary: "Keep this too.",
      trackers: [{ name: "Keeper trust" }]
    });

    expect(snapshot).toEqual({
      scratchpad: "Keep this.",
      continuitySummary: "Keep this too.",
      trackers: [{
        id: "Keeper trust",
        name: "Keeper trust",
        value: "",
        rules: ""
      }]
    });
  });
});
