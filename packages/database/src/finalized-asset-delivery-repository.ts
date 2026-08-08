import { createHash, randomBytes } from "node:crypto";
import type {
  FinalizedAssetDeliveryResolverPort,
  PrivateFinalizedAssetDeliveryGrant,
  PrivateFinalizedAssetDeliveryResolution,
  PrivateLegacyAnchoredReadCapability,
  PrivateLegacyReadDescriptor
} from "../../application/src/assets/private-finalized-delivery.js";
import type { PrivateStorageDescriptor } from "../../application/src/assets/private-storage-lifecycle.js";
import type {
  AssetDeliveryDescriptor,
  AssetDeliveryRequest,
  AssetLibraryItemView,
  AssetScope
} from "../../application/src/assets/types.js";
import {
  loadExactAssetDeliveryRow,
  selectAssetDeliveryRow,
  type SelectedAssetDeliveryRow
} from "./asset-delivery-selection.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";

export type FinalizedAssetDeliveryRepositoryOptions = Readonly<{
  capabilityLifetimeMilliseconds?: number;
}>;

type DeliveryIntent = "original" | "thumbnail";

type FinalizedBindingRow = Readonly<{
  operation_id: string;
  operation_purpose: "asset_original" | "asset_derivative";
  candidate_token_hash: string;
  relative_path: string;
  device_id: string;
  file_id: string;
  change_token: string;
  content_hash: string;
  byte_length: string;
}>;

type FinalizedGrantRow = FinalizedBindingRow & Readonly<{
  owner_user_id: string;
  asset_id: string;
  delivery_intent: DeliveryIntent;
  selected_row_kind: SelectedAssetDeliveryRow["selectedRowKind"];
  selected_row_id: string;
  mime_type: string;
  lifecycle: "issued" | "redeemed" | "expired" | "revoked";
  expired: boolean;
}>;

type LegacyCapabilityRow = Readonly<{
  owner_user_id: string;
  asset_id: string;
  delivery_intent: DeliveryIntent;
  selected_row_kind: SelectedAssetDeliveryRow["selectedRowKind"];
  selected_row_id: string;
  relative_path: string;
  content_hash: string;
  byte_length: string;
  mime_type: string;
  lifecycle: "issued" | "redeemed" | "expired" | "revoked";
  expired: boolean;
}>;

const IMAGE_MIME_TYPES = new Set<AssetLibraryItemView["mimeType"]>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
]);
const MAX_CAPABILITY_LIFETIME_MILLISECONDS = 60_000;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function deliveryIntent(request: AssetDeliveryRequest): DeliveryIntent {
  return request.kind === "original" ? "original" : "thumbnail";
}

function validMimeType(value: string): value is AssetLibraryItemView["mimeType"] {
  return IMAGE_MIME_TYPES.has(value as AssetLibraryItemView["mimeType"]);
}

function deliveryDescriptor(
  scope: AssetScope,
  request: AssetDeliveryRequest,
  selection: SelectedAssetDeliveryRow,
): AssetDeliveryDescriptor | null {
  if (!validMimeType(selection.mimeType)) return null;
  return request.kind === "original"
    ? {
      assetId: scope.assetId,
      kind: "original",
      derivativeKind: null,
      mimeType: selection.mimeType,
      byteLength: selection.byteLength,
      etag: selection.contentHash
    }
    : {
      assetId: scope.assetId,
      kind: "derivative",
      derivativeKind: "thumbnail",
      mimeType: selection.mimeType,
      byteLength: selection.byteLength,
      etag: selection.contentHash
    };
}

function selectionMatches(
  selection: SelectedAssetDeliveryRow | null,
  authority: FinalizedGrantRow | LegacyCapabilityRow,
): selection is SelectedAssetDeliveryRow {
  return selection !== null
    && selection.ownerUserId === authority.owner_user_id
    && selection.assetId === authority.asset_id
    && selection.selectedRowKind === authority.selected_row_kind
    && selection.selectedRowId === authority.selected_row_id
    && selection.relativePath === authority.relative_path
    && selection.contentHash === authority.content_hash
    && selection.byteLength === Number(authority.byte_length)
    && selection.mimeType === authority.mime_type;
}

