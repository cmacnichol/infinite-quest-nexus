import { createHash } from "node:crypto";
import type {
  AssetApplicationDependencies,
  AssetDeliveryDescriptor,
  AssetFilesystemDiagnosticCode,
  AssetLibraryItemView,
  AssetLibraryQuery,
  AssetLibraryView,
  AssetMetadataBackfillClaim,
  AssetMetadataBackfillPort,
  AssetMetadataUpdateCommand,
  AssetSelectionCommand,
  AssetSelectionView,
  AssetTransactionContext,
  TurnAssetSelectionScope,
  WorldAssetSelectionScope
} from "../../application/src/assets/index.js";
import type {
  DatabaseIssuedStorageLocator,
  DurableFilesystemScope,
  PrivateStorageDescriptor,
  PrivateStorageLocatorRedemptionPort
} from "../../application/src/assets/private-storage-lifecycle.js";
import { stableStringify } from "../../domain/src/text.js";
import { selectAssetDeliveryRow } from "./asset-delivery-selection.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";
import { withTransaction } from "./pool.js";

type AssetRepositoryErrorCode =
  | "asset_cursor_invalid"
  | "asset_diagnostic_invalid"
  | "asset_idempotency_mismatch"
  | "asset_not_found"
  | "asset_repository_unavailable"
  | "asset_revision_conflict"
  | "asset_scope_not_found"
  | "asset_shared_unavailable";

class AssetRepositoryError extends Error {
  constructor(readonly code: AssetRepositoryErrorCode, readonly statusCode: number) {
    super(code);
    this.name = "AssetRepositoryError";
  }
}

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const DIAGNOSTIC_CODES = new Set<AssetFilesystemDiagnosticCode>([
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

function repositoryError(code: AssetRepositoryErrorCode, statusCode: number): AssetRepositoryError {
  return new AssetRepositoryError(code, statusCode);
}

async function safeRepositoryCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AssetRepositoryError) throw error;
    throw repositoryError("asset_repository_unavailable", 503);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validMimeType(value: string): value is AssetLibraryItemView["mimeType"] {
  return IMAGE_MIME_TYPES.has(value);
}

type AssetQueryRow = Readonly<{
  id: string;
  mime_type: string;
  byte_length: string;
  pixel_width: number | null;
  pixel_height: number | null;
  created_at: Date;
  campaign_id: string | null;
  turn_id: string | null;
  title: string;
  caption: string;
  tags: string[];
  origin: AssetLibraryItemView["origin"];
  reuse_scope: AssetLibraryItemView["reuseScope"];
  automatic_reuse_enabled: boolean;
  review_status: AssetLibraryItemView["reviewStatus"];
  content_categories: string[];
  favorite: boolean;
  archived_at: Date | null;
  metadata_revision: number;
  provider_type: string | null;
  model: string | null;
  world_id: string | null;
  world_version_id: string | null;
  usage_count: number;
  sort_title: string;
}>;

type AssetCursor = Readonly<{
  fingerprint: string;
  id: string;
  createdAt: string;
  title: string;
  usageCount: number;
}>;

function queryFingerprint(ownerUserId: string, query: AssetLibraryQuery): string {
  return sha256(stableStringify({ ownerUserId, query: { ...query, cursor: undefined } }));
}

function decodeCursor(value: string, fingerprint: string): AssetCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<AssetCursor>;
    if (parsed.fingerprint !== fingerprint
      || typeof parsed.id !== "string"
      || typeof parsed.createdAt !== "string"
      || !Number.isFinite(Date.parse(parsed.createdAt))
      || typeof parsed.title !== "string"
      || typeof parsed.usageCount !== "number") {
      throw repositoryError("asset_cursor_invalid", 400);
    }
    return parsed as AssetCursor;
  } catch (error) {
    if (error instanceof AssetRepositoryError) throw error;
    throw repositoryError("asset_cursor_invalid", 400);
  }
}

function encodeCursor(row: AssetQueryRow, fingerprint: string): string {
  return Buffer.from(JSON.stringify({
    fingerprint,
    id: row.id,
    createdAt: row.created_at.toISOString(),
    title: row.sort_title,
    usageCount: row.usage_count
  } satisfies AssetCursor)).toString("base64url");
}

function mapAsset(row: AssetQueryRow): AssetLibraryItemView {
  if (!validMimeType(row.mime_type)) throw repositoryError("asset_repository_unavailable", 503);
  const title = row.title.trim();
  const caption = row.caption.trim();
  return {
    assetId: row.id,
    id: row.id,
    url: `/api/v1/assets/${row.id}`,
    thumbnailUrl: `/api/v1/assets/${row.id}/thumbnail`,
    mimeType: row.mime_type,
    byteLength: Number(row.byte_length),
    width: row.pixel_width,
    height: row.pixel_height,
    createdAt: row.created_at.toISOString(),
    campaignId: row.campaign_id,
    turnId: row.turn_id,
    title,
    caption,
    alt: caption || title || "Retained story illustration",
    tags: row.tags ?? [],
    origin: row.origin,
    reuseScope: row.reuse_scope,
    automaticReuseEnabled: row.automatic_reuse_enabled,
    reviewStatus: row.review_status,
    contentCategories: row.content_categories ?? [],
    favorite: row.favorite,
    archived: row.archived_at !== null,
    metadataRevision: row.metadata_revision,
    provider: row.provider_type,
    model: row.model,
    worldId: row.world_id,
    worldVersionId: row.world_version_id,
    usageCount: Number(row.usage_count)
  };
}

