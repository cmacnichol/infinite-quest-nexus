import { describe, expect, it } from "vitest";
import { selectVerifiedNarrativeExcerpt } from "../../packages/domain/src/story-evidence-spans.js";
import { sha256 } from "../../packages/domain/src/text.js";
const certificate = (source: string, text: string) => ({ normalizationVersion: "story-fiction-source-v1" as const, sourceHash: sha256(source), start: source.indexOf(text), end: source.indexOf(text) + text.length });
describe("verified generation excerpts", () => {
  it("retains adjacent negation and quoted lie context and merges overlapping selections", () => {
    const source = 'Earlier scenery. The door was not unlocked. Vale said, "It is open." He was lying. Later scenery.';
    const spans = [certificate(source, 'Vale said'), certificate(source, 'It is open.')];
    const result = selectVerifiedNarrativeExcerpt(source, spans);
    expect(result?.content).toContain('The door was not unlocked.');
    expect(result?.content).toContain('He was lying.');
    expect(result?.spans).toHaveLength(1);
    expect(result?.content).toBe(source.slice(result!.spans[0]!.start, result!.spans[0]!.end));
  });
  it("rejects stale, missing or wrong normalization provenance rather than guessing offsets", () => {
    const source = "A settled fact. A remembered passage. A consequence.";
    expect(selectVerifiedNarrativeExcerpt(source, [{ ...certificate(source, "passage"), sourceHash: "a".repeat(64) }])).toBeNull();
    expect(selectVerifiedNarrativeExcerpt(source, [])).toBeNull();
    expect(selectVerifiedNarrativeExcerpt(source + " Changed.", [certificate(source, "passage")])).toBeNull();
  });
});
