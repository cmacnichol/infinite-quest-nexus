import { describe, expect, it } from "vitest";
import {
  applyCampaignTrackerUpdates,
  CampaignTrackerUpdateError,
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

  it("limits normalized output to the runtime contract maximum", () => {
    const input = Array.from({ length: 205 }, (_, index) => ({
      name: `Tracker ${index + 1}`,
      value: String(index + 1)
    }));

    const trackers = normalizeCampaignTrackers(input);

    expect(trackers).toHaveLength(200);
    expect(trackers[199]).toEqual({
      id: "Tracker 200",
      name: "Tracker 200",
      value: "200",
      rules: ""
    });
    expect(input).toHaveLength(205);
  });

  it("uses a non-blank label when name is blank", () => {
    expect(normalizeCampaignTrackers([{
      name: "   ",
      label: " Moon gate ",
      currentValue: "sealed",
      updateRules: "Change when the lens is lit."
    }])).toEqual([{
      id: "Moon gate",
      name: "Moon gate",
      value: "sealed",
      rules: "Change when the lens is lit."
    }]);
  });

  it("falls back to the normalized name when a supplied ID is blank", () => {
    expect(normalizeCampaignTrackers([{
      id: "   ",
      name: " Keeper trust ",
      value: "wary"
    }])).toEqual([{
      id: "Keeper trust",
      name: "Keeper trust",
      value: "wary",
      rules: ""
    }]);
  });

  it("reserves later explicit IDs before assigning derived IDs", () => {
    const input = [
      { name: "trust", value: "derived" },
      { id: "trust", name: "Keeper trust", value: "explicit" }
    ];

    expect(normalizeCampaignTrackers(input)).toEqual([
      { id: "trust-2", name: "trust", value: "derived", rules: "" },
      { id: "trust", name: "Keeper trust", value: "explicit", rules: "" }
    ]);
    expect(input).toEqual([
      { name: "trust", value: "derived" },
      { id: "trust", name: "Keeper trust", value: "explicit" }
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

describe("campaign tracker identity-aware updates", () => {
  it("repairs the audited Location duplicate while preserving its original rules", () => {
    expect(applyCampaignTrackerUpdates(
      [{ id: "location", name: "Location", value: "Harbor", rules: "Track the current place." }],
      [{ name: "Location", value: "Northern gate" }]
    )).toEqual([{
      id: "location",
      name: "Location",
      value: "Northern gate",
      rules: "Track the current place."
    }]);
  });

  it("updates an exact explicit ID, permits a rename, and preserves omitted fields", () => {
    expect(applyCampaignTrackerUpdates(
      [
        { id: "target", name: "Old name", value: "old", rules: "keep" },
        { id: "other", name: "New name", value: "other", rules: "other rules" }
      ],
      [{ id: "target", name: "New name", value: "renamed" }]
    )).toEqual([
      { id: "target", name: "New name", value: "renamed", rules: "keep" },
      { id: "other", name: "New name", value: "other", rules: "other rules" }
    ]);
  });

  it("updates one exact trimmed, case-sensitive display-name match", () => {
    expect(applyCampaignTrackerUpdates(
      [{ id: "trust", name: "Keeper trust", value: "wary", rules: "after talks" }],
      [{ name: " Keeper trust ", currentValue: "open" }]
    )).toEqual([{ id: "trust", name: "Keeper trust", value: "open", rules: "after talks" }]);
    expect(applyCampaignTrackerUpdates(
      [{ id: "trust", name: "Keeper trust", value: "wary", rules: "after talks" }],
      [{ name: "keeper trust", value: "new" }]
    )).toEqual([
      { id: "trust", name: "Keeper trust", value: "wary", rules: "after talks" },
      { id: "keeper trust", name: "keeper trust", value: "new", rules: "" }
    ]);
  });

  it("uses the legacy ID/name tie-break for a duplicate pair", () => {
    expect(applyCampaignTrackerUpdates(
      [
        { id: "location", name: "Location", value: "Harbor", rules: "Track the current place." },
        { id: "Location", name: "Location", value: "Northern gate", rules: "" }
      ],
      [{ name: "Location", value: "Lighthouse" }]
    )).toEqual([
      { id: "location", name: "Location", value: "Harbor", rules: "Track the current place." },
      { id: "Location", name: "Location", value: "Lighthouse", rules: "" }
    ]);
  });

  it("rejects duplicate names without an ID/name tie-break", () => {
    const current = [
      { id: "first", name: "Location", value: "a", rules: "" },
      { id: "second", name: "Location", value: "b", rules: "" }
    ];
    expect(() => applyCampaignTrackerUpdates(current, [{ name: "Location", value: "new" }]))
      .toThrowError(CampaignTrackerUpdateError);
    try {
      applyCampaignTrackerUpdates(current, [{ name: "Location", value: "new" }]);
    } catch (error) {
      expect(error).toMatchObject({ code: "tracker_update_identity_invalid", reason: "ambiguous_name" });
      expect((error as Error).message).not.toContain("Location");
      expect((error as Error).message).not.toContain("new");
    }
  });


  it("does not route a name-only update to an ID when no display name matches", () => {
    expect(applyCampaignTrackerUpdates(
      [{ id: "Location", name: "Place", value: "existing", rules: "keep" }],
      [{ name: "Location", value: "new tracker" }]
    )).toEqual([
      { id: "Location", name: "Place", value: "existing", rules: "keep" },
      { id: "Location-2", name: "Location", value: "new tracker", rules: "" }
    ]);
  });

  it("rejects an unknown explicit ID when its name belongs to an existing tracker", () => {
    expect(() => applyCampaignTrackerUpdates(
      [{ id: "location", name: "Location", value: "Harbor", rules: "keep" }],
      [{ id: "new-id", name: "Location", value: "split state" }]
    )).toThrowError(expect.objectContaining({
      code: "tracker_update_identity_invalid",
      reason: "conflicting_identity"
    }));
  });

  it("creates a new tracker with an unknown explicit ID", () => {
    expect(applyCampaignTrackerUpdates(
      [{ id: "location", name: "Location", value: "Harbor", rules: "keep" }],
      [{ id: "weather", title: "Weather", currentValue: "rain" }]
    )).toEqual([
      { id: "location", name: "Location", value: "Harbor", rules: "keep" },
      { id: "weather", name: "Weather", value: "rain", rules: "" }
    ]);
  });

  it("creates a deterministic name-only tracker and avoids existing ID collisions", () => {
    const current = [{ id: "Weather", name: "Forecast", value: "sun", rules: "keep" }];
    const updates = [{ label: "Weather", value: "rain" }];
    const first = applyCampaignTrackerUpdates(current, updates);
    expect(first).toEqual([
      { id: "Weather", name: "Forecast", value: "sun", rules: "keep" },
      { id: "Weather-2", name: "Weather", value: "rain", rules: "" }
    ]);
    expect(applyCampaignTrackerUpdates(current, updates)).toEqual(first);
  });

  it("uses an ID match as the target when a rename creates duplicate names", () => {
    expect(applyCampaignTrackerUpdates(
      [
        { id: "Location", name: "Old", value: "a", rules: "first" },
        { id: "other", name: "Location", value: "b", rules: "second" }
      ],
      [
        { id: "Location", name: "Location" },
        { name: "Location", value: "tie-break target" }
      ]
    )).toEqual([
      { id: "Location", name: "Location", value: "tie-break target", rules: "first" },
      { id: "other", name: "Location", value: "b", rules: "second" }
    ]);
  });

  it("rejects a later name-only update after a rename creates an unresolvable duplicate", () => {
    expect(() => applyCampaignTrackerUpdates(
      [
        { id: "renamed", name: "Old", value: "a", rules: "first" },
        { id: "other", name: "Location", value: "b", rules: "second" }
      ],
      [
        { id: "renamed", name: "Location" },
        { name: "Location", value: "ambiguous" }
      ]
    )).toThrowError(expect.objectContaining({
      code: "tracker_update_identity_invalid",
      reason: "ambiguous_name"
    }));
  });

  it("applies empty strings to clear fields but treats null and undefined as omitted", () => {
    expect(applyCampaignTrackerUpdates(
      [{ id: "place", name: "Place", value: "Harbor", rules: "track it" }],
      [{ id: "place", value: "", rules: "" }]
    )).toEqual([{ id: "place", name: "Place", value: "", rules: "" }]);
    expect(applyCampaignTrackerUpdates(
      [{ id: "place", name: "Place", value: "Harbor", rules: "track it" }],
      [{ id: "place", name: null, value: null, currentValue: undefined, rules: undefined, updateRules: null }]
    )).toEqual([{ id: "place", name: "Place", value: "Harbor", rules: "track it" }]);
  });

  it("uses nullish alias fallbacks while preserving explicit empty strings", () => {
    expect(applyCampaignTrackerUpdates(
      [{ id: "place", name: "Place", value: "Harbor", rules: "old" }],
      [{ id: "place", value: null, currentValue: "Gate", rules: null, updateRules: "new" }]
    )).toEqual([{ id: "place", name: "Place", value: "Gate", rules: "new" }]);
  });

  it("applies repeated updates in array order and resolves new names against evolving state", () => {
    expect(applyCampaignTrackerUpdates(
      [],
      [
        { name: "Location", value: "Harbor" },
        { name: "Location", currentValue: "Gate" },
        { label: "Weather", value: "rain" },
        { title: "Weather", updateRules: "change at dawn" }
      ]
    )).toEqual([
      { id: "Location", name: "Location", value: "Gate", rules: "" },
      { id: "Weather", name: "Weather", value: "rain", rules: "change at dawn" }
    ]);
  });

  it("resolves name, value, and rules aliases before merging existing state", () => {
    const original = [{ id: "location", name: "Location", value: "Harbor", rules: "Track place." }];
    expect(applyCampaignTrackerUpdates(original, [{ name: "Location", currentValue: "Gate" }])[0]?.value)
      .toBe("Gate");
    expect(applyCampaignTrackerUpdates(original, [{ label: "Location", updateRules: "New rule" }])[0]?.rules)
      .toBe("New rule");
    expect(applyCampaignTrackerUpdates(original, [{ title: "Location", value: "Pier" }])[0]?.value)
      .toBe("Pier");
    expect(applyCampaignTrackerUpdates(original, [{ id: "location", currentValue: "Gate" }])[0]?.value)
      .toBe("Gate");
  });

  it("keeps metadata-only updates inert and materializes only tracker fields", () => {
    const current = [{ id: "location", name: "Location", value: "Harbor", rules: "track" }];
    expect(applyCampaignTrackerUpdates(current, [{ event: "metadata", nested: { secret: "evidence" } }]))
      .toEqual(current);
    expect(applyCampaignTrackerUpdates(current, [{
      id: "location", value: "Gate", nested: { secret: "evidence" }, privateNote: "raw"
    }])).toEqual([{ id: "location", name: "Location", value: "Gate", rules: "track" }]);
  });

  it("normalizes bounded tracker strings and retains the existing 200-tracker cap", () => {
    const current = Array.from({ length: 200 }, (_, index) => ({
      id: `id-${index + 1}`,
      name: `Tracker ${index + 1}`,
      value: "v",
      rules: "r"
    }));
    const capped = applyCampaignTrackerUpdates(current, [
      { name: "Tracker 200", value: "x" },
      { name: "Beyond", value: "ignored" }
    ]);
    expect(capped).toHaveLength(200);
    expect(capped[199]).toEqual({ id: "id-200", name: "Tracker 200", value: "x", rules: "r" });
    expect(capped.some((tracker) => tracker.name === "Beyond")).toBe(false);
    expect(applyCampaignTrackerUpdates(current, [{ name: "Tracker 200", value: "x" }])[199]?.value)
      .toBe("x");
    const long = applyCampaignTrackerUpdates([], [{
      id: ` ${"i".repeat(205)} `,
      title: ` ${"n".repeat(305)} `,
      value: "v".repeat(10_005),
      rules: "r".repeat(4_005)
    }]);
    expect(long[0]?.id).toHaveLength(200);
    expect(long[0]?.name).toHaveLength(300);
    expect(long[0]?.value).toHaveLength(10_000);
    expect(long[0]?.rules).toHaveLength(4_000);
  });

  it("does not mutate current state or update records", () => {
    const current = [{ id: "location", name: "Location", value: "Harbor", rules: "Track place." }];
    const updates = [{ name: "Location", currentValue: "Gate", nested: { secret: "evidence" } }];
    const currentBefore = structuredClone(current);
    const updatesBefore = structuredClone(updates);
    const result = applyCampaignTrackerUpdates(current, updates);
    expect(result).not.toBe(current);
    expect(result[0]).not.toBe(current[0]);
    expect(current).toEqual(currentBefore);
    expect(updates).toEqual(updatesBefore);
  });

  it("normalizes malformed current snapshots without mutating them", () => {
    const malformed = { ignored: true };
    expect(applyCampaignTrackerUpdates(malformed, [{ name: "Location", value: "Harbor" }]))
      .toEqual([{ id: "Location", name: "Location", value: "Harbor", rules: "" }]);
  });
});
