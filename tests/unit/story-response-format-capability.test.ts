import { describe, expect, it } from "vitest";
import { CURRENT_STORY_RESPONSE_FORMAT_CAPABILITY_IDENTITY } from "../../packages/contracts/src/provider-profile-view.js";
import { isExactStoryResponseFormatCapability } from "../../packages/client-core/src/providers/story-response-format-capability.js";
import { getProviderOutputSchema } from "../../packages/story-engine/src/provider-output-schema.js";

const expected = CURRENT_STORY_RESPONSE_FORMAT_CAPABILITY_IDENTITY;
const future = "2099-01-01T00:00:00.000Z";
function capability(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    model: "vendor/story",
    expectedRegistryDigest: "registry",
    advertisedAt: "2026-09-20T00:00:00.000Z",
    operations: [{
      operation: "story", streaming: true, status: "verified", reason: null,
      schemaVersion: expected.schemaVersion, schemaHash: expected.schemaHash,
      verifiedAt: "2026-09-20T00:00:00.000Z", expiresAt: future,
      ...overrides
    }]
  };
}

describe("exact Story response-format capability", () => {
  it("keeps the browser-safe identity synchronized with the canonical Story schema", () => {
    const story = getProviderOutputSchema("story");
    expect({ schemaVersion: story.version, schemaHash: story.schemaHash }).toEqual(expected);
  });

  it("requires the current schema identity plus matching model, operation, streaming, verification, and expiry", () => {
    const options = { modelId: "vendor/story", streaming: true, isUnexpired: (expiresAt: string) => expiresAt > "2026-09-20T01:00:00.000Z" };
    expect(isExactStoryResponseFormatCapability(capability(), options)).toBe(true);
    for (const changed of [
      { schemaVersion: "story-v1" }, { schemaHash: "a".repeat(64) }, { operation: "choices" },
      { streaming: false }, { status: "unknown" }, { expiresAt: "2026-09-20T00:30:00.000Z" }
    ]) {
      expect(isExactStoryResponseFormatCapability(capability(changed), options)).toBe(false);
    }
    expect(isExactStoryResponseFormatCapability(capability(), { ...options, modelId: "other/model" })).toBe(false);
  });
});
