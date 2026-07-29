import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { once } from "node:events";
import { Readable } from "node:stream";
import { ZipArchive } from "archiver";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeConfig } from "../../packages/database/src/config.js";
import type { DatabasePool } from "../../packages/database/src/pool.js";
import { calculateContentFingerprint, canonicalArchiveJson, type ArchiveEntry, type ArchiveManifest } from "../../packages/contracts/src/archives.js";
import { stageArchiveUpload, writeArchiveArtifact, type ArchiveLimits } from "../../services/api/src/archive-io.js";
import { adaptLegacyCampaignZip, captureCampaignArchiveSnapshot, cleanupExpiredArchivePreviews, decodeCampaignArchive, portableWorldContentHash, previewCampaignArchive } from "../../services/api/src/campaign-archive-service.js";

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

async function stagedCampaignArchive(
  root: string,
  overrides: {
    turns?: unknown[];
    archiveRecords?: Record<string, unknown>;
    chronicle?: Record<string, unknown>;
  } = {}
) {
  const campaignId = "11111111-1111-4111-8111-111111111111";
  const worldId = "22222222-2222-4222-8222-222222222222";
  const worldVersionId = "33333333-3333-4333-8333-333333333333";
  const content = { schemaVersion: 4, world: { title: "Archive validation world" } };
  const canonicalHash = portableWorldContentHash(content);
  const values = [
    ["campaign.json", "campaign", {
      campaign: { sourceCampaignId: campaignId, title: "Archive validation campaign" },
      world: { canonicalHash, sourceWorldId: worldId, sourceWorldVersionId: worldVersionId },
      turns: overrides.turns ?? [{ id: "44444444-4444-4444-8444-444444444444", turnNumber: 1 }],
      archiveRecords: {
        formatVersion: 1,
        characterProfileEdits: [],
        stateEdits: [],
        worldMigrations: [],
        illustrationConfig: null,
        illustrationSets: [],
        illustrationSegments: [],
        costs: [],
        ...overrides.archiveRecords
      }
    }],
    ["world.json", "world", {
      canonicalHash,
      sourceWorldId: worldId,
      sourceWorldVersionId: worldVersionId,
      versionNumber: 1,
      content
    }],
    ["chronicle.json", "chronicle", {
      formatVersion: 1,
      memories: [],
      summaries: [],
      ...overrides.chronicle
    }],
    ["assets/assets.json", "assets", { formatVersion: 1, assets: [] }]
  ] as const;
  const artifact = await writeArchiveArtifact(
    root,
    values.map(([path, logicalType, value]) => ({
      path,
      logicalType,
      mediaType: "application/json",
      source: Readable.from(Buffer.from(canonicalArchiveJson(value), "utf8"))
    })),
    (entries: readonly ArchiveEntry[]): ArchiveManifest => ({
      format: "infinite-quest-archive",
      formatVersion: 1,
      archiveType: "campaign",
      createdAt: "2026-07-28T00:00:00.000Z",
      contentFingerprint: calculateContentFingerprint({
        payloadHashes: entries.map((entry) => entry.sha256),
        originalAssetHashes: []
      }),
      campaignId,
      worldId,
      worldVersionId,
      entries: [...entries],
      payloads: values.map(([path, kind]) => ({
        kind,
        path,
        formatVersion: kind === "campaign" ? 3 : 1
      })),
      assets: []
    }),
    limits
  );
  return stageArchiveUpload(createReadStream(artifact.absolutePath), root, limits);
}

