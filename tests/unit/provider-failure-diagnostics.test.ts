import { describe, expect, it } from "vitest";
import { providerFailureEvidenceSchema, providerFailureProjectionSchema, projectProviderFailureEvidence, projectProviderFailure, projectGenerationFailureDiagnostic } from "../../packages/contracts/src/index.js";

const evidence = {
  version: 1, source: "http_error", observedAt: "2026-10-03T14:00:00.000Z", httpStatus: 429,
  upstreamStatus: 429, reason: "rate_limit", limitSource: "upstream_provider", upstreamCode: "rate_limit_exceeded",
  providerName: "Known Provider", retryAfterMs: 86400000, retryAt: "2026-10-04T14:00:00.000Z",
  rateLimit: { limit: 10, remaining: 0, resetAt: null }, successfulResponseStarted: false, emittedOutput: false, metadataStatus: "recognized"
};

describe("bounded provider failure evidence", () => {
  it("round trips recognized evidence and selects only public fields", () => {
    expect(providerFailureEvidenceSchema.parse(evidence)).toEqual(evidence);
    expect(projectProviderFailureEvidence(evidence)).toEqual(evidence);
    expect(projectProviderFailure(evidence)).toEqual({ version: 1, source: "http_error", httpStatus: 429,
      upstreamStatus: 429, reason: "rate_limit", limitSource: "upstream_provider", retryAfterMs: 86400000, retryAt: evidence.retryAt });
    expect(providerFailureProjectionSchema.safeParse(projectProviderFailure(evidence)).success).toBe(true);
  });
  it("drops unknown fields including nested raw, secret and prompt canaries", () => {
    const dirty = { ...evidence, raw: "PRIVATE_CANARY", secret: "PRIVATE_CANARY", prompt: "PRIVATE_CANARY",
      rateLimit: { ...evidence.rateLimit, raw: "PRIVATE_CANARY" } };
    expect(providerFailureEvidenceSchema.safeParse(dirty).success).toBe(false);
    expect(projectProviderFailureEvidence(dirty)).toEqual(evidence);
    expect(JSON.stringify(projectProviderFailure(dirty))).not.toContain("PRIVATE_CANARY");
  });
  it("includes only safe evidence in the fixed public rate-limit message", () => {
    const result = projectGenerationFailureDiagnostic({ version: 1, category: "provider_rejection", code: "provider_rate_limited",
      phase: "story_generation", attemptNumber: 1, occurredAt: evidence.observedAt, providerFailure: { ...evidence, raw: "PRIVATE_CANARY" } });
    expect(result).toEqual({ code: "provider_rate_limited", message: "The provider rate limit was reached. Wait before retrying.",
      providerFailure: projectProviderFailure(evidence) });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_CANARY|Known Provider|upstreamCode|rateLimit/);
  });
  it("bounds serialized UTF-8 evidence and rejects unsafe counters", () => {
    expect(providerFailureEvidenceSchema.safeParse({ ...evidence, observedAt: `2026-10-03T14:00:00.${"0".repeat(4096)}Z` }).success).toBe(false);
    expect(projectProviderFailureEvidence({ ...evidence, rateLimit: { limit: Number.MAX_SAFE_INTEGER + 1, remaining: 0, resetAt: null } })).toBeNull();
    expect(providerFailureProjectionSchema.safeParse({ ...projectProviderFailure(evidence), raw: "PRIVATE_CANARY" }).success).toBe(false);
  });
  it("requires retry timestamps to match observed time plus delay, including nulls", () => {
    expect(projectProviderFailureEvidence({ ...evidence, retryAfterMs: 0 })).toBeNull();
    expect(projectProviderFailureEvidence({ ...evidence, retryAt: null })).toBeNull();
    expect(projectProviderFailureEvidence({ ...evidence, retryAfterMs: null })).toBeNull();
    expect(projectProviderFailureEvidence({ ...evidence, retryAfterMs: null, retryAt: null })).not.toBeNull();
    expect(projectProviderFailureEvidence({ ...evidence, retryAfterMs: 0, retryAt: evidence.observedAt })).not.toBeNull();
    expect(projectProviderFailure({ ...evidence, retryAfterMs: null })).toBeNull();
  });
  it("rejects oversized public timestamps directly and drops them from optional diagnostics", () => {
    const oversized = { ...projectProviderFailure(evidence), retryAt: `2026-10-04T14:00:00.${"0".repeat(4096)}Z` };
    expect(providerFailureProjectionSchema.safeParse(oversized).success).toBe(false);
    expect(projectProviderFailure(oversized)).toBeNull();
  });
  it("rejects unknown versions and vocabulary", () => {
    expect(projectProviderFailure({ ...evidence, version: 2 })).toBeNull();
    expect(projectProviderFailureEvidence({ ...evidence, upstreamCode: "PRIVATE_CANARY" })).toBeNull();
    expect(projectProviderFailure({ ...evidence, reason: "PRIVATE_CANARY" })).toBeNull();
  });
  it("accepts zero and 24 hours while rejecting overflow and unsafe numbers", () => {
    expect(projectProviderFailureEvidence({ ...evidence, retryAfterMs: 0, retryAt: evidence.observedAt })).not.toBeNull();
    for (const retryAfterMs of [-1, 86400001, Infinity, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(projectProviderFailureEvidence({ ...evidence, retryAfterMs })).toBeNull();
    }
    expect(projectProviderFailureEvidence({ ...evidence, providerName: "x".repeat(4097) })).toBeNull();
    expect(projectProviderFailureEvidence({ ...evidence, httpStatus: 600 })).toBeNull();
    expect(projectProviderFailureEvidence({ ...evidence, observedAt: "2026-10-03T14:00:00+01:00" })).toBeNull();
  });
});
