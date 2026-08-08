import type { AssetDeliveryRequest } from "../../application/src/assets/types.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";

type Queryable = DatabaseClient | DatabasePool;

type AssetDeliveryRow = Readonly<{
  selected_row_kind: "asset" | "asset_derivative";
  selected_row_id: string;
  owner_user_id: string;
  asset_id: string;
  filesystem_operation_id: string | null;
  storage_path: string;
  mime_type: string;
  byte_length: string;
  content_hash: string;
}>;

export type SelectedAssetDeliveryRow = Readonly<{
  selectedRowKind: "asset" | "asset_derivative";
  selectedRowId: string;
  ownerUserId: string;
  assetId: string;
  filesystemOperationId: string | null;
  relativePath: string;
  mimeType: string;
  byteLength: number;
  contentHash: string;
}>;

function selected(row: AssetDeliveryRow): SelectedAssetDeliveryRow {
  return {
    selectedRowKind: row.selected_row_kind,
    selectedRowId: row.selected_row_id,
    ownerUserId: row.owner_user_id,
    assetId: row.asset_id,
    filesystemOperationId: row.filesystem_operation_id,
    relativePath: row.storage_path,
    mimeType: row.mime_type,
    byteLength: Number(row.byte_length),
    contentHash: row.content_hash
  };
}

async function originalRow(
  database: Queryable,
  ownerUserId: string,
  assetId: string,
  lock: boolean,
): Promise<SelectedAssetDeliveryRow | null> {
  const result = await database.query<AssetDeliveryRow>(
    `SELECT 'asset'::text AS selected_row_kind,a.id AS selected_row_id,
            a.owner_user_id,a.id AS asset_id,a.filesystem_operation_id,
            a.storage_path,a.mime_type,a.byte_length::text,a.content_hash
       FROM assets a
      WHERE a.id=$1 AND a.owner_user_id=$2
      ${lock ? "FOR SHARE OF a" : ""}`,
    [assetId, ownerUserId],
  );
  return result.rows[0] ? selected(result.rows[0]) : null;
}

/**
 * One deterministic selector shared by public description and private grant
 * issuance. Thumbnail width wins first; row UUID is the sole tie-break.
 */
export async function selectAssetDeliveryRow(
  database: Queryable,
  ownerUserId: string,
  assetId: string,
  request: AssetDeliveryRequest,
  options: Readonly<{ lock?: boolean }> = {},
): Promise<SelectedAssetDeliveryRow | null> {
  const original = await originalRow(database, ownerUserId, assetId, options.lock === true);
  if (!original || request.kind === "original") return original;

  const derivative = await database.query<AssetDeliveryRow>(
    `SELECT 'asset_derivative'::text AS selected_row_kind,d.id AS selected_row_id,
            d.owner_user_id,d.source_asset_id AS asset_id,d.filesystem_operation_id,
            d.storage_path,d.mime_type,d.byte_length::text,d.content_hash
       FROM asset_derivatives d
      WHERE d.source_asset_id=$1 AND d.owner_user_id=$2
        AND d.derivative_kind='thumbnail'
      ORDER BY d.pixel_width DESC,d.id DESC
      LIMIT 1
      ${options.lock === true ? "FOR SHARE OF d" : ""}`,
    [assetId, ownerUserId],
  );
  return derivative.rows[0] ? selected(derivative.rows[0]) : original;
}

/** Exact selected-row reload used by one-time redemption; it never reselects. */
export async function loadExactAssetDeliveryRow(
  database: Queryable,
  ownerUserId: string,
  assetId: string,
  selectedRowKind: SelectedAssetDeliveryRow["selectedRowKind"],
  selectedRowId: string,
  options: Readonly<{ lock?: boolean }> = {},
): Promise<SelectedAssetDeliveryRow | null> {
  if (selectedRowKind === "asset") {
    if (selectedRowId !== assetId) return null;
    return originalRow(database, ownerUserId, assetId, options.lock === true);
  }
  const result = await database.query<AssetDeliveryRow>(
    `SELECT 'asset_derivative'::text AS selected_row_kind,d.id AS selected_row_id,
            d.owner_user_id,d.source_asset_id AS asset_id,d.filesystem_operation_id,
            d.storage_path,d.mime_type,d.byte_length::text,d.content_hash
       FROM asset_derivatives d
      WHERE d.id=$1 AND d.source_asset_id=$2 AND d.owner_user_id=$3
        AND d.derivative_kind='thumbnail'
      ${options.lock === true ? "FOR SHARE OF d" : ""}`,
    [selectedRowId, assetId, ownerUserId],
  );
  return result.rows[0] ? selected(result.rows[0]) : null;
}
