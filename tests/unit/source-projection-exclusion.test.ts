import { describe, expect, it } from "vitest";
import { normalizeSourceDocument } from "../../packages/domain/src/source-authoring.js";
import { canonicalizeWorldContent } from "../../packages/contracts/src/world-library.js";
import { buildPlayableCharacterGenerationPrompt } from "../../packages/domain/src/character-authoring.js";
import { buildBriefIllustrationStoryContext, buildIllustrationRefinementInput } from "../../services/runtime/src/illustration-segment-job-adapter.js";
import { characterProfileOrganizerInput, characterProfileOrganizerRepairInput, characterProfileOrganizerSources } from "../../services/runtime/src/provider-character-organization-adapter.js";

const raw = "APPENDIX_ONLY_RAW_SOURCE_SENTINEL";
const source = normalizeSourceDocument("chapter.txt", raw, "source:sentinel");
const fact = { id: "fact:canon", kind: "tone" as const, subject: "World", predicate: "tone", value: "ACCEPTED_CANON_MARKER", provenance: "stated" as const, citations: [{ sourceId: source.id, paragraphId: "paragraph:0", start: 0, end: raw.length, quote: raw }] };
const content = canonicalizeWorldContent({ schemaVersion: 6, world: { title: "World", genre: "", tone: "ACCEPTED_CANON_MARKER", premise: "", backgroundStory: "", firstAction: "", rules: "" }, playableCharacters: [], sourceMaterial: { version: 1, documents: [source], boundary: { sourceId: source.id, paragraphId: "paragraph:0" }, acceptedFacts: [fact], fieldEvidence: [] } });

describe("source appendix projection exclusion", () => {
  it("omits appendix-only raw source from character, organizer, and illustration requests while retaining canon", () => {
    const character = buildPlayableCharacterGenerationPrompt(content, "ACCEPTED_CANON_MARKER");
    const sources = characterProfileOrganizerSources({ id: "iris", name: "Iris", characterText: "", rpgStats: [], defaultTriggers: [], source: {} }, content);
    const organizer = characterProfileOrganizerInput("Iris", sources);
    const repair = characterProfileOrganizerRepairInput("Iris", sources, {}, []);
    const brief = buildBriefIllustrationStoryContext({ worldContent: content, campaignTitle: "", characterSnapshot: null, previousNarration: "ACCEPTED_CANON_MARKER" });
    const refinement = buildIllustrationRefinementInput("ACCEPTED_CANON_MARKER", brief);
    for (const value of [character.input, JSON.stringify(organizer), JSON.stringify(repair), brief, refinement]) {
      expect(value).not.toContain(raw);
      expect(value).toContain("ACCEPTED_CANON_MARKER");
    }
  });
});