type AssetLibraryQueryFragment = Readonly<{ base: string; params: unknown[] }>;

function buildLibraryQuery(ownerUserId: string, query: AssetLibraryQuery): AssetLibraryQueryFragment {
  const params: unknown[] = [ownerUserId];
  const add = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const where = ["a.owner_user_id = $1"];
  const campaignPredicate = (parameter: string) => `(
    a.campaign_id = ${parameter}
    OR EXISTS (
      SELECT 1 FROM asset_references ar
       WHERE ar.asset_id = a.id AND ar.owner_user_id = a.owner_user_id
         AND ar.campaign_id = ${parameter}
    )
    OR EXISTS (
      SELECT 1 FROM asset_generation_contexts agc
       WHERE agc.asset_id = a.id AND agc.owner_user_id = a.owner_user_id
         AND agc.campaign_id = ${parameter}
    )
  )`;
  const worldPredicate = (parameter: string) => `(
    EXISTS (
      SELECT 1 FROM asset_generation_contexts agc
       WHERE agc.asset_id = a.id AND agc.owner_user_id = a.owner_user_id
         AND agc.world_id = ${parameter}
    )
    OR EXISTS (
      SELECT 1 FROM worlds w
       WHERE w.id = ${parameter} AND w.owner_user_id = a.owner_user_id
         AND w.cover_asset_id = a.id
    )
    OR EXISTS (
      SELECT 1 FROM campaigns c
      JOIN world_versions wv
        ON wv.id = c.world_version_id AND wv.owner_user_id = c.owner_user_id
       WHERE c.owner_user_id = a.owner_user_id AND wv.world_id = ${parameter}
         AND (
           c.id = a.campaign_id
           OR EXISTS (
             SELECT 1 FROM asset_references ar
              WHERE ar.asset_id = a.id AND ar.owner_user_id = a.owner_user_id
                AND ar.campaign_id = c.id
           )
         )
    )
  )`;

  if (query.q) {
    const parameter = add(query.q);
    where.push(`to_tsvector('simple', concat_ws(' ', le.title, le.caption, le.notes,
      array_to_string(le.tags, ' '), COALESCE(context.fiction_prompt, '')))
      @@ websearch_to_tsquery('simple', ${parameter})`);
  }
  if (query.creator === "me") where.push("le.created_by_user_id = a.owner_user_id");
  if (query.scope === "campaign" && query.campaignId) {
    where.push(campaignPredicate(add(query.campaignId)));
  } else if (query.scope === "world" && query.worldId) {
    where.push(worldPredicate(add(query.worldId)));
  } else if (query.scope === "owner_library") {
    where.push("le.reuse_scope = 'owner_library'");
  } else if (query.scope === "shared") {
    where.push("false");
  }
  if (query.campaignId && query.scope !== "campaign") where.push(campaignPredicate(add(query.campaignId)));
  if (query.worldId && query.scope !== "world") where.push(worldPredicate(add(query.worldId)));
  if (query.worldVersionId) {
    const parameter = add(query.worldVersionId);
    where.push(`(
      EXISTS (
        SELECT 1 FROM asset_generation_contexts agc
         WHERE agc.asset_id = a.id AND agc.owner_user_id = a.owner_user_id
           AND agc.world_version_id = ${parameter}
      )
      OR EXISTS (
        SELECT 1 FROM campaigns c
         WHERE c.world_version_id = ${parameter} AND c.owner_user_id = a.owner_user_id
           AND (
             c.id = a.campaign_id
             OR EXISTS (
               SELECT 1 FROM asset_references ar
                WHERE ar.asset_id = a.id AND ar.owner_user_id = a.owner_user_id
                  AND ar.campaign_id = c.id
             )
           )
      )
    )`);
  }
  if (query.origin.length) where.push(`le.origin = ANY(${add(query.origin)}::text[])`);
  if (query.tags.length) where.push(query.allTags
    ? `le.tags @> ${add(query.tags)}::text[]`
    : `le.tags && ${add(query.tags)}::text[]`);
  if (query.entityIds.length) where.push(`COALESCE(context.entities, '[]'::jsonb) ?| ${add(query.entityIds)}::text[]`);
  if (query.locationIds.length) where.push(`COALESCE(context.locations, '[]'::jsonb) ?| ${add(query.locationIds)}::text[]`);
  if (query.provider.length) where.push(`context.provider_type = ANY(${add(query.provider)}::text[])`);
  if (query.model.length) where.push(`context.model = ANY(${add(query.model)}::text[])`);
  if (query.reviewStatus.length) where.push(`le.review_status = ANY(${add(query.reviewStatus)}::text[])`);
  if (query.reuseScope.length) where.push(`le.reuse_scope = ANY(${add(query.reuseScope)}::text[])`);
  if (query.eligible !== undefined) where.push(`le.automatic_reuse_enabled = ${add(query.eligible)}`);
  if (query.favorite !== undefined) where.push(`le.favorite = ${add(query.favorite)}`);
  where.push(query.archived ? "le.archived_at IS NOT NULL" : "le.archived_at IS NULL");
  if (query.mimeType.length) where.push(`a.mime_type = ANY(${add(query.mimeType)}::text[])`);
  if (query.aspect.length) {
    where.push(`CASE
      WHEN a.pixel_width IS NULL OR a.pixel_height IS NULL THEN 'unknown'
      WHEN abs(a.pixel_width::numeric / a.pixel_height - 1) <= 0.08 THEN 'square'
      WHEN a.pixel_width > a.pixel_height THEN 'landscape'
      ELSE 'portrait'
    END = ANY(${add(query.aspect)}::text[])`);
  }
  if (query.createdFrom) where.push(`a.created_at >= ${add(query.createdFrom)}::timestamptz`);
  if (query.createdTo) where.push(`a.created_at <= ${add(query.createdTo)}::timestamptz`);

  return {
    params,
    base: `WITH library AS (
      SELECT a.id, a.mime_type, a.byte_length::text, a.pixel_width, a.pixel_height,
             a.created_at, a.campaign_id, a.turn_id, le.title, le.caption, le.tags,
             le.origin, le.reuse_scope, le.automatic_reuse_enabled, le.review_status,
             le.content_categories, le.favorite, le.archived_at, le.metadata_revision,
             context.provider_type, context.model, context.world_id, context.world_version_id,
             COALESCE(usage.usage_count, 0)::int AS usage_count,
             lower(COALESCE(NULLIF(le.title, ''), a.id::text)) AS sort_title
        FROM assets a
        JOIN asset_library_entries le
          ON le.asset_id = a.id AND le.owner_user_id = a.owner_user_id
        LEFT JOIN LATERAL (
          SELECT agc.provider_type, agc.model, agc.world_id, agc.world_version_id,
                 agc.fiction_prompt, agc.entities, agc.locations
            FROM asset_generation_contexts agc
           WHERE agc.asset_id = a.id AND agc.owner_user_id = a.owner_user_id
           ORDER BY agc.created_at DESC, agc.id DESC LIMIT 1
        ) context ON true
        LEFT JOIN LATERAL (
          SELECT count(*)::int AS usage_count FROM asset_references ar
           WHERE ar.asset_id = a.id AND ar.owner_user_id = a.owner_user_id
        ) usage ON true
       WHERE ${where.join(" AND ")}
    )`
  };
}

