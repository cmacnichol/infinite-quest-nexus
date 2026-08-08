import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { createAssetApplication } from "../../packages/application/src/assets/index.js";
import { toPortableStagedInput } from "../../packages/application/src/imports/index.js";
import type {
  AssetPublicationCandidate,
  AttachedFilesystemOperation,
  DurableFilesystemRecoveryClaim,
  DurableFilesystemOperationId,
  PrivateFilesystemCapabilityPersistencePort,
  PrivateStorageDescriptor,
  ReservedFilesystemOperation
} from "../../packages/application/src/assets/private-storage-lifecycle.js";
import type {
  ImportOwnerScope,
  PortableArchiveExportRetrieval,
  PortableArchiveExportView,
  PortableImportCommitView,
  PortableImportKind,
  PortableImportPreviewCommand,
  PortableImportPreviewProjectionFor,
  PortableImportPreviewView,
  PortableImportResultRetrieval,
  PortableImportResultView,
  PortablePreviewDestination,
  PortableStagedInput
} from "../../packages/application/src/imports/index.js";
import type { ArchiveType } from "../../packages/contracts/src/archives.js";
import { createPostgresAssetRepositories } from "../../packages/database/src/asset-repository.js";
import { createPostgresDurableFilesystemRepository } from "../../packages/database/src/durable-filesystem-repository.js";
import {
  createPostgresImportRepository,
  type CompletePortableImportRequest,
  type PortableImportBeginResult,
  type PortableImportCommitRepositoryCommand,
  type PortableExportScope
} from "../../packages/database/src/import-repository.js";
import { withTransaction, type DatabaseClient, type DatabasePool } from "../../packages/database/src/pool.js";
import {
  createPortableArchiveFilesystemAdapter,
  type PortableArchiveFilesystemAdapter
} from "../../services/api/src/portable-archive-filesystem-adapter.js";
import {
  rehydratePersistedAnchoredStagedArchive,
  releaseAnchoredStagedArchive,
  type ArchiveLimits
} from "../../services/api/src/archive-io.js";
import {
  adaptLegacyCampaignZip,
  type DecodedCampaignArchive
} from "../../services/api/src/campaign-archive-service.js";

type PortableReservation = Readonly<{
  kind: "staged" | "export";
  owner: ImportOwnerScope;
  operationScopeId: string;
  reservation: ReservedFilesystemOperation;
  claim: DurableFilesystemRecoveryClaim;
  expiresAt: string;
  exportScope?: PortableExportScope;
  skipFinalize?: boolean;
  skipDomainRegistration?: boolean;
}>;

