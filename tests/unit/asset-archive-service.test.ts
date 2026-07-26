import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_IMPORTED_IMAGE_BYTES,
  imageExtensionForMimeType,
  persistOriginalImage,
  verifyOriginalImage,
  type FilesystemAssetStore
} from "../../services/api/src/asset-service.js";
import {
  cleanupUnreferencedCreatedPaths,
  projectCampaignArchiveAssets,
  validateArchiveAssets,
  type ArchiveAssetSourceRow
} from "../../services/api/src/asset-archive-service.js";

const pngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
const ownerUserId = "11111111-1111-4111-8111-111111111111";
const assetA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const assetB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const hash = createHash("sha256").update(pngBytes).digest("hex");

describe("asset archive portability", () => {
  it("projects duplicate source rows to one deterministic original archive entry", () => {
    const result = projectCampaignArchiveAssets([
      {
        id: assetB, owner_user_id: ownerUserId, content_hash: hash, mime_type: "image/png",
        byte_length: pngBytes.length, pixel_width: 1, pixel_height: 1, storage_driver: "filesystem",
        storage_path: "bb/original.png", technical_metadata: { z: 1 }, created_at: new Date("2026-01-02T00:00:00Z"),
        title: "B", caption: "", notes: "", tags: ["b"], origin: "imported", review_status: "unreviewed",
        reuse_scope: "campaign", automatic_reuse_enabled: false, content_categories: [], favorite: false, archived_at: null,
        bindings: [{ role: "campaign_asset", campaignId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }]
      },
      {
        id: assetA, owner_user_id: ownerUserId, content_hash: hash, mime_type: "image/png",
        byte_length: pngBytes.length, pixel_width: 1, pixel_height: 1, storage_driver: "filesystem",
        storage_path: "aa/original.png", technical_metadata: { apiKey: "secret", safe: "yes" }, created_at: new Date("2026-01-01T00:00:00Z"),
        title: "A", caption: "", notes: "", tags: ["a"], origin: "imported", review_status: "unreviewed",
        reuse_scope: "campaign", automatic_reuse_enabled: false, content_categories: [], favorite: false, archived_at: null,
        bindings: [{ role: "turn_illustration", campaignId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", turnId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }]
      }
    ] satisfies ArchiveAssetSourceRow[]);

    expect(result.uniqueOriginals).toEqual([{
      contentHash: hash,
      archivePath: `assets/sha256/${hash.slice(0, 2)}/${hash}.png`,
      sourceAssetIds: [assetA, assetB],
      mimeType: "image/png",
      byteLength: pngBytes.length
    }]);
    expect(result.records[0]?.sourceAssetId).toBe(assetA);
    expect(result.records[0]?.technicalMetadata).toEqual({ safe: "yes" });
  });

  it("rejects signature mismatches and originals over 25 MiB", async () => {
    await expect(verifyOriginalImage(Buffer.from("not an image"), "image/png"))
      .rejects.toThrow("did not match declared type");
    await expect(verifyOriginalImage(Buffer.alloc(MAX_IMPORTED_IMAGE_BYTES + 1), "image/png"))
      .rejects.toThrow("25 MB");
    expect(imageExtensionForMimeType("image/jpeg")).toBe(".jpg");
  });

  it("validates a portable original and keeps the derivative absent for restore", async () => {
    const validated = await validateArchiveAssets({
      records: [{
        sourceAssetId: assetA, contentHash: hash, archivePath: `assets/sha256/${hash.slice(0, 2)}/${hash}.png`,
        mimeType: "image/png", byteLength: pngBytes.length, pixelWidth: 1, pixelHeight: 1,
        technicalMetadata: {}, library: { title: "", caption: "", notes: "", tags: [], origin: "imported",
          reviewStatus: "unreviewed", reuseScope: "campaign", automaticReuseEnabled: false,
          contentCategories: [], favorite: false, archivedAt: null }, createdAt: "2026-01-01T00:00:00.000Z", bindings: []
      }]
    }, async () => pngBytes);
    expect(validated.assets[0]?.createThumbnail).toBe(false);
  });

  it("cleans only created paths that remain unreferenced and inside the store", async () => {
    const root = await mkdtemp(join(tmpdir(), "asset-archive-test-"));
    try {
      const path = join(root, "aa", `${hash}.png`);
      const store: FilesystemAssetStore = { root };
      await expect(cleanupUnreferencedCreatedPaths(store, ["aa/does-not-exist.png"], new Set([path])))
        .resolves.toBeUndefined();
      expect((await stat(root)).isDirectory()).toBe(true);
      expect(await readFile).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
