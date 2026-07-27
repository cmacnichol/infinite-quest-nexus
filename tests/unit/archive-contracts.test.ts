import { describe, expect, it } from "vitest";
import {
  archiveAssetRecordSchema,
  archiveManifestSchema,
  archivePathSchema,
  calculateContentFingerprint,
  campaignArchivePreviewResponseSchema,
  canonicalArchiveJson,
  sanitizePortableMetadata
} from "../../packages/contracts/src/archives.js";

const campaignId = "11111111-1111-4111-8111-111111111111";
const worldId = "22222222-2222-4222-8222-222222222222";
const worldVersionId = "33333333-3333-4333-8333-333333333333";
const turnId = "44444444-4444-4444-8444-444444444444";
const assetId = "55555555-5555-4555-8555-555555555555";
const secondAssetId = "66666666-6666-4666-8666-666666666666";
const hash = "a".repeat(64);
const secondHash = "b".repeat(64);

const validAsset = {
  sourceAssetId: assetId,
  contentHash: hash,
  archivePath: "assets/original.png",
  mimeType: "image/png",
  byteLength: 128,
  pixelWidth: 16,
  pixelHeight: 8,
  technicalMetadata: { camera: "portable" },
  library: {
    title: "Moonlit Gate",
    caption: "A gate under moonlight.",
    notes: "Keep the original image.",
    tags: ["gate", "moon"],
    origin: "generated",
    reviewStatus: "eligible",
    reuseScope: "campaign",
    automaticReuseEnabled: true,
    contentCategories: ["fantasy"],
    favorite: false,
    archivedAt: null
  },
  createdAt: "2026-07-26T12:00:00.000Z",
  bindings: [{ role: "campaign_asset", campaignId }]
};

const validManifest = {
  format: "infinite-quest-archive",
  formatVersion: 1,
  archiveType: "campaign",
  createdAt: "2026-07-26T12:00:00.000Z",
  contentFingerprint: hash,
  campaignId,
  worldId,
  worldVersionId,
  entries: [
    { path: "campaign.json", logicalType: "campaign", mediaType: "application/json", byteLength: 10, sha256: hash },
    { path: "world.json", logicalType: "world", mediaType: "application/json", byteLength: 10, sha256: hash },
    { path: "chronicle.json", logicalType: "chronicle", mediaType: "application/json", byteLength: 10, sha256: hash },
    { path: "assets/assets.json", logicalType: "assets", mediaType: "application/json", byteLength: 10, sha256: hash },
    { path: "assets/original.png", logicalType: "asset_original", mediaType: "image/png", byteLength: 128, sha256: hash }
  ],
  payloads: [
    { kind: "campaign", path: "campaign.json", formatVersion: 1 },
    { kind: "world", path: "world.json", formatVersion: 1 },
    { kind: "chronicle", path: "chronicle.json", formatVersion: 1 },
    { kind: "assets", path: "assets/assets.json", formatVersion: 1 }
  ],
  assets: [validAsset]
};

const validPreview = {
  valid: true,
  archiveType: "campaign",
  formatVersion: 1,
  contentFingerprint: hash,
  campaign: {
    title: "The Moonlit Gate",
    sourceCampaignId: campaignId,
    acceptedTurnCount: 3,
    activeTurnNumber: 3,
    selectedCharacter: { id: "hero", name: "Aster" }
  },
  world: {
    title: "Moonlit Realms",
    sourceWorldId: worldId,
    sourceWorldVersionId: worldVersionId,
    versionNumber: 2
  },
  chronicle: { memoryCount: 4, summaryCount: 1 },
  assets: { originalCount: 1, totalBytes: 128 },
  destination: { kind: "embedded", operation: "create_world", worldId: null, worldVersionId: null },
  providerDataIncluded: false,
  warnings: [],
  previewToken: "p".repeat(40),
  expiresAt: "2026-07-26T13:00:00.000Z"
};