function facetRecord(rows: Array<{ value: string; count: number }>): Readonly<Record<string, number>> {
  return Object.fromEntries(rows.map((row) => [row.value, Number(row.count)]));
}

async function listAssets(pool: DatabasePool, ownerUserId: string, query: AssetLibraryQuery): Promise<AssetLibraryView> {
  const { base, params } = buildLibraryQuery(ownerUserId, query);
  const fingerprint = queryFingerprint(ownerUserId, query);
  const cursor = query.cursor ? decodeCursor(query.cursor, fingerprint) : null;
  const pageParams = [...params];
  const add = (value: unknown): string => {
    pageParams.push(value);
    return `$${pageParams.length}`;
  };
  let cursorWhere = "";
  let orderBy = "created_at DESC, id DESC";
  if (query.sort === "oldest") orderBy = "created_at ASC, id ASC";
  if (query.sort === "title") orderBy = "sort_title ASC, id ASC";
  if (query.sort === "most_used") orderBy = "usage_count DESC, id DESC";
  if (cursor) {
    if (query.sort === "newest") cursorWhere = `WHERE (created_at, id) < (${add(cursor.createdAt)}::timestamptz, ${add(cursor.id)}::uuid)`;
    if (query.sort === "oldest") cursorWhere = `WHERE (created_at, id) > (${add(cursor.createdAt)}::timestamptz, ${add(cursor.id)}::uuid)`;
    if (query.sort === "title") cursorWhere = `WHERE (sort_title, id) > (${add(cursor.title)}, ${add(cursor.id)}::uuid)`;
    if (query.sort === "most_used") cursorWhere = `WHERE (usage_count, id) < (${add(cursor.usageCount)}::int, ${add(cursor.id)}::uuid)`;
  }
  const limit = add(query.limit + 1);
  const page = await pool.query<AssetQueryRow>(
    `${base} SELECT * FROM library ${cursorWhere} ORDER BY ${orderBy} LIMIT ${limit}`,
    pageParams
  );
  const hasMore = page.rows.length > query.limit;
  const rows = page.rows.slice(0, query.limit);
  const summary = await pool.query<{
    total: number;
    origin: Array<{ value: string; count: number }>;
    review_status: Array<{ value: string; count: number }>;
    reuse_scope: Array<{ value: string; count: number }>;
    tags: Array<{ value: string; count: number }>;
  }>(`${base}
    SELECT count(*)::int AS total,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('value', origin, 'count', count))
        FROM (SELECT origin, count(*)::int AS count FROM library GROUP BY origin ORDER BY origin) x), '[]') AS origin,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('value', review_status, 'count', count))
        FROM (SELECT review_status, count(*)::int AS count FROM library GROUP BY review_status ORDER BY review_status) x), '[]') AS review_status,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('value', reuse_scope, 'count', count))
        FROM (SELECT reuse_scope, count(*)::int AS count FROM library GROUP BY reuse_scope ORDER BY reuse_scope) x), '[]') AS reuse_scope,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('value', tag, 'count', count))
        FROM (SELECT tag, count(*)::int AS count FROM library, unnest(tags) tag
          GROUP BY tag ORDER BY count DESC, tag LIMIT 100) x), '[]') AS tags
      FROM library`, params);
  const counts = summary.rows[0] ?? { total: 0, origin: [], review_status: [], reuse_scope: [], tags: [] };
  return {
    assets: rows.map(mapAsset),
    nextCursor: hasMore && rows.length > 0 ? encodeCursor(rows[rows.length - 1]!, fingerprint) : null,
    total: Number(counts.total),
    facets: {
      origin: facetRecord(counts.origin),
      reviewStatus: facetRecord(counts.review_status),
      reuseScope: facetRecord(counts.reuse_scope),
      tags: facetRecord(counts.tags)
    }
  };
}

