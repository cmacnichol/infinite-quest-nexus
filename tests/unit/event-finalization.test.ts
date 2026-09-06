import { describe, expect, it } from "vitest";
import { parseEventExtension } from "../../packages/story-engine/src/mechanics.js";

describe("event finalization", () => {
  it("rejects the legacy partial extension shape", () => {
    expect(() => parseEventExtension(JSON.stringify({
      additional_text: "A lantern appears.",
      tracker_updates: []
    }), "Mira enters the hall.")).toThrow();
  });

  it("accepts a complete story only when it preserves and extends the main narration", () => {
    const mainNarration = "Mira enters the silent hall.";
    const result = parseEventExtension(JSON.stringify({
      narration: "Mira enters the silent hall.\n\nA lantern blooms beside the sealed door.",
      choices: ["Follow the lantern", "Wait", "Call out", "Leave"],
      custom_action_suggestion: "Study the lantern.",
      image_prompt: "A lantern in a silent hall",
      continuity_summary: "Mira stands in the silent hall beside a lantern.",
      scratchpad: "The lantern appeared beside the sealed door.",
      open_threads: ["Why did the lantern appear?"],
      canonical_facts: [],
      canonical_fact_updates: [],
      superseded_facts: [],
      tracker_updates: []
    }), mainNarration);

    expect(result.narration).toContain("A lantern blooms");
  });

  it("rejects a complete extension that rewrites the validated prefix", () => {
    expect(() => parseEventExtension(JSON.stringify({
      narration: "Mira abandons the hall. A lantern blooms beside the sealed door.",
      choices: ["Follow the lantern", "Wait", "Call out", "Leave"],
      custom_action_suggestion: "Study the lantern.",
      image_prompt: "A lantern in a silent hall",
      continuity_summary: "Mira stands in the silent hall beside a lantern.",
      scratchpad: "The lantern appeared beside the sealed door.",
      open_threads: [], canonical_facts: [], canonical_fact_updates: [], superseded_facts: [], tracker_updates: []
    }), "Mira enters the silent hall.")).toThrow(/rewrote/);
  });
});
