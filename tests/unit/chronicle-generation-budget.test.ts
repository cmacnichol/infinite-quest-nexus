import { describe, expect, it } from "vitest";
import { generationChronicleRetrievalLimits } from "../../packages/database/src/chronicle-context-repository.js";

describe("generation Chronicle retrieval budget", () => {
  it("scales candidate and fact pools with the provider-safe generation budget", () => {
    expect(generationChronicleRetrievalLimits(32_000)).toEqual({
      perSignal: 16,
      maximumParents: 16,
      maximumParentsPerTurn: 2,
      candidatePool: 512,
      historicalCanonicalFacts: 256,
      canonicalCandidates: 64,
      turnSequenceCoverage: 8,
      turnLexicalCandidates: 96,
      entityCandidates: 64
    });
    expect(generationChronicleRetrievalLimits(128_000)).toEqual({
      perSignal: 64,
      maximumParents: 64,
      maximumParentsPerTurn: 8,
      candidatePool: 2_048,
      historicalCanonicalFacts: 1_024,
      canonicalCandidates: 256,
      turnSequenceCoverage: 32,
      turnLexicalCandidates: 384,
      entityCandidates: 256
    });
    expect(generationChronicleRetrievalLimits(1_000_000)).toEqual({
      perSignal: 512,
      maximumParents: 512,
      maximumParentsPerTurn: 64,
      candidatePool: 16_384,
      historicalCanonicalFacts: 8_192,
      canonicalCandidates: 2_048,
      turnSequenceCoverage: 256,
      turnLexicalCandidates: 3_072,
      entityCandidates: 2_048
    });
    expect(generationChronicleRetrievalLimits(10_000_000)).toEqual(
      generationChronicleRetrievalLimits(1_000_000)
    );
  });
});
