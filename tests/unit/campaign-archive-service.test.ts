import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { once } from "node:events";
import { ZipArchive } from "archiver";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeConfig } from "../../packages/database/src/config.js";
import type { DatabasePool } from "../../packages/database/src/pool.js";
import { stageArchiveUpload, type ArchiveLimits } from "../../services/api/src/archive-io.js";
import { adaptLegacyCampaignZip, decodeCampaignArchive, portableWorldContentHash, previewCampaignArchive } from "../../services/api/src/campaign-archive-service.js";

const temporaryRoots: string[] = [];
const limits: ArchiveLimits = {
  maxCompressedBytes: 10 * 1024 * 1024,
  maxUncompressedBytes: 10 * 1024 * 1024,
  maxEntries: 100,
  maxExpansionRatio: 100,
  maxManifestBytes: 1024 * 1024,
  maxJsonEntryBytes: 1024 * 1024,
  maxOriginalImageBytes: 1024 * 1024
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "infinite-quest-campaign-archive-"));
  temporaryRoots.push(root);
  return root;
}

async function writeLegacyZip(path: string, entries: readonly { name: string; content: string }[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const output = createWriteStream(path, { flags: "wx" });
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const completed = once(output, "close");
  archive.pipe(output);
  for (const entry of entries) archive.append(Buffer.from(entry.content, "utf8"), { name: entry.name });
  await archive.finalize();
  await completed;
}

describe("campaign archive preview validation", () => {
  it("returns archive-asset-invalid when duplicate manifest assets fail preview schema validation", async () => {
    const root = await temporaryRoot();
    const path = join(root, "duplicate-manifest-assets.zip");
    const campaignId = "11111111-1111-4111-8111-111111111111";
    const worldId = "22222222-2222-4222-8222-222222222222";
    const worldVersionId = "33333333-3333-4333-8333-333333333333";
    const sourceAssetId = "44444444-4444-4444-8444-444444444444";
    const hash = "a".repeat(64);
    const archivePath = `assets/sha256/${hash.slice(0, 2)}/${hash}.png`;
    const asset = {
      sourceAssetId,
      contentHash: hash,
      archivePath,
      mimeType: "image/png",
      byteLength: 1,
      pixelWidth: 1,
      pixelHeight: 1,
      technicalMetadata: {},
      library: {
        title: "",
        caption: "",
        notes: "",
        tags: [],
        origin: "imported",
        reviewStatus: "unreviewed",
        reuseScope: "campaign",
        automaticReuseEnabled: false,
        contentCategories: [],
        favorite: false,
        archivedAt: null
      },
      createdAt: "2026-07-26T12:00:00.000Z",
      bindings: [{ role: "campaign_asset", campaignId }]
    };
    const entries = [
      { path: "campaign.json", logicalType: "campaign", mediaType: "application/json", byteLength: 1, sha256: hash },
      { path: "world.json", logicalType: "world", mediaType: "application/json", byteLength: 1, sha256: hash },
      { path: "chronicle.json", logicalType: "chronicle", mediaType: "application/json", byteLength: 1, sha256: hash },
      { path: "assets/assets.json", logicalType: "assets", mediaType: "application/json", byteLength: 1, sha256: hash },
      { path: archivePath, logicalType: "asset-original", mediaType: "image/png", byteLength: 1, sha256: hash }
    ];
    const manifest = {
      format: "infinite-quest-archive",
      formatVersion: 1,
      archiveType: "campaign",
      createdAt: "2026-07-26T12:00:00.000Z",
      contentFingerprint: hash,
      campaignId,
      worldId,
      worldVersionId,
      entries,
      payloads: [
        { kind: "campaign", path: "campaign.json", formatVersion: 3 },
        { kind: "world", path: "world.json", formatVersion: 1 },
        { kind: "chronicle", path: "chronicle.json", formatVersion: 1 },
        { kind: "assets", path: "assets/assets.json", formatVersion: 1 }
      ],
      assets: [asset, { ...asset }]
    };
    await writeLegacyZip(path, [{ name: "manifest.json", content: JSON.stringify(manifest) }]);
    const staged = await stageArchiveUpload(createReadStream(path), root, limits);
    const pool = {
      query: async () => {
        throw new Error("Preview must reject the manifest before database access.");
      }
    } as unknown as DatabasePool;
    const config = {
      archiveStorageRoot: root,
      archivePreviewTtlSeconds: 1_800,
      campaignArchiveLimits: limits
    } as RuntimeConfig;

    await expect(previewCampaignArchive(
      pool,
      config,
      staged,
      "duplicate-manifest-assets.zip",
      { kind: "embedded" }
    )).rejects.toMatchObject({ code: "archive-asset-invalid" });
  });
});

describe("legacy campaign ZIP adaptation", () => {
  it("persists the preview-time staged compressed size for commit rehydration", async () => {
    const root = await temporaryRoot();
    const path = join(root, "persisted-size.zip");
    await writeLegacyZip(path, [{
      name: "campaign.json",
      content: JSON.stringify({ world: { schemaVersion: 4, world: { title: "Persisted size" } }, turns: [] })
    }]);
    const staged = await stageArchiveUpload(createReadStream(path), root, limits);
    const queries: Array<{ text: string; values: readonly unknown[] }> = [];
    const query = async (text: string, values: readonly unknown[] = []) => {
      queries.push({ text, values });
      if (text.includes("FROM users")) {
        return { rows: [{ id: "00000000-0000-4000-8000-000000000001" }] };
      }
      return { rows: [] };
    };
    const pool = {
      query,
      connect: async () => ({
        query,
        release: () => undefined
      })
    } as unknown as DatabasePool;
    const config = {
      archiveStorageRoot: root,
      archivePreviewTtlSeconds: 1_800,
      campaignArchiveLimits: limits
    } as RuntimeConfig;

    await previewCampaignArchive(pool, config, staged, "persisted-size.zip", { kind: "embedded" });

    const insert = queries.find((query) => query.text.includes("INSERT INTO archive_previews"));
    expect(JSON.parse(String(insert?.values[7]))).toMatchObject({
      stagedCompressedBytes: staged.compressedBytes
    });
  });

  it("hashes destination world content through the export-compatible secret sanitization path", () => {
    const portableWorld = {
      schemaVersion: 4,
      world: { title: "Compatible destination", provider: { model: "local-model" } }
    };
    const destinationWorld = {
      ...portableWorld,
      world: { ...portableWorld.world, provider: { ...portableWorld.world.provider, apiKey: "destination-only-secret" } }
    };

    expect(portableWorldContentHash(destinationWorld)).toBe(portableWorldContentHash(portableWorld));
  });

  it("rejects duplicate legacy entries through the shared strict archive validation", async () => {
    const root = await temporaryRoot();
    const path = join(root, "duplicate-campaign.zip");
    const campaign = JSON.stringify({ world: { schemaVersion: 4, world: { title: "Legacy archive" } }, turns: [] });
    await writeLegacyZip(path, [
      { name: "campaign.json", content: campaign },
      { name: "campaign.json", content: campaign }
    ]);

    const staged = await stageArchiveUpload(createReadStream(path), root, limits);

    await expect(adaptLegacyCampaignZip(staged, limits)).rejects.toMatchObject({ code: "archive-entry-duplicate" });
  });

  it("adapts a manifest-less legacy ZIP and reports compatibility warnings", async () => {
    const root = await temporaryRoot();
    const path = join(root, "legacy-campaign.zip");
    await writeLegacyZip(path, [{
      name: "campaign.json",
      content: JSON.stringify({ world: { schemaVersion: 4, world: { title: "Legacy archive" } }, turns: [] })
    }]);

    const staged = await stageArchiveUpload(createReadStream(path), root, limits);

    await expect(decodeCampaignArchive(staged, limits)).resolves.toMatchObject({
      warnings: expect.arrayContaining([expect.stringMatching(/no archive manifest/i)])
    });
  });

  it("rejects a legacy turn image pointer without a declared asset binding", async () => {
    const root = await temporaryRoot();
    const path = join(root, "legacy-pointer.zip");
    const missingAssetId = "11111111-1111-4111-8111-111111111111";
    await writeLegacyZip(path, [{
      name: "campaign.json",
      content: JSON.stringify({
        world: { schemaVersion: 4, world: { title: "Legacy archive" } },
        turns: [{ id: "22222222-2222-4222-8222-222222222222", imageUrl: `/api/v1/assets/${missingAssetId}` }]
      })
    }]);

    const staged = await stageArchiveUpload(createReadStream(path), root, limits);

    await expect(adaptLegacyCampaignZip(staged, limits)).rejects.toMatchObject({ code: "archive-asset-missing" });
  });

  it("rejects a world portable asset pointer without a declared world-version binding", async () => {
    const root = await temporaryRoot();
    const path = join(root, "legacy-world-pointer.zip");
    const missingAssetId = "33333333-3333-4333-8333-333333333333";
    await writeLegacyZip(path, [{
      name: "campaign.json",
      content: JSON.stringify({
        world: { schemaVersion: 4, world: { title: "Legacy archive", firstAction: `/api/v1/assets/${missingAssetId}` } },
        turns: []
      })
    }]);

    const staged = await stageArchiveUpload(createReadStream(path), root, limits);

    await expect(adaptLegacyCampaignZip(staged, limits)).rejects.toMatchObject({ code: "archive-asset-missing" });
  });
});