describe("portable archive contracts", () => {
  it("accepts a valid version-one campaign manifest", () => {
    expect(archiveManifestSchema.parse(validManifest)).toMatchObject(validManifest);
  });

  it("rejects unknown version-one root fields", () => {
    expect(archiveManifestSchema.safeParse({ ...validManifest, unexpected: true }).success).toBe(false);
  });

  it("rejects uppercase entry checksums and unsupported format versions", () => {
    expect(archiveManifestSchema.safeParse({
      ...validManifest,
      entries: [{ ...validManifest.entries[0], sha256: "A".repeat(64) }, ...validManifest.entries.slice(1)]
    }).success).toBe(false);
    expect(archiveManifestSchema.safeParse({ ...validManifest, formatVersion: 2 }).success).toBe(false);
  });

  it("rejects duplicate normalized entries, missing payload entries, and manifest entries", () => {
    expect(archiveManifestSchema.safeParse({
      ...validManifest,
      entries: [
        ...validManifest.entries,
        { path: "Assets/Cafe\u0301.png", logicalType: "asset_original", mediaType: "image/png", byteLength: 1, sha256: hash },
        { path: "assets/Café.png", logicalType: "asset_original", mediaType: "image/png", byteLength: 1, sha256: hash }
      ]
    }).success).toBe(false);
    expect(archiveManifestSchema.safeParse({
      ...validManifest,
      payloads: [{ kind: "campaign", path: "missing.json", formatVersion: 1 }, ...validManifest.payloads.slice(1)]
    }).success).toBe(false);
    expect(archiveManifestSchema.safeParse({
      ...validManifest,
      entries: [...validManifest.entries, { path: "manifest.json", logicalType: "manifest", mediaType: "application/json", byteLength: 1, sha256: hash }]
    }).success).toBe(false);
  });

  it("requires the complete campaign payload set and campaign-scoped asset bindings", () => {
    expect(archiveManifestSchema.safeParse({ ...validManifest, payloads: validManifest.payloads.slice(0, 3) }).success).toBe(false);
    expect(archiveManifestSchema.safeParse({
      ...validManifest,
      assets: [{ ...validAsset, bindings: [{ role: "turn_illustration", campaignId: "66666666-6666-4666-8666-666666666666", turnId }] }]
    }).success).toBe(false);
  });

  it("requires every asset archive path to be declared as an entry", () => {
    expect(archiveManifestSchema.safeParse({
      ...validManifest,
      assets: [{ ...validAsset, archivePath: "assets/missing.png" }]
    }).success).toBe(false);
  });

  it("rejects unbound assets from campaign manifests", () => {
    expect(archiveManifestSchema.safeParse({
      ...validManifest,
      assets: [{ ...validAsset, bindings: [] }]
    }).success).toBe(false);
  });

  describe("asset duplicates", () => {
    it("rejects duplicate source asset IDs", () => {
      expect(archiveManifestSchema.safeParse({
        ...validManifest,
        assets: [validAsset, { ...validAsset }]
      }).success).toBe(false);
    });

    it.each([
      ["content hash", { contentHash: secondHash }],
      ["byte length", { byteLength: validAsset.byteLength + 1 }],
      ["MIME type", { mimeType: "image/webp" }],
      ["pixel width", { pixelWidth: validAsset.pixelWidth + 1 }],
      ["pixel height", { pixelHeight: validAsset.pixelHeight + 1 }]
    ])("rejects one normalized archive path with contradictory %s", (_field, override) => {
      expect(archiveManifestSchema.safeParse({
        ...validManifest,
        assets: [
          validAsset,
          {
            ...validAsset,
            ...override,
            sourceAssetId: secondAssetId,
            archivePath: "Assets/Original.png"
          }
        ]
      }).success).toBe(false);
    });

    it("rejects one content hash mapped to different archive paths", () => {
      const alternatePath = "assets/alternate.png";
      expect(archiveManifestSchema.safeParse({
        ...validManifest,
        entries: [
          ...validManifest.entries,
          { ...validManifest.entries[4], path: alternatePath }
        ],
        assets: [
          validAsset,
          {
            ...validAsset,
            sourceAssetId: secondAssetId,
            archivePath: alternatePath
          }
        ]
      }).success).toBe(false);
    });

    it("accepts equivalent original metadata for distinct source asset IDs", () => {
      expect(archiveManifestSchema.safeParse({
        ...validManifest,
        assets: [
          validAsset,
          {
            ...validAsset,
            sourceAssetId: secondAssetId,
            bindings: [{ role: "campaign_asset", campaignId }]
          }
        ]
      }).success).toBe(true);
    });
  });

  it("accepts an unbound owner-library asset from a System Archive", () => {
    expect(archiveManifestSchema.safeParse({
      format: "infinite-quest-archive",
      formatVersion: 1,
      archiveType: "system",
      createdAt: "2026-07-26T12:00:00.000Z",
      contentFingerprint: hash,
      entries: [validManifest.entries[4]],
      payloads: [],
      assets: [{ ...validAsset, library: { ...validAsset.library, reuseScope: "owner_library" }, bindings: [] }]
    }).success).toBe(true);
  });

  it("rejects an unbound non-owner-library asset from a System Archive", () => {
    expect(archiveManifestSchema.safeParse({
      format: "infinite-quest-archive",
      formatVersion: 1,
      archiveType: "system",
      createdAt: "2026-07-26T12:00:00.000Z",
      contentFingerprint: hash,
      entries: [validManifest.entries[4]],
      payloads: [],
      assets: [{ ...validAsset, bindings: [] }]
    }).success).toBe(false);
  });

  it.each(["../turns.json", "/absolute.json", "C:/drive.json", "a\\b.json", "a/./b.json"])(
    "rejects unsafe archive path %s",
    (path) => expect(archivePathSchema.safeParse(path).success).toBe(false)
  );

  it("sanitizes recursive secret and local metadata before parsing asset records", () => {
    expect(sanitizePortableMetadata({
      nested: { apiKey: "secret", authorization: "Bearer private", cachePath: "C:/private/cache" },
      visible: "safe"
    })).toEqual({ nested: {}, visible: "safe" });
    expect(archiveAssetRecordSchema.parse({
      ...validAsset,
      technicalMetadata: { providerUrl: "https://temporary.example/image", visible: "safe" }
    }).technicalMetadata).toEqual({ visible: "safe" });
  });

  it("removes prohibited derived, provider, and remote-state metadata recursively", () => {
    const technicalMetadata = {
      embedding: [0.1, 0.2],
      thumbnail: "assets/thumb.png",
      rawProviderResponse: { text: "private" },
      privateReasoning: "hidden chain of thought",
      previousResponseId: "response-1",
      responseChainId: "chain-1",
      leaseId: "lease-1",
      generationJobId: "job-1",
      remoteState: { status: "running" },
      nested: [{ remoteJobId: "remote-job-1", safe: "retained" }],
      safe: "portable"
    };

    expect(sanitizePortableMetadata(technicalMetadata)).toEqual({
      nested: [{ safe: "retained" }],
      safe: "portable"
    });
    expect(archiveAssetRecordSchema.parse({ ...validAsset, technicalMetadata }).technicalMetadata).toEqual({
      nested: [{ safe: "retained" }],
      safe: "portable"
    });
    expect(archiveAssetRecordSchema.safeParse({ ...validAsset, technicalMetadata: "not-a-record" }).success).toBe(false);
  });

  it("canonicalizes object keys and fingerprints sorted unique content hashes", () => {
    expect(canonicalArchiveJson({ zebra: [2, 1], alpha: { second: true, first: false } })).toBe(
      '{"alpha":{"first":false,"second":true},"zebra":[2,1]}'
    );
    expect(canonicalArchiveJson({ tags: ["zebra", "amber", "zebra"], contentCategories: ["mystery", "fantasy", "mystery"] })).toBe(
      '{"contentCategories":["fantasy","mystery"],"tags":["amber","zebra"]}'
    );
    expect(calculateContentFingerprint({
      payloadHashes: ["b".repeat(64), "a".repeat(64)],
      originalAssetHashes: ["d".repeat(64), "c".repeat(64), "d".repeat(64)]
    })).toBe("411247f170f23c8ab39431df79003053f803aaa3bddb109a740476d21d594f2d");
  });

  it("validates campaign archive previews and destination consistency", () => {
    expect(campaignArchivePreviewResponseSchema.parse(validPreview)).toMatchObject(validPreview);
    expect(campaignArchivePreviewResponseSchema.safeParse({
      ...validPreview,
      campaign: { ...validPreview.campaign, activeTurnNumber: 4 }
    }).success).toBe(false);
    expect(campaignArchivePreviewResponseSchema.safeParse({
      ...validPreview,
      destination: { kind: "embedded", operation: "reuse_world_version", worldId: worldId, worldVersionId: null }
    }).success).toBe(false);
    expect(campaignArchivePreviewResponseSchema.safeParse({ ...validPreview, providerDataIncluded: true }).success).toBe(false);
  });
});
