import { describe, expect, it } from "vitest";
import { mergeSourceFacts, normalizeSourceDocument, sourceDocumentFromNormalizedText } from "../../packages/domain/src/source-authoring.js";
import type { SourceFact } from "../../packages/contracts/src/source-authoring.js";

function fact(overrides: Partial<SourceFact> = {}): SourceFact {
  return {
    id: "source-fact:one",
    kind: "character",
    subject: "Iris",
    predicate: "wears",
    value: "a blue coat",
    provenance: "stated",
    citations: [{ sourceId: "source", paragraphId: "paragraph:0", start: 0, end: 4, quote: "Iris" }],
    ...overrides
  };
}

describe("mergeSourceFacts", () => {
  it("unions exact compatible evidence without fuzzy name merging", () => {
    const blue = fact();
    const blueAgain = fact({ id: "source-fact:two", citations: [blue.citations[0]!, { sourceId: "source", paragraphId: "paragraph:1", start: 5, end: 9, quote: "blue" }] });
    const southIris = fact({ id: "source-fact:three", value: "a red coat", citations: [{ sourceId: "source", paragraphId: "paragraph:2", start: 10, end: 14, quote: "Iris" }] });

    expect(mergeSourceFacts([blue, blueAgain, southIris])).toEqual([
      expect.objectContaining({ subject: "Iris", value: "a blue coat", citations: expect.arrayContaining([blue.citations[0], blueAgain.citations[0]]) }),
      southIris
    ]);
  });

  it("keeps same-name people with distinct cited identities separate", () => {
    const northIris = fact({ value: "lives in North Harbor", citations: [{ sourceId: "source", paragraphId: "paragraph:0", start: 0, end: 4, quote: "Iris" }] });
    const southIris = fact({ value: "lives in South Harbor", citations: [{ sourceId: "source", paragraphId: "paragraph:4", start: 20, end: 24, quote: "Iris" }] });

    expect(mergeSourceFacts([northIris, southIris])).toEqual([northIris, southIris]);
  });

  it("keeps an alias-shaped name separate without explicit shared identity evidence", () => {
    const iris = fact({ subject: "Iris", citations: [{ sourceId: "source", paragraphId: "paragraph:0", start: 0, end: 4, quote: "Iris" }] });
    const mapmaker = fact({ id: "source-fact:alias", subject: "The Mapmaker", citations: [{ sourceId: "source", paragraphId: "paragraph:3", start: 30, end: 42, quote: "The Mapmaker" }] });

    expect(mergeSourceFacts([iris, mapmaker])).toEqual([iris, mapmaker]);
  });

  it("does not merge identical same-name claims without shared exact evidence", () => {
    const northIris = fact({ id: "source-fact:north", citations: [{ sourceId: "source", paragraphId: "paragraph:0", start: 0, end: 4, quote: "Iris" }] });
    const southIris = fact({ id: "source-fact:south", citations: [{ sourceId: "source", paragraphId: "paragraph:9", start: 90, end: 94, quote: "Iris" }] });

    expect(mergeSourceFacts([northIris, southIris])).toEqual([northIris, southIris]);
  });
});

describe("retained normalized source", () => {
  it("does not remove a second BOM while reconstructing persisted source", () => {
    const submitted = normalizeSourceDocument("chapter.txt", "\uFEFF\uFEFFIris crossed the bridge.", "source");
    const restored = sourceDocumentFromNormalizedText("chapter.txt", submitted.text, "source");

    expect(restored).toEqual(submitted);
    expect(restored.text.startsWith("\uFEFF")).toBe(true);
  });
});