type MutationKind = "asset_metadata_update" | "turn_asset_selection" | "world_asset_selection";

type IdempotencyRecord = Readonly<{
  request_fingerprint: string;
  status: "pending" | "completed" | "failed";
  result: unknown;
}>;

function assetMutationLockKey(
  ownerUserId: string,
  mutationKind: MutationKind,
  idempotencyKeyHash: string,
): string {
  return `infinite-quest-nexus:asset-mutation:${ownerUserId}:${mutationKind}:${idempotencyKeyHash}`;
}

async function lockAssetMutation(
  client: DatabaseClient,
  ownerUserId: string,
  mutationKind: MutationKind,
  idempotencyKeyHash: string,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
    [assetMutationLockKey(ownerUserId, mutationKind, idempotencyKeyHash)]
  );
}

async function beginIdempotency(
  client: DatabaseClient,
  input: Readonly<{
    ownerUserId: string;
    mutationKind: MutationKind;
    idempotencyKey: string;
    requestFingerprint: string;
    targetAssetId?: string;
    campaignId?: string;
    turnId?: string;
    worldId?: string;
    selectedAssetId?: string | null;
  }>,
): Promise<Readonly<{ replay: boolean; result: unknown }>> {
  const keyHash = sha256(input.idempotencyKey);
  await lockAssetMutation(client, input.ownerUserId, input.mutationKind, keyHash);
  await client.query(
    `INSERT INTO asset_mutation_idempotency (
       owner_user_id, mutation_kind, idempotency_key_hash, request_fingerprint,
       target_asset_id, campaign_id, turn_id, world_id, selected_asset_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (owner_user_id, mutation_kind, idempotency_key_hash) DO NOTHING`,
    [
      input.ownerUserId,
      input.mutationKind,
      keyHash,
      input.requestFingerprint,
      input.targetAssetId ?? null,
      input.campaignId ?? null,
      input.turnId ?? null,
      input.worldId ?? null,
      input.selectedAssetId ?? null
    ]
  );
  const locked = await client.query<IdempotencyRecord>(
    `SELECT request_fingerprint, status, result
       FROM asset_mutation_idempotency
      WHERE owner_user_id=$1 AND mutation_kind=$2 AND idempotency_key_hash=$3
      FOR UPDATE`,
    [input.ownerUserId, input.mutationKind, keyHash]
  );
  const row = locked.rows[0];
  if (!row) throw repositoryError("asset_repository_unavailable", 503);
  if (row.request_fingerprint !== input.requestFingerprint) {
    throw repositoryError("asset_idempotency_mismatch", 409);
  }
  return { replay: row.status === "completed", result: row.result };
}

async function completeIdempotency(
  client: DatabaseClient,
  ownerUserId: string,
  mutationKind: MutationKind,
  idempotencyKey: string,
  result: unknown,
): Promise<void> {
  await client.query(
    `UPDATE asset_mutation_idempotency
        SET status='completed', result=$4::jsonb, completed_at=now(), updated_at=now()
      WHERE owner_user_id=$1 AND mutation_kind=$2 AND idempotency_key_hash=$3`,
    [ownerUserId, mutationKind, sha256(idempotencyKey), JSON.stringify(result)]
  );
}

function metadataFingerprint(ownerUserId: string, assetId: string, command: AssetMetadataUpdateCommand): string {
  const { idempotencyKey: _idempotencyKey, ...request } = command;
  return sha256(stableStringify({ ownerUserId, assetId, request }));
}

