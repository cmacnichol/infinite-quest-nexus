import { createHash } from "node:crypto";
import type {
  PrivateAttachedAssetPublication,
  PrivateAttachedAssetPublicationReconciliation,
  PrivateAssetPublicationCommand,
  PrivateAssetPublicationIdentity,
  PrivateAssetPublicationIdentityPort,
  PrivateAssetPublicationFinalization,
  PrivateAssetPublicationResult,
  PrivatePreparedAssetPublication,
  PrivatePreparedAssetPublicationArtifact
} from "../../application/src/assets/private-asset-publication.js";
import { validatePrivateAssetPublicationCommand } from "../../application/src/assets/private-asset-publication.js";
import type { PrivateFilesystemCandidatePersistencePort } from "../../application/src/assets/private-filesystem-repository.js";
import type { DurableFilesystemTransactionContext } from "../../application/src/assets/private-storage-lifecycle.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";
import { withTransaction } from "./pool.js";

type IdentityRow = Readonly<{
  asset_id: string;
  owner_user_id: string;
  request_fingerprint: string | null;
  lifecycle: "legacy" | "prepared" | "attached" | "published" | "cleanup_pending";
  result: unknown;
  pending_finalization: unknown;
}>;

type DerivativeRow = Readonly<{ id: string }>;

type AttachedOperationStateRow = Readonly<{
  id: string;
  purpose: "asset_original" | "asset_derivative";
  lifecycle: "attached" | "finalized" | "cleanup_pending" | "cleaned" | "reserved";
  lease_id: string;
  lease_owner: string;
  work_version: number;
  lease_expires_at: Date;
  lease_current: boolean;
}>;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(record[key])}`
  )).join(",")}}`;
}

function canonicalProvenance(command: PrivateAssetPublicationCommand): Readonly<Record<string, string | null>> {
  return Object.freeze({
    campaignId: command.provenance.campaignId ?? null,
    origin: command.provenance.origin,
    targetType: command.provenance.targetType ?? "other",
    turnId: command.provenance.turnId ?? null,
    worldId: command.provenance.worldId ?? null,
    worldVersionId: command.provenance.worldVersionId ?? null
  });
}

function fingerprint(command: PrivateAssetPublicationCommand): string {
  return sha256(stableStringify({
    ownerUserId: command.owner.ownerUserId,
    original: {
      mimeType: command.original.mimeType,
      byteLength: command.original.byteLength,
      contentHash: command.original.contentHash
    },
    derivatives: command.derivatives.map((derivative) => ({
      derivativeKind: derivative.derivativeKind,
      transformVersion: derivative.transformVersion,
      pixelWidth: derivative.pixelWidth,
      pixelHeight: derivative.pixelHeight,
      mimeType: derivative.mimeType,
      byteLength: derivative.byteLength,
      contentHash: derivative.contentHash
    })),
    provenance: canonicalProvenance(command)
  }));
}

function idempotencyHash(command: PrivateAssetPublicationCommand): string {
  return sha256(command.idempotencyKey);
}

async function callerTransaction(database: DurableFilesystemTransactionContext): Promise<DatabaseClient> {
  const client = database as Partial<DatabaseClient>;
  if (typeof client.query !== "function") throw new Error("asset_publication_transaction_unavailable");
  try {
    await client.query("SAVEPOINT asset_publication_repository_context");
    await client.query("RELEASE SAVEPOINT asset_publication_repository_context");
  } catch {
    throw new Error("asset_publication_transaction_unavailable");
  }
  return client as DatabaseClient;
}

function identity(row: IdentityRow): PrivateAssetPublicationIdentity {
  if (!(["prepared", "attached", "published"] as const).includes(
    row.lifecycle as "prepared" | "attached" | "published",
  )) {
    throw new Error("asset_publication_identity_unavailable");
  }
  const finalization = row.lifecycle === "attached"
    ? storedFinalization(row.pending_finalization, row.asset_id, row.owner_user_id)
    : undefined;
  return Object.freeze({
    assetId: row.asset_id,
    ownerUserId: row.owner_user_id,
    lifecycle: row.lifecycle as "prepared" | "attached" | "published",
    ...(["attached", "published"] as const).includes(row.lifecycle as "attached" | "published")
      ? { result: storedResult(row.result) }
      : {},
    ...(finalization ? { finalization } : {})
  }) as PrivateAssetPublicationIdentity;
}

