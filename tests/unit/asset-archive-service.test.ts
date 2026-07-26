import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  MAX_IMPORTED_IMAGE_BYTES,
  imageExtensionForMimeType,
  persistOriginalImage,
  type FilesystemAssetStore,
  verifyOriginalImage
} from "../../services/api/src/asset-service.js";
import {
  ArchiveAssetPersistenceError,
  cleanupUnreferencedCreatedPaths,
  collectCampaignArchiveAssets,
  persistArchiveAssets,
  projectCampaignArchiveAssets,
  restoreAssetBindings,
  validateArchiveAssets,
  verifyAndWriteArchiveAssets,
  type ArchiveAssetSourceRow,
  type ArchiveIdMap
} from "../../services/api/src/asset-archive-service.js";
import { sanitizePortableMetadata, type ArchiveAssetBinding, type ArchiveAssetRecord } from "../../packages/contracts/src/archives.js";

const pngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
const ownerUserId = "11111111-1111-4111-8111-111111111111";
const campaignId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const worldId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const worldVersionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const turnId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const segmentId = "12121212-1212-4121-8121-121212121212";
const contextId = "13131313-1313-4131-8131-131313131313";
const assetA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const assetB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const assetC = "11111111-2222-4333-8444-555555555555";
const assetD = "22222222-3333-4444-8555-666666666666";
const assetE = "33333333-4444-4555-8666-777777777777";
const assetF = "44444444-5555-4666-8777-888888888888";
const assetG = "55555555-6666-4777-8888-999999999999";
const assetH = "77777777-1111-4777-8777-999999999999";
const assetI = "88888888-1111-4888-8888-999999999999";
const fuzzyOnlyAsset = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const hash = createHash("sha256").update(pngBytes.toString("base64")).digest("hex");

const library = {
  title: "portable",
  caption: "",
  notes: "",
  tags: [],
  origin: "imported" as const,
  reviewStatus: "unreviewed" as const,
  reuseScope: "campaign" as const,
  automaticReuseEnabled: false,
  contentCategories: [],
  favorite: false,
  archivedAt: null
};

function record(sourceAssetId: string, bindings: ArchiveAssetBinding[] = [], overrides: Partial<ArchiveAssetRecord> = {}): ArchiveAssetRecord {
  return {
    sourceAssetId,
    contentHash: hash,
    archivePath: `assets/sha256/${hash.slice(0, 2)}/${hash}.png`,
    mimeType: "image/png",
    byteLength: pngBytes.length,
    pixelWidth: 1,
    pixelHeight: 1,
    technicalMetadata: {},
    library,
    createdAt: "2026-01-01T00:00:00.000Z",
    bindings,
    ...overrides
  };
}

function sourceRow(sourceAssetId: string, bindings: ArchiveAssetBinding[] = []): ArchiveAssetSourceRow {
  return {
    id: sourceAssetId,
    owner_user_id: ownerUserId,
    content_hash: hash,
    mime_type: "image/png",
    byte_length: pngBytes.length,
    pixel_width: 1,
    pixel_height: 1,
    storage_driver: "filesystem",
    storage_path: `${sourceAssetId.slice(0, 2)}/original.png`,
    technical_metadata: {},
    created_at: new Date("2026-01-01T00:00:00Z"),
    title: library.title,
    caption: library.caption,
    notes: library.notes,
    origin: library.origin,
    review_status: library.reviewStatus,
    reuse_scope: library.reuseScope,
    automatic_reuse_enabled: library.automaticReuseEnabled,
    favorite: library.favorite,
    tags: [],
    content_categories: [],
    archived_at: null,
    bindings
  };
}

function projectedBinding(text: string, assetId: string, binding: ArchiveAssetBinding) {
  if (!/\bAS\s+binding\b/i.test(text)) return { asset_id: assetId };
  return { asset_id: assetId, binding };
}

