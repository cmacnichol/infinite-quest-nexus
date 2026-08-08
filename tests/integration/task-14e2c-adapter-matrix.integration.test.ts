import { createHash } from "node:crypto";
import { readFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toAssetMutationIdempotencyKey } from "../../packages/application/src/assets/index.js";
import {
  toPortableImportedRecordId,
  toPortableSourceInstallationId,
  type PortableImportKind,
  type PortableImportPreviewCommand,
  type PortableImportPreviewProjectionFor,
  type PortableImportResultProjectionFor
} from "../../packages/application/src/imports/index.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { writeArchiveArtifact, type ArchiveLimits } from "../../services/api/src/archive-io.js";
import { createTask14e2cAdapters } from "../helpers/task-14e2c-adapters.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

const limits: ArchiveLimits = {
  maxCompressedBytes: 2_000_000,
  maxUncompressedBytes: 4_000_000,
  maxEntries: 100,
  maxExpansionRatio: 100,
  maxManifestBytes: 100_000,
  maxJsonEntryBytes: 500_000,
  maxOriginalImageBytes: 1_000_000
};
const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

type PortableVariant = Readonly<{
  label: string;
  command: Omit<PortableImportPreviewCommand, "ownerUserId" | "stagedInput">;
  projection: PortableImportPreviewProjectionFor<PortableImportKind>;
}>;