describe("campaign archive preview validation", () => {
  it("rejects a dangling illustration-set turn reference with actionable details during decode", async () => {
    const root = await temporaryRoot();
    const missingTurnId = "55555555-5555-4555-8555-555555555555";
    const staged = await stagedCampaignArchive(root, {
      archiveRecords: {
        illustrationSets: [{
          id: "66666666-6666-4666-8666-666666666666",
          turn_id: missingTurnId
        }]
      }
    });

    await expect(decodeCampaignArchive(staged, limits)).rejects.toMatchObject({
      code: "archive-json-invalid",
      details: {
        payload: "campaign",
        collection: "archiveRecords.illustrationSets",
        field: "turn_id",
        recordId: "66666666-6666-4666-8666-666666666666",
        referenceId: missingTurnId
      }
    });
  });

  it.each([
    {
      name: "Chronicle memory",
      collection: "memories",
      payload: "chronicle",
      overrides: {
        chronicle: {
          memories: [{
            id: "66666666-6666-4666-8666-666666666666",
            turn_id: "55555555-5555-4555-8555-555555555555"
          }]
        }
      }
    },
    {
      name: "illustration segment",
      collection: "archiveRecords.illustrationSegments",
      payload: "campaign",
      overrides: {
        archiveRecords: {
          illustrationSets: [{
            id: "77777777-7777-4777-8777-777777777777",
            turn_id: "44444444-4444-4444-8444-444444444444"
          }],
          illustrationSegments: [{
            id: "66666666-6666-4666-8666-666666666666",
            illustration_set_id: "77777777-7777-4777-8777-777777777777",
            turn_id: "55555555-5555-4555-8555-555555555555"
          }]
        }
      }
    },
    {
      name: "provider cost",
      collection: "archiveRecords.costs",
      payload: "campaign",
      overrides: {
        archiveRecords: {
          costs: [{
            id: "66666666-6666-4666-8666-666666666666",
            turn_id: "55555555-5555-4555-8555-555555555555"
          }]
        }
      }
    }
  ])("rejects a dangling $name turn reference during decode", async ({ collection, payload, overrides }) => {
    const root = await temporaryRoot();
    const staged = await stagedCampaignArchive(root, overrides);

    await expect(decodeCampaignArchive(staged, limits)).rejects.toMatchObject({
      code: "archive-json-invalid",
      details: {
        payload,
        collection,
        field: "turn_id",
        recordId: "66666666-6666-4666-8666-666666666666",
        referenceId: "55555555-5555-4555-8555-555555555555"
      }
    });
  });

  it("omits legacy turnless illustration records and reports a compatibility warning", async () => {
    const root = await temporaryRoot();
    const acceptedTurnId = "44444444-4444-4444-8444-444444444444";
    const acceptedSetId = "55555555-5555-4555-8555-555555555555";
    const provisionalSetId = "66666666-6666-4666-8666-666666666666";
    const staged = await stagedCampaignArchive(root, {
      archiveRecords: {
        illustrationSets: [
          { id: acceptedSetId, turn_id: acceptedTurnId, status: "completed" },
          { id: provisionalSetId, turn_id: null, status: "provisional" }
        ],
        illustrationSegments: [
          {
            id: "77777777-7777-4777-8777-777777777777",
            illustration_set_id: acceptedSetId,
            turn_id: acceptedTurnId,
            status: "completed"
          },
          {
            id: "88888888-8888-4888-8888-888888888888",
            illustration_set_id: provisionalSetId,
            turn_id: null,
            status: "generating"
          }
        ]
      }
    });

    const decoded = await decodeCampaignArchive(staged, limits);

    expect(decoded.campaign.archiveRecords.illustrationSets).toEqual([
      expect.objectContaining({ id: acceptedSetId, turn_id: acceptedTurnId })
    ]);
    expect(decoded.campaign.archiveRecords.illustrationSegments).toEqual([
      expect.objectContaining({
        id: "77777777-7777-4777-8777-777777777777",
        illustration_set_id: acceptedSetId,
        turn_id: acceptedTurnId
      })
    ]);
    expect(decoded.warnings).toContain(
      "Ignored 1 turnless illustration set and 1 turnless illustration segment because provisional illustration work is not portable."
    );
  });

  it("rejects an illustration segment whose set is not included", async () => {
    const root = await temporaryRoot();
    const missingSetId = "55555555-5555-4555-8555-555555555555";
    const staged = await stagedCampaignArchive(root, {
      archiveRecords: {
        illustrationSegments: [{
          id: "66666666-6666-4666-8666-666666666666",
          illustration_set_id: missingSetId,
          turn_id: "44444444-4444-4444-8444-444444444444"
        }]
      }
    });

    await expect(decodeCampaignArchive(staged, limits)).rejects.toMatchObject({
      code: "archive-json-invalid",
      details: {
        payload: "campaign",
        collection: "archiveRecords.illustrationSegments",
        field: "illustration_set_id",
        recordId: "66666666-6666-4666-8666-666666666666",
        referenceId: missingSetId
      }
    });
  });

  it("rejects an illustration segment assigned to a different turn than its set", async () => {
    const root = await temporaryRoot();
    const setId = "66666666-6666-4666-8666-666666666666";
    const segmentId = "77777777-7777-4777-8777-777777777777";
    const staged = await stagedCampaignArchive(root, {
      turns: [
        { id: "44444444-4444-4444-8444-444444444444", turnNumber: 1 },
        { id: "55555555-5555-4555-8555-555555555555", turnNumber: 2 }
      ],
      archiveRecords: {
        illustrationSets: [{
          id: setId,
          turn_id: "44444444-4444-4444-8444-444444444444"
        }],
        illustrationSegments: [{
          id: segmentId,
          illustration_set_id: setId,
          turn_id: "55555555-5555-4555-8555-555555555555"
        }]
      }
    });

    await expect(decodeCampaignArchive(staged, limits)).rejects.toMatchObject({
      code: "archive-json-invalid",
      details: {
        payload: "campaign",
        collection: "archiveRecords.illustrationSegments",
        field: "turn_id",
        recordId: segmentId,
        referenceId: "55555555-5555-4555-8555-555555555555",
        expectedReferenceId: "44444444-4444-4444-8444-444444444444"
      }
    });
  });

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

describe("campaign archive snapshot portability", () => {
  it("excludes turnless provisional illustration records from new exports", async () => {
    const ownerUserId = "00000000-0000-4000-8000-000000000001";
    const campaignId = "11111111-1111-4111-8111-111111111111";
    const turnId = "22222222-2222-4222-8222-222222222222";
    const acceptedSet = { id: "33333333-3333-4333-8333-333333333333", turn_id: turnId };
    const acceptedSegment = {
      id: "55555555-5555-4555-8555-555555555555",
      illustration_set_id: acceptedSet.id,
      turn_id: turnId
    };
    const query = async (text: string) => {
      if (text.includes("FROM users")) return { rows: [{ id: ownerUserId }], rowCount: 1 };
      if (text.includes("FROM campaigns c")) {
        return {
          rows: [{
            id: campaignId,
            owner_user_id: ownerUserId,
            world_id: "77777777-7777-4777-8777-777777777777",
            world_version_id: "88888888-8888-4888-8888-888888888888",
            version_number: 1,
            content: { schemaVersion: 4, world: { title: "Snapshot world" } },
            active_turn_number: 1,
            state_revision: 0
          }],
          rowCount: 1
        };
      }
      if (text.includes("FROM turns WHERE")) {
        return {
          rows: [{ id: turnId, turn_number: 1, accepted_at: new Date("2026-07-28T00:00:00.000Z") }],
          rowCount: 1
        };
      }
      if (text.includes("FROM turn_illustration_sets") && !text.includes("JOIN turn_illustration_sets")) {
        expect(text).toContain("turn_id IS NOT NULL");
        return { rows: [acceptedSet], rowCount: 1 };
      }
      if (text.includes("FROM turn_illustration_segments")) {
        expect(text).toContain("JOIN turn_illustration_sets");
        expect(text).toContain("seg.turn_id IS NOT NULL");
        expect(text).toContain("illustration_set.turn_id=seg.turn_id");
        return { rows: [acceptedSegment], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    const client = { query, release: () => undefined };
    const pool = { connect: async () => client } as unknown as DatabasePool;

    const snapshot = await captureCampaignArchiveSnapshot(pool, campaignId);

    expect(snapshot.illustrationSets).toEqual([acceptedSet]);
    expect(snapshot.illustrationSegments).toEqual([acceptedSegment]);
  });
});

describe("campaign archive preview staging cleanup", () => {
  it("retries relinquished superseded, consumed, and failed paths without deleting the active replacement", async () => {
    const root = await temporaryRoot();
    const ownerUserId = "00000000-0000-4000-8000-000000000001";
    const cleanupRows = [
      { id: "superseded-preview", status: "superseded", stagedPath: "staging/superseded.zip", cleanupPending: true },
      { id: "consumed-preview", status: "consumed", stagedPath: "staging/consumed.zip", cleanupPending: true },
      { id: "failed-preview", status: "failed", stagedPath: "staging/failed.zip", cleanupPending: true },
      { id: "replacement-preview", status: "previewed", stagedPath: "staging/replacement.zip", cleanupPending: false }
    ];
    for (const row of cleanupRows.filter((row) => row.cleanupPending)) {
      await mkdir(join(root, row.stagedPath), { recursive: true });
    }
    const replacementPath = join(root, cleanupRows[3]!.stagedPath);
    await mkdir(dirname(replacementPath), { recursive: true });
    await writeFile(replacementPath, "replacement", { flag: "wx" });
    const query = async (text: string, values: readonly unknown[] = []) => {
      if (text.includes("FROM users")) return { rows: [{ id: ownerUserId }] };
      if (text.includes("SET status='expired'")) return { rows: [] };
      if (text.includes("status='expired'") && text.includes("stagingCleanupPending") && text.includes("IS NULL")) return { rows: [] };
      if (text.includes("SELECT id,staged_archive_path,status") && text.includes("stagingCleanupPending")) {
        return {
          rows: cleanupRows
            .filter((row) => row.cleanupPending && row.status !== "previewed")
            .map((row) => ({ id: row.id, staged_archive_path: row.stagedPath, status: row.status }))
        };
      }
      if (text.includes("SELECT 1") && text.includes("status='previewed'")) {
        const stagedPath = String(values[1]);
        const referenced = cleanupRows.some((row) => row.status === "previewed" && row.stagedPath === stagedPath);
        return { rows: referenced ? [{ "?column?": 1 }] : [], rowCount: referenced ? 1 : 0 };
      }
      if (text.includes("'false'::jsonb") && text.includes("stagingCleanupPending")) {
        const row = cleanupRows.find((candidate) => candidate.id === values[0] && candidate.stagedPath === values[2]);
        if (row) row.cleanupPending = false;
        return { rows: [], rowCount: row ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    };
    const pool = { query } as unknown as DatabasePool;
    const config = {
      archiveStorageRoot: root,
      archivePreviewTtlSeconds: 1_800,
      campaignArchiveLimits: limits
    } as RuntimeConfig;

    await expect(cleanupExpiredArchivePreviews(pool, config)).resolves.toEqual({
      expiredCount: 0,
      cleanupFailureCount: 3
    });
    expect(cleanupRows.slice(0, 3).every((row) => row.cleanupPending)).toBe(true);

    for (const row of cleanupRows.slice(0, 3)) {
      const stagedPath = join(root, row.stagedPath);
      await rmdir(stagedPath);
      await writeFile(stagedPath, row.status, { flag: "wx" });
    }

    await expect(cleanupExpiredArchivePreviews(pool, config)).resolves.toEqual({
      expiredCount: 0,
      cleanupFailureCount: 0
    });
    expect(cleanupRows.slice(0, 3).every((row) => !row.cleanupPending)).toBe(true);
    for (const row of cleanupRows.slice(0, 3)) {
      await expect(stat(join(root, row.stagedPath))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect((await stat(replacementPath)).isFile()).toBe(true);
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
