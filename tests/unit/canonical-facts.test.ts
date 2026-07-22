import { describe, expect, it } from "vitest";
import {
  buildCanonicalFactProjection,
  canonicalFactDeduplicationKey,
  createCanonicalFactId,
  normalizeCanonicalFactContent
} from "../../packages/domain/src/canonical-facts.js";

describe("canonical fact projection", () => {
  const seed = {
    campaignId: "campaign-1",
    sourceTurnId: "turn-7",
    factIndex: 2,
    content: "Mara guards the eastern gate."
  };

  it("normalizes compatibility characters and presentation whitespace", () => {
    expect(normalizeCanonicalFactContent("  Mara\u00a0guards\r\n the  eastern gate.  ")).toBe(
      "Mara guards the eastern gate."
    );
    expect(normalizeCanonicalFactContent("The key weighs １２ pounds.")).toBe("The key weighs 12 pounds.");
  });

  it("creates stable RFC-compatible UUIDs", () => {
    const id = createCanonicalFactId(seed);

    expect(createCanonicalFactId({ ...seed })).toBe(id);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(createCanonicalFactId({ ...seed, content: "  Mara guards the eastern gate.  " })).toBe(id);
  });

  it("changes identity when any authoritative identity component changes", () => {
    const id = createCanonicalFactId(seed);

    expect(createCanonicalFactId({ ...seed, campaignId: "campaign-2" })).not.toBe(id);
    expect(createCanonicalFactId({ ...seed, sourceTurnId: "turn-8" })).not.toBe(id);
    expect(createCanonicalFactId({ ...seed, factIndex: 3 })).not.toBe(id);
    expect(createCanonicalFactId({ ...seed, content: "Mara guards the western gate." })).not.toBe(id);
  });

  it("builds a deterministic projection and removes equivalent duplicates", () => {
    const projections = buildCanonicalFactProjection([
      seed,
      { ...seed, factIndex: 3, content: " mara  guards the eastern gate. " },
      { ...seed, factIndex: 4, content: "The bridge is closed." },
      { ...seed, factIndex: 5, content: " \n " }
    ]);

    expect(projections).toHaveLength(2);
    expect(projections[0]).toEqual({
      ...seed,
      id: createCanonicalFactId(seed),
      normalizedContent: seed.content,
      deduplicationKey: "mara guards the eastern gate."
    });
    expect(projections[1]?.content).toBe("The bridge is closed.");
  });

  it("keeps punctuation-distinct statements separate to avoid semantic over-deduplication", () => {
    expect(canonicalFactDeduplicationKey("The gate is open.")).not.toBe(
      canonicalFactDeduplicationKey("The gate is open?")
    );
  });
});