async function withRepeatableReadTransaction<T>(
  pool: DatabasePool,
  work: (client: DatabaseClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function finalizedBinding(
  client: DatabaseClient,
  selection: SelectedAssetDeliveryRow,
): Promise<FinalizedBindingRow | null> {
  if (!selection.filesystemOperationId) return null;
  const purpose = selection.selectedRowKind === "asset" ? "asset_original" : "asset_derivative";
  const result = await client.query<FinalizedBindingRow>(
    `SELECT operation.id AS operation_id,operation.purpose AS operation_purpose,
            operation.candidate_token_hash,descriptor.relative_path,
            descriptor.device_id,descriptor.file_id,descriptor.change_token,
            descriptor.content_hash,descriptor.byte_length::text
       FROM durable_filesystem_operations operation
       JOIN durable_filesystem_descriptors descriptor
         ON descriptor.operation_id=operation.id
        AND descriptor.owner_user_id=operation.owner_user_id
        AND descriptor.descriptor_role='delivery'
        AND descriptor.ordinal=0
      WHERE operation.id=$1 AND operation.owner_user_id=$2
        AND operation.resource_kind='asset' AND operation.asset_id=$3
        AND operation.purpose=$4 AND operation.lifecycle='finalized'
        AND operation.candidate_token_hash IS NOT NULL
        AND descriptor.relative_path=$5
        AND descriptor.content_hash=$6
        AND descriptor.byte_length=$7
      FOR SHARE OF operation,descriptor`,
    [
      selection.filesystemOperationId,
      selection.ownerUserId,
      selection.assetId,
      purpose,
      selection.relativePath,
      selection.contentHash,
      selection.byteLength
    ],
  );
  return result.rows[0] ?? null;
}

function privateDescriptor(row: FinalizedBindingRow): PrivateStorageDescriptor {
  return {
    relativePath: row.relative_path,
    identity: {
      deviceId: row.device_id,
      fileId: row.file_id,
      changeToken: row.change_token
    },
    contentHash: row.content_hash,
    byteLength: Number(row.byte_length)
  };
}

/**
 * Named adapter-private repository for finalized and legacy-null asset reads.
 * It never consumes the 0054 raw-candidate grant path or its locator seam.
 */
export function createPostgresFinalizedAssetDeliveryRepository(
  pool: DatabasePool,
  options: FinalizedAssetDeliveryRepositoryOptions = {},
): FinalizedAssetDeliveryResolverPort {
  const capabilityLifetimeMilliseconds = options.capabilityLifetimeMilliseconds
    ?? MAX_CAPABILITY_LIFETIME_MILLISECONDS;
  if (!Number.isInteger(capabilityLifetimeMilliseconds)
    || capabilityLifetimeMilliseconds <= 0
    || capabilityLifetimeMilliseconds > MAX_CAPABILITY_LIFETIME_MILLISECONDS) {
    throw new Error("finalized_asset_delivery_lifetime_invalid");
  }

  const resolveFinalizedAssetDelivery: FinalizedAssetDeliveryResolverPort["resolveFinalizedAssetDelivery"] = async (
    scope,
    request,
  ) => withRepeatableReadTransaction(pool, async (client): Promise<PrivateFinalizedAssetDeliveryResolution | null> => {
    const selection = await selectAssetDeliveryRow(
      client,
      scope.ownerUserId,
      scope.assetId,
      request,
      { lock: true },
    );
    if (!selection) return null;
    const descriptor = deliveryDescriptor(scope, request, selection);
    if (!descriptor) return null;
    const intent = deliveryIntent(request);
    const token = randomToken();

    if (selection.filesystemOperationId === null) {
      await client.query(
        `INSERT INTO private_legacy_asset_read_capabilities (
           capability_token_hash,owner_user_id,asset_id,delivery_intent,
           selected_row_kind,selected_row_id,relative_path,content_hash,
           byte_length,mime_type,expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
                   clock_timestamp()+($11::bigint * interval '1 millisecond'))`,
        [
          sha256(token),
          scope.ownerUserId,
          scope.assetId,
          intent,
          selection.selectedRowKind,
          selection.selectedRowId,
          selection.relativePath,
          selection.contentHash,
          selection.byteLength,
          selection.mimeType,
          capabilityLifetimeMilliseconds
        ],
      );
      return {
        kind: "legacy_retained",
        scope,
        request,
        descriptor,
        anchoredRead: token as PrivateLegacyAnchoredReadCapability,
        cleanupAuthority: "none"
      };
    }

    const binding = await finalizedBinding(client, selection);
    if (!binding) return null;
    await client.query(
      `INSERT INTO private_finalized_asset_delivery_grants (
         grant_token_hash,owner_user_id,asset_id,delivery_intent,
         selected_row_kind,selected_row_id,operation_id,operation_purpose,
         candidate_token_hash,relative_path,device_id,file_id,change_token,
         content_hash,byte_length,mime_type,expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                 clock_timestamp()+($17::bigint * interval '1 millisecond'))`,
      [
        sha256(token),
        scope.ownerUserId,
        scope.assetId,
        intent,
        selection.selectedRowKind,
        selection.selectedRowId,
        binding.operation_id,
        binding.operation_purpose,
        binding.candidate_token_hash,
        binding.relative_path,
        binding.device_id,
        binding.file_id,
        binding.change_token,
        binding.content_hash,
        Number(binding.byte_length),
        selection.mimeType,
        capabilityLifetimeMilliseconds
      ],
    );
    return {
      kind: "durable_finalized",
      scope,
      request,
      descriptor,
      grant: token as PrivateFinalizedAssetDeliveryGrant,
      cleanupAuthority: "none"
    };
  });

  const redeemFinalizedDeliveryGrant: FinalizedAssetDeliveryResolverPort["redeemFinalizedDeliveryGrant"] = async (
    scope,
    request,
    grant,
  ) => withRepeatableReadTransaction(pool, async (client): Promise<PrivateStorageDescriptor | null> => {
    const found = await client.query<FinalizedGrantRow>(
      `SELECT owner_user_id,asset_id,delivery_intent,selected_row_kind,
              selected_row_id,operation_id,operation_purpose,candidate_token_hash,
              relative_path,device_id,file_id,change_token,content_hash,
              byte_length::text,mime_type,lifecycle,
              expires_at <= clock_timestamp() AS expired
         FROM private_finalized_asset_delivery_grants
        WHERE grant_token_hash=$1 AND owner_user_id=$2 AND asset_id=$3
          AND delivery_intent=$4 AND lifecycle='issued'
        FOR UPDATE`,
      [sha256(grant), scope.ownerUserId, scope.assetId, deliveryIntent(request)],
    );
    const row = found.rows[0];
    if (!row) return null;
    if (row.expired) {
      await client.query(
        `UPDATE private_finalized_asset_delivery_grants
            SET lifecycle='expired',expired_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE grant_token_hash=$1`,
        [sha256(grant)],
      );
      return null;
    }
    const selection = await loadExactAssetDeliveryRow(
      client,
      row.owner_user_id,
      row.asset_id,
      row.selected_row_kind,
      row.selected_row_id,
      { lock: true },
    );
    if (!selectionMatches(selection, row)
      || selection.filesystemOperationId !== row.operation_id) return null;
    const binding = await finalizedBinding(client, selection);
    if (!binding
      || binding.operation_id !== row.operation_id
      || binding.operation_purpose !== row.operation_purpose
      || binding.candidate_token_hash !== row.candidate_token_hash
      || binding.relative_path !== row.relative_path
      || binding.device_id !== row.device_id
      || binding.file_id !== row.file_id
      || binding.change_token !== row.change_token
      || binding.content_hash !== row.content_hash
      || Number(binding.byte_length) !== Number(row.byte_length)) return null;

    const redeemed = await client.query(
      `UPDATE private_finalized_asset_delivery_grants
          SET lifecycle='redeemed',redeemed_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE grant_token_hash=$1 AND lifecycle='issued'
          AND expires_at > clock_timestamp()
        RETURNING grant_token_hash`,
      [sha256(grant)],
    );
    return redeemed.rowCount === 1 ? privateDescriptor(binding) : null;
  });

  const redeemLegacyAnchoredRead: FinalizedAssetDeliveryResolverPort["redeemLegacyAnchoredRead"] = async (
    scope,
    request,
    capability,
  ) => withRepeatableReadTransaction(pool, async (client): Promise<PrivateLegacyReadDescriptor | null> => {
    const found = await client.query<LegacyCapabilityRow>(
      `SELECT owner_user_id,asset_id,delivery_intent,selected_row_kind,
              selected_row_id,relative_path,content_hash,byte_length::text,
              mime_type,lifecycle,expires_at <= clock_timestamp() AS expired
         FROM private_legacy_asset_read_capabilities
        WHERE capability_token_hash=$1 AND owner_user_id=$2 AND asset_id=$3
          AND delivery_intent=$4 AND lifecycle='issued'
        FOR UPDATE`,
      [sha256(capability), scope.ownerUserId, scope.assetId, deliveryIntent(request)],
    );
    const row = found.rows[0];
    if (!row) return null;
    if (row.expired) {
      await client.query(
        `UPDATE private_legacy_asset_read_capabilities
            SET lifecycle='expired',expired_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE capability_token_hash=$1`,
        [sha256(capability)],
      );
      return null;
    }
    const selection = await loadExactAssetDeliveryRow(
      client,
      row.owner_user_id,
      row.asset_id,
      row.selected_row_kind,
      row.selected_row_id,
      { lock: true },
    );
    if (!selectionMatches(selection, row) || selection.filesystemOperationId !== null) return null;
    const redeemed = await client.query(
      `UPDATE private_legacy_asset_read_capabilities
          SET lifecycle='redeemed',redeemed_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE capability_token_hash=$1 AND lifecycle='issued'
          AND expires_at > clock_timestamp()
        RETURNING capability_token_hash`,
      [sha256(capability)],
    );
    return redeemed.rowCount === 1 ? {
      relativePath: row.relative_path,
      contentHash: row.content_hash,
      byteLength: Number(row.byte_length)
    } : null;
  });

  return {
    resolveFinalizedAssetDelivery,
    redeemFinalizedDeliveryGrant,
    redeemLegacyAnchoredRead
  };
}