export type Task14e2cAdapters = Readonly<{
  assets: ReturnType<typeof createAssetApplication>;
  archive: Readonly<{
    stage(
      owner: ImportOwnerScope,
      source: Readable,
      byteLength: number,
      options?: Readonly<{
        simulateCrashAfterAttach?: boolean;
        simulateCrashAfterDomainCommit?: boolean;
      }>,
    ): Promise<PortableStagedInput>;
    inspect(
      owner: ImportOwnerScope,
      stagedInput: PortableStagedInput,
      expectedType: ArchiveType | "container",
    ): ReturnType<PortableArchiveFilesystemAdapter["inspectPortableArchive"]>;
    extract(
      owner: ImportOwnerScope,
      stagedInput: PortableStagedInput,
      path: string,
      maximumBytes: number,
    ): ReturnType<PortableArchiveFilesystemAdapter["extractVerifiedEntry"]>;
    parseLegacyCampaignZip(
      owner: ImportOwnerScope,
      stagedInput: PortableStagedInput,
    ): Promise<DecodedCampaignArchive>;
    cleanup(owner: ImportOwnerScope, stagedInput: PortableStagedInput): Promise<void>;
    preview<Command extends PortableImportPreviewCommand>(input: Readonly<{
      command: Command;
      projection: PortableImportPreviewProjectionFor<Command["kind"]>;
      diagnostics?: readonly import("../../packages/application/src/imports/index.js").PortableArchiveDiagnosticCode[];
      expiresAt?: string;
    }>): Promise<PortableImportPreviewView<Command>>;
    commit<Kind extends PortableImportKind, Destination extends PortablePreviewDestination>(
      command: PortableImportCommitRepositoryCommand<Kind, Destination>,
      complete: (
        client: DatabaseClient,
        ready: Extract<PortableImportBeginResult<Kind>, { outcome: "ready" }>,
      ) => Promise<CompletePortableImportRequest<Kind>>,
    ): Promise<PortableImportCommitView<Kind>>;
    retrieve<Kind extends PortableImportKind>(
      owner: ImportOwnerScope,
      kind: Kind,
      retrieval: PortableImportResultRetrieval<Kind>,
    ): Promise<PortableImportResultView<Kind> | null>;
    abort(owner: ImportOwnerScope, stagedInput: PortableStagedInput): Promise<void>;
    publishCampaignExport(
      scope: PortableExportScope,
      entries: Parameters<PortableArchiveFilesystemAdapter["publishArchiveArtifact"]>[1],
      buildManifest: Parameters<PortableArchiveFilesystemAdapter["publishArchiveArtifact"]>[2],
    ): Promise<PortableArchiveExportView>;
    downloadExport(
      scope: PortableExportScope,
      retrieval: PortableArchiveExportRetrieval,
    ): ReturnType<PortableArchiveFilesystemAdapter["readExportArtifact"]>;
    cleanupExport(scope: PortableExportScope, retrieval: PortableArchiveExportRetrieval): Promise<void>;
    recover(workerId: string): Promise<readonly Readonly<{
      operationId: string;
      ownerUserId: string;
      action: "finalize" | "cleanup";
      outcome: string;
    }>[]>;
  }>;
  illustration: Readonly<{
    publishOriginal(input: Readonly<{
      ownerUserId: string;
      assetId: string;
      content: Uint8Array;
      mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
      failBeforeDomainCommit?: boolean;
      simulateCrashAfterAttach?: boolean;
      failFinalizedTransitionAfterDomainCommit?: boolean;
      captureAttachedLocator?: (
        locator: import("../../packages/application/src/assets/private-storage-lifecycle.js").DatabaseIssuedStorageLocator,
      ) => void;
    }>): Promise<Readonly<{
      locator: import("../../packages/application/src/assets/private-storage-lifecycle.js").DatabaseIssuedStorageLocator;
      relativePath: string;
      width: number;
      height: number;
      contentHash: string;
    }>>;
  }>;
  filesystem: PortableArchiveFilesystemAdapter;
  imports: ReturnType<typeof createPostgresImportRepository>;
  durable: ReturnType<typeof createPostgresDurableFilesystemRepository>;
}>;

export type Task14e2cAdapterOptions = Readonly<{
  pool: DatabasePool;
  archiveRoot: string;
  assetRoot: string;
  limits: ArchiveLimits;
}>;