integration("Task 14e2c additive adapter contract matrix", () => {
  let pool: DatabasePool;
  let ownerUserId = "";
  let foreignOwnerUserId = "";
  let zipBytes = Buffer.alloc(0);
  const roots: string[] = [];

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 8);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    const foreign = await pool.query<{ id: string }>(
      "INSERT INTO users (system_key,display_name) VALUES ($1,$2) RETURNING id",
      [`task-14e2c-foreign-${crypto.randomUUID()}`, "Task 14e2c foreign owner"]
    );
    foreignOwnerUserId = foreign.rows[0]!.id;
    const sourceRoot = await root("iq-14e2c-source-");
    const artifact = await writeArchiveArtifact(sourceRoot, [{
      path: "records/legacy-story.json",
      logicalType: "records",
      mediaType: "application/json",
      source: Readable.from(Buffer.from('{"title":"Adapter Story"}', "utf8"))
    }], (entries) => ({
      format: "infinite-quest-archive",
      formatVersion: 1,
      archiveType: "system",
      createdAt: "2026-08-08T00:00:00.000Z",
      contentFingerprint: "a".repeat(64),
      entries: [...entries],
      payloads: entries.map((entry) => ({ kind: "records" as const, path: entry.path, formatVersion: 1 })),
      assets: []
    }), limits);
    zipBytes = await readFile(artifact.absolutePath);
  });

  afterAll(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    await pool.end();
  });

  async function root(prefix: string): Promise<string> {
    const value = await mkdtemp(join(tmpdir(), prefix));
    roots.push(value);
    return value;
  }

  function hash(value: string | Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
  }

  async function worldScope(scopedOwner = ownerUserId) {
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id,title) VALUES ($1,$2) RETURNING id",
      [scopedOwner, `Task 14e2c world ${crypto.randomUUID()}`]
    );
    const version = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id,owner_user_id,version_number,content)
       VALUES ($1,$2,1,'{}'::jsonb) RETURNING id`,
      [world.rows[0]!.id, scopedOwner]
    );
    const campaign = await pool.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id,world_version_id,title) VALUES ($1,$2,$3) RETURNING id",
      [scopedOwner, version.rows[0]!.id, "Task 14e2c campaign"]
    );
    const turn = await pool.query<{ id: string }>(
      "INSERT INTO turns (owner_user_id,campaign_id,turn_number,narration) VALUES ($1,$2,1,$3) RETURNING id",
      [scopedOwner, campaign.rows[0]!.id, "A test scene waits for its illustration."]
    );
    return {
      worldId: world.rows[0]!.id,
      worldVersionId: version.rows[0]!.id,
      campaignId: campaign.rows[0]!.id,
      turnId: turn.rows[0]!.id
    };
  }

  async function asset(scopedOwner = ownerUserId, dimensions: readonly [number | null, number | null] = [null, null]) {
    const contentHash = hash(crypto.randomUUID());
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO assets (
         owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length,pixel_width,pixel_height
       ) VALUES ($1,$2,'filesystem',$3,'image/png',128,$4,$5) RETURNING id`,
      [scopedOwner, contentHash, `originals/legacy-${contentHash}.png`, dimensions[0], dimensions[1]]
    );
    return { assetId: inserted.rows[0]!.id, contentHash };
  }

  function portableVariants(scope: Awaited<ReturnType<typeof worldScope>>): PortableVariant[] {
    const campaignProjection = {
      valid: true as const,
      archiveType: "campaign" as const,
      formatVersion: 1 as const,
      contentFingerprint: hash("task-14e2c-campaign"),
      campaign: {
        title: "Portable campaign",
        sourceCampaignId: crypto.randomUUID(),
        acceptedTurnCount: 2,
        activeTurnNumber: 2,
        selectedCharacter: null
      },
      world: {
        title: "Portable world",
        sourceWorldId: crypto.randomUUID(),
        sourceWorldVersionId: crypto.randomUUID(),
        versionNumber: 1
      },
      chronicle: { memoryCount: 2, summaryCount: 1 },
      assets: { originalCount: 1, totalBytes: 42 },
      providerDataIncluded: false as const,
      warnings: [] as string[]
    };
    return [
      {
        label: "campaign ZIP embedded create-world",
        command: {
          kind: "campaign_zip",
          destination: { kind: "embedded", operation: "create_world" },
          sourceInstallationId: toPortableSourceInstallationId(foreignOwnerUserId),
          importedRecordId: toPortableImportedRecordId(crypto.randomUUID())
        },
        projection: {
          ...campaignProjection,
          destination: { kind: "embedded", operation: "create_world", worldId: null, worldVersionId: null }
        }
      },
      {
        label: "campaign ZIP existing version",
        command: {
          kind: "campaign_zip",
          destination: { kind: "existing_world_version", worldId: scope.worldId, worldVersionId: scope.worldVersionId }
        },
        projection: {
          ...campaignProjection,
          destination: {
            kind: "existing_world_version",
            operation: "attach_existing_world_version",
            worldId: scope.worldId,
            worldVersionId: scope.worldVersionId
          }
        }
      },
      {
        label: "Legacy Story existing version",
        command: {
          kind: "legacy_story",
          destination: { kind: "existing_world_version", worldId: scope.worldId, worldVersionId: scope.worldVersionId }
        },
        projection: {
          kind: "campaign", valid: true, title: "Legacy Story", duplicate: false,
          existingCampaignId: null,
          counts: { turns: 2, completeHistoryCharacters: 20, estimatedHistoryTokens: 5 },
          warnings: []
        }
      },
      {
        label: "story text existing version",
        command: {
          kind: "story_text",
          destination: { kind: "existing_world_version", worldId: scope.worldId, worldVersionId: scope.worldVersionId }
        },
        projection: {
          kind: "story_text", valid: true, title: "Story text", duplicate: false,
          existingCampaignId: null, targetWorldId: scope.worldId, diagnostics: [], characters: [],
          selectedCharacterId: null,
          counts: { turns: 2, completeHistoryCharacters: 20, estimatedHistoryTokens: 5 },
          warnings: []
        }
      },
      ...(["infinite_worlds", "world_json"] as const).map((kind) => ({
        label: `${kind} create-world`,
        command: { kind, destination: { kind: "create_world" as const } },
        projection: {
          kind: "world_json" as const, valid: true as const, title: `${kind} world`, duplicate: false,
          existingWorldId: null, characters: [],
          counts: { entities: 1, relationships: 0, triggers: 0 }, warnings: []
        }
      })),
      {
        label: "CYOA create-world",
        command: { kind: "cyoa", destination: { kind: "create_world" } },
        projection: {
          kind: "cyoa_json", valid: true, requiresProvider: false, warnings: [],
          counts: { topLevelTitle: "CYOA", layer1ChaptersCount: 2, characterTarget: "Hero" }
        }
      },
      {
        label: "world text create-world",
        command: { kind: "world_text", destination: { kind: "create_world" } },
        projection: {
          kind: "world_text", valid: true, requiresProvider: true, warnings: [],
          counts: { sourceCharacters: 100, sourceWords: 20 }
        }
      }
    ];
  }

  function portableResult(
    kind: PortableImportKind,
    importId: string,
    scope: Awaited<ReturnType<typeof worldScope>>,
  ): PortableImportResultProjectionFor<PortableImportKind> {
    if (kind === "campaign_zip") {
      return {
        importId,
        worldId: scope.worldId,
        worldVersionId: scope.worldVersionId,
        campaignId: scope.campaignId,
        duplicate: false,
        stats: { turnCount: 2, memoryCount: 2, summaryCount: 1, assetCount: 1, assetBytes: 42 }
      };
    }
    if (kind === "legacy_story" || kind === "story_text") {
      return {
        ...(kind === "story_text" ? { kind: "campaign" as const } : {}),
        importId,
        worldId: scope.worldId,
        worldVersionId: scope.worldVersionId,
        campaignId: scope.campaignId,
        duplicate: false,
        stats: {
          turnCount: 2,
          memoryCount: 2,
          completeHistoryCharacters: 20,
          estimatedHistoryTokens: 5,
          importedSummary: true,
          sanitizedMemoryCount: 2
        }
      };
    }
    return {
      kind: "world",
      importId,
      worldId: scope.worldId,
      worldVersionId: scope.worldVersionId,
      duplicate: false
    };
  }

  it("reserves durable staging before filesystem mutation and denies the resulting handle to another owner", async () => {
    const storageRoot = await root("iq-14e2c-storage-");
    const adapters = createTask14e2cAdapters({
      pool,
      archiveRoot: storageRoot,
      assetRoot: storageRoot,
      limits
    });

    const staged = await adapters.archive.stage(
      { ownerUserId },
      Readable.from(zipBytes),
      zipBytes.byteLength,
    );
    const inspection = await adapters.archive.inspect({ ownerUserId }, staged, "container");

    expect(inspection.entries.map((entry) => entry.path)).toContain("records/legacy-story.json");
    await expect(adapters.archive.inspect(
      { ownerUserId: foreignOwnerUserId },
      staged,
      "container",
    )).rejects.toEqual({ code: "archive_unavailable" });
    const operation = await pool.query<{ lifecycle: string; purpose: string }>(
      `SELECT operation.lifecycle,operation.purpose
         FROM portable_staged_inputs staged
         JOIN durable_filesystem_operations operation ON operation.id=staged.filesystem_operation_id
        WHERE staged.owner_user_id=$1`,
      [ownerUserId]
    );
    expect(operation.rows.at(-1)).toEqual({ lifecycle: "finalized", purpose: "portable_staging" });
    await adapters.archive.cleanup({ ownerUserId }, staged);
  });

  it("composes selection clear, metadata, derivative delivery, and database-owned backfill leases", async () => {
    const storageRoot = await root("iq-14e2c-assets-");
    const adapters = createTask14e2cAdapters({ pool, archiveRoot: storageRoot, assetRoot: storageRoot, limits });
    const target = await worldScope();
    const selected = await asset(ownerUserId, [640, 360]);
    const thumbnailHash = hash(`thumbnail:${selected.assetId}`);
    await pool.query(
      `INSERT INTO asset_derivatives (
         owner_user_id,source_asset_id,derivative_kind,transform_version,pixel_width,pixel_height,
         storage_driver,storage_path,mime_type,byte_length,content_hash
       ) VALUES ($1,$2,'thumbnail',1,480,270,'filesystem',$3,'image/webp',64,$4)`,
      [ownerUserId, selected.assetId, `derivatives/${thumbnailHash}.webp`, thumbnailHash]
    );
    await pool.query(
      "UPDATE asset_metadata_backfill_jobs SET next_attempt_at=now()+interval '1 day' WHERE owner_user_id=$1 AND asset_id=$2",
      [ownerUserId, selected.assetId]
    );

    await expect(adapters.assets.selectTurnIllustration(
      { ownerUserId, campaignId: target.campaignId, turnId: target.turnId },
      { assetId: selected.assetId, idempotencyKey: toAssetMutationIdempotencyKey(`select-${crypto.randomUUID()}`) },
    )).resolves.toEqual({ assetId: selected.assetId, selected: true });
    const cleared = await adapters.assets.selectTurnIllustration(
      { ownerUserId, campaignId: target.campaignId, turnId: target.turnId },
      { assetId: null, idempotencyKey: toAssetMutationIdempotencyKey(`clear-${crypto.randomUUID()}`) },
    );
    expect(cleared).toEqual({ assetId: null, selected: false });

    const metadata = await adapters.assets.updateAssetMetadata(
      { ownerUserId, assetId: selected.assetId },
      {
        expectedRevision: 1,
        title: "Adapter remapped illustration",
        tags: ["archive-remap", "illustration"],
        idempotencyKey: toAssetMutationIdempotencyKey(`metadata-${crypto.randomUUID()}`)
      },
    );
    expect(metadata).toEqual({ assetId: selected.assetId, metadataRevision: 2 });
    await expect(adapters.assets.describeAssetDelivery(
      { ownerUserId, assetId: selected.assetId },
      { kind: "derivative", derivativeKind: "thumbnail" },
    )).resolves.toMatchObject({
      assetId: selected.assetId,
      kind: "derivative",
      derivativeKind: "thumbnail",
      mimeType: "image/webp",
      byteLength: 64,
      etag: thumbnailHash
    });
    await expect(adapters.assets.describeAssetDelivery(
      { ownerUserId: foreignOwnerUserId, assetId: selected.assetId },
      { kind: "original" },
    )).rejects.toMatchObject({ code: "asset_not_found" });

    const incomplete = await asset(foreignOwnerUserId);
    await pool.query(
      "INSERT INTO asset_metadata_backfill_jobs (owner_user_id,asset_id) VALUES ($1,$2)",
      [foreignOwnerUserId, incomplete.assetId]
    );
    const claim = await adapters.assets.claimNextMetadataBackfill({ workerId: "task-14e2c-worker", leaseSeconds: 60 });
    expect(claim).not.toBeNull();
    expect(claim?.ownerUserId).toBe(foreignOwnerUserId);
    expect(claim?.assetId).toBe(incomplete.assetId);
    if (!claim) throw new Error("Expected database-derived backfill claim.");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const failed = await adapters.assets.backfillMetadata(client, claim);
      expect(failed).toEqual({
        assetId: incomplete.assetId,
        outcome: "safe_failure",
        diagnosticCode: "asset_metadata_unavailable"
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const diagnostic = await pool.query<{ diagnostic_code: string; leaked: string | null }>(
      `SELECT diagnostic_code,
              CASE WHEN diagnostic_code LIKE '%/%' OR diagnostic_code LIKE '%Error%' THEN diagnostic_code END AS leaked
         FROM asset_metadata_backfill_jobs
        WHERE owner_user_id=$1 AND asset_id=$2`,
      [foreignOwnerUserId, incomplete.assetId]
    );
    expect(diagnostic.rows[0]).toEqual({ diagnostic_code: "asset_metadata_unavailable", leaked: null });
  });

  it("drives all eight campaign ZIP, Legacy Story, Infinite Worlds/CYOA, and text variants through durable adapters", async () => {
    const storageRoot = await root("iq-14e2c-portable-");
    const adapters = createTask14e2cAdapters({ pool, archiveRoot: storageRoot, assetRoot: storageRoot, limits });
    const scope = await worldScope();
    const labels: string[] = [];

    for (const variant of portableVariants(scope)) {
      const stagedInput = await adapters.archive.stage(
        { ownerUserId },
        Readable.from(zipBytes),
        zipBytes.byteLength,
      );
      const command = {
        ...variant.command,
        ownerUserId,
        stagedInput
      } as PortableImportPreviewCommand;
      const preview = await adapters.archive.preview({
        command,
        projection: variant.projection,
      });
      expect(await adapters.imports.retrievePreviewPayload(
        { ownerUserId: foreignOwnerUserId },
        command.kind,
        preview.previewHandle,
      )).toBeNull();

      const commitCommand = {
        ownerUserId,
        kind: command.kind,
        destination: command.destination,
        previewHandle: preview.previewHandle,
        idempotencyKey: `task-14e2c-${command.kind}-${crypto.randomUUID()}`
      };
      const committed = await adapters.archive.commit(commitCommand, async (client) => {
        const campaignId = command.kind === "campaign_zip"
          || command.kind === "legacy_story"
          || command.kind === "story_text"
          ? scope.campaignId
          : null;
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO imports (
             owner_user_id,source_type,source_name,source_hash,status,
             world_id,world_version_id,campaign_id,stats,completed_at
           ) VALUES ($1,'task_14e2c',$2,$3,'completed',$4,$5,$6,'{}'::jsonb,now())
           RETURNING id`,
          [ownerUserId, variant.label, hash(`${hash(zipBytes)}:${variant.label}`), scope.worldId, scope.worldVersionId, campaignId]
        );
        const importId = inserted.rows[0]!.id;
        return {
          importId,
          importedRecordId: toPortableImportedRecordId(importId),
          duplicate: false,
          diagnostics: [],
          result: portableResult(command.kind, importId, scope),
          resultExpiresAt: new Date(Date.now() + 60_000).toISOString()
        };
      });
      expect(committed.kind).toBe(command.kind);
      expect((await adapters.archive.retrieve(
        { ownerUserId },
        command.kind,
        committed.retrieval,
      ))?.kind).toBe(command.kind);
      const replay = await adapters.archive.commit(commitCommand, async () => {
        throw new Error("Exact idempotent replay must not repeat domain work.");
      });
      expect(replay).toEqual(committed);
      await adapters.archive.cleanup({ ownerUserId }, stagedInput);
      labels.push(variant.label);
    }

    expect(labels).toEqual([
      "campaign ZIP embedded create-world",
      "campaign ZIP existing version",
      "Legacy Story existing version",
      "story text existing version",
      "infinite_worlds create-world",
      "world_json create-world",
      "CYOA create-world",
      "world text create-world"
    ]);
    const provenance = await pool.query<{ owner_user_id: string; source_installation_id: string }>(
      `SELECT owner_user_id,source_installation_id
         FROM portable_import_operations
        WHERE source_installation_id=$1`,
      [foreignOwnerUserId]
    );
    expect(provenance.rows).toEqual([{ owner_user_id: ownerUserId, source_installation_id: foreignOwnerUserId }]);
  });

  it("cleans superseded, expired, aborted, rolled-back, and crash-recovered portable work", async () => {
    const storageRoot = await root("iq-14e2c-lifecycle-");
    const adapters = createTask14e2cAdapters({ pool, archiveRoot: storageRoot, assetRoot: storageRoot, limits });
    const scope = await worldScope();
    const legacy = portableVariants(scope).find((variant) => variant.command.kind === "legacy_story")!;

    async function stagedPreview(expiresAt?: string) {
      const stagedInput = await adapters.archive.stage(
        { ownerUserId },
        Readable.from(zipBytes),
        zipBytes.byteLength,
      );
      const command = {
        ...legacy.command,
        ownerUserId,
        stagedInput
      } as PortableImportPreviewCommand;
      const preview = await adapters.archive.preview({
        command,
        projection: legacy.projection,
        ...(expiresAt ? { expiresAt } : {})
      });
      return { stagedInput, command, preview };
    }

    const first = await stagedPreview();
    const replacement = await stagedPreview();
    expect(await adapters.imports.retrievePreviewPayload(
      { ownerUserId },
      first.command.kind,
      first.preview.previewHandle,
    )).toBeNull();
    const superseded = await pool.query<{ status: string }>(
      "SELECT status FROM portable_import_operations WHERE preview_token_hash=$1",
      [hash(first.preview.previewHandle.token)]
    );
    expect(superseded.rows[0]).toEqual({ status: "superseded" });
    await adapters.archive.abort({ ownerUserId }, first.stagedInput);
    await adapters.archive.abort({ ownerUserId }, replacement.stagedInput);

    const expiring = await stagedPreview();
    await pool.query(
      `UPDATE portable_import_operations
          SET expires_at=now()-interval '1 second'
        WHERE preview_token_hash=$1`,
      [hash(expiring.preview.previewHandle.token)]
    );
    expect(await adapters.imports.retrievePreviewPayload(
      { ownerUserId },
      expiring.command.kind,
      expiring.preview.previewHandle,
    )).toBeNull();
    await adapters.archive.abort({ ownerUserId }, expiring.stagedInput);

    const retrying = await stagedPreview();
    const retryCommand = {
      ownerUserId,
      kind: retrying.command.kind,
      destination: retrying.command.destination,
      previewHandle: retrying.preview.previewHandle,
      idempotencyKey: `task-14e2c-rollback-${crypto.randomUUID()}`
    };
    const rolledBackSourceHash = hash(`rollback:${crypto.randomUUID()}`);
    await expect(adapters.archive.commit(retryCommand, async (client) => {
      await client.query(
        "INSERT INTO imports (owner_user_id,source_type,source_name,source_hash,status) VALUES ($1,'task_14e2c','rollback',$2,'processing')",
        [ownerUserId, rolledBackSourceHash]
      );
      throw new Error("task_14e2c_forced_import_rollback");
    })).rejects.toThrow("task_14e2c_forced_import_rollback");
    expect((await pool.query(
      "SELECT 1 FROM imports WHERE owner_user_id=$1 AND source_hash=$2",
      [ownerUserId, rolledBackSourceHash]
    )).rowCount).toBe(0);
    const retried = await adapters.archive.commit(retryCommand, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO imports (
           owner_user_id,source_type,source_name,source_hash,status,world_id,world_version_id,campaign_id,stats,completed_at
         ) VALUES ($1,'task_14e2c','retry',$2,'completed',$3,$4,$5,'{}'::jsonb,now()) RETURNING id`,
        [ownerUserId, rolledBackSourceHash, scope.worldId, scope.worldVersionId, scope.campaignId]
      );
      const importId = inserted.rows[0]!.id;
      return {
        importId,
        importedRecordId: toPortableImportedRecordId(importId),
        duplicate: false,
        diagnostics: [],
        result: portableResult("legacy_story", importId, scope),
        resultExpiresAt: new Date(Date.now() + 60_000).toISOString()
      };
    });
    expect(retried.kind).toBe("legacy_story");
    await adapters.archive.cleanup({ ownerUserId }, retrying.stagedInput);

    await adapters.archive.stage(
      { ownerUserId },
      Readable.from(zipBytes),
      zipBytes.byteLength,
      { simulateCrashAfterAttach: true },
    );
    const crashed = await pool.query<{ id: string }>(
      `SELECT operation.id
         FROM durable_filesystem_operations operation
         LEFT JOIN portable_staged_inputs staged ON staged.filesystem_operation_id=operation.id
        WHERE operation.owner_user_id=$1 AND operation.purpose='portable_staging'
          AND operation.lifecycle='attached' AND staged.id IS NULL
        ORDER BY operation.created_at DESC LIMIT 1`,
      [ownerUserId]
    );
    await pool.query(
      `UPDATE durable_filesystem_operations
          SET lease_expires_at=now()-interval '1 second',expires_at=now()-interval '1 second'
        WHERE id=$1`,
      [crashed.rows[0]!.id]
    );
    const recovery = await adapters.archive.recover("task-14e2c-reaper");
    expect(recovery).toContainEqual({
      operationId: crashed.rows[0]!.id,
      ownerUserId,
      action: "cleanup",
      outcome: "cleaned"
    });
    const remainingFiles = (await readdir(storageRoot, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile());
    expect(remainingFiles).toHaveLength(0);
  });

  it("publishes and redeems a campaign ZIP with exact owner/scope and idempotent cleanup", async () => {
    const storageRoot = await root("iq-14e2c-export-");
    const adapters = createTask14e2cAdapters({ pool, archiveRoot: storageRoot, assetRoot: storageRoot, limits });
    const scope = await worldScope();
    const exportScope = {
      ownerUserId,
      exportKind: "campaign_zip" as const,
      campaignId: scope.campaignId,
      worldId: scope.worldId,
      worldVersionId: scope.worldVersionId
    };
    const payloads = [
      { path: "campaign.json", kind: "campaign" as const, formatVersion: 3 },
      { path: "world.json", kind: "world" as const, formatVersion: 1 },
      { path: "chronicle.json", kind: "chronicle" as const, formatVersion: 1 },
      { path: "assets/assets.json", kind: "assets" as const, formatVersion: 1 }
    ];
    const exported = await adapters.archive.publishCampaignExport(exportScope, payloads.map((payload) => ({
      path: payload.path,
      logicalType: payload.kind,
      mediaType: "application/json",
      source: Readable.from(Buffer.from(JSON.stringify({ formatVersion: payload.formatVersion }), "utf8"))
    })), (entries) => ({
      format: "infinite-quest-archive",
      formatVersion: 1,
      archiveType: "campaign",
      createdAt: "2026-08-08T00:00:00.000Z",
      contentFingerprint: hash("task-14e2c-export"),
      campaignId: scope.campaignId,
      worldId: scope.worldId,
      worldVersionId: scope.worldVersionId,
      entries: [...entries],
      payloads,
      assets: []
    }));

    await expect(adapters.archive.downloadExport(
      { ...exportScope, ownerUserId: foreignOwnerUserId },
      exported.retrieval,
    )).rejects.toEqual({ code: "archive_unavailable" });
    const downloaded = await adapters.archive.downloadExport(exportScope, exported.retrieval);
    expect(downloaded.content.subarray(0, 2)).toEqual(new Uint8Array([0x50, 0x4b]));
    expect(downloaded.byteLength).toBe(exported.byteLength);
    await adapters.archive.cleanupExport(exportScope, exported.retrieval);
    await expect(adapters.archive.cleanupExport(exportScope, exported.retrieval)).resolves.toBeUndefined();
    const persisted = await pool.query<{ status: string }>(
      "SELECT status FROM portable_export_artifacts WHERE owner_user_id=$1 AND campaign_id=$2",
      [ownerUserId, scope.campaignId]
    );
    expect(persisted.rows.at(-1)).toEqual({ status: "cleaned" });
  });

  it("persists verified image metadata atomically and leaves no reachable partial file on rollback", async () => {
    const storageRoot = await root("iq-14e2c-images-");
    const adapters = createTask14e2cAdapters({ pool, archiveRoot: storageRoot, assetRoot: storageRoot, limits });
    const completedAsset = await asset();
    const published = await adapters.illustration.publishOriginal({
      ownerUserId,
      assetId: completedAsset.assetId,
      content: tinyPng,
      mimeType: "image/png"
    });
    expect(published).toMatchObject({ width: 1, height: 1, contentHash: hash(tinyPng) });
    const metadata = await pool.query<{
      storage_path: string;
      content_hash: string;
      pixel_width: number;
      pixel_height: number;
      format: string;
      pages: number;
    }>(
      `SELECT storage_path,content_hash,pixel_width,pixel_height,
              technical_metadata->>'format' AS format,
              (technical_metadata->>'pages')::int AS pages
         FROM assets WHERE owner_user_id=$1 AND id=$2`,
      [ownerUserId, completedAsset.assetId]
    );
    expect(metadata.rows[0]).toEqual({
      storage_path: published.relativePath,
      content_hash: hash(tinyPng),
      pixel_width: 1,
      pixel_height: 1,
      format: "png",
      pages: 1
    });
    await expect(adapters.filesystem.readPublishedAsset({
      scope: { resourceKind: "asset", ownerUserId: foreignOwnerUserId, assetId: completedAsset.assetId },
      locator: published.locator,
      mimeType: "image/png",
      maximumBytes: limits.maxOriginalImageBytes
    })).rejects.toEqual({ code: "asset_storage_unavailable" });

    const rolledBackAsset = await asset();
    const before = await pool.query<{ storage_path: string; content_hash: string }>(
      "SELECT storage_path,content_hash FROM assets WHERE owner_user_id=$1 AND id=$2",
      [ownerUserId, rolledBackAsset.assetId]
    );
    await expect(adapters.illustration.publishOriginal({
      ownerUserId,
      assetId: rolledBackAsset.assetId,
      content: tinyPng,
      mimeType: "image/png",
      failBeforeDomainCommit: true
    })).rejects.toThrow("task_14e2c_forced_image_rollback");
    const after = await pool.query<{ storage_path: string; content_hash: string }>(
      "SELECT storage_path,content_hash FROM assets WHERE owner_user_id=$1 AND id=$2",
      [ownerUserId, rolledBackAsset.assetId]
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    const files = (await readdir(storageRoot, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile());
    expect(files).toHaveLength(1);
    expect(files[0]!.name.endsWith(".asset")).toBe(true);

    const crashedAsset = await asset();
    await expect(adapters.illustration.publishOriginal({
      ownerUserId,
      assetId: crashedAsset.assetId,
      content: tinyPng,
      mimeType: "image/png",
      simulateCrashAfterAttach: true
    })).rejects.toThrow("task_14e2c_simulated_image_crash");
    const crashed = await pool.query<{ id: string }>(
      `SELECT id FROM durable_filesystem_operations
        WHERE owner_user_id=$1 AND asset_id=$2 AND purpose='asset_original'
          AND lifecycle='attached'
        ORDER BY created_at DESC LIMIT 1`,
      [ownerUserId, crashedAsset.assetId]
    );
    await pool.query(
      `UPDATE durable_filesystem_operations
          SET lease_expires_at=now()-interval '1 second',expires_at=now()-interval '1 second'
        WHERE id=$1`,
      [crashed.rows[0]!.id]
    );
    await expect(adapters.archive.recover("task-14e2c-image-reaper")).resolves.toContainEqual({
      operationId: crashed.rows[0]!.id,
      ownerUserId,
      action: "cleanup",
      outcome: "cleaned"
    });
    const afterRecovery = (await readdir(storageRoot, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile());
    expect(afterRecovery).toHaveLength(1);
  });
});