async function updateMetadata(
  pool: DatabasePool,
  ownerUserId: string,
  assetId: string,
  command: AssetMetadataUpdateCommand,
) {
  if (command.reuseScope === "shared") throw repositoryError("asset_shared_unavailable", 409);
  return withTransaction(pool, async (client) => {
    const fingerprint = metadataFingerprint(ownerUserId, assetId, command);
    await lockAssetMutation(client, ownerUserId, "asset_metadata_update", sha256(command.idempotencyKey));
    const current = await client.query<{ metadata_revision: number }>(
      `SELECT le.metadata_revision
         FROM assets a
         JOIN asset_library_entries le
           ON le.asset_id=a.id AND le.owner_user_id=a.owner_user_id
        WHERE a.id=$1 AND a.owner_user_id=$2
        FOR UPDATE OF le`,
      [assetId, ownerUserId]
    );
    if (!current.rows[0]) throw repositoryError("asset_not_found", 404);
    const idempotency = await beginIdempotency(client, {
      ownerUserId,
      mutationKind: "asset_metadata_update",
      idempotencyKey: command.idempotencyKey,
      requestFingerprint: fingerprint,
      targetAssetId: assetId
    });
    if (idempotency.replay) return idempotency.result as { assetId: string; metadataRevision: number };
    if (current.rows[0].metadata_revision !== command.expectedRevision) {
      throw repositoryError("asset_revision_conflict", 409);
    }
    const normalizedTags = command.tags === undefined
      ? null
      : [...new Set(command.tags.map((tag) => tag.toLocaleLowerCase()))].sort();
    const normalizedCategories = command.contentCategories === undefined
      ? null
      : [...new Set(command.contentCategories)].sort();
    const updated = await client.query<{ metadata_revision: number }>(
      `UPDATE asset_library_entries SET
         title=COALESCE($4,title), caption=COALESCE($5,caption), notes=COALESCE($6,notes),
         tags=COALESCE($7,tags), reuse_scope=COALESCE($8,reuse_scope),
         automatic_reuse_enabled=COALESCE($9,automatic_reuse_enabled),
         review_status=COALESCE($10,review_status), content_categories=COALESCE($11,content_categories),
         favorite=COALESCE($12,favorite),
         archived_at=CASE WHEN $13::boolean IS NULL THEN archived_at
                          WHEN $13 THEN COALESCE(archived_at,now()) ELSE NULL END,
         metadata_revision=metadata_revision+1, updated_at=now()
       WHERE asset_id=$1 AND owner_user_id=$2 AND metadata_revision=$3
       RETURNING metadata_revision`,
      [
        assetId,
        ownerUserId,
        command.expectedRevision,
        command.title ?? null,
        command.caption ?? null,
        command.notes ?? null,
        normalizedTags,
        command.reuseScope ?? null,
        command.automaticReuseEnabled ?? null,
        command.reviewStatus ?? null,
        normalizedCategories,
        command.favorite ?? null,
        command.archived ?? null
      ]
    );
    const revision = updated.rows[0]?.metadata_revision;
    if (!revision) throw repositoryError("asset_revision_conflict", 409);
    const result = { assetId, metadataRevision: revision };
    await completeIdempotency(client, ownerUserId, "asset_metadata_update", command.idempotencyKey, result);
    return result;
  });
}

function selectionFingerprint(
  kind: "turn_asset_selection" | "world_asset_selection",
  scope: TurnAssetSelectionScope | WorldAssetSelectionScope,
  command: AssetSelectionCommand,
): string {
  return sha256(stableStringify({ kind, scope, assetId: command.assetId }));
}

async function requireSelectedAsset(client: DatabaseClient, ownerUserId: string, assetId: string | null): Promise<void> {
  if (assetId === null) return;
  const owned = await client.query(
    "SELECT 1 FROM assets WHERE id=$1 AND owner_user_id=$2",
    [assetId, ownerUserId]
  );
  if (!owned.rowCount) throw repositoryError("asset_not_found", 404);
}

async function selectTurn(
  pool: DatabasePool,
  scope: TurnAssetSelectionScope,
  command: AssetSelectionCommand,
): Promise<AssetSelectionView> {
  return withTransaction(pool, async (client) => {
    await lockAssetMutation(
      client,
      scope.ownerUserId,
      "turn_asset_selection",
      sha256(command.idempotencyKey),
    );
    const turn = await client.query(
      `SELECT 1 FROM turns
        WHERE id=$1 AND campaign_id=$2 AND owner_user_id=$3
        FOR UPDATE`,
      [scope.turnId, scope.campaignId, scope.ownerUserId]
    );
    if (!turn.rowCount) throw repositoryError("asset_scope_not_found", 404);
    await requireSelectedAsset(client, scope.ownerUserId, command.assetId);
    const idempotency = await beginIdempotency(client, {
      ownerUserId: scope.ownerUserId,
      mutationKind: "turn_asset_selection",
      idempotencyKey: command.idempotencyKey,
      requestFingerprint: selectionFingerprint("turn_asset_selection", scope, command),
      campaignId: scope.campaignId,
      turnId: scope.turnId,
      selectedAssetId: command.assetId
    });
    if (idempotency.replay) return idempotency.result as AssetSelectionView;
    const assetUrl = command.assetId === null ? "" : `/api/v1/assets/${command.assetId}`;
    await client.query(
      "UPDATE turns SET image_url=$4 WHERE id=$1 AND campaign_id=$2 AND owner_user_id=$3",
      [scope.turnId, scope.campaignId, scope.ownerUserId, assetUrl]
    );
    await client.query(
      `DELETE FROM asset_references
        WHERE owner_user_id=$1 AND campaign_id=$2 AND turn_id=$3
          AND asset_role='turn_illustration'`,
      [scope.ownerUserId, scope.campaignId, scope.turnId]
    );
    if (command.assetId !== null) {
      await client.query(
        `INSERT INTO asset_references (owner_user_id, asset_id, campaign_id, turn_id, asset_role)
         VALUES ($1,$2,$3,$4,'turn_illustration') ON CONFLICT DO NOTHING`,
        [scope.ownerUserId, command.assetId, scope.campaignId, scope.turnId]
      );
    }
    const result = { assetId: command.assetId, selected: command.assetId !== null };
    await completeIdempotency(client, scope.ownerUserId, "turn_asset_selection", command.idempotencyKey, result);
    return result;
  });
}

