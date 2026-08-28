import type { PrivateFilesystemCandidateAttachment } from "../../application/src/assets/private-filesystem-repository.js";
import type {
  PrivateAssetMetadataBackfillClaim,
  PrivateAssetMetadataBackfillFinalization,
  PrivateAssetMetadataBackfillThumbnail
} from "../../application/src/assets/private-metadata-backfill.js";
import type {
  DurableFilesystemJournalPort,
  DurableFilesystemTransactionContext
} from "../../application/src/assets/private-storage-lifecycle.js";
import type { AssetFilesystemDiagnosticCode } from "../../application/src/assets/types.js";
import { withTransaction, type DatabaseClient, type DatabasePool } from "./pool.js";

const DIAGNOSTICS = new Set<AssetFilesystemDiagnosticCode>([
  "asset_content_invalid",
  "asset_hash_mismatch",
  "asset_metadata_unavailable",
  "asset_storage_unavailable",
  "asset_unsupported_media",
  "asset_too_large",
  "filesystem_containment_denied",
  "filesystem_link_denied",
  "filesystem_path_invalid",
  "filesystem_race_detected"
]);

type JobRow = Readonly<{
  owner_user_id: string;
  asset_id: string;
  lease_id: string;
  lease_owner: string;
  work_version: number;
  lease_expires_at: Date;
  content_hash: string;
  mime_type: string;
  byte_length: string;
}>;

type PendingRow = Readonly<{
  filesystem_operation_id: string;
  operation_lease_id: string;
  operation_lease_owner: string;
  operation_work_version: number;
  operation_lease_expires_at: Date;
}>;

type PrivateAssetMetadataBackfillOriginalMetadata = Readonly<{
  pixelWidth: number;
  pixelHeight: number;
  format: "png" | "jpeg" | "webp" | "gif";
  pages: 1;
  orientation: number | null;
}>;

export type PrivateAssetMetadataBackfillExecutorRepository = Readonly<{
  enqueueMissing(limit: number): Promise<number>;
  claimNext(input: Readonly<{ workerId: string; leaseSeconds: number }>): Promise<PrivateAssetMetadataBackfillClaim | null>;
  heartbeat(claim: PrivateAssetMetadataBackfillClaim, leaseSeconds: number): Promise<PrivateAssetMetadataBackfillClaim | null>;
  pendingFinalization(claim: PrivateAssetMetadataBackfillClaim, leaseSeconds: number): Promise<PrivateAssetMetadataBackfillFinalization | null>;
  completeWithExistingThumbnail(
    claim: PrivateAssetMetadataBackfillClaim,
    thumbnail: PrivateAssetMetadataBackfillThumbnail,
    originalMetadata: PrivateAssetMetadataBackfillOriginalMetadata,
  ): Promise<"completed" | "stale">;
  attachThumbnail(
    database: DurableFilesystemTransactionContext,
    claim: PrivateAssetMetadataBackfillClaim,
    thumbnail: PrivateAssetMetadataBackfillThumbnail,
    attachment: PrivateFilesystemCandidateAttachment,
    originalMetadata: PrivateAssetMetadataBackfillOriginalMetadata,
  ): Promise<PrivateAssetMetadataBackfillFinalization | null>;
  completeFinalization(claim: PrivateAssetMetadataBackfillClaim, operationId: string): Promise<"completed" | "stale" | "lease_lost">;
  reconcileFinalizedOperation(input: Readonly<{ operationId: string; ownerUserId: string }>): Promise<"completed" | "pending" | "noop">;
  fail(claim: PrivateAssetMetadataBackfillClaim, diagnosticCode: AssetFilesystemDiagnosticCode): Promise<"recoverable" | "failed" | "stale" | "lease_lost">;
}>;

function validMimeType(value: string): value is PrivateAssetMetadataBackfillClaim["expectedMimeType"] {
  return ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(value);
}

