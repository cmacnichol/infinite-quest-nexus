import { describe, expect, it } from "vitest";
import {
  chronicleRetrievalAuditSchema,
  parseStoredChronicleRetrievalAudit,
  type ChronicleRetrievalAudit
} from "../../packages/contracts/src/memory.js";
import type { ChronicleContextPreview } from "../../packages/application/src/memory/types.js";
import {
  DEDICATED_CHUNKED_AUDIT,
  LEXICAL_NO_PROVIDER_AUDIT,
  TEXT_FALLBACK_LEGACY_AUDIT
} from "../fixtures/chronicle-retrieval-audits.js";

const requiredChronicleRetrieval: ChronicleRetrievalAudit = null as unknown as ChronicleContextPreview["chronicleRetrieval"];
void requiredChronicleRetrieval;

describe("Chronicle retrieval audit contract", () => {
  it("parses every valid observed audit fixture", () => {
    expect(chronicleRetrievalAuditSchema.parse(DEDICATED_CHUNKED_AUDIT)).toEqual(DEDICATED_CHUNKED_AUDIT);
    expect(chronicleRetrievalAuditSchema.parse(TEXT_FALLBACK_LEGACY_AUDIT)).toEqual(TEXT_FALLBACK_LEGACY_AUDIT);
    expect(chronicleRetrievalAuditSchema.parse(LEXICAL_NO_PROVIDER_AUDIT)).toEqual(LEXICAL_NO_PROVIDER_AUDIT);
  });

  it("treats historical, malformed, and imported values as unknown", () => {
    expect(parseStoredChronicleRetrievalAudit(undefined)).toBeNull();
    expect(parseStoredChronicleRetrievalAudit({ auditVersion: "old" })).toBeNull();
    expect(parseStoredChronicleRetrievalAudit({
      ...DEDICATED_CHUNKED_AUDIT,
      provider: { ...DEDICATED_CHUNKED_AUDIT.provider, model: "https://provider.example/v1?apiKey=secret" }
    })).toBeNull();
  });

  it("treats endpoint-shaped provider labels as unknown", () => {
    for (const field of ["providerType", "model"] as const) {
      expect(parseStoredChronicleRetrievalAudit({
        ...DEDICATED_CHUNKED_AUDIT,
        provider: { ...DEDICATED_CHUNKED_AUDIT.provider, [field]: "https://provider.example/v1" }
      })).toBeNull();
    }
  });

  it("accepts existing model identifiers while normalizing bounded safe labels", () => {
    const validModels = [
      "openai/text-embedding-3-large",
      "nomic-ai/nomic-embed-text-v1.5@f32",
      "provider model + revision 2026"
    ];
    for (const model of validModels) {
      expect(chronicleRetrievalAuditSchema.parse({
        ...DEDICATED_CHUNKED_AUDIT,
        provider: { ...DEDICATED_CHUNKED_AUDIT.provider, model }
      }).provider.model).toBe(model);
    }
    expect(chronicleRetrievalAuditSchema.parse({
      ...DEDICATED_CHUNKED_AUDIT,
      provider: { ...DEDICATED_CHUNKED_AUDIT.provider, model: "  local/model + revision@f32  " }
    }).provider.model).toBe("local/model + revision@f32");
    expect(chronicleRetrievalAuditSchema.safeParse({
      ...DEDICATED_CHUNKED_AUDIT,
      provider: { ...DEDICATED_CHUNKED_AUDIT.provider, model: "m".repeat(500) }
    }).success).toBe(true);
  });

  it("rejects unsafe model-label boundaries without relaxing other audit fields", () => {
    for (const model of ["", "   ", "m".repeat(501), "model\nname", "https://provider.example/v1"] as const) {
      expect(chronicleRetrievalAuditSchema.safeParse({
        ...DEDICATED_CHUNKED_AUDIT,
        provider: { ...DEDICATED_CHUNKED_AUDIT.provider, model }
      }).success).toBe(false);
    }
  });

  it("rejects IP and scheme-relative endpoint model labels", () => {
    for (const model of [
      "127.0.0.1:8080/v1",
      "[::1]:8080/v1",
      "//provider.example/v1",
      "//127.0.0.1:8080/v1"
    ] as const) {
      expect(chronicleRetrievalAuditSchema.safeParse({
        ...DEDICATED_CHUNKED_AUDIT,
        provider: { ...DEDICATED_CHUNKED_AUDIT.provider, model }
      }).success).toBe(false);
    }
  });

  it("derives query vector path exactly from live requests and cache hits", () => {
    expect(() => chronicleRetrievalAuditSchema.parse({
      ...DEDICATED_CHUNKED_AUDIT,
      queryVectorPath: "cache_only",
      queryEmbeddingRequests: 1,
      queryCacheHits: 0
    })).toThrow();
    expect(() => chronicleRetrievalAuditSchema.parse({
      ...DEDICATED_CHUNKED_AUDIT,
      queryVectorPath: "none",
      queryEmbeddingRequests: 0,
      queryCacheHits: 1
    })).toThrow();
  });

  it("rejects contradictory provider and call-outcome states", () => {
    expect(() => chronicleRetrievalAuditSchema.parse({
      ...LEXICAL_NO_PROVIDER_AUDIT,
      providerCallOutcome: "succeeded",
      queryEmbeddingRequests: 1,
      queryVectorPath: "provider_only"
    })).toThrow();
    expect(() => chronicleRetrievalAuditSchema.parse({
      ...TEXT_FALLBACK_LEGACY_AUDIT,
      providerCallOutcome: "not_attempted",
      queryEmbeddingRequests: 0,
      queryVectorPath: "none"
    })).toThrow();
    expect(() => chronicleRetrievalAuditSchema.parse({
      ...TEXT_FALLBACK_LEGACY_AUDIT,
      providerCallOutcome: "failed",
      effectiveMode: "semantic_hybrid"
    })).toThrow();
  });

  it("requires usable provider provenance for semantic retrieval", () => {
    expect(() => chronicleRetrievalAuditSchema.parse({
      ...LEXICAL_NO_PROVIDER_AUDIT,
      effectiveMode: "semantic_hybrid"
    })).toThrow();
    expect(() => chronicleRetrievalAuditSchema.parse({
      ...TEXT_FALLBACK_LEGACY_AUDIT,
      providerCallOutcome: "failed",
      effectiveMode: "lexical_only"
    })).not.toThrow();
    expect(() => chronicleRetrievalAuditSchema.parse({
      ...DEDICATED_CHUNKED_AUDIT,
      providerCallOutcome: "not_attempted",
      queryEmbeddingRequests: 0,
      queryCacheHits: 1,
      queryVectorPath: "cache_only"
    })).not.toThrow();
  });
});