async function selectWorld(
  pool: DatabasePool,
  scope: WorldAssetSelectionScope,
  command: AssetSelectionCommand,
): Promise<AssetSelectionView> {
  return withTransaction(pool, async (client) => {
    await lockAssetMutation(
      client,
      scope.ownerUserId,
      "world_asset_selection",
      sha256(command.idempotencyKey),
    );
    const world = await client.query(
      "SELECT 1 FROM worlds WHERE id=$1 AND owner_user_id=$2 FOR UPDATE",
      [scope.worldId, scope.ownerUserId]
    );
    if (!world.rowCount) throw repositoryError("asset_scope_not_found", 404);
    await requireSelectedAsset(client, scope.ownerUserId, command.assetId);
    const idempotency = await beginIdempotency(client, {
      ownerUserId: scope.ownerUserId,
      mutationKind: "world_asset_selection",
      idempotencyKey: command.idempotencyKey,
      requestFingerprint: selectionFingerprint("world_asset_selection", scope, command),
      worldId: scope.worldId,
      selectedAssetId: command.assetId
    });
    if (idempotency.replay) return idempotency.result as AssetSelectionView;
    await client.query(
      "UPDATE worlds SET cover_asset_id=$3, updated_at=now() WHERE id=$1 AND owner_user_id=$2",
      [scope.worldId, scope.ownerUserId, command.assetId]
    );
    const result = { assetId: command.assetId, selected: command.assetId !== null };
    await completeIdempotency(client, scope.ownerUserId, "world_asset_selection", command.idempotencyKey, result);
    return result;
  });
}

async function deliveryDescriptor(
  pool: DatabasePool,
  ownerUserId: string,
  assetId: string,
  request: Readonly<{ kind: "original" }> | Readonly<{ kind: "derivative"; derivativeKind: "thumbnail" }>,
): Promise<AssetDeliveryDescriptor> {
  const row = await selectAssetDeliveryRow(pool, ownerUserId, assetId, request);
  if (!row) throw repositoryError("asset_not_found", 404);
  if (!validMimeType(row.mimeType)) throw repositoryError("asset_repository_unavailable", 503);
  return request.kind === "original"
    ? {
      assetId,
      kind: "original",
      derivativeKind: null,
      mimeType: row.mimeType,
      byteLength: row.byteLength,
      etag: row.contentHash
    }
    : {
      assetId,
      kind: "derivative",
      derivativeKind: "thumbnail",
      mimeType: row.mimeType,
      byteLength: row.byteLength,
      etag: row.contentHash
    };
}

type BackfillJobRow = Readonly<{
  owner_user_id: string;
  asset_id: string;
  lease_id: string;
  lease_owner: string;
  work_version: number;
  lease_expires_at: Date;
}>;

function backfillClaim(row: BackfillJobRow): AssetMetadataBackfillClaim {
  return {
    ownerUserId: row.owner_user_id,
    assetId: row.asset_id,
    leaseId: row.lease_id,
    leaseOwner: row.lease_owner,
    workVersion: row.work_version,
    leaseExpiresAt: row.lease_expires_at.toISOString()
  };
}

async function classifyLease(
  client: DatabaseClient | DatabasePool,
  claim: AssetMetadataBackfillClaim,
): Promise<"stale" | "lease_lost" | "already_current"> {
  const current = await client.query<{
    status: string;
    work_version: number;
    completion_fence: string | null;
  }>(
    `SELECT job.status, job.work_version,
            asset.technical_metadata ->> 'assetMetadataBackfillCompletionFence' AS completion_fence
       FROM asset_metadata_backfill_jobs job
       JOIN assets asset
         ON asset.id=job.asset_id AND asset.owner_user_id=job.owner_user_id
      WHERE job.owner_user_id=$1 AND job.asset_id=$2`,
    [claim.ownerUserId, claim.assetId]
  );
  const row = current.rows[0];
  if (!row || row.work_version !== claim.workVersion) return "stale";
  if (row.status === "completed" && row.completion_fence === backfillCompletionFence(claim)) {
    return "already_current";
  }
  return "lease_lost";
}

function backfillCompletionFence(claim: AssetMetadataBackfillClaim): string {
  return sha256(stableStringify({
    ownerUserId: claim.ownerUserId,
    assetId: claim.assetId,
    leaseId: claim.leaseId,
    leaseOwner: claim.leaseOwner,
    workVersion: claim.workVersion
  }));
}

