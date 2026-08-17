import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import {
  createDatabasePool,
  initialOwnerId,
  withTransaction,
  type DatabasePool
} from "../../packages/database/src/pool.js";
import { createPostgresAssetMetadataBackfillExecutorRepository } from "../../packages/database/src/asset-metadata-backfill-executor-repository.js";
import { supportsSecureGeneratedArchiveStaging } from "../../services/api/src/archive-io.js";
import { createAssetImportStorageComposition } from "../../services/runtime/src/asset-import-composition.js";
import { createPrivateAssetMetadataBackfillComposition } from "../../services/runtime/src/private-asset-metadata-backfill-composition.js";
import { normalizePrivateImageArtifact } from "../../services/runtime/src/private-image-normalization.js";

const slowNormalization = vi.hoisted(() => ({ delayMs: 0 }));

vi.mock("../../services/runtime/src/private-image-normalization.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/runtime/src/private-image-normalization.js")>();
  return {
    ...actual,
    async normalizePrivateImageArtifact(
      input: Parameters<typeof actual.normalizePrivateImageArtifact>[0],
    ): Promise<Awaited<ReturnType<typeof actual.normalizePrivateImageArtifact>>> {
      if (slowNormalization.delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, slowNormalization.delayMs));
      }
      return actual.normalizePrivateImageArtifact(input);
    }
  };
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl && supportsSecureGeneratedArchiveStaging() ? describe : describe.skip;

