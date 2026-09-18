import { describe, expect, it } from "vitest";
import {
  resolveResponseFormatEligibility,
  selectResponseFormat
} from "../../packages/application/src/providers/response-format.js";

const now = "2026-09-18T12:00:00.000Z";
const record = {
  version: 1 as const,
  providerType: "openrouter" as const,
  endpointIdentity: "endpoint-hash",
  model: "openrouter/model",
  routeConfigHash: "route-hash",
  adapterProtocol: "text-schema-adapter-v1" as const,
  operation: "story" as const,
  schemaHash: "schema-hash",
  streaming: false,
  verifiedAt: "2026-09-17T12:00:00.000Z",
  expiresAt: "2026-09-19T12:00:00.000Z",
  providerRoutingSlugs: [],
  nativeOpenTrackerObjects: true
};

describe("response-format eligibility", () => {
  it("requires both advertisement and an exact current operator record before schema mode", () => {
    const verified = resolveResponseFormatEligibility({
      advertisement: { supportedParameters: ["response_format", "structured_outputs"], discoveredAt: now },
      providerType: "openrouter", endpointIdentity: "endpoint-hash", model: "openrouter/model",
      routeConfigHash: "route-hash", adapterProtocol: "text-schema-adapter-v1", operation: "story",
      schemaHash: "schema-hash", streaming: false, now, verifications: [record]
    });
    expect(verified).toMatchObject({ status: "verified", reason: "verified" });
    expect(selectResponseFormat("auto", verified)).toBe("json_schema");
  });

  it("fails closed for aliases and OpenRouter advertisements without structured-output support", () => {
    const base = { advertisement: { supportedParameters: ["response_format"], discoveredAt: now }, providerType: "openrouter" as const, endpointIdentity: "endpoint-hash", model: "openrouter/model", routeConfigHash: "route-hash", adapterProtocol: "text-schema-adapter-v1" as const, operation: "story" as const, schemaHash: "schema-hash", streaming: false, now, verifications: [] };
    expect(resolveResponseFormatEligibility(base)).toMatchObject({ status: "unsupported", reason: "not_advertised" });
    expect(resolveResponseFormatEligibility({ ...base, model: "@preset", advertisement: null })).toMatchObject({ status: "unknown", reason: "unresolved_model" });
  });

  it("keeps unverified metadata advisory and required policy unavailable", () => {
    const unknown = resolveResponseFormatEligibility({
      advertisement: null, providerType: "openrouter", endpointIdentity: "endpoint-hash", model: "openrouter/model",
      routeConfigHash: "route-hash", adapterProtocol: "text-schema-adapter-v1", operation: "story",
      schemaHash: "schema-hash", streaming: false, now, verifications: []
    });
    expect(unknown).toMatchObject({ status: "unknown", reason: "missing_metadata" });
    expect(selectResponseFormat("auto", unknown)).toBe("json_object");
    expect(selectResponseFormat("required", unknown)).toBe("unavailable");
    expect(selectResponseFormat("legacy", unknown)).toBe("legacy");
  });
});
