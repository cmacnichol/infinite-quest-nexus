import { describe, expect, it } from "vitest";
import { normalizeSourceDocument } from "../../packages/domain/src/source-authoring.js";
import { assembleSourceWorldProposal, assembleSourceWorldProposalWithEvidence } from "../../packages/domain/src/source-world-proposal.js";

const source = normalizeSourceDocument("chapter.txt", "Iris wears a blue coat.\nThe gate opens at dawn.", "source:chapter");
const iris = {
  id: "fact:iris", kind: "character" as const, subject: "Iris", predicate: "clothing", value: "blue coat", provenance: "stated" as const,
  citations: [{ sourceId: source.id, paragraphId: "paragraph:0", start: 0, end: 22, quote: "Iris wears a blue coat" }]
};
const gate = {
  id: "fact:gate", kind: "event" as const, subject: "The gate", predicate: "opens", value: "at dawn", provenance: "stated" as const,
  citations: [{ sourceId: source.id, paragraphId: "paragraph:0", start: 24, end: 46, quote: "The gate opens at dawn" }]
};

describe("source world proposal", () => {
  it("builds a one-character faithful draft and rejects unsupported generated rules", () => {
    expect(() => assembleSourceWorldProposal({
      source, boundaryParagraphId: "paragraph:0", acceptedFacts: [iris, gate], selectedCharacterFactIds: [iris.id],
      characterIdentityGroups: [{ representativeFactId: iris.id, factIds: [iris.id] }], mode: "faithful"
    }, { fields: [{ path: "world.rules", value: "invented magic system", supportingFactIds: [iris.id] }], characterFields: [] })).toThrow();
    const proposal = assembleSourceWorldProposal({
      source, boundaryParagraphId: "paragraph:0", acceptedFacts: [iris, gate], selectedCharacterFactIds: [iris.id],
      characterIdentityGroups: [{ representativeFactId: iris.id, factIds: [iris.id] }], mode: "faithful"
    }, { fields: [], characterFields: [{ selectedCharacterFactId: iris.id, fields: [{ path: "profile.appearance.clothing", value: "blue coat", supportingFactIds: [iris.id] }] }] });
    expect(proposal.playableCharacters).toHaveLength(1);
    expect(proposal.playableCharacters[0]?.profile?.appearance.clothing).toBe("blue coat");
    expect(proposal.playableCharacters[0]?.profile?.appearance.apparentAge).toBe("");
  });

  it("keeps zero selected characters as lore and leaves unknown appearance blank", () => {
    const proposal = assembleSourceWorldProposal({
      source, boundaryParagraphId: "paragraph:0", acceptedFacts: [iris, gate], selectedCharacterFactIds: [],
      characterIdentityGroups: [{ representativeFactId: iris.id, factIds: [iris.id] }], mode: "faithful"
    }, { fields: [], characterFields: [] });
    expect(proposal.playableCharacters).toHaveLength(0);
    expect(proposal.entities).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Iris" })]));
  });

  it("rejects a mechanics rule from fiction-facing source-world fields", () => {
    const mechanics = {
      id: "fact:mechanics", kind: "rule" as const, subject: "Checks", predicate: "rule", value: "roll d20 + Strength against 15", provenance: "stated" as const,
      citations: [{ sourceId: source.id, paragraphId: "paragraph:0", start: 0, end: 22, quote: "Iris wears a blue coat" }]
    };
    expect(() => assembleSourceWorldProposal({
      source, boundaryParagraphId: "paragraph:0", acceptedFacts: [iris, mechanics], selectedCharacterFactIds: [iris.id],
      characterIdentityGroups: [{ representativeFactId: iris.id, factIds: [iris.id] }], mode: "faithful"
    }, { fields: [{ path: "world.rules", value: mechanics.value, supportingFactIds: [mechanics.id] }], characterFields: [] })).toThrow(/mechanics/u);
  });

  it("keeps expansion-only fields outside canonical content with invented provenance", () => {
    const assembled = assembleSourceWorldProposalWithEvidence({
      source, boundaryParagraphId: "paragraph:0", acceptedFacts: [iris, gate], selectedCharacterFactIds: [iris.id],
      characterIdentityGroups: [{ representativeFactId: iris.id, factIds: [iris.id] }], mode: "expand"
    }, { fields: [], characterFields: [], expansionCandidates: [{ target: "world", path: "world.rules", value: "invented magic system", supportingFactIds: [iris.id] }] });
    expect(assembled.proposal.world.rules).toBe("");
    expect(assembled.expansionCandidates).toEqual([expect.objectContaining({ target: "world", path: "world.rules", value: "invented magic system", provenance: "invented" })]);
  });

  it("rejects expand candidates outside the closed source-world target contract", () => {
    expect(() => assembleSourceWorldProposalWithEvidence({
      source, boundaryParagraphId: "paragraph:0", acceptedFacts: [iris, gate], selectedCharacterFactIds: [iris.id],
      characterIdentityGroups: [{ representativeFactId: iris.id, factIds: [iris.id] }], mode: "expand"
    }, { fields: [], characterFields: [], expansionCandidates: [{ target: "world", path: "world.backgroundStory", value: "An invented backstory", supportingFactIds: [iris.id] }] }))
      .toThrow(/closed source-world target/u);
  });

  it("rejects expand candidates with mismatched targets or another identity's support", () => {
    const south = { ...iris, id: "fact:iris-south", citations: [{ ...iris.citations[0]!, start: 5, end: 22, quote: "wears a blue coat" }] };
    const selection = {
      source, boundaryParagraphId: "paragraph:0", acceptedFacts: [iris, south], selectedCharacterFactIds: [iris.id],
      characterIdentityGroups: [{ representativeFactId: iris.id, factIds: [iris.id] }, { representativeFactId: south.id, factIds: [south.id] }], mode: "expand" as const
    };
    expect(() => assembleSourceWorldProposalWithEvidence(selection, {
      fields: [], characterFields: [], expansionCandidates: [{ target: "world", path: "profile.appearance.clothing", value: "blue coat", supportingFactIds: [iris.id] }]
    })).toThrow(/closed source-world target/u);
    expect(() => assembleSourceWorldProposalWithEvidence(selection, {
      fields: [], characterFields: [], expansionCandidates: [{ target: iris.id, path: "profile.appearance.hair", value: "black hair", supportingFactIds: [south.id] }]
    })).toThrow(/selected identity/u);
  });

  it("keeps mechanical character facts out of deterministic guidance and lore entities", () => {
    const strength = { ...iris, id: "fact:strength", predicate: "strength", value: "18" };
    const check = { ...iris, id: "fact:check", predicate: "check", value: "roll d20 + Strength" };
    const proposal = assembleSourceWorldProposal({
      source, boundaryParagraphId: "paragraph:0", acceptedFacts: [iris, strength, check], selectedCharacterFactIds: [iris.id],
      characterIdentityGroups: [{ representativeFactId: iris.id, factIds: [iris.id, strength.id, check.id] }], mode: "faithful"
    }, { fields: [], characterFields: [] });
    expect(proposal.playableCharacters[0]?.characterText).not.toMatch(/strength|roll|d20|check/u);
    expect(JSON.stringify(proposal.entities)).not.toMatch(/strength|roll|d20|check/u);
  });

  it("keeps canonical armor-class mechanics out of deterministic guidance and entities", () => {
    const armorClass = { ...iris, id: "fact:armor-class", predicate: "armor class", value: "16" };
    const hair = { ...iris, id: "fact:hair", predicate: "hair", value: "armor class: 16" };
    const characterSelection = {
      source, boundaryParagraphId: "paragraph:0", acceptedFacts: [iris, armorClass, hair], selectedCharacterFactIds: [iris.id],
      characterIdentityGroups: [{ representativeFactId: iris.id, factIds: [iris.id, armorClass.id, hair.id] }], mode: "faithful" as const
    };
    const proposal = assembleSourceWorldProposal(characterSelection, { fields: [], characterFields: [] });
    expect(proposal.playableCharacters[0]?.characterText).not.toMatch(/armor class|\b16\b/u);
    expect(JSON.stringify(proposal.entities)).not.toMatch(/armor class|\b16\b/u);
  });

  it("rejects canonical armor-class mechanics from mapped and expansion values", () => {
    const tone = { ...gate, id: "fact:tone", kind: "tone" as const, predicate: "tone", value: "armor class: 16" };
    const hair = { ...iris, id: "fact:hair", predicate: "hair", value: "armor class: 16" };
    const characterSelection = {
      source, boundaryParagraphId: "paragraph:0", acceptedFacts: [iris, hair], selectedCharacterFactIds: [iris.id],
      characterIdentityGroups: [{ representativeFactId: iris.id, factIds: [iris.id, hair.id] }], mode: "faithful" as const
    };
    expect(() => assembleSourceWorldProposal({
      source, boundaryParagraphId: "paragraph:0", acceptedFacts: [iris, tone], selectedCharacterFactIds: [iris.id],
      characterIdentityGroups: [{ representativeFactId: iris.id, factIds: [iris.id] }], mode: "faithful"
    }, { fields: [{ path: "world.tone", value: tone.value, supportingFactIds: [tone.id] }], characterFields: [] }))
      .toThrow(/mechanics/u);
    expect(() => assembleSourceWorldProposal(characterSelection, {
      fields: [], characterFields: [{ selectedCharacterFactId: iris.id, fields: [{ path: "profile.appearance.hair", value: hair.value, supportingFactIds: [hair.id] }] }]
    })).toThrow(/mechanics/u);
    expect(() => assembleSourceWorldProposalWithEvidence({ ...characterSelection, mode: "expand" }, {
      fields: [], characterFields: [], expansionCandidates: [{ target: "world", path: "world.tone", value: tone.value, supportingFactIds: [iris.id] }]
    })).toThrow(/mechanics/u);
    expect(() => assembleSourceWorldProposalWithEvidence({ ...characterSelection, mode: "expand" }, {
      fields: [], characterFields: [], expansionCandidates: [{ target: iris.id, path: "profile.appearance.hair", value: hair.value, supportingFactIds: [iris.id] }]
    })).toThrow(/mechanics/u);
  });

  it("preserves ordinary fictional strength prose that is not a typed mechanic", () => {
    const familyStrength = { ...iris, id: "fact:family-strength", predicate: "temperament", value: "strength comes from family" };
    const proposal = assembleSourceWorldProposal({
      source, boundaryParagraphId: "paragraph:0", acceptedFacts: [iris, familyStrength], selectedCharacterFactIds: [iris.id],
      characterIdentityGroups: [{ representativeFactId: iris.id, factIds: [iris.id, familyStrength.id] }], mode: "faithful"
    }, { fields: [], characterFields: [] });
    expect(proposal.playableCharacters[0]?.characterText).toContain("temperament: strength comes from family");
    expect(proposal.entities).toEqual(expect.arrayContaining([expect.objectContaining({ facts: expect.arrayContaining([expect.objectContaining({ value: "strength comes from family" })]) })]));
  });

  it("rejects a reviewed-looking fact whose citation falls after the selected boundary", () => {
    const bounded = normalizeSourceDocument("bounded.txt", "Iris reaches the gate.\n\nThe gate opens onto Mars.", "source:bounded");
    const earlier = {
      id: "fact:earlier", kind: "character" as const, subject: "Iris", predicate: "clothing", value: "blue coat", provenance: "stated" as const,
      citations: [{ sourceId: bounded.id, paragraphId: "paragraph:0", start: 0, end: 21, quote: "Iris reaches the gate" }]
    };
    const later = {
      id: "fact:later", kind: "event" as const, subject: "The gate", predicate: "opens", value: "onto Mars", provenance: "stated" as const,
      citations: [{ sourceId: bounded.id, paragraphId: "paragraph:1", start: 24, end: 48, quote: "The gate opens onto Mars" }]
    };
    expect(() => assembleSourceWorldProposal({
      source: bounded, boundaryParagraphId: "paragraph:0", acceptedFacts: [earlier, later], selectedCharacterFactIds: [earlier.id],
      characterIdentityGroups: [{ representativeFactId: earlier.id, factIds: [earlier.id] }], mode: "faithful"
    }, { fields: [], characterFields: [] })).toThrow(/evidence inside the selected boundary/u);
  });
});