integration("Task 14e3e5 private asset metadata backfill", () => {
  let pool: DatabasePool;
  let ownerUserId = "";
  let archiveRoot = "";
  let assetRoot = "";
  const compositions = new Set<Readonly<{ close(): Promise<void> }>>();

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 3);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    archiveRoot = await mkdtemp(join(tmpdir(), "iqn-e5-archive-"));
    assetRoot = await mkdtemp(join(tmpdir(), "iqn-e5-assets-"));
    await mkdir(join(assetRoot, "assets", "content"), { recursive: true });
  });

  afterAll(async () => {
    await Promise.all([...compositions].map((composition) => composition.close()));
    await pool.end();
    await rm(archiveRoot, { recursive: true, force: true });
    await rm(assetRoot, { recursive: true, force: true });
  });

  const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

  async function compose() {
    const composition = await createPrivateAssetMetadataBackfillComposition(pool, { archiveRoot, assetRoot });
    compositions.add(composition);
    return composition;
  }

  async function createLegacyAsset(
    label: string,
    suppliedBytes?: Uint8Array,
    ownerId = ownerUserId,
    mimeType: "image/png" | "image/jpeg" = "image/png",
  ) {
    const shade = [...label].reduce((total, character) => total + character.charCodeAt(0), 0) % 255;
    const bytes = suppliedBytes ?? await sharp({
      create: {
        width: 8,
        height: 6,
        channels: 4,
        background: { r: shade, g: 40, b: 60, alpha: 1 }
      }
    }).png().toBuffer();
    const contentHash = hash(bytes);
    const relativePath = `assets/content/${contentHash}`;
    await writeFile(join(assetRoot, relativePath), bytes);
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO assets (
         owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length,
         pixel_width,pixel_height,technical_metadata
       ) VALUES ($1,$2,'filesystem',$3,$4,$5,NULL,NULL,'{}'::jsonb)
       RETURNING id`,
      [ownerId, contentHash, relativePath, mimeType, bytes.byteLength],
    );
    const assetId = inserted.rows[0]!.id;
    await pool.query(
      `INSERT INTO asset_metadata_backfill_jobs (owner_user_id,asset_id,status,next_attempt_at)
       VALUES ($1,$2,'queued',clock_timestamp())
       ON CONFLICT (owner_user_id,asset_id)
       DO UPDATE SET status='queued',diagnostic_code=NULL,next_attempt_at=clock_timestamp(),
                     lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL`,
      [ownerId, assetId],
    );
    return { assetId, contentHash, bytes };
  }

  async function installHeartbeatAudit(): Promise<void> {
    await pool.query(`
      CREATE TABLE e5_heartbeat_audit (job_id uuid NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp());
      CREATE FUNCTION audit_e5_heartbeat() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status='running' AND NEW.status='running'
          AND OLD.work_version=NEW.work_version AND OLD.lease_id=NEW.lease_id
          AND NEW.lease_expires_at > OLD.lease_expires_at THEN
          INSERT INTO e5_heartbeat_audit (job_id) VALUES (NEW.id);
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER audit_e5_heartbeat_trigger
      BEFORE UPDATE ON asset_metadata_backfill_jobs
      FOR EACH ROW EXECUTE FUNCTION audit_e5_heartbeat();
    `);
  }

  async function removeHeartbeatAudit(): Promise<void> {
    await pool.query("DROP TRIGGER IF EXISTS audit_e5_heartbeat_trigger ON asset_metadata_backfill_jobs");
    await pool.query("DROP FUNCTION IF EXISTS audit_e5_heartbeat()");
    await pool.query("DROP TABLE IF EXISTS e5_heartbeat_audit");
  }

  async function heartbeatCount(assetId: string): Promise<number> {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM e5_heartbeat_audit audit
        JOIN asset_metadata_backfill_jobs job ON job.id=audit.job_id
       WHERE job.owner_user_id=$1 AND job.asset_id=$2`,
      [ownerUserId, assetId],
    );
    return Number(result.rows[0]!.count);
  }

  it("derives verified metadata and publishes one deterministic thumbnail from a bounded finalized original", async () => {
    const source = await createLegacyAsset("initial");
    const composition = await compose();
    await pool.query(
      `UPDATE asset_library_entries SET title='canonical title',caption='canonical caption',metadata_revision=41
        WHERE owner_user_id=$1 AND asset_id=$2`,
      [ownerUserId, source.assetId],
    );

    const result = await composition.executor.processOne({ workerId: "e5-initial", leaseSeconds: 30 });
    expect(result).toEqual({ outcome: "completed", assetId: source.assetId });
    const current = await pool.query<{ status: string; work_version: number; lease_owner: string | null }>(
      "SELECT status,work_version,lease_owner FROM asset_metadata_backfill_jobs WHERE owner_user_id=$1 AND asset_id=$2",
      [ownerUserId, source.assetId],
    );
    expect(current.rows[0]).toMatchObject({ status: "completed", lease_owner: null });
    await expect(pool.query(
      `SELECT title,caption,metadata_revision FROM asset_library_entries
        WHERE owner_user_id=$1 AND asset_id=$2`,
      [ownerUserId, source.assetId],
    )).resolves.toMatchObject({
      rows: [{ title: "canonical title", caption: "canonical caption", metadata_revision: 41 }]
    });

    await expect(pool.query<{
      pixel_width: number;
      pixel_height: number;
      technical_metadata: { state?: string };
      status: string;
      derivative_count: string;
    }>(
      `SELECT a.pixel_width,a.pixel_height,a.technical_metadata,j.status,
              (SELECT count(*)::text FROM asset_derivatives d
                WHERE d.owner_user_id=a.owner_user_id AND d.source_asset_id=a.id
                  AND d.derivative_kind='thumbnail' AND d.transform_version=1) AS derivative_count
         FROM assets a
         JOIN asset_metadata_backfill_jobs j ON j.owner_user_id=a.owner_user_id AND j.asset_id=a.id
        WHERE a.owner_user_id=$1 AND a.id=$2`,
      [ownerUserId, source.assetId],
    )).resolves.toMatchObject({
      rows: [{ pixel_width: 8, pixel_height: 6, status: "completed", derivative_count: "1" }]
    });

    await expect(composition.executor.processOne({ workerId: "e5-replay", leaseSeconds: 30 }))
      .resolves.toEqual({ outcome: "idle" });

    await pool.query(
      `UPDATE assets SET pixel_width=NULL,pixel_height=NULL,technical_metadata='{}'::jsonb
        WHERE owner_user_id=$1 AND id=$2`,
      [ownerUserId, source.assetId],
    );
    await pool.query(
      `UPDATE asset_metadata_backfill_jobs
          SET status='queued',next_attempt_at=clock_timestamp(),diagnostic_code=NULL,
              lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,completed_at=NULL
        WHERE owner_user_id=$1 AND asset_id=$2`,
      [ownerUserId, source.assetId],
    );
    await expect(composition.executor.processOne({ workerId: "e5-metadata-repair", leaseSeconds: 30 }))
      .resolves.toEqual({ outcome: "completed", assetId: source.assetId });
    await expect(pool.query(
      `SELECT a.pixel_width,a.pixel_height,j.status,
              (SELECT count(*) FROM asset_derivatives d
                WHERE d.owner_user_id=a.owner_user_id AND d.source_asset_id=a.id
                  AND d.derivative_kind='thumbnail' AND d.transform_version=1) AS derivative_count
         FROM assets a
         JOIN asset_metadata_backfill_jobs j ON j.owner_user_id=a.owner_user_id AND j.asset_id=a.id
        WHERE a.owner_user_id=$1 AND a.id=$2`,
      [ownerUserId, source.assetId],
    )).resolves.toMatchObject({
      rows: [{ pixel_width: 8, pixel_height: 6, status: "completed", derivative_count: "1" }]
    });
  });

  it("uses SKIP LOCKED so two private compositions publish only one thumbnail", async () => {
    const source = await createLegacyAsset("concurrent");
    const first = await compose();
    const second = await compose();

    const results = await Promise.all([
      first.executor.processOne({ workerId: "e5-concurrent-one", leaseSeconds: 30 }),
      second.executor.processOne({ workerId: "e5-concurrent-two", leaseSeconds: 30 })
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual(["completed", "idle"]);
    await expect(pool.query(
      `SELECT j.status,(SELECT count(*) FROM asset_derivatives d
                          WHERE d.owner_user_id=j.owner_user_id AND d.source_asset_id=j.asset_id
                            AND d.derivative_kind='thumbnail' AND d.transform_version=1) AS derivative_count
         FROM asset_metadata_backfill_jobs j WHERE j.owner_user_id=$1 AND j.asset_id=$2`,
      [ownerUserId, source.assetId],
    )).resolves.toMatchObject({ rows: [{ status: "completed", derivative_count: "1" }] });
  });

  it("repairs a missing thumbnail while preserving verified technical metadata", async () => {
    const source = await createLegacyAsset("thumbnail-only");
    await pool.query(
      `UPDATE assets SET pixel_width=8,pixel_height=6,
          technical_metadata='{"state":"verified","format":"png","pages":1,"orientation":null,"sentinel":"preserve"}'::jsonb
        WHERE owner_user_id=$1 AND id=$2`,
      [ownerUserId, source.assetId],
    );
    const composition = await compose();
    await expect(composition.executor.processOne({ workerId: "e5-thumbnail-only", leaseSeconds: 30 }))
      .resolves.toEqual({ outcome: "completed", assetId: source.assetId });
    await expect(pool.query(
      `SELECT technical_metadata->>'sentinel' AS sentinel,
              (SELECT count(*) FROM asset_derivatives d WHERE d.owner_user_id=a.owner_user_id AND d.source_asset_id=a.id
                AND d.derivative_kind='thumbnail' AND d.transform_version=1) AS derivative_count
         FROM assets a WHERE a.owner_user_id=$1 AND a.id=$2`,
      [ownerUserId, source.assetId],
    )).resolves.toMatchObject({ rows: [{ sentinel: "preserve", derivative_count: "1" }] });
  });

  it("maps poisoned image content to enum diagnostics with finite backoff and no metadata mutation", async () => {
    const source = await createLegacyAsset("poisoned", Uint8Array.from([0, 1, 2, 3, 4, 5]));
    const composition = await compose();

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await composition.executor.processOne({ workerId: `e5-poison-${attempt}`, leaseSeconds: 30 });
      expect(result).toMatchObject({
        outcome: attempt === 3 ? "failed" : "recoverable",
        assetId: source.assetId,
        diagnosticCode: "asset_unsupported_media"
      });
      if (attempt < 3) {
        await pool.query(
          `UPDATE asset_metadata_backfill_jobs SET next_attempt_at=clock_timestamp()
            WHERE owner_user_id=$1 AND asset_id=$2`,
          [ownerUserId, source.assetId],
        );
      }
    }
    await expect(pool.query(
      `SELECT a.pixel_width,a.pixel_height,j.status,j.diagnostic_code,
              (SELECT count(*) FROM asset_derivatives d WHERE d.owner_user_id=a.owner_user_id AND d.source_asset_id=a.id) AS derivative_count
         FROM assets a JOIN asset_metadata_backfill_jobs j ON j.owner_user_id=a.owner_user_id AND j.asset_id=a.id
        WHERE a.owner_user_id=$1 AND a.id=$2`,
      [ownerUserId, source.assetId],
    )).resolves.toMatchObject({
      rows: [{ pixel_width: null, pixel_height: null, status: "failed", diagnostic_code: "asset_unsupported_media", derivative_count: "0" }]
    });
  });

  it("rejects a foreign rotated lease before attachment without mutating metadata or derivatives", async () => {
    const source = await createLegacyAsset("foreign-lease");
    const storage = await createAssetImportStorageComposition(pool, { archiveRoot, assetRoot });
    const repository = createPostgresAssetMetadataBackfillExecutorRepository(pool, storage.journal);
    const claim = await repository.claimNext({ workerId: "e5-original-worker", leaseSeconds: 30 });
    expect(claim).toMatchObject({ ownerUserId, assetId: source.assetId });
    const normalized = await normalizePrivateImageArtifact({
      bytes: source.bytes,
      declaredMimeType: "image/png",
      maximumBytes: 16 * 1024 * 1024,
      maximumPixels: 20_000_000,
      diagnosticPrefix: "portable_import_image"
    });
    const thumbnail = {
      bytes: normalized.thumbnail.artifact.bytes,
      contentHash: normalized.thumbnail.artifact.contentHash,
      byteLength: normalized.thumbnail.artifact.byteLength,
      mimeType: "image/webp" as const,
      pixelWidth: normalized.thumbnail.slot.pixelWidth,
      pixelHeight: normalized.thumbnail.slot.pixelHeight,
      transformVersion: 1 as const
    };
    const prepared = await storage.adapter.prepareMetadataBackfillThumbnail({
      claim: claim!,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      thumbnail
    });
    await pool.query(
      `UPDATE asset_metadata_backfill_jobs
          SET lease_id=gen_random_uuid(),lease_owner='e5-foreign-worker',work_version=work_version+1
        WHERE owner_user_id=$1 AND asset_id=$2`,
      [ownerUserId, source.assetId],
    );
    await expect(withTransaction(pool, (database) => repository.attachThumbnail(
      database,
      claim!,
      thumbnail,
      prepared.attachment,
      { format: "png", pages: 1, orientation: null },
    ))).rejects.toThrow("asset_metadata_backfill_claim_unavailable");
    await prepared.rollback();
    await expect(pool.query(
      `SELECT a.pixel_width,a.pixel_height,
              (SELECT count(*) FROM asset_derivatives d WHERE d.owner_user_id=a.owner_user_id AND d.source_asset_id=a.id) AS derivative_count
         FROM assets a WHERE a.owner_user_id=$1 AND a.id=$2`,
      [ownerUserId, source.assetId],
    )).resolves.toMatchObject({ rows: [{ pixel_width: null, pixel_height: null, derivative_count: "0" }] });
    await storage.close();
  });

  it("renews a live lease during deterministic slow valid normalization and completes", async () => {
    const source = await createLegacyAsset("slow-heartbeat-success");
    await installHeartbeatAudit();
    slowNormalization.delayMs = 1_000;
    try {
      const composition = await compose();
      await expect(composition.executor.processOne({ workerId: "e5-slow-heartbeat", leaseSeconds: 2 }))
        .resolves.toEqual({ outcome: "completed", assetId: source.assetId });
      expect(await heartbeatCount(source.assetId)).toBeGreaterThanOrEqual(2);
    } finally {
      slowNormalization.delayMs = 0;
      await removeHeartbeatAudit();
    }
  });

  it("abandons a lease rotated after a successful slow-work heartbeat without attachment", async () => {
    const source = await createLegacyAsset("slow-heartbeat-loss");
    await installHeartbeatAudit();
    slowNormalization.delayMs = 1_000;
    try {
      const composition = await compose();
      const processing = composition.executor.processOne({ workerId: "e5-slow-heartbeat-loss", leaseSeconds: 2 });
      await new Promise<void>((resolve) => setTimeout(resolve, 750));
      expect(await heartbeatCount(source.assetId)).toBeGreaterThanOrEqual(2);
      const rotated = await pool.query(
        `UPDATE asset_metadata_backfill_jobs
            SET lease_id=gen_random_uuid(),lease_owner='e5-rotated-during-slow-work',work_version=work_version+1
          WHERE owner_user_id=$1 AND asset_id=$2 AND status='running'`,
        [ownerUserId, source.assetId],
      );
      expect(rotated.rowCount).toBe(1);
      await expect(processing).resolves.toEqual({ outcome: "lease_lost", assetId: source.assetId });
      await expect(pool.query(
        `SELECT a.pixel_width,a.pixel_height,
                (SELECT count(*) FROM asset_derivatives d WHERE d.owner_user_id=a.owner_user_id AND d.source_asset_id=a.id) AS derivative_count
           FROM assets a WHERE a.owner_user_id=$1 AND a.id=$2`,
        [ownerUserId, source.assetId],
      )).resolves.toMatchObject({ rows: [{ pixel_width: null, pixel_height: null, derivative_count: "0" }] });
    } finally {
      slowNormalization.delayMs = 0;
      await removeHeartbeatAudit();
    }
  });

  it("reconciles a post-commit attached thumbnail from a fresh composition without duplicate decode/publication", async () => {
    const source = await createLegacyAsset("restart");
    const storage = await createAssetImportStorageComposition(pool, { archiveRoot, assetRoot });
    const repository = createPostgresAssetMetadataBackfillExecutorRepository(pool, storage.journal);
    const claim = await repository.claimNext({ workerId: "e5-interrupted", leaseSeconds: 30 });
    expect(claim).not.toBeNull();
    const normalized = await normalizePrivateImageArtifact({
      bytes: source.bytes,
      declaredMimeType: "image/png",
      maximumBytes: 16 * 1024 * 1024,
      maximumPixels: 20_000_000,
      diagnosticPrefix: "portable_import_image"
    });
    const thumbnail = {
      bytes: normalized.thumbnail.artifact.bytes,
      contentHash: normalized.thumbnail.artifact.contentHash,
      byteLength: normalized.thumbnail.artifact.byteLength,
      mimeType: "image/webp" as const,
      pixelWidth: normalized.thumbnail.slot.pixelWidth,
      pixelHeight: normalized.thumbnail.slot.pixelHeight,
      transformVersion: 1 as const
    };
    const technicalMetadata = {
      format: normalized.original.technicalMetadata.format,
      pages: 1 as const,
      orientation: normalized.original.technicalMetadata.orientation
    };
    const prepared = await storage.adapter.prepareMetadataBackfillThumbnail({
      claim: claim!,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      thumbnail
    });
    await withTransaction(pool, (database) => repository.attachThumbnail(
      database,
      claim!,
      thumbnail,
      prepared.attachment,
      technicalMetadata,
    ));
    await storage.close();
    await pool.query(
      `UPDATE asset_metadata_backfill_jobs SET lease_expires_at=clock_timestamp()-interval '1 second'
        WHERE owner_user_id=$1 AND asset_id=$2`,
      [ownerUserId, source.assetId],
    );

    const fresh = await compose();
    await expect(fresh.executor.processOne({ workerId: "e5-reconciler", leaseSeconds: 30 }))
      .resolves.toEqual({ outcome: "completed", assetId: source.assetId });
    await expect(pool.query(
      `SELECT p.lifecycle,j.status,
              (SELECT count(*) FROM asset_derivatives d WHERE d.owner_user_id=j.owner_user_id AND d.source_asset_id=j.asset_id
                AND d.derivative_kind='thumbnail' AND d.transform_version=1) AS derivative_count
         FROM asset_metadata_backfill_jobs j
         JOIN asset_metadata_backfill_publications p ON p.owner_user_id=j.owner_user_id AND p.asset_id=j.asset_id
        WHERE j.owner_user_id=$1 AND j.asset_id=$2`,
      [ownerUserId, source.assetId],
    )).resolves.toMatchObject({ rows: [{ lifecycle: "published", status: "completed", derivative_count: "1" }] });
  });

  it("retains a cross-owner shared thumbnail when cleanup is requested after an attached operation", async () => {
    const firstSource = await createLegacyAsset("shared-thumbnail");
    const otherOwner = await pool.query<{ id: string }>(
      `INSERT INTO users (system_key,display_name) VALUES ($1,$2) RETURNING id`,
      [`e5-owner-${randomUUID()}`, "E5 other owner"],
    );
    const otherOwnerId = otherOwner.rows[0]!.id;
    const storage = await createAssetImportStorageComposition(pool, { archiveRoot, assetRoot });
    const repository = createPostgresAssetMetadataBackfillExecutorRepository(pool, storage.journal);
    const claim = await repository.claimNext({ workerId: "e5-shared-second", leaseSeconds: 30 });
    expect(claim).toMatchObject({ ownerUserId, assetId: firstSource.assetId });
    const normalized = await normalizePrivateImageArtifact({
      bytes: firstSource.bytes,
      declaredMimeType: "image/png",
      maximumBytes: 16 * 1024 * 1024,
      maximumPixels: 20_000_000,
      diagnosticPrefix: "portable_import_image"
    });
    const thumbnail = {
      bytes: normalized.thumbnail.artifact.bytes,
      contentHash: normalized.thumbnail.artifact.contentHash,
      byteLength: normalized.thumbnail.artifact.byteLength,
      mimeType: "image/webp" as const,
      pixelWidth: normalized.thumbnail.slot.pixelWidth,
      pixelHeight: normalized.thumbnail.slot.pixelHeight,
      transformVersion: 1 as const
    };
    const prepared = await storage.adapter.prepareMetadataBackfillThumbnail({
      claim: claim!,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      thumbnail
    });
    await pool.query(
      `INSERT INTO assets (
         owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length,
         pixel_width,pixel_height,technical_metadata
       ) VALUES ($1,$2,'filesystem',$3,'image/webp',$4,$5,$6,'{}'::jsonb)`,
      [
        otherOwnerId,
        thumbnail.contentHash,
        `assets/content/${thumbnail.contentHash}`,
        thumbnail.byteLength,
        thumbnail.pixelWidth,
        thumbnail.pixelHeight
      ],
    );

    await prepared.rollback();
    await expect(readFile(join(assetRoot, "assets", "content", thumbnail.contentHash)))
      .resolves.toEqual(Buffer.from(thumbnail.bytes));
    await storage.close();
    await pool.query(
      "DELETE FROM assets WHERE owner_user_id=$1 AND content_hash=$2",
      [otherOwnerId, thumbnail.contentHash],
    );
  });

  it("retains attached finalization evidence when post-commit filesystem finalization fails", async () => {
    const source = await createLegacyAsset("finalization-failure");
    await pool.query(`
      CREATE FUNCTION fail_e5_thumbnail_finalization() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.lifecycle='finalized' AND OLD.purpose='asset_derivative' THEN
          RAISE EXCEPTION 'e5 finalization fault';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER fail_e5_thumbnail_finalization_trigger
      BEFORE UPDATE ON durable_filesystem_operations
      FOR EACH ROW EXECUTE FUNCTION fail_e5_thumbnail_finalization();
    `);
    try {
      const composition = await compose();
      await expect(composition.executor.processOne({ workerId: "e5-finalization-failure", leaseSeconds: 30 }))
        .resolves.toMatchObject({ outcome: "recoverable", assetId: source.assetId });
      await expect(pool.query(
        `SELECT publication.lifecycle AS publication_lifecycle,operation.lifecycle AS operation_lifecycle,
                job.status,derivative.storage_path
           FROM asset_metadata_backfill_jobs job
           JOIN asset_metadata_backfill_publications publication
             ON publication.owner_user_id=job.owner_user_id AND publication.asset_id=job.asset_id
           JOIN durable_filesystem_operations operation ON operation.id=publication.filesystem_operation_id
           JOIN asset_derivatives derivative ON derivative.filesystem_operation_id=operation.id
          WHERE job.owner_user_id=$1 AND job.asset_id=$2`,
        [ownerUserId, source.assetId],
      )).resolves.toMatchObject({
        rows: [{ publication_lifecycle: "attached", operation_lifecycle: "attached", status: "recoverable" }]
      });
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS fail_e5_thumbnail_finalization_trigger ON durable_filesystem_operations");
      await pool.query("DROP FUNCTION IF EXISTS fail_e5_thumbnail_finalization()");
    }
    await pool.query(
      `UPDATE asset_metadata_backfill_jobs SET next_attempt_at=clock_timestamp()
        WHERE owner_user_id=$1 AND asset_id=$2 AND status='recoverable'`,
      [ownerUserId, source.assetId],
    );
    const fresh = await compose();
    await expect(fresh.executor.processOne({ workerId: "e5-finalization-reconciler", leaseSeconds: 30 }))
      .resolves.toEqual({ outcome: "completed", assetId: source.assetId });
    await expect(pool.query(
      `SELECT publication.lifecycle AS publication_lifecycle,operation.lifecycle AS operation_lifecycle,
              job.status,
              (SELECT count(*) FROM asset_derivatives d WHERE d.owner_user_id=job.owner_user_id AND d.source_asset_id=job.asset_id
                AND d.derivative_kind='thumbnail' AND d.transform_version=1) AS derivative_count
         FROM asset_metadata_backfill_jobs job
         JOIN asset_metadata_backfill_publications publication
           ON publication.owner_user_id=job.owner_user_id AND publication.asset_id=job.asset_id
         JOIN durable_filesystem_operations operation ON operation.id=publication.filesystem_operation_id
        WHERE job.owner_user_id=$1 AND job.asset_id=$2`,
      [ownerUserId, source.assetId],
    )).resolves.toMatchObject({
      rows: [{ publication_lifecycle: "published", operation_lifecycle: "finalized", status: "completed", derivative_count: "1" }]
    });
  });
});
