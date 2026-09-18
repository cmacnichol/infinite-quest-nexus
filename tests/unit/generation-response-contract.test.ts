import { describe, expect, it } from "vitest";
import { getProviderOutputSchema } from "../../packages/story-engine/src/provider-output-schema.js";
import { resolveGenerationResponseContracts } from "../../services/runtime/src/generation-response-contract.js";

const hash = "a".repeat(64);
const profile = {
  id: "11111111-1111-4111-8111-111111111111",
  providerType: "openrouter" as const,
  model: "structured-model",
  endpointIdentity: "endpoint-a",
  configurationHash: hash
};

describe("resolveGenerationResponseContracts", () => {
  it("selects mixed schema and json-object contracts from verified per-operation evidence", () => {
    const story = getProviderOutputSchema("story");
    const selection = resolveGenerationResponseContracts({
      queuedPolicy: {
        version: 1, policy: "auto", providerProfileId: profile.id, model: profile.model,
        endpointIdentity: profile.endpointIdentity, providerConfigurationHash: hash,
        verificationRegistryHash: "b".repeat(64), operationClosureVersion: 1,
        invocationKeys: ["story:nonstream", "choices:nonstream"]
      },
      profile,
      registryDigest: "b".repeat(64),
      eligible: (operation, streaming) => operation === "story" && !streaming
        ? { status: "verified", reason: "verified", verification: {
          version: 1, providerType: "openrouter", endpointIdentity: profile.endpointIdentity, model: profile.model,
          routeConfigHash: hash, adapterProtocol: "text-schema-adapter-v1", operation,
          schemaHash: story.schemaHash, streaming, verifiedAt: "2026-09-01T00:00:00.000Z",
          expiresAt: "2026-10-01T00:00:00.000Z", providerRoutingSlugs: ["openai/gpt-4.1"], nativeOpenTrackerObjects: true
        } }
        : { status: "advertised", reason: "missing_verification", verification: null }
    });

    expect(selection.contracts["story:nonstream"]).toMatchObject({ mode: "json_schema", operation: "story", streaming: false, schemaHash: story.schemaHash });
    expect(selection.contracts["choices:nonstream"]).toEqual({ version: 1, mode: "json_object", operation: "choices", streaming: false, forbidFormatFallback: true });
    expect(selection.selectionHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails required policy before dispatch when capability evidence is unavailable", () => {
    expect(() => resolveGenerationResponseContracts({
      queuedPolicy: {
        version: 1, policy: "required", providerProfileId: profile.id, model: profile.model,
        endpointIdentity: profile.endpointIdentity, providerConfigurationHash: hash,
        verificationRegistryHash: "b".repeat(64), operationClosureVersion: 1,
        invocationKeys: ["story:nonstream"]
      },
      profile,
      registryDigest: "b".repeat(64),
      eligible: () => ({ status: "unknown", reason: "discovery_unavailable", verification: null })
    })).toThrow(/required response contract is unavailable/i);
  });

  it("rejects native adapter enrollment before a text call", () => {
    expect(() => resolveGenerationResponseContracts({
      queuedPolicy: {
        version: 1, policy: "auto", providerProfileId: profile.id, model: profile.model,
        endpointIdentity: profile.endpointIdentity, providerConfigurationHash: hash,
        verificationRegistryHash: "b".repeat(64), operationClosureVersion: 1,
        invocationKeys: ["story:nonstream"]
      },
      profile: { ...profile, providerType: "lm_studio" }, registryDigest: "b".repeat(64),
      eligible: () => ({ status: "unknown", reason: "discovery_unavailable", verification: null })
    })).toThrow(/does not support response contracts/i);
  });
});