function claim(row: JobRow): PrivateAssetMetadataBackfillClaim {
  if (!validMimeType(row.mime_type)) throw new Error("asset_metadata_backfill_mime_invalid");
  const byteLength = Number(row.byte_length);
  if (!/^[0-9a-f]{64}$/u.test(row.content_hash) || !Number.isSafeInteger(byteLength) || byteLength < 1) {
    throw new Error("asset_metadata_backfill_identity_invalid");
  }
  return Object.freeze({
    ownerUserId: row.owner_user_id,
    assetId: row.asset_id,
    leaseId: row.lease_id,
    leaseOwner: row.lease_owner,
    workVersion: row.work_version,
    leaseExpiresAt: row.lease_expires_at.toISOString(),
    expectedContentHash: row.content_hash,
    expectedMimeType: row.mime_type,
    expectedByteLength: byteLength
  });
}

function clientFrom(database: DurableFilesystemTransactionContext): DatabaseClient {
  const candidate = database as Partial<DatabaseClient>;
  if (typeof candidate.query !== "function") throw new Error("asset_metadata_backfill_transaction_unavailable");
  return candidate as DatabaseClient;
}

function validLeaseSeconds(value: number): boolean {
  return Number.isInteger(value) && value >= 2 && value <= 300;
}

function finalization(row: PendingRow, claimValue: PrivateAssetMetadataBackfillClaim): PrivateAssetMetadataBackfillFinalization {
  return Object.freeze({
    operation: Object.freeze({
      resourceKind: "asset" as const,
      ownerUserId: claimValue.ownerUserId,
      assetId: claimValue.assetId,
      operationId: row.filesystem_operation_id,
      purpose: "asset_derivative" as const
    }) as PrivateAssetMetadataBackfillFinalization["operation"],
    claim: Object.freeze({
      operationId: row.filesystem_operation_id,
      leaseId: row.operation_lease_id,
      leaseOwner: row.operation_lease_owner,
      workVersion: row.operation_work_version,
      leaseExpiresAt: row.operation_lease_expires_at.toISOString()
    }) as PrivateAssetMetadataBackfillFinalization["claim"]
  });
}

function leaseWhere(claimValue: PrivateAssetMetadataBackfillClaim): unknown[] {
  return [
    claimValue.ownerUserId,
    claimValue.assetId,
    claimValue.leaseId,
    claimValue.leaseOwner,
    claimValue.workVersion
  ];
}

