import { describe, expect, it } from "vitest";
import {
  buildCurrentStateUpdate,
  createCampaignContinuityDraft,
  hasCampaignContinuityChanges
} from "../../../packages/client-core/src/index.js";
import { currentStateFixture } from "../../fixtures/current-state-corrections.js";

describe("shared campaign continuity draft", () => {
  it("retains existing fact identity and current-state concurrency fences", () => {
    const base = currentStateFixture();
    const draft = createCampaignContinuityDraft(base);
    draft.scratchpad = "A private corrected detail.";
    const unchangedFactId = base.canonicalFacts[0]!.id;
    const payload = buildCurrentStateUpdate(base, draft);

    expect(draft.openThreads[0]!.key).toBe("thread:0");
    expect(draft.canonicalFacts[0]!.key).toBe(`fact:${unchangedFactId}`);
    expect(payload.canonicalFacts[0]!.id).toBe(unchangedFactId);
    expect(payload.expectedTurnNumber).toBe(base.activeTurnNumber);
    expect(payload.effectiveTurnNumber).toBe(base.activeTurnNumber);
    expect(payload.expectedRevision).toBe(base.revision);
    expect(payload.rpgStats).toEqual(base.rpgStats);
    expect(base.scratchpad).not.toBe(draft.scratchpad);
  });

  it("rejects a historical snapshot instead of retargeting it", () => {
    const base = currentStateFixture();
    const draft = createCampaignContinuityDraft(base);

    expect(() => buildCurrentStateUpdate({
      ...base,
      isCurrent: false,
      viewedTurnNumber: base.activeTurnNumber - 1
    }, draft)).toThrow(/current state/i);
  });

  it("normalizes rows without trimming multiline continuity text", () => {
    const draft = createCampaignContinuityDraft(currentStateFixture());
    draft.continuitySummary = " Summary with edges ";
    draft.scratchpad = " Private\ndetail ";
    draft.openThreads = [
      { key: "thread:first", content: " Find the chart. " },
      { key: "thread:blank", content: "  " },
      { key: "thread:multiline", content: "Follow the light.\nAsk the keeper." }
    ];
    draft.canonicalFacts = [
      { key: "fact:existing", id: "22222222-2222-4222-8222-222222222222", content: " The lens is moon glass. " },
      { key: "fact:new", id: null, content: "New fact.\nIt remains one row." },
      { key: "fact:blank", id: null, content: "\n  " }
    ];

    expect(buildCurrentStateUpdate(currentStateFixture(), draft)).toMatchObject({
      continuitySummary: " Summary with edges ",
      scratchpad: " Private\ndetail ",
      openThreads: ["Find the chart.", "Follow the light.\nAsk the keeper."],
      canonicalFacts: [
        { id: "22222222-2222-4222-8222-222222222222", content: "The lens is moon glass." },
        { id: null, content: "New fact.\nIt remains one row." }
      ]
    });
  });

  it("rejects duplicate retained fact IDs", () => {
    const base = currentStateFixture();
    const draft = createCampaignContinuityDraft(base);
    const fact = draft.canonicalFacts[0]!;
    draft.canonicalFacts.push({ key: "fact:duplicate", id: fact.id, content: "A second row." });

    expect(() => buildCurrentStateUpdate(base, draft)).toThrow(/duplicate.*fact/i);
  });

  it("treats normalized row order and intentional clearing as continuity changes", () => {
    const base = currentStateFixture({
      openThreads: ["First thread.", "Second thread."],
      canonicalFacts: [
        { id: "22222222-2222-4222-8222-222222222222", content: "First fact." },
        { id: "33333333-3333-4333-8333-333333333333", content: "Second fact." }
      ]
    });
    const draft = createCampaignContinuityDraft(base);

    expect(hasCampaignContinuityChanges(base, draft)).toBe(false);
    draft.canonicalFacts.reverse();
    expect(hasCampaignContinuityChanges(base, draft)).toBe(true);
    expect(buildCurrentStateUpdate(base, draft).canonicalFacts.map((fact) => fact.id)).toEqual([
      "33333333-3333-4333-8333-333333333333",
      "22222222-2222-4222-8222-222222222222"
    ]);
    draft.canonicalFacts = [];
    draft.openThreads = [{ key: "thread:blank", content: " " }];
    draft.continuitySummary = "";
    draft.scratchpad = "";
    const payload = buildCurrentStateUpdate(base, draft);

    expect(payload).toMatchObject({
      continuitySummary: "",
      scratchpad: "",
      openThreads: [],
      canonicalFacts: []
    });
  });

  it("keeps the base immutable and accepts an optional tracker override", () => {
    const base = currentStateFixture({
      trackers: [{ id: "trust", name: "Trust", value: "wary", rules: "" }]
    });
    const draft = createCampaignContinuityDraft(base);
    draft.openThreads[0]!.content = "Changed thread.";
    const trackers = [{ id: "trust", name: "Trust", value: "warm", rules: "" }];
    const payload = buildCurrentStateUpdate(base, draft, { trackers });

    expect(base.openThreads).toEqual(["Find the missing harbor chart."]);
    expect(payload.trackers).toEqual(trackers);
    expect(payload.canonicalFacts[0]).not.toHaveProperty("key");
  });
});
