import { describe, expect, it } from "vitest";
import { assetListQuerySchema, assetMetadataUpdateSchema } from "../../packages/contracts/src/assets.js";
import { scoreLibraryCandidate } from "../../services/api/src/illustration-resolution-service.js";

describe("image library contracts", () => {
  it("normalizes custom metadata filters and bounded pagination", () => {
    const query = assetListQuerySchema.parse({
      q: "violet arch",
      origin: "generated,imported",
      tags: ["portrait", "night"],
      reviewStatus: "eligible",
      favorite: "true",
      limit: "40"
    });
    expect(query).toMatchObject({
      q: "violet arch",
      origin: ["generated", "imported"],
      tags: ["portrait", "night"],
      reviewStatus: ["eligible"],
      favorite: true,
      archived: false,
      sort: "newest",
      limit: 40
    });
  });

  it("rejects invalid date bounds and unbounded pages", () => {
    expect(assetListQuerySchema.safeParse({ createdFrom: "2026-08-01T00:00:00.000Z", createdTo: "2026-07-01T00:00:00.000Z" }).success).toBe(false);
    expect(assetListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });

  it("requires optimistic concurrency for metadata edits", () => {
    expect(assetMetadataUpdateSchema.safeParse({ title: "No revision" }).success).toBe(false);
    expect(assetMetadataUpdateSchema.safeParse({ expectedRevision: 2 }).success).toBe(false);
    expect(assetMetadataUpdateSchema.parse({ expectedRevision: 2, title: "Moonlit Gate", favorite: true })).toMatchObject({
      expectedRevision: 2,
      title: "Moonlit Gate",
      favorite: true
    });
  });
});

describe("provider-independent library scoring", () => {
  const query = {
    imagePrompt: "Lyra stands beneath a luminous violet stone arch at night",
    entities: ["character:lyra", "location:violet-arch"],
    campaignId: "campaign-1",
    worldId: "world-1"
  };

  it("ranks canonical context and prompt overlap above a loose candidate", () => {
    const exact = scoreLibraryCandidate(query, {
      asset_id: "asset-1",
      title: "Lyra at the violet arch",
      caption: "A moonlit stone gateway",
      tags: ["night", "portrait"],
      fiction_prompt: "Lyra stands beneath a luminous violet stone arch",
      entities: ["character:lyra", "location:violet-arch"],
      characters: [],
      locations: [],
      campaign_id: "campaign-1",
      world_id: "world-1",
      recent_uses: 0
    });
    const loose = scoreLibraryCandidate(query, {
      asset_id: "asset-2",
      title: "Sunny harbor",
      caption: "Empty ships at noon",
      tags: ["day"],
      fiction_prompt: "A bright harbor without characters",
      entities: ["location:harbor"],
      characters: [],
      locations: [],
      campaign_id: null,
      world_id: "world-1",
      recent_uses: 0
    });
    expect(exact.score).toBeGreaterThan(loose.score);
    expect(exact.components.sameCampaign).toBe(true);
    expect(loose.rejectionReasons).toContain("canonical_entity_mismatch");
  });

  it("penalizes repetition without making a result mandatory", () => {
    const base = {
      asset_id: "asset-1", title: "Violet arch", caption: "", tags: [], fiction_prompt: "luminous violet stone arch",
      entities: [], characters: [], locations: [], campaign_id: "campaign-1", world_id: "world-1"
    };
    expect(scoreLibraryCandidate(query, { ...base, recent_uses: 0 }).score)
      .toBeGreaterThan(scoreLibraryCandidate(query, { ...base, recent_uses: 3 }).score);
  });
});