function assetDatabaseClient(context: AssetTransactionContext): DatabaseClient {
  const candidate = context as Partial<DatabaseClient>;
  if (typeof candidate.query !== "function" || typeof candidate.release !== "function") {
    throw repositoryError("asset_repository_unavailable", 503);
  }
  return candidate as DatabaseClient;
}

function metadataRepository(pool: DatabasePool): AssetMetadataBackfillPort {
  return {
    async updateAssetMetadata(scope, command) {
      return safeRepositoryCall(() => updateMetadata(pool, scope.ownerUserId, scope.assetId, command));
    },

    async claimNextMetadataBackfill(request) {
      return safeRepositoryCall(() => withTransaction(pool, async (client) => {
        const claimed = await client.query<BackfillJobRow>(
          `WITH candidate AS (
             SELECT id FROM asset_metadata_backfill_jobs
              WHERE (
                status IN ('queued','recoverable') AND next_attempt_at <= now()
              ) OR (
                status='running' AND lease_expires_at < now()
              )
              ORDER BY next_attempt_at, created_at, id
              FOR UPDATE SKIP LOCKED LIMIT 1
           )
           UPDATE asset_metadata_backfill_jobs job
              SET status='running', attempts=attempts+1, work_version=work_version+1,
                  lease_id=gen_random_uuid(), lease_owner=$1,
                  lease_expires_at=now()+($2::text || ' seconds')::interval,
                  updated_at=now(), completed_at=NULL
             FROM candidate WHERE job.id=candidate.id
           RETURNING job.owner_user_id, job.asset_id, job.lease_id, job.lease_owner,
                     job.work_version, job.lease_expires_at`,
          [request.workerId, request.leaseSeconds]
        );
        return claimed.rows[0] ? backfillClaim(claimed.rows[0]) : null;
      }));
    },

    async heartbeatMetadataBackfill(claim, request) {
      return safeRepositoryCall(async () => {
        const renewed = await pool.query<BackfillJobRow>(
          `UPDATE asset_metadata_backfill_jobs
              SET lease_expires_at=now()+($6::text || ' seconds')::interval, updated_at=now()
            WHERE owner_user_id=$1 AND asset_id=$2 AND lease_id=$3 AND lease_owner=$4
              AND work_version=$5 AND status='running' AND lease_expires_at > now()
          RETURNING owner_user_id, asset_id, lease_id, lease_owner, work_version, lease_expires_at`,
          [claim.ownerUserId, claim.assetId, claim.leaseId, claim.leaseOwner, claim.workVersion, request.leaseSeconds]
        );
        return renewed.rows[0]
          ? { outcome: "renewed" as const, claim: backfillClaim(renewed.rows[0]) }
          : { outcome: (await classifyLease(pool, claim)) === "stale" ? "stale" as const : "lease_lost" as const };
      });
    },

    async requeueMetadataBackfill(claim, request) {
      return safeRepositoryCall(async () => {
        if (request.diagnosticCode !== undefined && !DIAGNOSTIC_CODES.has(request.diagnosticCode)) {
          throw repositoryError("asset_diagnostic_invalid", 400);
        }
        const requeued = await pool.query(
          `UPDATE asset_metadata_backfill_jobs
              SET status='recoverable', diagnostic_code=$6, lease_id=NULL, lease_owner=NULL,
                  lease_expires_at=NULL, next_attempt_at=now(), updated_at=now()
            WHERE owner_user_id=$1 AND asset_id=$2 AND lease_id=$3 AND lease_owner=$4
              AND work_version=$5 AND status='running' AND lease_expires_at > now()
          RETURNING id`,
          [claim.ownerUserId, claim.assetId, claim.leaseId, claim.leaseOwner, claim.workVersion, request.diagnosticCode ?? null]
        );
        if (requeued.rowCount) return { outcome: "requeued" as const };
        const classification = await classifyLease(pool, claim);
        return { outcome: classification === "stale" ? "stale" as const : "lease_lost" as const };
      });
    },

    async backfillMetadata(database, claim) {
      return safeRepositoryCall(async () => {
        const client = assetDatabaseClient(database);
        const completed = await client.query(
          `UPDATE asset_metadata_backfill_jobs job
              SET status='completed', diagnostic_code=NULL, lease_id=NULL, lease_owner=NULL,
                  lease_expires_at=NULL, completed_at=now(), updated_at=now()
            WHERE job.owner_user_id=$1 AND job.asset_id=$2 AND job.lease_id=$3
              AND job.lease_owner=$4 AND job.work_version=$5 AND job.status='running'
              AND job.lease_expires_at > now()
              AND EXISTS (
                SELECT 1 FROM assets a
                 WHERE a.id=job.asset_id AND a.owner_user_id=job.owner_user_id
                   AND a.pixel_width IS NOT NULL AND a.pixel_height IS NOT NULL
              )
              AND EXISTS (
                SELECT 1 FROM asset_derivatives d
                 WHERE d.source_asset_id=job.asset_id AND d.owner_user_id=job.owner_user_id
                   AND d.derivative_kind='thumbnail' AND d.transform_version=1
              )
          RETURNING job.id`,
          [claim.ownerUserId, claim.assetId, claim.leaseId, claim.leaseOwner, claim.workVersion]
        );
        if (completed.rowCount) {
          await client.query(
            `UPDATE assets
                SET technical_metadata=jsonb_set(
                  technical_metadata,
                  '{assetMetadataBackfillCompletionFence}',
                  to_jsonb($3::text),
                  true
                )
              WHERE id=$1 AND owner_user_id=$2`,
            [claim.assetId, claim.ownerUserId, backfillCompletionFence(claim)]
          );
          return { assetId: claim.assetId, outcome: "updated" as const };
        }
        const classification = await classifyLease(client, claim);
        if (classification === "already_current") {
          return { assetId: claim.assetId, outcome: "already_current" as const };
        }
        if (classification === "stale") return { assetId: claim.assetId, outcome: "stale" as const };
        const failed = await client.query(
          `UPDATE asset_metadata_backfill_jobs
              SET status='failed', diagnostic_code='asset_metadata_unavailable',
                  lease_id=NULL, lease_owner=NULL, lease_expires_at=NULL, updated_at=now()
            WHERE owner_user_id=$1 AND asset_id=$2 AND lease_id=$3 AND lease_owner=$4
              AND work_version=$5 AND status='running' AND lease_expires_at > now()
          RETURNING id`,
          [claim.ownerUserId, claim.assetId, claim.leaseId, claim.leaseOwner, claim.workVersion]
        );
        return failed.rowCount
          ? {
            assetId: claim.assetId,
            outcome: "safe_failure" as const,
            diagnosticCode: "asset_metadata_unavailable" as const
          }
          : { assetId: claim.assetId, outcome: "lease_lost" as const };
      });
    }
  };
}