function storedResult(value: unknown): PrivateAssetPublicationResult {
  if (!value || typeof value !== "object") throw new Error("asset_publication_result_invalid");
  const result = value as Partial<PrivateAssetPublicationResult>;
  const { assetId, mimeType, byteLength, contentHash, derivativeIds } = result;
  if (typeof assetId !== "string"
    || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mimeType ?? "")
    || typeof byteLength !== "number"
    || !Number.isSafeInteger(byteLength)
    || byteLength < 0
    || typeof contentHash !== "string"
    || !/^[0-9a-f]{64}$/u.test(contentHash)
    || !Array.isArray(derivativeIds)
    || !derivativeIds.every((derivative) => (
      derivative !== null
      && typeof derivative === "object"
      && typeof derivative.derivativeId === "string"
      && derivative.derivativeKind === "thumbnail"
    ))) {
    throw new Error("asset_publication_result_invalid");
  }
  return Object.freeze({
    assetId,
    mimeType: mimeType as PrivateAssetPublicationResult["mimeType"],
    byteLength,
    contentHash,
    derivativeIds: Object.freeze(derivativeIds.map((derivative) => Object.freeze({
      derivativeId: derivative.derivativeId,
      derivativeKind: "thumbnail" as const
    })))
  });
}

function storedFinalization(
  value: unknown,
  assetId: string,
  ownerUserId: string,
): readonly PrivateAssetPublicationFinalization[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("asset_publication_finalization_invalid");
  const operationIds = new Set<string>();
  const finalization = value.map((entry): PrivateAssetPublicationFinalization => {
    if (!entry || typeof entry !== "object") throw new Error("asset_publication_finalization_invalid");
    const { operation, claim } = entry as Readonly<{ operation?: Record<string, unknown>; claim?: Record<string, unknown> }>;
    if (!operation || !claim
      || operation.resourceKind !== "asset"
      || operation.ownerUserId !== ownerUserId
      || operation.assetId !== assetId
      || typeof operation.operationId !== "string"
      || !["asset_original", "asset_derivative"].includes(operation.purpose as string)
      || claim.operationId !== operation.operationId
      || typeof claim.leaseId !== "string"
      || typeof claim.leaseOwner !== "string"
      || !Number.isInteger(claim.workVersion)
      || (claim.workVersion as number) <= 0
      || typeof claim.leaseExpiresAt !== "string"
      || !Number.isFinite(Date.parse(claim.leaseExpiresAt))) {
      throw new Error("asset_publication_finalization_invalid");
    }
    if (operationIds.has(operation.operationId)) throw new Error("asset_publication_finalization_invalid");
    operationIds.add(operation.operationId);
    return Object.freeze({
      operation: Object.freeze({
        resourceKind: "asset",
        ownerUserId,
        assetId,
        operationId: operation.operationId,
        purpose: operation.purpose
      }) as PrivateAssetPublicationFinalization["operation"],
      claim: Object.freeze({
        operationId: claim.operationId,
        leaseId: claim.leaseId,
        leaseOwner: claim.leaseOwner,
        workVersion: claim.workVersion,
        leaseExpiresAt: claim.leaseExpiresAt
      }) as PrivateAssetPublicationFinalization["claim"]
    });
  });
  return Object.freeze(finalization);
}

/**
 * The publication identity's pending finalization is a complete fence, not a
 * list of operations that happen to be relevant to the current retry. Lock
 * every durable asset operation in the two publication purposes so an
 * unexpected operation cannot be left outside the publication decision.
 */
async function lockedExactAssetPublicationOperations(
  client: DatabaseClient,
  ownerUserId: string,
  assetId: string,
  finalization: readonly PrivateAssetPublicationFinalization[],
): Promise<readonly AttachedOperationStateRow[] | null> {
  const selected = await client.query<AttachedOperationStateRow>(
    `SELECT id,purpose,lifecycle,lease_id,lease_owner,work_version,lease_expires_at,
            lease_expires_at > clock_timestamp() AS lease_current
       FROM durable_filesystem_operations
      WHERE owner_user_id=$1
        AND asset_id=$2
        AND purpose IN ('asset_original','asset_derivative')
        AND lifecycle<>'cleaned'
      FOR UPDATE`,
    [ownerUserId, assetId],
  );
  const actualById = new Map(selected.rows.map((operation) => [operation.id, operation]));
  if (actualById.size !== selected.rows.length
    || actualById.size !== finalization.length
    || finalization.some(({ operation }) => (
      actualById.get(operation.operationId)?.purpose !== operation.purpose
    ))) {
    return null;
  }
  return selected.rows;
}

