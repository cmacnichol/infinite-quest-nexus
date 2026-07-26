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
  collectCampaignArchiveAssets,
  persistArchiveAssets,
  projectCampaignArchiveAssets,
  restoreAssetBindings,
  verifyAndWriteArchiveAssets,
  validateArchiveAssets,
  type ArchiveAssetSourceRow,
  type ArchiveIdMap
} from "../../services/api/src/asset-archive-service.js";

const pngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
const ownerUserId = "11111111-1111-4111-8111-111111111111";
const assetA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const assetB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const hash = createHash("sha256").update(pngBytes.toString("base64")).digest("hex");

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
      const retainedPath = join(root, "bb", `${hash}.png`);
      const store: FilesystemAssetStore = { root };
      const outside = join(root, "..", "outside.png");
      await (await import("node:fs/promises")).mkdir(join(root, "aa"), { recursive: true });
      await (await import("node:fs/promises")).mkdir(join(root, "bb"), { recursive: true });
      await (await import("node:fs/promises")).writeFile(path, pngBytes);
      await (await import("node:fs/promises")).writeFile(retainedPath, pngBytes);
      await expect(cleanupUnreferencedCreatedPaths(store, ["aa/" + hash + ".png", "bb/" + hash + ".png", "../outside.png"], new Set([retainedPath])))
        .resolves.toBeUndefined();
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await stat(retainedPath)).isFile()).toBe(true);
      expect((await stat(root)).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses canonical stored hashes when writing one original entry per content hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "asset-archive-write-"));
    try {
      await expect(verifyAndWriteArchiveAssets({
        records: [
          { sourceAssetId: assetA, contentHash: hash, archivePath: `assets/sha256/${hash.slice(0, 2)}/${hash}.png`, mimeType: "image/png", byteLength: pngBytes.length, pixelWidth: 1, pixelHeight: 1, technicalMetadata: {}, library: { title: "", caption: "", notes: "", tags: [], origin: "imported", reviewStatus: "unreviewed", reuseScope: "campaign", automaticReuseEnabled: false, contentCategories: [], favorite: false, archivedAt: null }, createdAt: "2026-01-01T00:00:00.000Z", bindings: [] },
          { sourceAssetId: assetB, contentHash: hash, archivePath: `assets/sha256/${hash.slice(0, 2)}/${hash}.jpg`, mimeType: "image/jpeg", byteLength: pngBytes.length, pixelWidth: 1, pixelHeight: 1, technicalMetadata: {}, library: { title: "", caption: "", notes: "", tags: [], origin: "imported", reviewStatus: "unreviewed", reuseScope: "campaign", automaticReuseEnabled: false, contentCategories: [], favorite: false, archivedAt: null }, createdAt: "2026-01-01T00:00:00.000Z", bindings: [] }
        ], readOriginal: async () => pngBytes, outputRoot: root
      })).rejects.toThrow("Inconsistent metadata");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("aggregates all required source read failures with archive-asset-missing", async () => {
    const records = [assetA, assetB].map((id) => ({ sourceAssetId: id, contentHash: hash, archivePath: `assets/sha256/${hash.slice(0, 2)}/${hash}.png`, mimeType: "image/png" as const, byteLength: pngBytes.length, pixelWidth: 1, pixelHeight: 1, technicalMetadata: {}, library: { title: "", caption: "", notes: "", tags: [], origin: "imported" as const, reviewStatus: "unreviewed" as const, reuseScope: "campaign" as const, automaticReuseEnabled: false, contentCategories: [], favorite: false, archivedAt: null }, createdAt: "2026-01-01T00:00:00.000Z", bindings: [] }));
    const root = await mkdtemp(join(tmpdir(), "asset-archive-fail-"));
    try {
      await expect(verifyAndWriteArchiveAssets({ records, readOriginal: async (id) => { throw new Error(id); }, outputRoot: root }))
        .rejects.toThrow(new RegExp(`${assetA}.*${assetB}|${assetB}.*${assetA}`));
      await expect(stat(join(root, "assets"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("collects the complete owner-scoped inventory query", async () => {
    let sql = "";
    const client = { query: async (text: string) => { sql = text; return { rows: [] }; } } as never;
    await expect(collectCampaignArchiveAssets(client, ownerUserId, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "ffffffff-ffff-4fff-8fff-ffffffffffff")).resolves.toEqual({ records: [], uniqueOriginals: [] });
    expect(sql).toContain("turn_illustration_segment_assets");
    expect(sql).toContain("image_jobs");
    expect(sql).toContain("cover_asset_id");
    expect(sql).toContain("asset_generation_contexts");
    expect(sql).toContain("image_url");
  });

  it("persists one content hash and requires its library metadata row", async () => {
    const root = await mkdtemp(join(tmpdir(), "asset-archive-persist-"));
    try {
      const client = { query: async (text: string) => text.startsWith("INSERT INTO assets") ? { rows: [{ id: "dest-asset" }], rowCount: 1 } : text.startsWith("UPDATE asset_library_entries") ? { rows: [{ asset_id: "dest-asset" }], rowCount: 1 } : { rows: [], rowCount: 1 } } as never;
      const record = (await validateArchiveAssets({ records: [{ sourceAssetId: assetA, contentHash: hash, archivePath: `assets/sha256/${hash.slice(0, 2)}/${hash}.png`, mimeType: "image/png", byteLength: pngBytes.length, pixelWidth: 1, pixelHeight: 1, technicalMetadata: {}, library: { title: "portable", caption: "", notes: "", tags: [], origin: "imported", reviewStatus: "unreviewed", reuseScope: "campaign", automaticReuseEnabled: false, contentCategories: [], favorite: false, archivedAt: null }, createdAt: "2026-01-01T00:00:00.000Z", bindings: [] }] }, async () => pngBytes)).assets;
      const idMap: ArchiveIdMap = new Map();
      await expect(persistArchiveAssets(client, { root }, ownerUserId, { assets: [record[0]!, { ...record[0]!, sourceAssetId: assetB }] }, idMap)).resolves.toMatchObject({ assetIds: new Map([[assetA, "dest-asset"], [assetB, "dest-asset"], [hash, "dest-asset"]]) });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("restores every binding through namespaced destination IDs", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const client = { query: async (text: string, values?: unknown[]) => { queries.push(values === undefined ? { text } : { text, values }); return { rows: [{ id: "dest-asset" }], rowCount: 1 }; } } as never;
    const idMap: ArchiveIdMap = new Map([
      ["campaign", new Map([["campaign-source", "campaign-dest"]])], ["world", new Map([["world-source", "world-dest"]])],
      ["worldVersion", new Map([["version-source", "version-dest"]])], ["turn", new Map([["turn-source", "turn-dest"]])],
      ["illustrationSegment", new Map([["segment-source", "segment-dest"]])], ["generationContext", new Map([["context-source", "context-dest"]])]
    ]);
    await restoreAssetBindings(client, ownerUserId, [{ sourceAssetId: assetA, contentHash: hash, archivePath: "assets/a", mimeType: "image/png", byteLength: pngBytes.length, pixelWidth: 1, pixelHeight: 1, technicalMetadata: {}, library: { title: "", caption: "", notes: "", tags: [], origin: "imported", reviewStatus: "unreviewed", reuseScope: "campaign", automaticReuseEnabled: false, contentCategories: [], favorite: false, archivedAt: null }, createdAt: "2026-01-01T00:00:00.000Z", bindings: [
      { role: "world_cover", worldId: "world-source" }, { role: "world_version_asset", worldId: "world-source", worldVersionId: "version-source" }, { role: "campaign_asset", campaignId: "campaign-source" }, { role: "turn_illustration", campaignId: "campaign-source", turnId: "turn-source" }, { role: "illustration_segment_variant", campaignId: "campaign-source", turnId: "turn-source", segmentId: "segment-source", variantIndex: 0 }, { role: "imported_attachment", campaignId: "campaign-source", turnId: null }, { role: "generation_context", campaignId: "campaign-source", worldId: "world-source", worldVersionId: "version-source", turnId: "turn-source", sourceContextId: "context-source" }
    ] }], new Map([[assetA, "dest-asset"]]), idMap);
    expect(queries.every(({ values }) => !values?.some((value) => typeof value === "string" && value.endsWith("source")))).toBe(true);
    expect(queries.some(({ values }) => values?.includes("segment-dest"))).toBe(true);
    expect(queries.some(({ values }) => values?.includes("context-dest"))).toBe(true);
  });
});