export function createPostgresAssetMetadataBackfillExecutorRepository(
  pool: DatabasePool,
  journal: DurableFilesystemJournalPort,
): PrivateAssetMetadataBackfillExecutorRepository {
  const enqueueMissing: PrivateAssetMetadataBackfillExecutorRepository["enqueueMissing"] = async (limit) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error("asset_metadata_backfill_discovery_limit_invalid");
    }
    const result = await pool.query(
      `WITH candidates AS (
         SELECT asset.owner_user_id,asset.id
           FROM assets asset
          WHERE NOT EXISTS (
                  SELECT 1 FROM asset_metadata_backfill_jobs job
                   WHERE job.owner_user_id=asset.owner_user_id AND job.asset_id=asset.id
                )
            AND (asset.pixel_width IS NULL OR asset.pixel_height IS NULL OR NOT EXISTS (
                  SELECT 1 FROM asset_derivatives derivative
                   WHERE derivative.owner_user_id=asset.owner_user_id
                     AND derivative.source_asset_id=asset.id
                     AND derivative.derivative_kind='thumbnail'
                     AND derivative.transform_version=1
                ))
          ORDER BY asset.id
          LIMIT $1
        )
        INSERT INTO asset_metadata_backfill_jobs (
          owner_user_id,asset_id,status,next_attempt_at
        )
        SELECT owner_user_id,id,'queued',clock_timestamp() FROM candidates
        ON CONFLICT (asset_id,owner_user_id) DO NOTHING
        RETURNING id`,
      [limit],
    );
    return result.rowCount ?? 0;
  };

  const claimNext: PrivateAssetMetadataBackfillExecutorRepository["claimNext"] = async (input) => {
    if (!input.workerId.trim() || !validLeaseSeconds(input.leaseSeconds)) {
      throw new Error("asset_metadata_backfill_claim_invalid");
    }
    return withTransaction(pool, async (database) => {
      const result = await database.query<JobRow>(
        `WITH candidate AS (
           SELECT job.id
             FROM asset_metadata_backfill_jobs job
            WHERE job.attempts < 3
              AND ((job.status IN ('queued','recoverable') AND job.next_attempt_at <= clock_timestamp())
                OR (job.status='running' AND job.lease_expires_at <= clock_timestamp()))
            ORDER BY job.next_attempt_at,job.created_at,job.id
            FOR UPDATE SKIP LOCKED
            LIMIT 1
         )
         UPDATE asset_metadata_backfill_jobs job
            SET status='running',attempts=attempts+1,work_version=work_version+1,
                lease_id=gen_random_uuid(),lease_owner=$1,
                lease_expires_at=clock_timestamp()+($2::text || ' seconds')::interval,
                updated_at=clock_timestamp(),completed_at=NULL
           FROM candidate
          WHERE job.id=candidate.id
         RETURNING job.owner_user_id,job.asset_id,job.lease_id,job.lease_owner,job.work_version,
                   job.lease_expires_at,
                   (SELECT a.content_hash FROM assets a
                     WHERE a.id=job.asset_id AND a.owner_user_id=job.owner_user_id) AS content_hash,
                   (SELECT a.mime_type FROM assets a
                     WHERE a.id=job.asset_id AND a.owner_user_id=job.owner_user_id) AS mime_type,
                   (SELECT a.byte_length::text FROM assets a
                     WHERE a.id=job.asset_id AND a.owner_user_id=job.owner_user_id) AS byte_length`,
        [input.workerId, input.leaseSeconds],
      );
      return result.rows[0] ? claim(result.rows[0]) : null;
    });
  };

  const heartbeat: PrivateAssetMetadataBackfillExecutorRepository["heartbeat"] = async (claimValue, leaseSeconds) => {
    if (!validLeaseSeconds(leaseSeconds)) throw new Error("asset_metadata_backfill_lease_invalid");
    const result = await pool.query<JobRow>(
      `UPDATE asset_metadata_backfill_jobs job
          SET lease_expires_at=clock_timestamp()+($6::text || ' seconds')::interval,updated_at=clock_timestamp()
        WHERE job.owner_user_id=$1 AND job.asset_id=$2 AND job.lease_id=$3 AND job.lease_owner=$4
          AND job.work_version=$5 AND job.status='running' AND job.lease_expires_at > clock_timestamp()
        RETURNING job.owner_user_id,job.asset_id,job.lease_id,job.lease_owner,job.work_version,
                  job.lease_expires_at,
                  (SELECT a.content_hash FROM assets a WHERE a.id=job.asset_id AND a.owner_user_id=job.owner_user_id) AS content_hash,
                  (SELECT a.mime_type FROM assets a WHERE a.id=job.asset_id AND a.owner_user_id=job.owner_user_id) AS mime_type,
                  (SELECT a.byte_length::text FROM assets a WHERE a.id=job.asset_id AND a.owner_user_id=job.owner_user_id) AS byte_length`,
      [...leaseWhere(claimValue), leaseSeconds],
    );
    return result.rows[0] ? claim(result.rows[0]) : null;
  };

  const pendingFinalization: PrivateAssetMetadataBackfillExecutorRepository["pendingFinalization"] = async (claimValue, leaseSeconds) => {
    if (!validLeaseSeconds(leaseSeconds)) throw new Error("asset_metadata_backfill_lease_invalid");
    return withTransaction(pool, async (database) => {
      const pending = await database.query<Readonly<{ filesystem_operation_id: string }>>(
        `SELECT publication.filesystem_operation_id
           FROM asset_metadata_backfill_jobs job
           JOIN asset_metadata_backfill_publications publication
             ON publication.owner_user_id=job.owner_user_id AND publication.asset_id=job.asset_id
          WHERE job.owner_user_id=$1 AND job.asset_id=$2 AND job.lease_id=$3 AND job.lease_owner=$4
            AND job.work_version=$5 AND job.status='running' AND job.lease_expires_at > clock_timestamp()
            AND publication.lifecycle='attached'
          FOR UPDATE OF job,publication`,
        leaseWhere(claimValue),
      );
      const operationId = pending.rows[0]?.filesystem_operation_id;
      if (!operationId) return null;
      const operation = await database.query<PendingRow>(
        `UPDATE durable_filesystem_operations operation
            SET lease_id=gen_random_uuid(),lease_owner=$2,work_version=operation.work_version+1,
                lease_expires_at=clock_timestamp()+($3::text || ' seconds')::interval,updated_at=clock_timestamp()
          WHERE operation.id=$1 AND operation.owner_user_id=$4 AND operation.asset_id=$5
            AND operation.purpose='asset_derivative' AND operation.resource_kind='asset'
            AND operation.lifecycle='attached'
          RETURNING operation.id AS filesystem_operation_id,operation.lease_id AS operation_lease_id,
                    operation.lease_owner AS operation_lease_owner,operation.work_version AS operation_work_version,
                    operation.lease_expires_at AS operation_lease_expires_at`,
        [operationId, claimValue.leaseOwner, leaseSeconds, claimValue.ownerUserId, claimValue.assetId],
      );
      return operation.rows[0] ? finalization(operation.rows[0], claimValue) : null;
    });
  };

  const attachThumbnail: PrivateAssetMetadataBackfillExecutorRepository["attachThumbnail"] = async (
    database,
    claimValue,
    thumbnail,
    attachment,
    originalMetadata,
  ) => {
    const client = clientFrom(database);
    const locked = await client.query<Readonly<{ id: string }>>(
      `SELECT job.id
         FROM asset_metadata_backfill_jobs job
         JOIN assets asset ON asset.id=job.asset_id AND asset.owner_user_id=job.owner_user_id
        WHERE job.owner_user_id=$1 AND job.asset_id=$2 AND job.lease_id=$3 AND job.lease_owner=$4
          AND job.work_version=$5 AND job.status='running' AND job.lease_expires_at > clock_timestamp()
          AND asset.content_hash=$6 AND asset.mime_type=$7 AND asset.byte_length=$8
        FOR UPDATE OF job,asset`,
      [...leaseWhere(claimValue), claimValue.expectedContentHash, claimValue.expectedMimeType, claimValue.expectedByteLength],
    );
    if (!locked.rows[0]) throw new Error("asset_metadata_backfill_claim_unavailable");
    if (attachment.operation.resourceKind !== "asset"
      || attachment.operation.ownerUserId !== claimValue.ownerUserId
      || attachment.operation.assetId !== claimValue.assetId
      || attachment.operation.purpose !== "asset_derivative"
      || attachment.descriptor.contentHash !== thumbnail.contentHash
      || attachment.descriptor.byteLength !== thumbnail.byteLength) {
      throw new Error("asset_metadata_backfill_attachment_mismatch");
    }
    // The derivative record cannot reference this operation until the
    // candidate is attached. Attach it and insert that reference in this
    // same transaction, so the brief unattached state is never committed.
    const attached = await journal.attach(client, attachment.operation, attachment.candidate);
    if (attached.outcome !== "attached") {
      throw new Error(`asset_metadata_backfill_attach_${attached.outcome}`);
    }
    const derivative = await client.query<{ id: string }>(
      `INSERT INTO asset_derivatives (
         owner_user_id,source_asset_id,derivative_kind,transform_version,pixel_width,pixel_height,
         storage_driver,storage_path,mime_type,byte_length,content_hash,filesystem_operation_id
       ) VALUES ($1,$2,'thumbnail',1,$3,$4,'filesystem',$5,'image/webp',$6,$7,$8)
       ON CONFLICT (owner_user_id,source_asset_id,derivative_kind,transform_version,pixel_width,pixel_height)
       DO NOTHING
       RETURNING id`,
      [
        claimValue.ownerUserId, claimValue.assetId, thumbnail.pixelWidth, thumbnail.pixelHeight,
        attachment.descriptor.relativePath, thumbnail.byteLength, thumbnail.contentHash, attached.operation.operationId
      ],
    );
    if (!derivative.rows[0]) throw new Error("asset_metadata_backfill_derivative_conflict");
    await client.query(
      `UPDATE assets
          SET pixel_width=$3,pixel_height=$4,
              technical_metadata=(technical_metadata - 'backfillError') || $5::jsonb
        WHERE owner_user_id=$1 AND id=$2 AND content_hash=$6 AND mime_type=$7 AND byte_length=$8`,
      [
        claimValue.ownerUserId, claimValue.assetId, originalMetadata.pixelWidth, originalMetadata.pixelHeight,
        JSON.stringify({
          state: "verified",
          format: originalMetadata.format,
          pages: originalMetadata.pages,
          orientation: originalMetadata.orientation
        }),
        claimValue.expectedContentHash, claimValue.expectedMimeType, claimValue.expectedByteLength
      ],
    );
    await client.query(
      `UPDATE asset_publication_content_arbitrations arbitration
          SET verification_state='verified',updated_at=clock_timestamp()
        WHERE arbitration.owner_user_id=$1 AND arbitration.content_hash=$2 AND arbitration.canonical_asset_id=$3
          AND arbitration.verification_state='verification_required'
          AND EXISTS (
            SELECT 1 FROM asset_publication_identities identity
             WHERE identity.owner_user_id=arbitration.owner_user_id AND identity.asset_id=arbitration.canonical_asset_id
               AND identity.lifecycle IN ('prepared','attached','published')
          )`,
      [claimValue.ownerUserId, claimValue.expectedContentHash, claimValue.assetId],
    );
    await client.query(
      `INSERT INTO asset_metadata_backfill_publications (
         owner_user_id,asset_id,work_version,expected_content_hash,thumbnail_content_hash,filesystem_operation_id,lifecycle
       ) VALUES ($1,$2,$3,$4,$5,$6,'attached')
       ON CONFLICT (owner_user_id,asset_id) DO UPDATE
         SET work_version=EXCLUDED.work_version,expected_content_hash=EXCLUDED.expected_content_hash,
             thumbnail_content_hash=EXCLUDED.thumbnail_content_hash,filesystem_operation_id=EXCLUDED.filesystem_operation_id,
             lifecycle='attached',updated_at=clock_timestamp(),published_at=NULL`,
      [claimValue.ownerUserId, claimValue.assetId, claimValue.workVersion, claimValue.expectedContentHash,
        thumbnail.contentHash, attached.operation.operationId],
    );
    return Object.freeze({ operation: attached.operation, claim: attached.claim });
  };

  const completeWithExistingThumbnail: PrivateAssetMetadataBackfillExecutorRepository["completeWithExistingThumbnail"] = async (
    claimValue,
    thumbnail,
    originalMetadata,
  ) => withTransaction(pool, async (database) => {
    const locked = await database.query<Readonly<{ id: string }>>(
      `SELECT job.id
         FROM asset_metadata_backfill_jobs job
         JOIN assets asset ON asset.id=job.asset_id AND asset.owner_user_id=job.owner_user_id
         JOIN asset_derivatives derivative
           ON derivative.owner_user_id=asset.owner_user_id AND derivative.source_asset_id=asset.id
         JOIN durable_filesystem_operations operation ON operation.id=derivative.filesystem_operation_id
        WHERE job.owner_user_id=$1 AND job.asset_id=$2 AND job.lease_id=$3 AND job.lease_owner=$4
          AND job.work_version=$5 AND job.status='running' AND job.lease_expires_at > clock_timestamp()
          AND asset.content_hash=$6 AND asset.mime_type=$7 AND asset.byte_length=$8
          AND derivative.derivative_kind='thumbnail' AND derivative.transform_version=$9
          AND derivative.pixel_width=$10 AND derivative.pixel_height=$11
          AND derivative.mime_type=$12 AND derivative.byte_length=$13 AND derivative.content_hash=$14
          AND operation.owner_user_id=job.owner_user_id AND operation.asset_id=job.asset_id
          AND operation.purpose='asset_derivative' AND operation.resource_kind='asset' AND operation.lifecycle='finalized'
        FOR UPDATE OF job,asset,derivative,operation`,
      [
        ...leaseWhere(claimValue), claimValue.expectedContentHash, claimValue.expectedMimeType,
        claimValue.expectedByteLength, thumbnail.transformVersion, thumbnail.pixelWidth, thumbnail.pixelHeight,
        thumbnail.mimeType, thumbnail.byteLength, thumbnail.contentHash
      ],
    );
    if (!locked.rows[0]) return "stale" as const;
    await database.query(
      `UPDATE assets
          SET pixel_width=$3,pixel_height=$4,
              technical_metadata=(technical_metadata - 'backfillError') || $5::jsonb
        WHERE owner_user_id=$1 AND id=$2 AND content_hash=$6 AND mime_type=$7 AND byte_length=$8`,
      [
        claimValue.ownerUserId, claimValue.assetId, originalMetadata.pixelWidth, originalMetadata.pixelHeight,
        JSON.stringify({
          state: "verified",
          format: originalMetadata.format,
          pages: originalMetadata.pages,
          orientation: originalMetadata.orientation
        }), claimValue.expectedContentHash,
        claimValue.expectedMimeType, claimValue.expectedByteLength
      ],
    );
    await database.query(
      `UPDATE asset_publication_content_arbitrations arbitration
          SET verification_state='verified',updated_at=clock_timestamp()
        WHERE arbitration.owner_user_id=$1 AND arbitration.content_hash=$2 AND arbitration.canonical_asset_id=$3
          AND arbitration.verification_state='verification_required'
          AND EXISTS (
            SELECT 1 FROM asset_publication_identities identity
             WHERE identity.owner_user_id=arbitration.owner_user_id AND identity.asset_id=arbitration.canonical_asset_id
               AND identity.lifecycle IN ('prepared','attached','published')
          )`,
      [claimValue.ownerUserId, claimValue.expectedContentHash, claimValue.assetId],
    );
    // A concurrent recovery worker may have physically finalized the attached
    // operation while this claim was decoding. Reusing that finalized
    // derivative is valid only if its durable publication projection is
    // completed in the same transaction as the backfill job.
    await database.query(
      `UPDATE asset_metadata_backfill_publications publication
          SET lifecycle='published',published_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE publication.owner_user_id=$1 AND publication.asset_id=$2
          AND publication.lifecycle='attached'
          AND publication.filesystem_operation_id=(
            SELECT derivative.filesystem_operation_id
              FROM asset_derivatives derivative
             WHERE derivative.owner_user_id=$1 AND derivative.source_asset_id=$2
               AND derivative.derivative_kind='thumbnail' AND derivative.transform_version=$3
               AND derivative.pixel_width=$4 AND derivative.pixel_height=$5
               AND derivative.mime_type=$6 AND derivative.byte_length=$7 AND derivative.content_hash=$8
          )`,
      [
        claimValue.ownerUserId, claimValue.assetId, thumbnail.transformVersion,
        thumbnail.pixelWidth, thumbnail.pixelHeight, thumbnail.mimeType,
        thumbnail.byteLength, thumbnail.contentHash
      ],
    );
    const completed = await database.query(
      `UPDATE asset_metadata_backfill_jobs
          SET status='completed',diagnostic_code=NULL,lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,
              completed_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE id=$1`,
      [locked.rows[0].id],
    );
    return completed.rowCount ? "completed" as const : "stale" as const;
  });

  const completeFinalization: PrivateAssetMetadataBackfillExecutorRepository["completeFinalization"] = async (claimValue, operationId) => withTransaction(pool, async (database) => {
    const completed = await database.query(
      `WITH locked AS (
         SELECT job.id
           FROM asset_metadata_backfill_jobs job
           JOIN asset_metadata_backfill_publications publication
             ON publication.owner_user_id=job.owner_user_id AND publication.asset_id=job.asset_id
          WHERE job.owner_user_id=$1 AND job.asset_id=$2 AND job.lease_id=$3 AND job.lease_owner=$4
            AND job.work_version=$5 AND job.status='running' AND job.lease_expires_at > clock_timestamp()
            AND publication.filesystem_operation_id=$6 AND publication.lifecycle='attached'
          FOR UPDATE OF job,publication
       ), completed_job AS (
         UPDATE asset_metadata_backfill_jobs job
            SET status='completed',diagnostic_code=NULL,lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,
                completed_at=clock_timestamp(),updated_at=clock_timestamp()
           FROM locked
          WHERE job.id=locked.id
          RETURNING job.owner_user_id,job.asset_id
       )
       UPDATE asset_metadata_backfill_publications publication
          SET lifecycle='published',published_at=clock_timestamp(),updated_at=clock_timestamp()
         FROM completed_job job
        WHERE publication.owner_user_id=job.owner_user_id AND publication.asset_id=job.asset_id
          AND publication.filesystem_operation_id=$6 AND publication.lifecycle='attached'
       RETURNING publication.asset_id`,
      [...leaseWhere(claimValue), operationId],
    );
    return completed.rowCount ? "completed" as const : "stale" as const;
  });

  const reconcileFinalizedOperation: PrivateAssetMetadataBackfillExecutorRepository["reconcileFinalizedOperation"] = async (input) => withTransaction(pool, async (database) => {
    const publication = await database.query<Readonly<{ asset_id: string; job_id: string; job_status: string; lease_expires_at: Date | null }>>(
      `SELECT publication.asset_id,job.id AS job_id,job.status AS job_status,job.lease_expires_at
         FROM asset_metadata_backfill_publications publication
         JOIN asset_metadata_backfill_jobs job
           ON job.owner_user_id=publication.owner_user_id AND job.asset_id=publication.asset_id
         JOIN durable_filesystem_operations operation
           ON operation.id=publication.filesystem_operation_id
          AND operation.owner_user_id=publication.owner_user_id
        WHERE publication.filesystem_operation_id=$1 AND publication.owner_user_id=$2
          AND publication.lifecycle='attached' AND operation.lifecycle='finalized'
        FOR UPDATE OF publication,job,operation`,
      [input.operationId, input.ownerUserId],
    );
    const row = publication.rows[0];
    if (!row) return "noop" as const;
    if (row.job_status === "running" && row.lease_expires_at !== null && row.lease_expires_at.getTime() > Date.now()) {
      return "pending" as const;
    }
    if (!["running", "recoverable", "queued"].includes(row.job_status)) {
      return "pending" as const;
    }
    const published = await database.query(
      `UPDATE asset_metadata_backfill_publications
          SET lifecycle='published',published_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE owner_user_id=$1 AND asset_id=$2 AND filesystem_operation_id=$3 AND lifecycle='attached'`,
      [input.ownerUserId, row.asset_id, input.operationId],
    );
    if (published.rowCount !== 1) return "pending" as const;
    await database.query(
      `UPDATE asset_metadata_backfill_jobs
          SET status='completed',diagnostic_code=NULL,lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,
              completed_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE id=$1 AND status IN ('running','recoverable','queued')`,
      [row.job_id],
    );
    return "completed" as const;
  });

  const fail: PrivateAssetMetadataBackfillExecutorRepository["fail"] = async (claimValue, diagnosticCode) => {
    if (!DIAGNOSTICS.has(diagnosticCode)) throw new Error("asset_metadata_backfill_diagnostic_invalid");
    const updated = await pool.query<Readonly<{ status: "recoverable" | "failed" }>>(
      `WITH updated_job AS (
         UPDATE asset_metadata_backfill_jobs
            SET status=CASE WHEN attempts >= 3 THEN 'failed' ELSE 'recoverable' END,
                diagnostic_code=$6,lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,
                next_attempt_at=clock_timestamp()+CASE attempts
                  WHEN 1 THEN interval '2 seconds' WHEN 2 THEN interval '8 seconds' ELSE interval '30 seconds' END,
                updated_at=clock_timestamp()
          WHERE owner_user_id=$1 AND asset_id=$2 AND lease_id=$3 AND lease_owner=$4 AND work_version=$5
            AND status='running' AND lease_expires_at > clock_timestamp()
          RETURNING owner_user_id,asset_id,status
       ), updated_asset AS (
         UPDATE assets asset
            SET technical_metadata=asset.technical_metadata || jsonb_build_object('backfillError',$6::text)
           FROM updated_job job
          WHERE asset.owner_user_id=job.owner_user_id AND asset.id=job.asset_id
          RETURNING asset.id
       )
       SELECT status FROM updated_job`,
      [...leaseWhere(claimValue), diagnosticCode],
    );
    return updated.rows[0]?.status ?? "lease_lost";
  };

  return Object.freeze({
    enqueueMissing,
    claimNext,
    heartbeat,
    pendingFinalization,
    completeWithExistingThumbnail,
    attachThumbnail,
    completeFinalization,
    reconcileFinalizedOperation,
    fail
  });
}