function serializeFinalization(finalization: readonly PrivateAssetPublicationFinalization[]): string {
  return JSON.stringify(finalization.map(({ operation, claim }) => ({
    operation: (() => {
      if (operation.resourceKind !== "asset") throw new Error("asset_publication_finalization_invalid");
      return {
        resourceKind: operation.resourceKind,
        ownerUserId: operation.ownerUserId,
        assetId: operation.assetId,
        operationId: operation.operationId,
        purpose: operation.purpose
      };
    })(),
    claim: {
      operationId: claim.operationId,
      leaseId: claim.leaseId,
      leaseOwner: claim.leaseOwner,
      workVersion: claim.workVersion,
      leaseExpiresAt: claim.leaseExpiresAt
    }
  })));
}

function requirePreparedArtifact(
  value: PrivatePreparedAssetPublicationArtifact,
  kind: "original" | "derivative",
  index: number | null,
): void {
  if (value.kind !== kind || value.derivativeIndex !== index
    || value.attachment.operation.resourceKind !== "asset"
    || value.attachment.operation.purpose !== (kind === "original" ? "asset_original" : "asset_derivative")) {
    throw new Error("asset_publication_attachment_invalid");
  }
}

function assetAttachment(value: PrivatePreparedAssetPublicationArtifact) {
  const operation = value.attachment.operation;
  if (operation.resourceKind !== "asset") throw new Error("asset_publication_attachment_invalid");
  return operation;
}

async function requireScope(client: DatabaseClient, command: PrivateAssetPublicationCommand): Promise<void> {
  const { ownerUserId } = command.owner;
  const provenance = command.provenance;
  if (provenance.campaignId) {
    const campaign = await client.query(
      `SELECT campaign.world_version_id,version.world_id
         FROM campaigns campaign
         JOIN world_versions version
           ON version.id=campaign.world_version_id
          AND version.owner_user_id=campaign.owner_user_id
        WHERE campaign.id=$1 AND campaign.owner_user_id=$2
        FOR KEY SHARE OF campaign,version`,
      [provenance.campaignId, ownerUserId],
    );
    if (campaign.rowCount !== 1) throw new Error("asset_publication_campaign_scope_invalid");
    const scopedCampaign = campaign.rows[0] as Readonly<{ world_version_id: string; world_id: string }>;
    if ((provenance.worldVersionId && provenance.worldVersionId !== scopedCampaign.world_version_id)
      || (provenance.worldId && provenance.worldId !== scopedCampaign.world_id)) {
      throw new Error("asset_publication_campaign_scope_invalid");
    }
  }
  if (provenance.turnId) {
    if (!provenance.campaignId) throw new Error("asset_publication_turn_scope_invalid");
    const turn = await client.query(
      "SELECT 1 FROM turns WHERE id=$1 AND campaign_id=$2 AND owner_user_id=$3 FOR KEY SHARE",
      [provenance.turnId, provenance.campaignId, ownerUserId],
    );
    if (turn.rowCount !== 1) throw new Error("asset_publication_turn_scope_invalid");
  }
  if (provenance.worldId) {
    const world = await client.query(
      "SELECT 1 FROM worlds WHERE id=$1 AND owner_user_id=$2 FOR KEY SHARE",
      [provenance.worldId, ownerUserId],
    );
    if (world.rowCount !== 1) throw new Error("asset_publication_world_scope_invalid");
  }
  if (provenance.worldVersionId) {
    if (!provenance.worldId) throw new Error("asset_publication_world_version_scope_invalid");
    const version = await client.query(
      "SELECT 1 FROM world_versions WHERE id=$1 AND world_id=$2 AND owner_user_id=$3 FOR KEY SHARE",
      [provenance.worldVersionId, provenance.worldId, ownerUserId],
    );
    if (version.rowCount !== 1) throw new Error("asset_publication_world_version_scope_invalid");
  }
}

/**
 * Private PostgreSQL publisher. The composition owns the outer transaction;
 * this adapter only attaches already-published filesystem candidates to the
 * matching domain rows in that exact caller transaction.
 */
