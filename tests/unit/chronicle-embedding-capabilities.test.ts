import { describe, expect, it } from "vitest";
import {
  assertCompleteEmbeddingBatch,
  resolveEmbeddingCapability
} from "../../packages/domain/src/chronicle-embedding-capabilities.js";

describe("Chronicle embedding capabilities", () => {
  it("uses conservative defaults when provider capabilities are unknown", () => {
    const capability = resolveEmbeddingCapability({
      model: "custom-embed-v1",
      contextWindowTokens: 20_000,
      requestTimeoutMs: 12_000,
      configuration: {}
    });

    expect(capability).toMatchObject({
      maxInputTokens: 8_192,
      maxBatchItems: 1,
      maxBatchTokens: 8_192,
      expectedDimensions: null,
      documentPrefix: "",
      queryPrefix: "",
      requestTimeoutMs: 12_000,
      maxRetries: 2
    });
  });

  it("uses only complete, in-range safe configuration overrides", () => {
    const capability = resolveEmbeddingCapability({
      model: "nomic-embed-text-v1.5",
      contextWindowTokens: 40_000,
      requestTimeoutMs: 12_000,
      configuration: {
        embeddingMaxInputTokens: 1_024,
        embeddingMaxBatchItems: 8,
        embeddingMaxBatchTokens: 4_096,
        embeddingDimensions: 768,
        embeddingMaxRetries: 4,
        apiKey: "must-not-project"
      }
    });

    expect(capability).toMatchObject({
      maxInputTokens: 1_024,
      maxBatchItems: 8,
      maxBatchTokens: 4_096,
      expectedDimensions: 768,
      documentPrefix: "search_document: ",
      queryPrefix: "search_query: ",
      maxRetries: 4
    });
    expect(JSON.stringify(capability)).not.toContain("must-not-project");
  });

  it("rejects incomplete responses and vectors with mismatched dimensions", () => {
    const capability = resolveEmbeddingCapability({
      model: "embed-v1",
      contextWindowTokens: 8_192,
      requestTimeoutMs: 12_000,
      configuration: { embeddingDimensions: 3 }
    });

    expect(() => assertCompleteEmbeddingBatch([[0.1, 0.2, 0.3]], 2, capability))
      .toThrow("Embedding response did not include every requested document.");
    expect(() => assertCompleteEmbeddingBatch([[0.1, 0.2], [0.1, 0.2]], 2, capability))
      .toThrow("Embedding response dimensions do not match the configured capability.");
    expect(assertCompleteEmbeddingBatch([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]], 2, capability)).toBe(3);
  });
});