/**
 * Additive PostgreSQL implementation of the frozen asset application ports.
 * API owner resolution and worker scheduling remain outside this repository.
 */
export function createPostgresAssetRepositories(pool: DatabasePool): AssetApplicationDependencies {
  const metadata = metadataRepository(pool);
  return {
    library: {
      async listAssets(scope, query) {
        return safeRepositoryCall(() => listAssets(pool, scope.ownerUserId, query));
      },
      async readAsset(scope) {
        return safeRepositoryCall(async () => {
          const result = await pool.query<{ mime_type: string; byte_length: string }>(
            "SELECT mime_type, byte_length::text FROM assets WHERE id=$1 AND owner_user_id=$2",
            [scope.assetId, scope.ownerUserId]
          );
          const row = result.rows[0];
          if (!row) throw repositoryError("asset_not_found", 404);
          if (!validMimeType(row.mime_type)) throw repositoryError("asset_repository_unavailable", 503);
          return { assetId: scope.assetId, mimeType: row.mime_type, byteLength: Number(row.byte_length) };
        });
      }
    },
    selection: {
      async selectTurnIllustration(scope, command) {
        return safeRepositoryCall(() => selectTurn(pool, scope, command));
      },
      async selectWorldCover(scope, command) {
        return safeRepositoryCall(() => selectWorld(pool, scope, command));
      }
    },
    metadata,
    delivery: {
      async describeAssetDelivery(scope, request) {
        return safeRepositoryCall(() => deliveryDescriptor(pool, scope.ownerUserId, scope.assetId, request));
      }
    }
  };
}

/** Adapter-private redemption of a database-issued locator into immutable storage identity. */
export function createPostgresAssetStorageLocatorRedemptionRepository(
  pool: DatabasePool,
): PrivateStorageLocatorRedemptionPort {
  return {
    async redeemStorageLocator(scope: DurableFilesystemScope, locator: DatabaseIssuedStorageLocator) {
      return safeRepositoryCall(async (): Promise<PrivateStorageDescriptor | null> => {
        if (scope.resourceKind !== "asset") return null;
        const result = await pool.query<{
          relative_path: string;
          device_id: string;
          file_id: string;
          change_token: string;
          content_hash: string;
          byte_length: string;
        }>(
          `SELECT descriptor.relative_path, descriptor.device_id, descriptor.file_id,
                  descriptor.change_token, descriptor.content_hash, descriptor.byte_length::text
             FROM durable_filesystem_operations operation
             JOIN durable_filesystem_descriptors descriptor
               ON descriptor.operation_id=operation.id
              AND descriptor.owner_user_id=operation.owner_user_id
              AND descriptor.descriptor_role='delivery'
            WHERE operation.owner_user_id=$1 AND operation.asset_id=$2
              AND operation.resource_kind='asset'
              AND operation.purpose IN ('asset_original','asset_derivative')
              AND operation.lifecycle='finalized'
              AND operation.locator_token_hash=$3
            LIMIT 1`,
          [scope.ownerUserId, scope.assetId, sha256(locator)]
        );
        const row = result.rows[0];
        return row ? {
          relativePath: row.relative_path,
          identity: {
            deviceId: row.device_id,
            fileId: row.file_id,
            changeToken: row.change_token
          },
          contentHash: row.content_hash,
          byteLength: Number(row.byte_length)
        } : null;
      });
    }
  };
}