export function createPostgresAssetPublicationRepository(
  pool: DatabasePool,
  candidates: PrivateFilesystemCandidatePersistencePort,
): PrivateAssetPublicationIdentityPort {
  const prepareIdentityWithClient = async (
    client: DatabaseClient,
    command: PrivateAssetPublicationCommand,
    contentLockAlreadyHeld = false,
  ): Promise<PrivateAssetPublicationIdentity> => {
    validatePrivateAssetPublicationCommand(command);
    const requestFingerprint = fingerprint(command);
    const keyHash = idempotencyHash(command);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `infinite-quest-nexus:asset-publication:${command.owner.ownerUserId}:${keyHash}`,
    ]);
    // Share the exact physical-content lock used by durable filesystem
    // publication and normalized request reservation.  A legacy prepare must
    // establish its canonical arbitration before another writer can publish a
    // second owner-scoped logical asset for the same bytes.
    if (!contentLockAlreadyHeld) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `infinite-quest-nexus:asset-content:${command.original.contentHash}`,
      ]);
    }
    const existing = await client.query<IdentityRow>(
        `SELECT asset_id,owner_user_id,request_fingerprint,lifecycle,result,pending_finalization
          FROM asset_publication_identities
          WHERE owner_user_id=$1 AND idempotency_key_hash=$2
          FOR KEY SHARE`,
        [command.owner.ownerUserId, keyHash],
      );
    const row = existing.rows[0];
    if (row) {
      if (row.request_fingerprint !== requestFingerprint) {
        throw new Error("asset_publication_idempotency_mismatch");
      }
      if (row.lifecycle === "cleanup_pending") {
        const operations = await client.query<{ lifecycle: string }>(
          `SELECT lifecycle FROM durable_filesystem_operations
            WHERE asset_id=$1 AND owner_user_id=$2
            FOR UPDATE`,
          [row.asset_id, row.owner_user_id],
        );
        if (operations.rows.length === 0
          || operations.rows.some((operation) => operation.lifecycle !== "cleaned")) {
          throw new Error("asset_publication_cleanup_pending");
        }
        const reset = await client.query<IdentityRow>(
          `UPDATE asset_publication_identities
              SET lifecycle='prepared',updated_at=clock_timestamp()
            WHERE asset_id=$1 AND owner_user_id=$2 AND lifecycle='cleanup_pending'
          RETURNING asset_id,owner_user_id,request_fingerprint,lifecycle,result,pending_finalization`,
          [row.asset_id, row.owner_user_id],
        );
        if (reset.rowCount !== 1) throw new Error("asset_publication_identity_unavailable");
        return identity(reset.rows[0]!);
      }
      return identity(row);
    }
    const arbitration = await client.query<Readonly<{ canonical_asset_id: string }>>(
      `SELECT canonical_asset_id
         FROM asset_publication_content_arbitrations
        WHERE owner_user_id=$1 AND content_hash=$2
        FOR UPDATE`,
      [command.owner.ownerUserId, command.original.contentHash],
    );
    if (arbitration.rowCount !== 0) {
      // The legacy identity/result contract cannot safely attach request-owned
      // data to another canonical asset.  Keep the transition fail-closed; the
      // normalized coordinator will retain that request context in e1d.
      throw new Error("asset_publication_canonical_reuse_required");
    }
    const created = await client.query<IdentityRow>(
        `INSERT INTO asset_publication_identities (
           asset_id,owner_user_id,idempotency_key_hash,request_fingerprint,lifecycle
         ) VALUES (gen_random_uuid(),$1,$2,$3,'prepared')
         RETURNING asset_id,owner_user_id,request_fingerprint,lifecycle,result,pending_finalization`,
        [command.owner.ownerUserId, keyHash, requestFingerprint],
      );
    const createdIdentity = identity(created.rows[0]!);
    // This legacy command has verified bytes but no verified decoder metadata.
    // Keep the durable canonical reservation, but make normalized reuse wait
    // for e3e5 to supply the missing technical evidence rather than inventing
    // it while a legacy publication is still active.
    await client.query(
      `INSERT INTO asset_publication_content_arbitrations (
         owner_user_id,content_hash,canonical_asset_id,verification_state
       ) VALUES ($1,$2,$3,'verification_required')`,
      [command.owner.ownerUserId, command.original.contentHash, createdIdentity.assetId],
    );
    return createdIdentity;
  };
  const prepareIdentity: PrivateAssetPublicationIdentityPort["prepareIdentity"] = (command) => (
    withTransaction(pool, (client) => prepareIdentityWithClient(client, command))
  );
  const prepareIdentityUnderContentLock: PrivateAssetPublicationIdentityPort["prepareIdentityUnderContentLock"] = (
    command,
  ) => withTransaction(pool, (client) => prepareIdentityWithClient(client, command, true));
  const prepareIdentityInTransaction: PrivateAssetPublicationIdentityPort["prepareIdentityInTransaction"] = async (
    database,
    command,
  ) => prepareIdentityWithClient(await callerTransaction(database), command);
  const discardPreparedIdentityInTransaction: PrivateAssetPublicationIdentityPort["discardPreparedIdentityInTransaction"] = async (
    database,
    publicationIdentity,
    command,
  ) => {
    validatePrivateAssetPublicationCommand(command);
    if (command.owner.ownerUserId !== publicationIdentity.ownerUserId) {
      throw new Error("asset_publication_identity_mismatch");
    }
    const client = await callerTransaction(database);
    const found = await client.query<IdentityRow>(
      `SELECT asset_id,owner_user_id,request_fingerprint,lifecycle,result,pending_finalization
         FROM asset_publication_identities
        WHERE asset_id=$1 AND owner_user_id=$2
        FOR UPDATE`,
      [publicationIdentity.assetId, publicationIdentity.ownerUserId],
    );
    const row = found.rows[0];
    if (!row) throw new Error("asset_publication_identity_unavailable");
    if (row.request_fingerprint !== fingerprint(command)) {
      throw new Error("asset_publication_idempotency_mismatch");
    }
    if (row.lifecycle === "attached" || row.lifecycle === "published") return;
    if (row.lifecycle !== "prepared") throw new Error("asset_publication_identity_unavailable");
    const operations = await client.query<{ lifecycle: string }>(
      `SELECT lifecycle FROM durable_filesystem_operations
        WHERE asset_id=$1 AND owner_user_id=$2
        FOR UPDATE`,
      [publicationIdentity.assetId, publicationIdentity.ownerUserId],
    );
    if (operations.rows.length === 0) {
      const removed = await client.query(
        `DELETE FROM asset_publication_identities
          WHERE asset_id=$1 AND owner_user_id=$2 AND lifecycle='prepared'`,
        [publicationIdentity.assetId, publicationIdentity.ownerUserId],
      );
      if (removed.rowCount !== 1) throw new Error("asset_publication_identity_unavailable");
      return;
    }
    if (operations.rows.some((operation) => operation.lifecycle !== "cleaned")) {
      throw new Error("asset_publication_cleanup_incomplete");
    }
    const retired = await client.query(
      `UPDATE asset_publication_identities
          SET lifecycle='cleanup_pending',updated_at=clock_timestamp()
        WHERE asset_id=$1 AND owner_user_id=$2 AND lifecycle='prepared'`,
      [publicationIdentity.assetId, publicationIdentity.ownerUserId],
    );
    if (retired.rowCount !== 1) throw new Error("asset_publication_identity_unavailable");
  };

  const readPublicationIdentities: PrivateAssetPublicationIdentityPort["readPublicationIdentities"] = async (
    ownerUserId,
    assetIds,
  ) => {
    if (ownerUserId.trim().length === 0
      || assetIds.length > 1000
      || assetIds.some((assetId) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(assetId))
      || new Set(assetIds).size !== assetIds.length) {
      throw new Error("asset_publication_identity_set_invalid");
    }
    if (assetIds.length === 0) return Object.freeze([]);
    const selected = await pool.query<IdentityRow>(
      `SELECT identity.asset_id,identity.owner_user_id,identity.request_fingerprint,
              identity.lifecycle,identity.result,identity.pending_finalization
         FROM asset_publication_identities identity
        WHERE identity.owner_user_id=$1 AND identity.asset_id=ANY($2::uuid[])
          AND identity.lifecycle IN ('attached','published')
        ORDER BY identity.asset_id`,
      [ownerUserId, assetIds],
    );
    if (selected.rows.length !== assetIds.length) {
      throw new Error("asset_publication_identity_set_unavailable");
    }
    return Object.freeze(selected.rows.map(identity));
  };

  const attachPublication: PrivateAssetPublicationIdentityPort["attachPublication"] = async (
    database,
    publicationIdentity,
    command,
    prepared,
  ): Promise<PrivateAttachedAssetPublication> => {
    validatePrivateAssetPublicationCommand(command);
    if (publicationIdentity.ownerUserId !== command.owner.ownerUserId) {
      throw new Error("asset_publication_owner_mismatch");
    }
    requirePreparedArtifact(prepared.original, "original", null);
    if (prepared.derivatives.length !== command.derivatives.length) {
      throw new Error("asset_publication_derivative_count_invalid");
    }
    prepared.derivatives.forEach((derivative, index) => requirePreparedArtifact(derivative, "derivative", index));
    const client = await callerTransaction(database);
    const found = await client.query<IdentityRow>(
      `SELECT asset_id,owner_user_id,request_fingerprint,lifecycle,result,pending_finalization
         FROM asset_publication_identities
        WHERE asset_id=$1 AND owner_user_id=$2
        FOR UPDATE`,
      [publicationIdentity.assetId, publicationIdentity.ownerUserId],
    );
    const row = found.rows[0];
    if (!row || row.request_fingerprint !== fingerprint(command)) {
      throw new Error("asset_publication_identity_mismatch");
    }
    if (row.lifecycle === "published") {
      const publishedIdentity = identity(row);
      return Object.freeze({
        identity: publishedIdentity,
        result: storedResult(row.result),
        finalization: Object.freeze([])
      });
    }
    if (row.lifecycle !== "prepared") throw new Error("asset_publication_identity_unavailable");
    await requireScope(client, command);

    const originalAttachment = prepared.original.attachment;
    const originalOperation = assetAttachment(prepared.original);
    if (originalOperation.assetId !== publicationIdentity.assetId
      || originalOperation.ownerUserId !== command.owner.ownerUserId
      || originalAttachment.descriptor.contentHash !== command.original.contentHash
      || originalAttachment.descriptor.byteLength !== command.original.byteLength) {
      throw new Error("asset_publication_original_mismatch");
    }
    await client.query(
      `INSERT INTO assets (
         id,owner_user_id,campaign_id,turn_id,content_hash,storage_driver,storage_path,
         mime_type,byte_length,filesystem_operation_id
       ) VALUES ($1,$2,$3,$4,$5,'filesystem',$6,$7,$8,$9)`,
      [
        publicationIdentity.assetId,
        command.owner.ownerUserId,
        command.provenance.campaignId ?? null,
        command.provenance.turnId ?? null,
        command.original.contentHash,
        originalAttachment.descriptor.relativePath,
        command.original.mimeType,
        command.original.byteLength,
        originalOperation.operationId,
      ],
    );
    await client.query(
      `INSERT INTO asset_library_entries (asset_id,owner_user_id,created_by_user_id,origin)
       VALUES ($1,$2,$2,$3)
       ON CONFLICT (asset_id) DO NOTHING`,
      [publicationIdentity.assetId, command.owner.ownerUserId, command.provenance.origin],
    );
    await client.query(
      `UPDATE asset_library_entries
       SET created_by_user_id=$2, origin=$3
       WHERE asset_id=$1 AND owner_user_id=$2`,
      [publicationIdentity.assetId, command.owner.ownerUserId, command.provenance.origin],
    );
    if (command.provenance.campaignId) {
      await client.query(
        `INSERT INTO asset_references (owner_user_id,asset_id,campaign_id,turn_id,asset_role)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (asset_id,campaign_id,turn_id,asset_role) DO NOTHING`,
        [
          command.owner.ownerUserId,
          publicationIdentity.assetId,
          command.provenance.campaignId,
          command.provenance.turnId ?? null,
          command.provenance.turnId ? "turn_illustration" : "import_attachment",
        ],
      );
    }
    await client.query(
      `INSERT INTO asset_generation_contexts (
         owner_user_id,asset_id,created_by_user_id,world_id,world_version_id,campaign_id,turn_id,target_type
       ) VALUES ($1,$2,$1,$3,$4,$5,$6,$7)`,
      [
        command.owner.ownerUserId,
        publicationIdentity.assetId,
        command.provenance.worldId ?? null,
        command.provenance.worldVersionId ?? null,
        command.provenance.campaignId ?? null,
        command.provenance.turnId ?? null,
        command.provenance.targetType ?? "other",
      ],
    );

    const derivatives: Array<Readonly<{ derivativeId: string; derivativeKind: "thumbnail" }>> = [];
    for (const [index, derivative] of command.derivatives.entries()) {
      const attachment = prepared.derivatives[index]!.attachment;
      const operation = assetAttachment(prepared.derivatives[index]!);
      if (operation.assetId !== publicationIdentity.assetId
        || operation.ownerUserId !== command.owner.ownerUserId
        || attachment.descriptor.contentHash !== derivative.contentHash
        || attachment.descriptor.byteLength !== derivative.byteLength) {
        throw new Error("asset_publication_derivative_mismatch");
      }
      const inserted = await client.query<DerivativeRow>(
        `INSERT INTO asset_derivatives (
           owner_user_id,source_asset_id,derivative_kind,transform_version,pixel_width,pixel_height,
           storage_driver,storage_path,mime_type,byte_length,content_hash,filesystem_operation_id
         ) VALUES ($1,$2,$3,$4,$5,$6,'filesystem',$7,$8,$9,$10,$11)
         RETURNING id`,
        [
          command.owner.ownerUserId,
          publicationIdentity.assetId,
          derivative.derivativeKind,
          derivative.transformVersion,
          derivative.pixelWidth,
          derivative.pixelHeight,
          attachment.descriptor.relativePath,
          derivative.mimeType,
          derivative.byteLength,
          derivative.contentHash,
          operation.operationId,
        ],
      );
      derivatives.push(Object.freeze({ derivativeId: inserted.rows[0]!.id, derivativeKind: "thumbnail" }));
    }
    const attachments = [prepared.original, ...prepared.derivatives];
    const finalization: PrivateAssetPublicationFinalization[] = [];
    for (const preparedArtifact of attachments) {
      const attached = await candidates.attachCandidate(database, preparedArtifact.attachment);
      if (attached.outcome !== "attached") throw new Error(`asset_publication_attach_${attached.outcome}`);
      finalization.push(Object.freeze({ operation: attached.operation, claim: attached.claim }));
    }
    const result: PrivateAssetPublicationResult = Object.freeze({
      assetId: publicationIdentity.assetId,
      mimeType: command.original.mimeType,
      byteLength: command.original.byteLength,
      contentHash: command.original.contentHash,
      derivativeIds: Object.freeze(derivatives)
    });
    await client.query(
      `UPDATE asset_publication_identities
          SET lifecycle='attached',result=$3::jsonb,pending_finalization=$4::jsonb,updated_at=clock_timestamp()
        WHERE asset_id=$1 AND owner_user_id=$2 AND lifecycle='prepared'`,
      [
        publicationIdentity.assetId,
        command.owner.ownerUserId,
        JSON.stringify(result),
        serializeFinalization(finalization)
      ],
    );
    const attachedIdentity = Object.freeze({
      assetId: publicationIdentity.assetId,
      ownerUserId: command.owner.ownerUserId,
      lifecycle: "attached",
      result,
      finalization: Object.freeze(finalization)
    }) as PrivateAssetPublicationIdentity;
    return Object.freeze({
      identity: attachedIdentity,
      result,
      finalization: Object.freeze(finalization)
    });
  };

  const completePublication: PrivateAssetPublicationIdentityPort["completePublication"] = async (publicationIdentity) => {
    if (publicationIdentity.lifecycle !== "attached"
      || !publicationIdentity.result
      || !publicationIdentity.finalization) {
      throw new Error("asset_publication_identity_unavailable");
    }
    return withTransaction(pool, async (client) => {
      const found = await client.query<IdentityRow>(
        `SELECT asset_id,owner_user_id,request_fingerprint,lifecycle,result,pending_finalization
           FROM asset_publication_identities
          WHERE asset_id=$1 AND owner_user_id=$2
          FOR UPDATE`,
        [publicationIdentity.assetId, publicationIdentity.ownerUserId],
      );
      const row = found.rows[0];
      if (!row) throw new Error("asset_publication_identity_unavailable");
      if (row.lifecycle === "published") return storedResult(row.result);
      if (row.lifecycle !== "attached") throw new Error("asset_publication_identity_unavailable");
      const finalization = storedFinalization(
        row.pending_finalization,
        publicationIdentity.assetId,
        publicationIdentity.ownerUserId,
      );
      const operations = await lockedExactAssetPublicationOperations(
        client,
        publicationIdentity.ownerUserId,
        publicationIdentity.assetId,
        finalization,
      );
      if (!operations || operations.some((operation) => operation.lifecycle !== "finalized")) {
        throw new Error("asset_publication_finalization_pending");
      }
      const result = storedResult(row.result);
      const updated = await client.query(
        `UPDATE asset_publication_identities
            SET lifecycle='published',pending_finalization=NULL,published_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE asset_id=$1 AND owner_user_id=$2 AND lifecycle='attached'`,
        [publicationIdentity.assetId, publicationIdentity.ownerUserId],
      );
      if (updated.rowCount !== 1) throw new Error("asset_publication_identity_unavailable");
      return result;
    });
  };

  const reconcileAttachedPublication: PrivateAssetPublicationIdentityPort["reconcileAttachedPublication"] = async (
    publicationIdentity,
    recovery,
  ): Promise<PrivateAttachedAssetPublicationReconciliation> => {
    if (publicationIdentity.lifecycle !== "attached") {
      throw new Error("asset_publication_identity_unavailable");
    }
    return withTransaction(pool, async (client) => {
      const found = await client.query<IdentityRow>(
        `SELECT asset_id,owner_user_id,request_fingerprint,lifecycle,result,pending_finalization
           FROM asset_publication_identities
          WHERE asset_id=$1 AND owner_user_id=$2
          FOR UPDATE`,
        [publicationIdentity.assetId, publicationIdentity.ownerUserId],
      );
      const row = found.rows[0];
      if (!row) throw new Error("asset_publication_identity_unavailable");
      if (row.lifecycle === "published") {
        return Object.freeze({ outcome: "published" as const, result: storedResult(row.result) });
      }
      if (row.lifecycle !== "attached") throw new Error("asset_publication_identity_unavailable");
      const persisted = storedFinalization(row.pending_finalization, row.asset_id, row.owner_user_id);
      let selected = await lockedExactAssetPublicationOperations(
        client,
        row.owner_user_id,
        row.asset_id,
        persisted,
      );
      if (!selected) return Object.freeze({ outcome: "recoverable" as const });
      const result = storedResult(row.result);
      let byId = new Map(selected.map((operation) => [operation.id, operation]));
      if (persisted.every(({ operation }) => byId.get(operation.operationId)?.lifecycle === "finalized")) {
        const updated = await client.query(
          `UPDATE asset_publication_identities
              SET lifecycle='published',pending_finalization=NULL,published_at=clock_timestamp(),updated_at=clock_timestamp()
            WHERE asset_id=$1 AND owner_user_id=$2 AND lifecycle='attached'`,
          [row.asset_id, row.owner_user_id],
        );
        if (updated.rowCount !== 1) throw new Error("asset_publication_identity_unavailable");
        return Object.freeze({ outcome: "published" as const, result });
      }
      if (selected.some((operation) => (
        operation.lifecycle !== "attached" && operation.lifecycle !== "finalized"
      ))) {
        return Object.freeze({ outcome: "recoverable" as const });
      }
      const unfinishedOperationIds = selected
        .filter((operation) => operation.lifecycle === "attached")
        .map((operation) => operation.id);
      if (selected.some((operation) => operation.lifecycle === "attached" && !operation.lease_current)
        && recovery) {
        if (recovery.leaseOwner.trim().length === 0
          || recovery.leaseOwner.length > 512
          || !Number.isSafeInteger(recovery.leaseSeconds)
          || recovery.leaseSeconds <= 0
          || recovery.leaseSeconds > 300) {
          throw new Error("asset_publication_recovery_invalid");
        }
        const rotated = await client.query(
          `UPDATE durable_filesystem_operations
              SET work_version=work_version+1,lease_id=gen_random_uuid(),lease_owner=$3,
                  lease_expires_at=LEAST(expires_at,clock_timestamp()+($4::text || ' seconds')::interval),
                  updated_at=clock_timestamp()
            WHERE owner_user_id=$1 AND asset_id=$2 AND id=ANY($5::uuid[])
              AND lifecycle='attached' AND expires_at > clock_timestamp()`,
          [row.owner_user_id, row.asset_id, recovery.leaseOwner, recovery.leaseSeconds, unfinishedOperationIds],
        );
        if (rotated.rowCount !== unfinishedOperationIds.length) {
          return Object.freeze({ outcome: "recoverable" as const });
        }
        selected = await lockedExactAssetPublicationOperations(
          client,
          row.owner_user_id,
          row.asset_id,
          persisted,
        );
        if (!selected) return Object.freeze({ outcome: "recoverable" as const });
        byId = new Map(selected.map((operation) => [operation.id, operation]));
      }
      if (persisted.some(({ operation }) => {
        const current = byId.get(operation.operationId);
        return current?.lifecycle !== "finalized"
          && (current?.lifecycle !== "attached" || !current.lease_current);
      })) {
        return Object.freeze({ outcome: "recoverable" as const });
      }
      const currentFinalization = persisted.flatMap(({ operation }) => {
        const current = byId.get(operation.operationId)!;
        if (current.lifecycle === "finalized") return [];
        return [Object.freeze({
          operation,
          claim: Object.freeze({
            operationId: operation.operationId,
            leaseId: current.lease_id,
            leaseOwner: current.lease_owner,
            workVersion: current.work_version,
            leaseExpiresAt: current.lease_expires_at.toISOString()
          }) as PrivateAssetPublicationFinalization["claim"]
        })];
      });
      const identity = Object.freeze({
        assetId: row.asset_id,
        ownerUserId: row.owner_user_id,
        lifecycle: "attached",
        result,
        finalization: Object.freeze(currentFinalization)
      }) as PrivateAssetPublicationIdentity;
      return Object.freeze({ outcome: "ready_to_finalize" as const, identity });
    });
  };

  return Object.freeze({
    prepareIdentity,
    prepareIdentityUnderContentLock,
    prepareIdentityInTransaction,
    discardPreparedIdentityInTransaction,
    readPublicationIdentities,
    attachPublication,
    reconcileAttachedPublication,
    completePublication
  });
}