describe("asset archive portability", () => {
  it("projects duplicate source rows to one deterministic original archive entry", () => {
    const result = projectCampaignArchiveAssets([
      { ...sourceRow(assetB, [{ role: "campaign_asset", campaignId }]), title: "B", tags: ["b"], created_at: new Date("2026-01-02T00:00:00Z") },
      { ...sourceRow(assetA, [{ role: "turn_illustration", campaignId, turnId }]), title: "A", technical_metadata: { apiKey: "secret", safe: "yes" }, tags: ["a"] }
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
    const validated = await validateArchiveAssets({ records: [record(assetA)] }, async () => pngBytes);
    expect(validated.assets[0]?.createThumbnail).toBe(false);
  });

  it("cleans only database-unreferenced created paths and retains an actual outside-root file", async () => {
    const root = await mkdtemp(join(tmpdir(), "asset-archive-test-"));
    const outside = join(root, "..", `outside-${process.pid}.png`);
    try {
      const path = join(root, "aa", `${hash}.png`);
      const retainedPath = join(root, "bb", `${hash}.png`);
      const store: FilesystemAssetStore = { root };
      await mkdir(join(root, "aa"), { recursive: true });
      await mkdir(join(root, "bb"), { recursive: true });
      await writeFile(path, pngBytes);
      await writeFile(retainedPath, pngBytes);
      await writeFile(outside, pngBytes);
      const database = {
        query: async (text: string, values: unknown[]) => {
          expect(text).toContain("SELECT storage_path");
          expect(text).toContain("FROM assets");
          expect(values).toEqual([ownerUserId, ["aa/" + hash + ".png", "bb/" + hash + ".png"]]);
          return { rows: [{ storage_path: "bb/" + hash + ".png" }], rowCount: 1 };
        }
      } as never;
      await cleanupUnreferencedCreatedPaths(database, store, ownerUserId, ["aa/" + hash + ".png", "bb/" + hash + ".png", "../" + `outside-${process.pid}.png`]);
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await stat(retainedPath)).isFile()).toBe(true);
      expect((await stat(outside)).isFile()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { force: true });
    }
  });

  it("writes one physical archive entry for duplicate source IDs with the same content", async () => {
    const root = await mkdtemp(join(tmpdir(), "asset-archive-write-"));
    try {
      const entries = await verifyAndWriteArchiveAssets({
        records: [record(assetA), record(assetB)],
        readOriginal: async () => pngBytes,
        outputRoot: root
      });
      expect(entries).toHaveLength(1);
      expect((await readFile(join(root, entries[0]!.path))).equals(pngBytes)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects conflicting archive metadata for one content hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "asset-archive-conflict-"));
    try {
      await expect(verifyAndWriteArchiveAssets({
        records: [record(assetA), record(assetB, [], { archivePath: `assets/sha256/${hash.slice(0, 2)}/${hash}.jpg`, mimeType: "image/jpeg" })],
        readOriginal: async () => pngBytes,
        outputRoot: root
      })).rejects.toThrow("Inconsistent metadata");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("aggregates all required source read failures with archive-asset-missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "asset-archive-fail-"));
    try {
      await expect(verifyAndWriteArchiveAssets({
        records: [record(assetA), record(assetB)],
        readOriginal: async (id) => { throw new Error(id); },
        outputRoot: root
      })).rejects.toMatchObject({ code: "archive-asset-missing", assetIds: [assetA, assetB] });
      await expect(stat(join(root, "assets"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("collects each explicit source once with its scoped rows and keeps exact legacy pointers", async () => {
    const sourceCalls = new Map<string, unknown[][]>();
    const track = (source: string, values: readonly unknown[] | undefined) => {
      const calls = sourceCalls.get(source) ?? [];
      calls.push([...(values ?? [])]);
      sourceCalls.set(source, calls);
    };
    const client = {
      query: async (text: string, values?: unknown[]) => {
        if (text.includes("FROM asset_references r")) {
          track("assetReferences", values);
          return { rows: [
            projectedBinding(text, assetA, { role: "campaign_asset", campaignId }),
            projectedBinding(text, assetA, { role: "imported_attachment", campaignId, turnId: null })
          ], rowCount: 2 };
        }
        if (text.includes("FROM turn_illustration_segment_assets s")) {
          track("segmentAssets", values);
          return { rows: [projectedBinding(text, assetB, { role: "illustration_segment_variant", campaignId, turnId, segmentId, variantIndex: 0 })], rowCount: 1 };
        }
        if (text.includes("FROM image_jobs j") && text.includes("j.campaign_id=$2")) {
          track("campaignImageJobs", values);
          return { rows: [
            { asset_id: assetC, target_type: "turn_illustration", campaign_id: campaignId, turn_id: turnId },
            { asset_id: assetD, target_type: "streaming_illustration", campaign_id: campaignId, turn_id: null }
          ], rowCount: 2 };
        }
        if (text.includes("FROM worlds w") && text.includes("cover_asset_id")) {
          track("worldCover", values);
          return { rows: [projectedBinding(text, assetF, { role: "world_cover", worldId })], rowCount: 1 };
        }
        if (text.includes("FROM asset_generation_contexts c")) {
          track("generationContexts", values);
          return { rows: [
            projectedBinding(text, assetG, { role: "generation_context", campaignId, worldId: null, worldVersionId: null, turnId: null, sourceContextId: contextId }),
            projectedBinding(text, assetG, { role: "generation_context", campaignId: null, worldId, worldVersionId, turnId: null, sourceContextId: "14141414-1414-4141-8141-141414141414" }),
            projectedBinding(text, assetG, { role: "generation_context", campaignId: null, worldId, worldVersionId: null, turnId: null, sourceContextId: "15151515-1515-4151-8151-151515151515" })
          ], rowCount: 3 };
        }
        if (text.includes("FROM turns") && text.includes("image_url")) return { rows: [{ id: turnId, image_url: `/api/v1/assets/${assetH}` }], rowCount: 1 };
        if (text.includes("FROM world_versions") && text.includes("content")) return {
          rows: [{ content: { nested: { exact: `/api/v1/assets/${assetI}` }, repeated: `/api/v1/assets/${assetI}`, fuzzy: `prefix-${fuzzyOnlyAsset}-suffix` } }],
          rowCount: 1
        };
        if (text.includes("FROM assets a")) return { rows: [assetA, assetB, assetC, assetD, assetF, assetG, assetH, assetI].map((id) => sourceRow(id)), rowCount: 8 };
        throw new Error(`Unexpected archive query: ${text}`);
      }
    } as never;

    const result = await collectCampaignArchiveAssets(client, ownerUserId, campaignId, worldVersionId, worldId);
    const byAsset = new Map(result.records.map((item) => [item.sourceAssetId, item]));
    expect([...byAsset.keys()].sort()).toEqual([assetA, assetB, assetC, assetD, assetF, assetG, assetH, assetI].sort());
    expect(byAsset.get(assetA)?.bindings).toEqual([
      { role: "campaign_asset", campaignId },
      { role: "imported_attachment", campaignId, turnId: null }
    ]);
    expect(byAsset.get(assetB)?.bindings).toEqual([{ role: "illustration_segment_variant", campaignId, turnId, segmentId, variantIndex: 0 }]);
    expect(byAsset.get(assetC)?.bindings).toEqual([{ role: "turn_illustration", campaignId, turnId }]);
    expect(byAsset.get(assetD)?.bindings).toEqual([{ role: "campaign_asset", campaignId }]);
    expect(byAsset.get(assetF)?.bindings).toEqual([{ role: "world_cover", worldId }]);
    expect(byAsset.get(assetG)?.bindings).toEqual([
      { role: "generation_context", campaignId: null, worldId, worldVersionId: null, turnId: null, sourceContextId: "15151515-1515-4151-8151-151515151515" },
      { role: "generation_context", campaignId: null, worldId, worldVersionId, turnId: null, sourceContextId: "14141414-1414-4141-8141-141414141414" },
      { role: "generation_context", campaignId, worldId: null, worldVersionId: null, turnId: null, sourceContextId: contextId }
    ]);
    expect(byAsset.get(assetH)?.bindings).toEqual([{ role: "turn_illustration", campaignId, turnId }]);
    expect(byAsset.get(assetI)?.bindings).toEqual([{ role: "world_version_asset", worldId, worldVersionId }]);
    expect(byAsset.has(fuzzyOnlyAsset)).toBe(false);
    expect(sourceCalls).toEqual(new Map([
      ["assetReferences", [[ownerUserId, campaignId]]],
      ["segmentAssets", [[ownerUserId, campaignId]]],
      ["campaignImageJobs", [[ownerUserId, campaignId]]],
      ["worldCover", [[ownerUserId, worldId]]],
      ["generationContexts", [[ownerUserId, campaignId, worldVersionId, worldId]]]
    ]));
  });

  it("rejects a same-world generation context belonging to another campaign", async () => {
    const foreignCampaignId = "99999999-9999-4999-8999-999999999999";
    const client = {
      query: async (text: string) => {
        if (text.includes("FROM asset_references r") || text.includes("FROM turn_illustration_segment_assets s") || text.includes("FROM image_jobs j") || text.includes("FROM worlds w")) return { rows: [], rowCount: 0 };
        if (text.includes("FROM asset_generation_contexts c")) {
          const reusableWorldScopesRequireNullCampaign = text.includes("c.campaign_id IS NULL AND c.world_version_id") && text.includes("c.campaign_id IS NULL AND c.world_id");
          return reusableWorldScopesRequireNullCampaign
            ? { rows: [], rowCount: 0 }
            : { rows: [projectedBinding(text, assetA, { role: "generation_context", campaignId: foreignCampaignId, worldId, worldVersionId: null, turnId: null, sourceContextId: contextId })], rowCount: 1 };
        }
        if (text.includes("FROM turns") && text.includes("image_url")) return { rows: [], rowCount: 0 };
        if (text.includes("FROM world_versions") && text.includes("content")) return { rows: [{ content: {} }], rowCount: 1 };
        if (text.includes("FROM assets a")) return { rows: [], rowCount: 0 };
        throw new Error(`Unexpected archive query: ${text}`);
      }
    } as never;

    const result = await collectCampaignArchiveAssets(client, ownerUserId, campaignId, worldVersionId, worldId);
    expect(result.records).toEqual([]);
  });

  it("restores a legacy turn image URL to the mapped destination asset URL", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const idMap: ArchiveIdMap = new Map([
      ["campaign", new Map([[campaignId, "campaign-destination"]])],
      ["turn", new Map([[turnId, "turn-destination"]])]
    ]);
    const client = {
      query: async (text: string, values?: unknown[]) => {
        queries.push(values === undefined ? { text } : { text, values });
        if (text.startsWith("SELECT 1 FROM")) return { rows: [{ id: "scoped" }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }
    } as never;

    await restoreAssetBindings(client, ownerUserId, [record(assetA, [{ role: "turn_illustration", campaignId, turnId }])], new Map([[assetA, "asset-destination"]]), idMap);
    const turnUpdate = queries.find(({ text }) => text.startsWith("UPDATE turns SET image_url"));
    expect(turnUpdate?.values).toEqual(["turn-destination", ownerUserId, "/api/v1/assets/asset-destination", "campaign-destination"]);
    expect(queries.some(({ values }) => values?.includes(assetA))).toBe(false);
  });

  it("requires canonical archive paths and matching full-manifest original metadata", async () => {
    await expect(validateArchiveAssets({ records: [record(assetA, [], { archivePath: "assets/custom.png" })] }, async () => pngBytes))
      .rejects.toThrow("canonical");

    const manifest = {
      assets: [record(assetA)],
      entries: [{ path: record(assetA).archivePath, logicalType: "asset-thumbnail", mediaType: "image/png" }]
    };
    await expect(validateArchiveAssets(manifest as never, async () => pngBytes)).rejects.toThrow("asset-original");
    await expect(validateArchiveAssets({
      assets: [record(assetA)],
      entries: [{ path: record(assetA).archivePath, logicalType: "asset-original", mediaType: "image/jpeg" }]
    } as never, async () => pngBytes)).rejects.toThrow("asset-original");
  });

  it("sanitizes nested artifact URLs from portable metadata", () => {
    expect(sanitizePortableMetadata({ nested: [{ artifactUrl: "https://provider.example/result", safe: true }] }))
      .toEqual({ nested: [{ safe: true }] });
  });

  it("rejects absent and foreign-owner legacy pointers together", async () => {
    const missingId = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
    const foreignId = "88888888-9999-4aaa-8bbb-cccccccccccc";
    const client = {
      query: async (text: string) => {
        if (
          text.includes("FROM asset_references r") ||
          text.includes("FROM turn_illustration_segment_assets s") ||
          text.includes("FROM image_jobs j") ||
          text.includes("FROM worlds w") ||
          text.includes("FROM asset_generation_contexts c")
        ) return { rows: [], rowCount: 0 };
        if (text.includes("FROM turns") && text.includes("image_url")) return {
          rows: [{ id: turnId, image_url: `/api/v1/assets/${missingId}` }, { id: "99999999-aaaa-4bbb-8ccc-dddddddddddd", image_url: `/api/v1/assets/${foreignId}` }],
          rowCount: 2
        };
        if (text.includes("FROM world_versions") && text.includes("content")) return { rows: [{ content: {} }], rowCount: 1 };
        if (text.includes("FROM assets a")) return { rows: [], rowCount: 0 };
        throw new Error(`Unexpected archive query: ${text}`);
      }
    } as never;

    await expect(collectCampaignArchiveAssets(client, ownerUserId, campaignId, worldVersionId, worldId))
      .rejects.toMatchObject({ code: "archive-asset-missing", assetIds: [missingId, foreignId] });
  });

  it("persists originals without thumbnails and reports only newly created content-addressed paths", async () => {
    const secondBytes = await sharp({ create: { width: 2, height: 1, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
    const secondHash = createHash("sha256").update(secondBytes.toString("base64")).digest("hex");
    const first = record(assetA);
    const second = record(assetB, [], {
      contentHash: secondHash,
      archivePath: `assets/sha256/${secondHash.slice(0, 2)}/${secondHash}.png`,
      byteLength: secondBytes.length,
      pixelWidth: 2
    });
    const root = await mkdtemp(join(tmpdir(), "asset-archive-persist-"));
    const preexistingPath = `${hash.slice(0, 2)}/${hash}.png`;
    try {
      await mkdir(join(root, hash.slice(0, 2)), { recursive: true });
      await writeFile(join(root, preexistingPath), pngBytes);
      const queries: string[] = [];
      let insertNumber = 0;
      const client = {
        query: async (text: string) => {
          queries.push(text);
          if (text.startsWith("INSERT INTO assets")) return { rows: [{ id: `dest-${++insertNumber}` }], rowCount: 1 };
          if (text.startsWith("UPDATE asset_library_entries")) return { rows: [{ asset_id: "dest" }], rowCount: 1 };
          return { rows: [], rowCount: 1 };
        }
      } as never;
      const result = await persistArchiveAssets(client, { root }, ownerUserId, { assets: [{ ...first, bytes: pngBytes, createThumbnail: false }, { ...second, bytes: secondBytes, createThumbnail: false }] }, new Map());
      expect(result.createdPaths).toEqual([`${secondHash.slice(0, 2)}/${secondHash}.png`]);
      expect(queries.some((query) => query.includes("asset_derivatives"))).toBe(false);
      expect((await stat(join(root, preexistingPath))).isFile()).toBe(true);
      expect((await stat(join(root, `${secondHash.slice(0, 2)}/${secondHash}.png`))).isFile()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports concurrent original creation ownership only to the writer that won publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "asset-archive-concurrent-write-"));
    const createdBy: string[][] = [[], []];
    try {
      const client = {
        query: async (text: string) => text.startsWith("INSERT INTO assets")
          ? { rows: [{ id: "destination-asset" }], rowCount: 1 }
          : { rows: [], rowCount: 1 }
      } as never;
      await Promise.all([
        persistOriginalImage(client, { root }, ownerUserId, {
          bytes: pngBytes,
          mimeType: "image/png",
          createThumbnail: false,
          onOriginalCreated: (path) => { createdBy[0]!.push(path); }
        }),
        persistOriginalImage(client, { root }, ownerUserId, {
          bytes: pngBytes,
          mimeType: "image/png",
          createThumbnail: false,
          onOriginalCreated: (path) => { createdBy[1]!.push(path); }
        })
      ]);
      expect(createdBy.flat()).toEqual([`${hash.slice(0, 2)}/${hash}.png`]);
      expect((await stat(join(root, hash.slice(0, 2), `${hash}.png`))).isFile()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when the destination library metadata row is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "asset-archive-metadata-"));
    try {
      const client = {
        query: async (text: string) => text.startsWith("INSERT INTO assets")
          ? { rows: [{ id: "dest-asset" }], rowCount: 1 }
          : text.startsWith("UPDATE asset_library_entries") ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 1 }
      } as never;
      await expect(persistArchiveAssets(client, { root }, ownerUserId, { assets: [{ ...record(assetA), bytes: pngBytes, createThumbnail: false }] }, new Map()))
        .rejects.toMatchObject({ cause: { message: "Asset library metadata row is missing for 'dest-asset'." } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains a recreated original for a surviving pre-existing asset row after rollback", async () => {
    const secondBytes = await sharp({ create: { width: 2, height: 1, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 1 } } }).png().toBuffer();
    const secondHash = createHash("sha256").update(secondBytes.toString("base64")).digest("hex");
    const first = record(assetA);
    const second = record(assetB, [], {
      contentHash: secondHash,
      archivePath: `assets/sha256/${secondHash.slice(0, 2)}/${secondHash}.png`,
      byteLength: secondBytes.length,
      pixelWidth: 2
    });
    const root = await mkdtemp(join(tmpdir(), "asset-archive-rollback-"));
    const preexistingPath = `${hash.slice(0, 2)}/${hash}.png`;
    const laterCreatedPath = `${secondHash.slice(0, 2)}/${secondHash}.png`;
    const preexistingAssetId = "pre-existing-asset";
    const updatedAssetIds: string[] = [];
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    try {
      const assetRows = new Map([[hash, { ownerUserId, id: preexistingAssetId, storagePath: preexistingPath }]]);
      let insertNumber = 0;
      const client = {
        query: async (text: string, values?: unknown[]) => {
          queries.push(values === undefined ? { text } : { text, values });
          if (text.startsWith("INSERT INTO assets")) {
            expect(values?.[0]).toBe(ownerUserId);
            const contentHash = values?.[3];
            const preexisting = values?.[0] === ownerUserId && typeof contentHash === "string" ? assetRows.get(contentHash) : undefined;
            return { rows: [{ id: preexisting?.id ?? `dest-${++insertNumber}` }], rowCount: 1 };
          }
          if (text.startsWith("UPDATE asset_library_entries")) {
            const assetId = values?.[0];
            if (typeof assetId === "string") updatedAssetIds.push(assetId);
            if (updatedAssetIds.length === 2) throw new Error("primary metadata failure");
            return { rows: [{ asset_id: assetId }], rowCount: 1 };
          }
          return { rows: [], rowCount: 1 };
        }
      } as never;

      await expect(stat(join(root, preexistingPath))).rejects.toMatchObject({ code: "ENOENT" });
      let caught: unknown;
      try {
        await persistArchiveAssets(client, { root }, ownerUserId, {
          assets: [
            { ...first, bytes: pngBytes, createThumbnail: false },
            { ...second, bytes: secondBytes, createThumbnail: false }
          ]
        }, new Map());
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ArchiveAssetPersistenceError);
      expect(updatedAssetIds[0]).toBe(preexistingAssetId);
      expect((caught as ArchiveAssetPersistenceError).createdPaths).toEqual([preexistingPath, laterCreatedPath]);
      expect((caught as ArchiveAssetPersistenceError).cause).toMatchObject({ message: "primary metadata failure" });
      expect(queries.some((query) => query.text.includes("SELECT storage_path") && query.text.includes("FROM assets"))).toBe(false);
      expect((await stat(join(root, preexistingPath))).isFile()).toBe(true);
      expect((await stat(join(root, laterCreatedPath))).isFile()).toBe(true);

      const rollbackDatabase = {
        query: async (text: string, values: unknown[]) => {
          expect(text).toContain("FROM assets");
          expect(values).toEqual([ownerUserId, [preexistingPath, laterCreatedPath]]);
          return { rows: [{ storage_path: preexistingPath }], rowCount: 1 };
        }
      } as never;
      await cleanupUnreferencedCreatedPaths(rollbackDatabase, { root }, ownerUserId, (caught as ArchiveAssetPersistenceError).createdPaths);
      expect((await stat(join(root, preexistingPath))).isFile()).toBe(true);
      await expect(stat(join(root, laterCreatedPath))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves the primary cause and exposes only safe relative cleanup candidates", async () => {
    const root = await mkdtemp(join(tmpdir(), "asset-archive-cleanup-error-"));
    try {
      const client = {
        query: async (text: string) => {
          if (text.startsWith("INSERT INTO assets")) {
            return { rows: [{ id: "destination-asset" }], rowCount: 1 };
          }
          if (text.startsWith("UPDATE asset_library_entries")) {
            throw new Error("primary persistence failure");
          }
          return { rows: [], rowCount: 1 };
        }
      } as never;
      const unsafe = "../outside.png";
      let caught: unknown;
      try {
        await persistArchiveAssets(client, { root }, ownerUserId, {
          assets: [{ ...record(assetA), bytes: pngBytes, createThumbnail: false }]
        }, new Map());
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ArchiveAssetPersistenceError);
      expect((caught as ArchiveAssetPersistenceError).cause).toMatchObject({ message: "primary persistence failure" });
      expect((caught as ArchiveAssetPersistenceError).createdPaths).toEqual([`${hash.slice(0, 2)}/${hash}.png`]);
      expect((caught as ArchiveAssetPersistenceError).createdPaths).not.toContain(unsafe);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains a candidate with a surviving owner-scoped asset reference after rollback", async () => {
    const root = await mkdtemp(join(tmpdir(), "asset-archive-reference-retain-"));
    const path = `${hash.slice(0, 2)}/${hash}.png`;
    try {
      await mkdir(join(root, hash.slice(0, 2)), { recursive: true });
      await writeFile(join(root, path), pngBytes);
      const database = {
        query: async (text: string, values: unknown[]) => {
          expect(text).toContain("FROM assets");
          expect(values).toEqual([ownerUserId, [path]]);
          return { rows: [{ storage_path: path }], rowCount: 1 };
        }
      } as never;
      await cleanupUnreferencedCreatedPaths(database, { root }, ownerUserId, [path]);
      expect((await stat(join(root, path))).isFile()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("deletes a truly unreferenced candidate after rollback-aware cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "asset-archive-reference-delete-"));
    const path = `${hash.slice(0, 2)}/${hash}.png`;
    try {
      await mkdir(join(root, hash.slice(0, 2)), { recursive: true });
      await writeFile(join(root, path), pngBytes);
      const queries: Array<{ text: string; values: unknown[] }> = [];
      const database = {
        query: async (text: string, values: unknown[]) => {
          queries.push({ text, values });
          expect(text).toContain("SELECT storage_path");
          expect(text).toContain("FROM assets");
          expect(values).toEqual([ownerUserId, [path]]);
          return { rows: [], rowCount: 0 };
        }
      } as never;
      await cleanupUnreferencedCreatedPaths(database, { root }, ownerUserId, [path]);
      expect(queries).toHaveLength(1);
      await expect(stat(join(root, path))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects Windows drive-relative cleanup candidates before database lookup", async () => {
    const root = await mkdtemp(join(tmpdir(), "asset-archive-drive-relative-"));
    let queryCount = 0;
    try {
      const database = {
        query: async () => {
          queryCount += 1;
          return { rows: [], rowCount: 0 };
        }
      } as never;
      await cleanupUnreferencedCreatedPaths(database, { root }, ownerUserId, ["C:foo.png"]);
      expect(queryCount).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not query or unlink during persistence failure before the caller rolls back", async () => {
    const root = await mkdtemp(join(tmpdir(), "asset-archive-no-pre-rollback-cleanup-"));
    const path = `${hash.slice(0, 2)}/${hash}.png`;
    const queries: string[] = [];
    try {
      const client = {
        query: async (text: string) => {
          queries.push(text);
          if (text.startsWith("INSERT INTO assets")) return { rows: [{ id: "destination-asset" }], rowCount: 1 };
          if (text.startsWith("UPDATE asset_library_entries")) throw new Error("primary persistence failure");
          return { rows: [], rowCount: 1 };
        }
      } as never;
      await expect(persistArchiveAssets(client, { root }, ownerUserId, {
        assets: [{ ...record(assetA), bytes: pngBytes, createThumbnail: false }]
      }, new Map())).rejects.toBeInstanceOf(ArchiveAssetPersistenceError);
      expect(queries.some((query) => query.includes("storage_path") && query.includes("FROM assets"))).toBe(false);
      expect((await stat(join(root, path))).isFile()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps duplicate source UUIDs to one restored asset without exposing the content hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "asset-archive-id-map-"));
    try {
      let inserts = 0;
      const idMap: ArchiveIdMap = new Map();
      const client = {
        query: async (text: string) => text.startsWith("INSERT INTO assets")
          ? { rows: [{ id: `destination-${++inserts}` }], rowCount: 1 }
          : { rows: [{ asset_id: "destination-1" }], rowCount: 1 }
      } as never;

      const result = await persistArchiveAssets(client, { root }, ownerUserId, {
        assets: [
          { ...record(assetA), bytes: pngBytes, createThumbnail: false },
          { ...record(assetB), bytes: pngBytes, createThumbnail: false }
        ]
      }, idMap);

      expect(inserts).toBe(1);
      expect(result.assetIds).toEqual(new Map([[assetA, "destination-1"], [assetB, "destination-1"]]));
      expect(idMap.get("asset")).toEqual(new Map([[assetA, "destination-1"], [assetB, "destination-1"]]));
      expect(result.assetIds.has(hash)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects stale asset map keys and refuses hash-only binding resolution", async () => {
    const root = await mkdtemp(join(tmpdir(), "asset-archive-stale-map-"));
    try {
      const staleMap: ArchiveIdMap = new Map([["asset", new Map([[hash, "stale-destination"]])]]);
      const client = { query: async () => ({ rows: [{ id: "destination" }], rowCount: 1 }) } as never;
      let staleError: unknown;
      try {
        await persistArchiveAssets(client, { root }, ownerUserId, { assets: [{ ...record(assetA), bytes: pngBytes, createThumbnail: false }] }, staleMap);
      } catch (error) {
        staleError = error;
      }
      expect(staleError).toBeInstanceOf(ArchiveAssetPersistenceError);
      expect(((staleError as ArchiveAssetPersistenceError).cause as Error).message).toBe(`Unknown archive asset mapping '${hash}'.`);
      await expect(restoreAssetBindings(client, ownerUserId, [record(assetA)], new Map([[hash, "destination"]]), new Map()))
        .rejects.toThrow(`Missing restored asset mapping for '${assetA}'`);
      await expect(restoreAssetBindings(client, ownerUserId, [record(assetB)], new Map([[assetA, "destination"]]), new Map()))
        .rejects.toThrow(`Missing restored asset mapping for '${assetB}'`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores every binding role without fabricating campaign references for world-version assets", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const idMap: ArchiveIdMap = new Map([
      ["campaign", new Map([[campaignId, "campaign-dest"]])],
      ["world", new Map([[worldId, "world-dest"]])],
      ["worldVersion", new Map([[worldVersionId, "version-dest"]])],
      ["turn", new Map([[turnId, "turn-dest"]])],
      ["illustrationSegment", new Map([[segmentId, "segment-dest"]])],
      ["generationContext", new Map([[contextId, "context-dest"]])]
    ]);
    const client = {
      query: async (text: string, values?: unknown[]) => {
        queries.push(values === undefined ? { text } : { text, values });
        if (text.includes("FROM asset_generation_contexts") && text.includes("SELECT campaign_id")) return { rows: [{ campaign_id: "campaign-dest", world_id: "world-dest", world_version_id: "version-dest", turn_id: "turn-dest" }], rowCount: 1 };
        if (text.includes("FROM turn_illustration_segments")) return { rows: [{ id: "segment-dest" }], rowCount: text.includes("campaign_id=$3") && text.includes("turn_id=$4") ? 1 : 0 };
        if (text.includes("FROM world_versions")) return { rows: [{ id: "version-dest" }], rowCount: 1 };
        if (text.includes("FROM assets") || text.includes("FROM campaigns") || text.includes("FROM worlds") || text.includes("FROM turns") || text.includes("FROM asset_generation_contexts")) return { rows: [{ id: "target" }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }
    } as never;
    const bindings: ArchiveAssetBinding[] = [
      { role: "world_cover", worldId },
      { role: "world_version_asset", worldId, worldVersionId },
      { role: "campaign_asset", campaignId },
      { role: "turn_illustration", campaignId, turnId },
      { role: "illustration_segment_variant", campaignId, turnId, segmentId, variantIndex: 0 },
      { role: "imported_attachment", campaignId, turnId: null },
      { role: "generation_context", campaignId, worldId, worldVersionId, turnId, sourceContextId: contextId }
    ];

    await expect(restoreAssetBindings(client, ownerUserId, [record(assetA, bindings)], new Map([[assetA, "asset-dest"]]), idMap)).resolves.toBeUndefined();
    expect(queries.some(({ text }) => text.includes("INSERT INTO asset_references") && text.includes("world_version"))).toBe(false);
  });

  it("rejects an unmapped non-null generation-context relationship", async () => {
    const idMap: ArchiveIdMap = new Map([
      ["campaign", new Map([[campaignId, "campaign-dest"]])],
      ["world", new Map([[worldId, "world-dest"]])],
      ["turn", new Map([[turnId, "turn-dest"]])],
      ["generationContext", new Map([[contextId, "context-dest"]])]
    ]);
    const client = { query: async () => ({ rows: [{ id: "target" }], rowCount: 1 }) } as never;
    await expect(restoreAssetBindings(client, ownerUserId, [record(assetA, [{ role: "generation_context", campaignId, worldId, worldVersionId, turnId, sourceContextId: contextId }])], new Map([[assetA, "asset-dest"]]), idMap))
      .rejects.toThrow(`Unknown archive worldVersion reference '${worldVersionId}'`);
  });

  it("validates a generation context's complete destination relationship before updating its asset", async () => {
    const idMap: ArchiveIdMap = new Map([
      ["campaign", new Map([[campaignId, "campaign-dest"]])],
      ["world", new Map([[worldId, "world-dest"]])],
      ["worldVersion", new Map([[worldVersionId, "version-dest"]])],
      ["turn", new Map([[turnId, "turn-dest"]])],
      ["generationContext", new Map([[contextId, "context-dest"]])]
    ]);
    let updateSeen = false;
    const client = {
      query: async (text: string) => {
        if (text.includes("SELECT campaign_id")) return { rows: [{ campaign_id: "wrong-campaign", world_id: "world-dest", world_version_id: "version-dest", turn_id: "turn-dest" }], rowCount: 1 };
        if (text.startsWith("UPDATE asset_generation_contexts")) updateSeen = true;
        return { rows: [{ id: "target" }], rowCount: 1 };
      }
    } as never;
    await expect(restoreAssetBindings(client, ownerUserId, [record(assetA, [{ role: "generation_context", campaignId, worldId, worldVersionId, turnId, sourceContextId: contextId }])], new Map([[assetA, "asset-dest"]]), idMap))
      .rejects.toThrow("destination context");
    expect(updateSeen).toBe(false);
  });
});
