import { describe, expect, it } from "vitest";
import {
  archiveManifestV1Schema,
  archiveManifestV2Schema,
  archiveManifestSchema,
  portableAcceptedGenerationPolicyProvenanceSchema
} from "../../packages/contracts/src/index.js";

const campaignId = "11111111-1111-4111-8111-111111111111";
const worldId = "22222222-2222-4222-8222-222222222222";
const worldVersionId = "33333333-3333-4333-8333-333333333333";
const foreignCampaignId = "44444444-4444-4444-8444-444444444444";
const assetId = "55555555-5555-4555-8555-555555555555";
const secondAssetId = "66666666-6666-4666-8666-666666666666";
const hash = "a".repeat(64);
const secondHash = "b".repeat(64);

const campaignPayloads = [
  { kind: "campaign", path: "campaign.json", formatVersion: 4 },
  { kind: "world", path: "world.json", formatVersion: 1 },
  { kind: "chronicle", path: "chronicle.json", formatVersion: 1 },
  { kind: "assets", path: "assets/assets.json", formatVersion: 1 }
] as const;

const manifestV2 = {
  format: "infinite-quest-archive",
  formatVersion: 2,
  archiveType: "campaign",
  createdAt: "2026-09-09T12:00:00.000Z",
  contentFingerprint: hash,
  campaignId,
  worldId,
  worldVersionId,
  entries: campaignPayloads.map((payload) => ({
    path: payload.path,
    logicalType: payload.kind,
    mediaType: "application/json",
    byteLength: 10,
    sha256: hash
  })),
  payloads: campaignPayloads,
  assets: []
};

const asset = {
  sourceAssetId: assetId,
  contentHash: hash,
  archivePath: "assets/original.png",
  mimeType: "image/png",
  byteLength: 128,
  pixelWidth: 16,
  pixelHeight: 8,
  technicalMetadata: {},
  library: {
    title: "Moonlit gate",
    caption: "A quiet gate.",
    notes: "Portable fixture.",
    tags: ["gate"],
    origin: "generated",
    reviewStatus: "eligible",
    reuseScope: "campaign",
    automaticReuseEnabled: true,
    contentCategories: ["fantasy"],
    favorite: false,
    archivedAt: null
  },
  createdAt: "2026-09-09T12:00:00.000Z",
  bindings: [{ role: "campaign_asset", campaignId }]
};

describe("portable accepted generation-policy provenance", () => {
  it.each([
    null,
    { version: 1, playMode: "legacy", turnControlStyle: "action_only", protocolVersion: null },
    { version: 1, playMode: "legacy", turnControlStyle: "flexible_action", protocolVersion: null },
    { version: 1, playMode: "story_only", turnControlStyle: "flexible_scene", protocolVersion: "story-only-v1" }
  ])("accepts historical null or a known version-one policy record", (provenance) => {
    expect(portableAcceptedGenerationPolicyProvenanceSchema.safeParse(provenance).success).toBe(true);
  });

  it.each([
    {},
    { version: 1, playMode: "legacy", turnControlStyle: "flexible_scene", protocolVersion: null },
    { version: 1, playMode: "story_only", turnControlStyle: "flexible_scene", protocolVersion: null },
    { version: 1, playMode: "story_only", turnControlStyle: "flexible_scene", protocolVersion: "story-only-v2" },
    { version: 2, playMode: "legacy", turnControlStyle: "action_only", protocolVersion: null },
    { version: 1, playMode: "legacy", turnControlStyle: "action_only", protocolVersion: null, prompt: "private" }
  ])("rejects incomplete, inconsistent, unknown, and extended policy records", (provenance) => {
    expect(portableAcceptedGenerationPolicyProvenanceSchema.safeParse(provenance).success).toBe(false);
  });
});

describe("version-two campaign manifest portability", () => {
  it("accepts a valid v2 campaign manifest while the immutable v1 reader rejects it", () => {
    expect(archiveManifestV2Schema.safeParse(manifestV2).success).toBe(true);
    expect(archiveManifestSchema.safeParse(manifestV2).success).toBe(true);
    expect(archiveManifestV1Schema.safeParse(manifestV2).success).toBe(false);
  });

  it("requires campaign payload version four in a v2 campaign manifest", () => {
    expect(archiveManifestV2Schema.safeParse({
      ...manifestV2,
      payloads: [{ ...campaignPayloads[0], formatVersion: 3 }, ...campaignPayloads.slice(1)]
    }).success).toBe(false);
  });

  it("retains v1 path, declaration, and campaign payload-set safeguards", () => {
    const duplicateNormalizedEntry = {
      ...manifestV2,
      entries: [
        ...manifestV2.entries,
        { ...manifestV2.entries[0], path: "Campaign.json" }
      ]
    };
    const undeclaredPayload = {
      ...manifestV2,
      payloads: [...manifestV2.payloads, { kind: "records", path: "records.json", formatVersion: 1 }]
    };
    const incompletePayloadSet = {
      ...manifestV2,
      payloads: manifestV2.payloads.slice(0, 3)
    };

    expect(archiveManifestV2Schema.safeParse(duplicateNormalizedEntry).success).toBe(false);
    expect(archiveManifestV2Schema.safeParse(undeclaredPayload).success).toBe(false);
    expect(archiveManifestV2Schema.safeParse(incompletePayloadSet).success).toBe(false);
  });

  it("retains v1 asset declaration, metadata, hash-path, and campaign-scope safeguards", () => {
    const withAsset = {
      ...manifestV2,
      entries: [...manifestV2.entries, {
        path: asset.archivePath,
        logicalType: "asset_original",
        mediaType: asset.mimeType,
        byteLength: asset.byteLength,
        sha256: asset.contentHash
      }],
      assets: [asset]
    };
    const undeclaredAsset = { ...withAsset, assets: [{ ...asset, archivePath: "assets/missing.png" }] };
    const conflictingMetadata = {
      ...withAsset,
      assets: [asset, { ...asset, sourceAssetId: secondAssetId, archivePath: "Assets/Original.png", byteLength: 129 }]
    };
    const conflictingHashPath = {
      ...withAsset,
      entries: [...withAsset.entries, { ...withAsset.entries[4], path: "assets/copy.png" }],
      assets: [asset, { ...asset, sourceAssetId: secondAssetId, archivePath: "assets/copy.png" }]
    };
    const foreignBinding = {
      ...withAsset,
      assets: [{ ...asset, bindings: [{ role: "campaign_asset", campaignId: foreignCampaignId }] }]
    };

    expect(archiveManifestV2Schema.safeParse(undeclaredAsset).success).toBe(false);
    expect(archiveManifestV2Schema.safeParse(conflictingMetadata).success).toBe(false);
    expect(archiveManifestV2Schema.safeParse(conflictingHashPath).success).toBe(false);
    expect(archiveManifestV2Schema.safeParse(foreignBinding).success).toBe(false);
  });
});