function operationExpiry(): string {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireAttached(
  result: Awaited<ReturnType<ReturnType<typeof createPostgresDurableFilesystemRepository>["journal"]["attach"]>>,
): Extract<typeof result, { outcome: "attached" }> {
  if (result.outcome !== "attached") throw new Error(`task_14e2c_attach_${result.outcome}`);
  return result;
}

class Task14e2cSimulatedCrash extends Error {}

/**
 * Test-only composition of the approved 14e2aR capability and 14e2b
 * repositories. Production routes/workers deliberately do not import it.
 */
export function createTask14e2cAdapters(options: Task14e2cAdapterOptions): Task14e2cAdapters {
  const imports = createPostgresImportRepository(options.pool);
  const durable = createPostgresDurableFilesystemRepository(options.pool);
  const reservationContext = new AsyncLocalStorage<PortableReservation>();
  const exportRedemptionContext = new AsyncLocalStorage<PortableExportScope>();
  const candidateDescriptors = new Map<AssetPublicationCandidate, PrivateStorageDescriptor>();

  type PortableCleanupRow = Readonly<{
    id: string;
    owner_user_id: string;
    operation_scope_hash: string;
    purpose: "portable_staging" | "portable_export";
    lifecycle: "reserved" | "attached" | "finalized" | "cleanup_pending" | "cleaned";
    lease_id: string;
    lease_owner: string;
    work_version: number;
    lease_expires_at: Date;
    relative_path: string;
    device_id: string;
    file_id: string;
    change_token: string;
    content_hash: string;
    byte_length: string;
  }>;

  function portableCleanupCapability(row: PortableCleanupRow): Readonly<{
    descriptor: PrivateStorageDescriptor;
    operation: AttachedFilesystemOperation;
    claim: DurableFilesystemRecoveryClaim;
  }> {
    return {
      descriptor: {
        relativePath: row.relative_path,
        identity: {
          deviceId: row.device_id,
          fileId: row.file_id,
          changeToken: row.change_token
        },
        contentHash: row.content_hash,
        byteLength: Number(row.byte_length)
      },
      operation: {
        resourceKind: "portable",
        ownerUserId: row.owner_user_id,
        operationScopeId: row.operation_scope_hash,
        operationId: row.id as DurableFilesystemOperationId,
        purpose: row.purpose
      } as AttachedFilesystemOperation,
      claim: {
        operationId: row.id as DurableFilesystemOperationId,
        leaseId: row.lease_id,
        leaseOwner: row.lease_owner,
        workVersion: row.work_version,
        leaseExpiresAt: row.lease_expires_at.toISOString()
      } as DurableFilesystemRecoveryClaim
    };
  }

  async function claimStagedCleanup(
    owner: ImportOwnerScope,
    stagedInput: PortableStagedInput,
  ): Promise<Readonly<{ outcome: "already_cleaned" }> | Readonly<{
    outcome: "claimed";
    descriptor: PrivateStorageDescriptor;
    operation: AttachedFilesystemOperation;
    claim: DurableFilesystemRecoveryClaim;
  }> | null> {
    return withTransaction(options.pool, async (client) => {
      const selected = await client.query<PortableCleanupRow>(
        `SELECT operation.id,operation.owner_user_id,operation.operation_scope_hash,
                operation.purpose,operation.lifecycle,operation.lease_id,operation.lease_owner,
                operation.work_version,operation.lease_expires_at,
                descriptor.relative_path,descriptor.device_id,descriptor.file_id,
                descriptor.change_token,descriptor.content_hash,descriptor.byte_length::text
           FROM portable_staged_inputs staged
           JOIN durable_filesystem_operations operation
             ON operation.id=staged.filesystem_operation_id
            AND operation.owner_user_id=staged.owner_user_id
            AND operation.resource_kind='portable'
            AND operation.purpose='portable_staging'
           JOIN durable_filesystem_descriptors descriptor
             ON descriptor.operation_id=operation.id
            AND descriptor.owner_user_id=operation.owner_user_id
            AND descriptor.descriptor_role='delivery'
          WHERE staged.owner_user_id=$1 AND staged.handle_token_hash=$2
          FOR UPDATE OF operation`,
        [owner.ownerUserId, sha256(stagedInput)]
      );
      const row = selected.rows[0];
      if (!row) return null;
      if (row.lifecycle === "cleaned") return { outcome: "already_cleaned" };
      const claimed = await client.query<PortableCleanupRow>(
        `UPDATE durable_filesystem_operations operation
            SET lease_id=gen_random_uuid(),lease_owner=$2,work_version=operation.work_version+1,
                lease_expires_at=now()+interval '60 seconds',updated_at=now()
          WHERE operation.id=$1 AND operation.owner_user_id=$3
            AND operation.resource_kind='portable' AND operation.purpose='portable_staging'
            AND operation.lifecycle IN ('attached','finalized','cleanup_pending')
        RETURNING operation.id,operation.owner_user_id,operation.operation_scope_hash,
                  operation.purpose,operation.lifecycle,operation.lease_id,operation.lease_owner,
                  operation.work_version,operation.lease_expires_at,
                  $4::text AS relative_path,$5::text AS device_id,$6::text AS file_id,
                  $7::text AS change_token,$8::text AS content_hash,$9::bigint::text AS byte_length`,
        [
          row.id,
          `task-14e2c-staged-cleanup:${crypto.randomUUID()}`,
          owner.ownerUserId,
          row.relative_path,
          row.device_id,
          row.file_id,
          row.change_token,
          row.content_hash,
          row.byte_length
        ]
      );
      const value = claimed.rows[0];
      return value ? { outcome: "claimed", ...portableCleanupCapability(value) } : null;
    });
  }

  async function claimExportCleanup(
    scope: PortableExportScope,
    retrieval: PortableArchiveExportRetrieval,
  ): Promise<Readonly<{ outcome: "already_cleaned" }> | Readonly<{
    outcome: "claimed";
    descriptor: PrivateStorageDescriptor;
    operation: AttachedFilesystemOperation;
    claim: DurableFilesystemRecoveryClaim;
  }> | null> {
    return withTransaction(options.pool, async (client) => {
      const selected = await client.query<PortableCleanupRow>(
        `SELECT operation.id,operation.owner_user_id,operation.operation_scope_hash,
                operation.purpose,operation.lifecycle,operation.lease_id,operation.lease_owner,
                operation.work_version,operation.lease_expires_at,
                descriptor.relative_path,descriptor.device_id,descriptor.file_id,
                descriptor.change_token,descriptor.content_hash,descriptor.byte_length::text
           FROM portable_export_artifacts artifact
           JOIN durable_filesystem_operations operation
             ON operation.id=artifact.filesystem_operation_id
            AND operation.owner_user_id=artifact.owner_user_id
            AND operation.resource_kind='portable'
            AND operation.purpose='portable_export'
           JOIN durable_filesystem_descriptors descriptor
             ON descriptor.operation_id=operation.id
            AND descriptor.owner_user_id=operation.owner_user_id
            AND descriptor.descriptor_role='delivery'
          WHERE artifact.owner_user_id=$1 AND artifact.retrieval_token_hash=$2
            AND artifact.export_kind=$3 AND artifact.campaign_id IS NOT DISTINCT FROM $4::uuid
            AND artifact.world_id=$5 AND artifact.world_version_id=$6
          FOR UPDATE OF operation`,
        [scope.ownerUserId, sha256(retrieval), scope.exportKind, scope.campaignId, scope.worldId, scope.worldVersionId]
      );
      const row = selected.rows[0];
      if (!row) return null;
      if (row.lifecycle === "cleaned") return { outcome: "already_cleaned" };
      const claimed = await client.query<PortableCleanupRow>(
        `UPDATE durable_filesystem_operations operation
            SET lease_id=gen_random_uuid(),lease_owner=$2,work_version=operation.work_version+1,
                lease_expires_at=now()+interval '60 seconds',updated_at=now()
          WHERE operation.id=$1 AND operation.owner_user_id=$3
            AND operation.resource_kind='portable' AND operation.purpose='portable_export'
            AND operation.lifecycle IN ('attached','finalized','cleanup_pending')
        RETURNING operation.id,operation.owner_user_id,operation.operation_scope_hash,
                  operation.purpose,operation.lifecycle,operation.lease_id,operation.lease_owner,
                  operation.work_version,operation.lease_expires_at,
                  $4::text AS relative_path,$5::text AS device_id,$6::text AS file_id,
                  $7::text AS change_token,$8::text AS content_hash,$9::bigint::text AS byte_length`,
        [
          row.id,
          `task-14e2c-export-cleanup:${crypto.randomUUID()}`,
          scope.ownerUserId,
          row.relative_path,
          row.device_id,
          row.file_id,
          row.change_token,
          row.content_hash,
          row.byte_length
        ]
      );
      const value = claimed.rows[0];
      return value ? { outcome: "claimed", ...portableCleanupCapability(value) } : null;
    });
  }

  async function attachPortable(
    pending: PortableReservation,
    descriptor: PrivateStorageDescriptor,
  ) {
    const candidate = await durable.issuePublicationCandidate(pending.reservation, {
      deliveryRelativePath: descriptor.relativePath,
      cleanupDescriptors: [descriptor]
    });
    await durable.completePublicationCandidate(pending.reservation, candidate, descriptor);
    const attached = requireAttached(await withTransaction(
      options.pool,
      (client) => durable.journal.attach(client, pending.reservation, candidate),
    ));
    return attached;
  }

  const persistence: PrivateFilesystemCapabilityPersistencePort = {
    journal: durable.journal,

    async issueStagedInput(owner, descriptor) {
      const pending = reservationContext.getStore();
      if (!pending || pending.kind !== "staged" || pending.owner.ownerUserId !== owner.ownerUserId) {
        throw new Error("task_14e2c_staging_reservation_missing");
      }
      const attached = await attachPortable(pending, descriptor);
      if (pending.skipDomainRegistration) {
        const stagedInput = toPortableStagedInput(`crashed:${crypto.randomUUID()}`);
        return stagedInput;
      }
      const stagedInput = await imports.registerStagedInput({
        ownerUserId: owner.ownerUserId,
        filesystemOperationId: attached.operation.operationId,
        operationScopeId: pending.operationScopeId,
        contentHash: descriptor.contentHash,
        byteLength: descriptor.byteLength,
        expiresAt: pending.expiresAt
      });
      if (!pending.skipFinalize) {
        const finalized = await durable.journal.finalizeAfterCommit(attached.operation, attached.claim);
        if (finalized.outcome !== "finalized" && finalized.outcome !== "already_finalized") {
          throw new Error(`task_14e2c_staging_finalize_${finalized.outcome}`);
        }
      }
      return stagedInput;
    },

    async redeemStagedInput(owner, stagedInput) {
      const payload = await imports.retrieveStagedPayload(owner, stagedInput);
      return payload?.descriptor ?? null;
    },

    async beginStagedCleanup(owner, stagedInput) {
      const record = await claimStagedCleanup(owner, stagedInput);
      if (!record) return { outcome: "stale" };
      if (record.outcome === "already_cleaned") return record;
      const marked = await durable.journal.markCleanup(record.operation, record.claim, { cause: "rollback" });
      if (marked.outcome === "already_cleaned") return { outcome: "already_cleaned" };
      if (marked.outcome !== "cleanup_pending") return { outcome: "stale" };
      await options.pool.query(
        `UPDATE portable_staged_inputs
            SET status='cleanup_pending',updated_at=now()
          WHERE owner_user_id=$1 AND filesystem_operation_id=$2
            AND status IN ('staged','consumed','expired','failed','cleanup_pending')`,
        [owner.ownerUserId, record.operation.operationId]
      );
      return { outcome: "cleanup_required", descriptor: record.descriptor };
    },

    async completeStagedCleanup(owner, stagedInput) {
      const record = await claimStagedCleanup(owner, stagedInput);
      if (!record) return { outcome: "stale" };
      if (record.outcome === "already_cleaned") return record;
      const completed = await durable.journal.completeCleanup(record.operation, record.claim);
      if (completed.outcome === "cleaned" || completed.outcome === "already_cleaned") {
        await options.pool.query(
          `UPDATE portable_staged_inputs
              SET status='cleaned',updated_at=now()
            WHERE owner_user_id=$1 AND filesystem_operation_id=$2
              AND status IN ('cleanup_pending','cleaned')`,
          [owner.ownerUserId, record.operation.operationId]
        );
        return { outcome: completed.outcome };
      }
      return { outcome: "stale" };
    },

    async issueExportRetrieval(owner, descriptor) {
      const pending = reservationContext.getStore();
      if (!pending || pending.kind !== "export" || !pending.exportScope
        || pending.owner.ownerUserId !== owner.ownerUserId) {
        throw new Error("task_14e2c_export_reservation_missing");
      }
      const attached = await attachPortable(pending, descriptor);
      const retrieval = await imports.registerExportArtifact({
        ...pending.exportScope,
        filesystemOperationId: attached.operation.operationId,
        operationScopeId: pending.operationScopeId,
        contentType: "application/zip",
        contentHash: descriptor.contentHash,
        byteLength: descriptor.byteLength,
        expiresAt: pending.expiresAt
      });
      const finalized = await durable.journal.finalizeAfterCommit(attached.operation, attached.claim);
      if (finalized.outcome !== "finalized" && finalized.outcome !== "already_finalized") {
        throw new Error(`task_14e2c_export_finalize_${finalized.outcome}`);
      }
      return retrieval.retrieval;
    },

    async redeemExportRetrieval(owner, retrieval) {
      const scope = exportRedemptionContext.getStore();
      if (!scope || scope.ownerUserId !== owner.ownerUserId) return null;
      return (await imports.retrieveExportArtifact(scope, retrieval))?.descriptor ?? null;
    },

    async beginExportCleanup(owner, retrieval) {
      const scope = exportRedemptionContext.getStore();
      if (!scope || scope.ownerUserId !== owner.ownerUserId) return { outcome: "stale" };
      const record = await claimExportCleanup(scope, retrieval);
      if (!record) return { outcome: "stale" };
      if (record.outcome === "already_cleaned") return record;
      const marked = await durable.journal.markCleanup(record.operation, record.claim, { cause: "rollback" });
      if (marked.outcome === "already_cleaned") return { outcome: "already_cleaned" };
      if (marked.outcome !== "cleanup_pending") return { outcome: "stale" };
      await options.pool.query(
        `UPDATE portable_export_artifacts
            SET status='cleanup_pending',updated_at=now()
          WHERE owner_user_id=$1 AND filesystem_operation_id=$2
            AND status IN ('ready','consumed','expired','failed','cleanup_pending')`,
        [owner.ownerUserId, record.operation.operationId]
      );
      return { outcome: "cleanup_required", descriptor: record.descriptor };
    },

    async completeExportCleanup(owner, retrieval) {
      const scope = exportRedemptionContext.getStore();
      if (!scope || scope.ownerUserId !== owner.ownerUserId) return { outcome: "stale" };
      const record = await claimExportCleanup(scope, retrieval);
      if (!record) return { outcome: "stale" };
      if (record.outcome === "already_cleaned") return record;
      const completed = await durable.journal.completeCleanup(record.operation, record.claim);
      if (completed.outcome === "cleaned" || completed.outcome === "already_cleaned") {
        await options.pool.query(
          `UPDATE portable_export_artifacts
              SET status='cleaned',updated_at=now()
            WHERE owner_user_id=$1 AND filesystem_operation_id=$2
              AND status IN ('cleanup_pending','cleaned')`,
          [owner.ownerUserId, record.operation.operationId]
        );
        return { outcome: completed.outcome };
      }
      return { outcome: "stale" };
    },

    async issuePublicationCandidate(reservation, preparation) {
      return durable.issuePublicationCandidate(reservation, preparation);
    },

    async completePublicationCandidate(reservation, candidate, descriptor) {
      await durable.completePublicationCandidate(reservation, candidate, descriptor);
      candidateDescriptors.set(candidate, descriptor);
    },

    preparePublicationCleanup(operation, claim) {
      return durable.preparePublicationCleanup(operation, claim);
    },

    redeemStorageLocator(scope, locator) {
      return durable.redeemStorageLocator(scope, locator);
    }
  };

  const filesystem = createPortableArchiveFilesystemAdapter({
    archiveRoot: options.archiveRoot,
    assetRoot: options.assetRoot,
    limits: options.limits,
    persistence
  });
  const portableCleanupFilesystem = options.archiveRoot === options.assetRoot
    ? filesystem
    : createPortableArchiveFilesystemAdapter({
      archiveRoot: options.archiveRoot,
      assetRoot: options.archiveRoot,
      limits: options.limits,
      persistence
    });

  async function cleanupReservation(pending: PortableReservation): Promise<void> {
    const marked = await durable.journal.markCleanup(
      pending.reservation,
      pending.claim,
      { cause: "rollback", diagnosticCode: "asset_storage_unavailable" },
    );
    if (marked.outcome === "cleanup_pending") {
      await filesystem.cleanupPublishedAsset(pending.reservation, pending.claim);
    }
  }

  return {
    assets: createAssetApplication(createPostgresAssetRepositories(options.pool)),
    imports,
    durable,
    filesystem,
    illustration: {
      async publishOriginal(input) {
        const expiresAt = operationExpiry();
        let domainCommitted = false;
        const reserved = await durable.journal.reserve(
          { resourceKind: "asset", ownerUserId: input.ownerUserId, assetId: input.assetId },
          { purpose: "asset_original", leaseOwner: "task-14e2c-image", expiresAt },
        );
        try {
          const candidate = await filesystem.publishAssetCandidate(reserved.operation, {
            content: input.content,
            mimeType: input.mimeType
          });
          const descriptor = candidateDescriptors.get(candidate);
          if (!descriptor) throw new Error("task_14e2c_image_descriptor_missing");
          const attached = requireAttached(await withTransaction(options.pool, async (client) => {
            const result = await durable.journal.attach(client, reserved.operation, candidate);
            if (input.failBeforeDomainCommit) throw new Error("task_14e2c_forced_image_rollback");
            if (result.outcome !== "attached") return result;
            if (input.simulateCrashAfterAttach) return result;
            const updated = await client.query(
              `UPDATE assets
                  SET storage_path=$3,content_hash=$4,byte_length=$5
                WHERE id=$1 AND owner_user_id=$2`,
              [input.assetId, input.ownerUserId, descriptor.relativePath, descriptor.contentHash, descriptor.byteLength]
            );
            if (!updated.rowCount) throw new Error("task_14e2c_asset_not_found");
            return result;
          }));
          if (input.simulateCrashAfterAttach) {
            throw new Task14e2cSimulatedCrash("task_14e2c_simulated_image_crash");
          }
          domainCommitted = true;
          input.captureAttachedLocator?.(attached.locator);
          if (input.failFinalizedTransitionAfterDomainCommit) {
            throw new Error("task_14e2c_forced_image_finalize_failure");
          }
          const finalized = await durable.journal.finalizeAfterCommit(attached.operation, attached.claim);
          if (finalized.outcome !== "finalized" && finalized.outcome !== "already_finalized") {
            throw new Error(`task_14e2c_image_finalize_${finalized.outcome}`);
          }
          const verified = await filesystem.readPublishedAsset({
            scope: { resourceKind: "asset", ownerUserId: input.ownerUserId, assetId: input.assetId },
            locator: attached.locator,
            mimeType: input.mimeType,
            maximumBytes: options.limits.maxOriginalImageBytes
          });
          await options.pool.query(
            `UPDATE assets
                SET pixel_width=$3,pixel_height=$4,
                    technical_metadata=COALESCE(technical_metadata,'{}'::jsonb) || $5::jsonb
              WHERE id=$1 AND owner_user_id=$2`,
            [
              input.assetId,
              input.ownerUserId,
              verified.width,
              verified.height,
              JSON.stringify({ format: verified.format, pages: verified.pages, orientation: verified.orientation })
            ]
          );
          candidateDescriptors.delete(candidate);
          return {
            locator: attached.locator,
            relativePath: descriptor.relativePath,
            width: verified.width,
            height: verified.height,
            contentHash: verified.contentHash
          };
        } catch (error) {
          if (error instanceof Task14e2cSimulatedCrash || domainCommitted) throw error;
          const marked = await durable.journal.markCleanup(
            reserved.operation,
            reserved.claim,
            { cause: "rollback", diagnosticCode: "asset_storage_unavailable" },
          ).catch(() => ({ outcome: "stale" as const }));
          if (marked.outcome === "cleanup_pending") {
            await filesystem.cleanupPublishedAsset(reserved.operation, reserved.claim).catch(() => undefined);
          }
          throw error;
        }
      }
    },
    archive: {
      async stage(owner, source, byteLength, stageOptions) {
        const operationScopeId = `staged:${crypto.randomUUID()}`;
        const expiresAt = operationExpiry();
        const reserved = await durable.journal.reserve(
          { resourceKind: "portable", ownerUserId: owner.ownerUserId, operationScopeId },
          { purpose: "portable_staging", leaseOwner: "task-14e2c-staging", expiresAt },
        );
        const pending: PortableReservation = {
          kind: "staged",
          owner,
          operationScopeId,
          reservation: reserved.operation,
          claim: reserved.claim,
          expiresAt,
          ...(stageOptions?.simulateCrashAfterAttach ? { skipDomainRegistration: true } : {}),
          ...(stageOptions?.simulateCrashAfterDomainCommit ? { skipFinalize: true } : {})
        };
        try {
          const upload = filesystem.issueOwnerBoundUpload(owner, source, byteLength);
          return await reservationContext.run(
            pending,
            () => filesystem.stagingPort.stagePortableArchive(upload),
          );
        } catch (error) {
          await cleanupReservation(pending).catch(() => undefined);
          throw error;
        }
      },

      inspect(owner, stagedInput, expectedType) {
        return filesystem.inspectPortableArchive(owner, stagedInput, expectedType);
      },

      extract(owner, stagedInput, path, maximumBytes) {
        return filesystem.extractVerifiedEntry(owner, stagedInput, path, maximumBytes);
      },

      async parseLegacyCampaignZip(owner, stagedInput) {
        const payload = await imports.retrieveStagedPayload(owner, stagedInput);
        if (!payload) throw new Error("task_14e2c_staged_input_unavailable");
        const changeToken = payload.descriptor.identity.changeToken.split(":");
        if (changeToken.length !== 2) throw new Error("task_14e2c_staged_identity_invalid");
        const staged = await rehydratePersistedAnchoredStagedArchive({
          archiveRoot: options.archiveRoot,
          relativePath: payload.descriptor.relativePath,
          compressedBytes: payload.byteLength,
          maximumCompressedBytes: options.limits.maxCompressedBytes,
          sha256: payload.contentHash,
          identity: {
            device: BigInt(payload.descriptor.identity.deviceId),
            inode: BigInt(payload.descriptor.identity.fileId),
            size: BigInt(payload.byteLength),
            modifiedNanoseconds: BigInt(changeToken[0]!),
            changedNanoseconds: BigInt(changeToken[1]!)
          }
        });
        try {
          return await adaptLegacyCampaignZip(staged, options.limits);
        } finally {
          await releaseAnchoredStagedArchive(staged);
        }
      },

      cleanup(owner, stagedInput) {
        return filesystem.cleanupStagedInput(owner, stagedInput);
      },

      async preview(input) {
        const staged = await imports.retrieveStagedPayload(
          { ownerUserId: input.command.ownerUserId },
          input.command.stagedInput,
        );
        if (!staged) throw new Error("task_14e2c_staged_input_unavailable");
        return imports.createPreview({
          command: input.command,
          contentFingerprint: staged.contentHash,
          projection: input.projection,
          diagnostics: input.diagnostics ?? [],
          expiresAt: input.expiresAt ?? operationExpiry()
        });
      },

      async commit(command, complete) {
        return withTransaction(options.pool, async (client) => {
          const begun = await imports.beginImport(client, command);
          if (begun.outcome === "replay") return begun.view;
          return imports.completeImport(client, begun.claim, await complete(client, begun));
        });
      },

      retrieve(owner, kind, retrieval) {
        return imports.retrieveImportResult(owner, kind, retrieval);
      },

      async abort(owner, stagedInput) {
        const payload = await imports.retrieveStagedPayload(owner, stagedInput);
        if (!payload) return;
        await options.pool.query(
          `UPDATE portable_import_operations
              SET status='cleanup_pending',diagnostic_codes=ARRAY['archive_cleanup_required']::text[],updated_at=now()
            WHERE owner_user_id=$1 AND staged_input_id=$2
              AND status IN ('previewed','superseded','expired','failed','cleanup_pending')`,
          [owner.ownerUserId, payload.stagedInputId]
        );
        await filesystem.cleanupStagedInput(owner, stagedInput);
        await options.pool.query(
          `UPDATE portable_import_operations
              SET status='cleaned',updated_at=now()
            WHERE owner_user_id=$1 AND staged_input_id=$2 AND status='cleanup_pending'`,
          [owner.ownerUserId, payload.stagedInputId]
        );
      },

      async publishCampaignExport(scope, entries, buildManifest) {
        const operationScopeId = `export:${crypto.randomUUID()}`;
        const expiresAt = operationExpiry();
        const reserved = await durable.journal.reserve(
          { resourceKind: "portable", ownerUserId: scope.ownerUserId, operationScopeId },
          { purpose: "portable_export", leaseOwner: "task-14e2c-export", expiresAt },
        );
        const pending: PortableReservation = {
          kind: "export",
          owner: { ownerUserId: scope.ownerUserId },
          operationScopeId,
          reservation: reserved.operation,
          claim: reserved.claim,
          expiresAt,
          exportScope: scope
        };
        try {
          return await reservationContext.run(
            pending,
            () => filesystem.publishArchiveArtifact({ ownerUserId: scope.ownerUserId }, entries, buildManifest),
          );
        } catch (error) {
          await cleanupReservation(pending).catch(() => undefined);
          throw error;
        }
      },

      downloadExport(scope, retrieval) {
        return exportRedemptionContext.run(
          scope,
          () => filesystem.readExportArtifact(
            { ownerUserId: scope.ownerUserId },
            retrieval,
            options.limits.maxCompressedBytes,
          ),
        );
      },

      cleanupExport(scope, retrieval) {
        return exportRedemptionContext.run(
          scope,
          () => filesystem.cleanupExportArtifact({ ownerUserId: scope.ownerUserId }, retrieval),
        );
      },

      async recover(workerId) {
        const records = await durable.journal.recover({ leaseOwner: workerId, leaseSeconds: 60, limit: 100 });
        const outcomes: Array<{
          operationId: string;
          ownerUserId: string;
          action: "finalize" | "cleanup";
          outcome: string;
        }> = [];
        for (const record of records) {
          if (record.action === "finalize") {
            const result = await durable.journal.finalizeAfterCommit(record.operation, record.claim);
            outcomes.push({
              operationId: record.operation.operationId,
              ownerUserId: record.operation.ownerUserId,
              action: record.action,
              outcome: result.outcome
            });
            continue;
          }
          const marked = await durable.journal.markCleanup(
            record.operation,
            record.claim,
            { cause: "recovery", diagnosticCode: "asset_storage_unavailable" },
          );
          const result = marked.outcome === "cleanup_pending"
            ? await (record.operation.resourceKind === "portable" ? portableCleanupFilesystem : filesystem)
              .cleanupPublishedAsset(record.operation, record.claim)
            : marked;
          if (result.outcome === "cleaned" || result.outcome === "already_cleaned") {
            await options.pool.query(
              `UPDATE portable_staged_inputs SET status='cleaned',updated_at=now()
                WHERE owner_user_id=$1 AND filesystem_operation_id=$2 AND status IN ('expired','failed','cleanup_pending')`,
              [record.operation.ownerUserId, record.operation.operationId]
            );
            await options.pool.query(
              `UPDATE portable_export_artifacts SET status='cleaned',updated_at=now()
                WHERE owner_user_id=$1 AND filesystem_operation_id=$2 AND status IN ('expired','failed','cleanup_pending')`,
              [record.operation.ownerUserId, record.operation.operationId]
            );
          }
          outcomes.push({
            operationId: record.operation.operationId,
            ownerUserId: record.operation.ownerUserId,
            action: record.action,
            outcome: result.outcome
          });
        }
        return outcomes;
      }
    }
  };
}
