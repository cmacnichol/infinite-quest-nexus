import { describe, expect, it } from "vitest";
import {
  projectChroniclePublicError,
  requireCampaignWorldVersionScope
} from "../../packages/application/src/memory/index.js";
import {
  buildAcceptedTurnFictionMemory,
  buildCanonicalChronicleFacts,
  buildChronicleEntityCatalog,
  embeddingEligibility,
  modelAwareEmbeddingPrefixes,
  providerModelFingerprint,
  sanitizeChronicleFictionValue,
  sanitizeChronicleMemoryLines
} from "../../packages/domain/src/index.js";

const scope = {
  ownerUserId: "owner-1",
  campaignId: "campaign-1",
  worldVersionId: "world-version-1"
} as const;

describe("Chronicle helper parity", () => {
  it("requires the campaign row to match the direct caller's campaign and world-version scope", () => {
    const row = { id: scope.campaignId, world_version_id: scope.worldVersionId, title: "Campaign" };

    expect(requireCampaignWorldVersionScope(scope, row)).toBe(row);
    for (const candidate of [{ ...row, world_version_id: "other-version" }, undefined]) {
      try {
        requireCampaignWorldVersionScope(scope, candidate);
        throw new Error("test fixture did not reject the mismatched campaign scope");
      } catch (error) {
        expect(error).toMatchObject({ message: "Campaign not found.", statusCode: 404 });
      }
    }
  });

  it("builds fiction only for accepted turns and excludes private or mechanics-bearing input", () => {
    expect(buildAcceptedTurnFictionMemory({ accepted: false, action: "Private action", narration: "Private narration" }, 3))
      .toBeNull();

    const memory = buildAcceptedTurnFictionMemory({
      accepted: true,
      action: "Open the archive after rolling 31.",
      narration: "The sealed archive opens.",
      scratchpadPrivate: "never persist this",
      diagnostics: "hidden diagnostic"
    }, 3);

    expect(memory?.content).toContain("The sealed archive opens.");
    expect(memory?.content).not.toMatch(/rolling 31|never persist|diagnostic/i);
  });

  it("sanitizes memory values and builds canonical facts with the pinned entity catalogue", () => {
    const catalog = buildChronicleEntityCatalog({
      worldContent: { entities: [{ id: "archive", name: "Amber Archive", aliases: ["archive"] }] },
      characterSnapshot: { id: "hero", name: "Mira" }
    });
    const value = sanitizeChronicleFictionValue({
      safe: "The archive opens.",
      diceResult: 31,
      privateReasoning: "omit"
    });
    const facts = buildCanonicalChronicleFacts({
      campaignId: scope.campaignId,
      turnId: "turn-1",
      canonicalFacts: ["Amber Archive is now open.", "amber archive is now open."],
      entityCatalog: catalog
    });

    expect(value).toEqual({ safe: "The archive opens." });
    expect(sanitizeChronicleMemoryLines(["The archive opens.", "The archive opens.", "The skill check rolled 12."]))
      .toEqual(["The archive opens."]);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      content: "Amber Archive is now open.",
      entities: ["Amber Archive"],
      entityIds: ["world:archive"]
    });
  });

  it("removes bracketed roll and check directives from derived fiction strings", () => {
    expect(sanitizeChronicleMemoryLines([
      "The Moon Warden wakes. [[ROLL 1d20=20]]",
      "Find the silver key. [CHECK dexterity]"
    ])).toEqual([
      "The Moon Warden wakes.",
      "Find the silver key."
    ]);
    expect(buildAcceptedTurnFictionMemory({
      accepted: true,
      action: "Open the gate. [[ROLL 1d20=20]]",
      narration: "The gate opens. [CHECK dexterity]"
    }, 4)?.content).toBe("Turn 4\nPlayer action: Open the gate.\nNarration: The gate opens.");
  });

  it("shares embedding eligibility, stable provider fingerprints, and fixed safe error projections with direct ports", () => {
    expect(embeddingEligibility({ enabled: true, providerProfileId: "embedding-1", model: "nomic-embed-text" })).toEqual({ eligible: true });
    expect(embeddingEligibility({ enabled: true, providerProfileId: null, model: "nomic-embed-text" }))
      .toEqual({ eligible: false, reason: "provider_not_configured" });
    expect(modelAwareEmbeddingPrefixes("nomic-embed-text", null, null)).toMatchObject({
      documentPrefix: "search_document: ",
      queryPrefix: "search_query: ",
      automatic: true
    });
    expect(providerModelFingerprint({
      providerType: "openai-compatible",
      baseUrl: "http://embeddings.example/v1///",
      model: "nomic-embed-text",
      configuration: { dimensions: 768 }
    }, modelAwareEmbeddingPrefixes("nomic-embed-text", null, null)))
      .toBe(providerModelFingerprint({
        providerType: "openai-compatible",
        baseUrl: "http://embeddings.example/v1",
        model: "nomic-embed-text",
        configuration: { dimensions: 768 }
      }, modelAwareEmbeddingPrefixes("nomic-embed-text", null, null)));
    expect(projectChroniclePublicError(new Error("token=super-secret http://internal.example"))).toEqual({
      code: "memory_unavailable",
      message: "Chronicle memory is unavailable."
    });
  });
});
