import { createHash } from "node:crypto";
import {
  fingerprintPrivateNormalizedAssetPublicationRequest,
  type PrivateNormalizedAssetPublicationRequest
} from "../../application/src/assets/private-normalized-asset-publication.js";
import type {
  PrivatePortableNormalizedAttachedPublication,
  PrivatePortableNormalizedPendingFinalization,
  PrivatePortableNormalizedPublicationIntent,
  PrivatePortableNormalizedRetirementReason,
  PrivatePortableNormalizedPublicationScope
} from "../../application/src/imports/private-normalized-portable-publication.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";
import { withTransaction } from "./pool.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SOURCE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const SAFE_SOURCE_KEY_PATTERN = /^source-key-sha256:[0-9a-f]{64}$/u;
const SAFE_SOURCE_INSTALLATION_PATTERN = /^source-installation-sha256:[0-9a-f]{64}$/u;
const MAXIMUM_PORTABLE_PUBLICATION_BATCH = 256;

type IntentRow = Readonly<{
  asset_ordinal: number;
  request_fingerprint: string;
  request_idempotency_key_hash: string;
  request_id: string | null;
  publication_state: string;
}>;

function stableError(code: string): Error {
  return new Error(code);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requestFingerprint(request: PrivateNormalizedAssetPublicationRequest): string {
  return fingerprintPrivateNormalizedAssetPublicationRequest(request, sha256);
}

function requestIdempotencyHash(request: PrivateNormalizedAssetPublicationRequest): string {
  return sha256(request.idempotencyKey);
}

function validateScope(scope: PrivatePortableNormalizedPublicationScope): void {
  if (!UUID_PATTERN.test(scope.operationId)
    || !UUID_PATTERN.test(scope.ownerUserId)
    || !HASH_PATTERN.test(scope.authorityFingerprint)
    || !HASH_PATTERN.test(scope.commitIdempotencyKeyHash)) {
    throw stableError("portable_normalized_publication_scope_invalid");
  }
}

function validateRequests(
  scope: PrivatePortableNormalizedPublicationScope,
  intents: readonly PrivatePortableNormalizedPublicationIntent[],
): readonly PrivateNormalizedAssetPublicationRequest[] {
  if (intents.length > MAXIMUM_PORTABLE_PUBLICATION_BATCH) {
    throw stableError("portable_normalized_publication_batch_invalid");
  }
  const requests = intents.map(({ request }) => request);
  for (const request of requests) {
    if (request.owner.ownerUserId !== scope.ownerUserId
      || request.provenance.kind !== "import"
      || request.provenance.importKind !== scope.importKind
      || request.provenance.importOperationId !== scope.operationId
      || request.provenance.importId !== null
      || (request.provenance.sourceInstallationId !== null
        && !SAFE_SOURCE_INSTALLATION_PATTERN.test(request.provenance.sourceInstallationId))
      || request.sourceRecords.length === 0
      || request.sourceRecords.some((source) => (
        source.sourceKind !== scope.importKind
        || !SOURCE_UUID_PATTERN.test(source.sourceAssetId)
        || (source.sourceRecordId !== null && !HASH_PATTERN.test(source.sourceRecordId))
        || (source.sourceKey !== null && !SAFE_SOURCE_KEY_PATTERN.test(source.sourceKey))
      ))) {
      throw stableError("portable_normalized_publication_request_invalid");
    }
  }
  if (new Set(requests.map(requestIdempotencyHash)).size !== requests.length
    || new Set(requests.map(requestFingerprint)).size !== requests.length) {
    throw stableError("portable_normalized_publication_batch_invalid");
  }
  return Object.freeze(requests);
}

function databaseClient(value: object): DatabaseClient {
  if (!("query" in value) || typeof (value as { query?: unknown }).query !== "function") {
    throw stableError("portable_normalized_publication_transaction_invalid");
  }
  return value as DatabaseClient;
}

async function lockOperation(
  database: DatabaseClient,
  scope: PrivatePortableNormalizedPublicationScope,
  expectedStatus: "previewed" | "consuming",
): Promise<void> {
  const operation = await database.query(
    `SELECT 1
       FROM portable_import_operations operation
       JOIN portable_import_work work
         ON work.operation_id=operation.id AND work.owner_user_id=operation.owner_user_id
      WHERE operation.id=$1 AND operation.owner_user_id=$2
        AND operation.import_kind=$3 AND operation.authority_fingerprint=$4
        AND operation.status=$5
        AND ($5::text<>'consuming' OR operation.idempotency_key_hash=$6)
        AND work.status IN ('running','recoverable')
        AND work.expires_at>clock_timestamp()
      FOR UPDATE OF operation,work`,
    [
      scope.operationId,
      scope.ownerUserId,
      scope.importKind,
      scope.authorityFingerprint,
      expectedStatus,
      scope.commitIdempotencyKeyHash
    ],
  );
  if (operation.rowCount !== 1) {
    throw stableError("portable_normalized_publication_operation_unavailable");
  }
}

async function readIntentRows(
  database: DatabaseClient,
  scope: PrivatePortableNormalizedPublicationScope,
): Promise<readonly IntentRow[]> {
  const rows = await database.query<IntentRow>(
    `SELECT asset_ordinal,request_fingerprint,request_idempotency_key_hash,
            request_id,publication_state
       FROM portable_import_normalized_asset_publications
      WHERE operation_id=$1 AND owner_user_id=$2
      ORDER BY asset_ordinal
      FOR UPDATE`,
    [scope.operationId, scope.ownerUserId],
  );
  return rows.rows;
}

async function bindReservedRequestsWithDatabase(
  database: DatabaseClient,
  scope: PrivatePortableNormalizedPublicationScope,
  requests: readonly PrivateNormalizedAssetPublicationRequest[],
): Promise<void> {
  for (const [assetOrdinal, request] of requests.entries()) {
    const bound = await database.query<{ request_id: string }>(
      `UPDATE portable_import_normalized_asset_publications mapping
          SET request_id=request.id,publication_state='reserved'
         FROM asset_publication_requests request
        WHERE mapping.operation_id=$1 AND mapping.owner_user_id=$2
          AND mapping.asset_ordinal=$3
          AND mapping.publication_state='reservation_intent'
          AND request.owner_user_id=mapping.owner_user_id
          AND request.request_fingerprint=mapping.request_fingerprint
          AND request.idempotency_key_hash=mapping.request_idempotency_key_hash
          AND request.provenance_snapshot->>'kind'='import'
          AND request.provenance_snapshot->>'importKind'=mapping.import_kind
          AND request.provenance_snapshot->>'importOperationId'=mapping.operation_id::text
        RETURNING mapping.request_id`,
      [scope.operationId, scope.ownerUserId, assetOrdinal],
    );
    if (!bound.rows[0]) {
      const replay = await database.query<{ request_id: string }>(
        `SELECT request_id
           FROM portable_import_normalized_asset_publications
          WHERE operation_id=$1 AND owner_user_id=$2 AND asset_ordinal=$3
            AND publication_state='reserved'
            AND request_fingerprint=$4 AND request_idempotency_key_hash=$5`,
        [
          scope.operationId,
          scope.ownerUserId,
          assetOrdinal,
          requestFingerprint(request),
          requestIdempotencyHash(request)
        ],
      );
      if (!replay.rows[0]) {
        throw stableError("portable_normalized_publication_request_unavailable");
      }
    }
  }
}

async function recordReservationIntentsWithDatabase(
  database: DatabaseClient,
  scope: PrivatePortableNormalizedPublicationScope,
  requests: readonly PrivateNormalizedAssetPublicationRequest[],
): Promise<void> {
  const existing = await readIntentRows(database, scope);
  if (existing.length === 0) {
    for (const [assetOrdinal, request] of requests.entries()) {
      await database.query(
        `INSERT INTO portable_import_normalized_asset_publications (
           operation_id,owner_user_id,asset_ordinal,import_kind,authority_fingerprint,
           commit_idempotency_key_hash,request_fingerprint,request_idempotency_key_hash
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          scope.operationId,
          scope.ownerUserId,
          assetOrdinal,
          scope.importKind,
          scope.authorityFingerprint,
          scope.commitIdempotencyKeyHash,
          requestFingerprint(request),
          requestIdempotencyHash(request)
        ],
      );
      for (const [sourceOrdinal, source] of request.sourceRecords.entries()) {
        await database.query(
          `INSERT INTO portable_import_normalized_asset_sources (
             operation_id,owner_user_id,asset_ordinal,source_ordinal,source_kind,
             source_asset_id,source_record_id,source_key,requested_library_snapshot,
             binding_intent_keys
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)`,
          [
            scope.operationId,
            scope.ownerUserId,
            assetOrdinal,
            sourceOrdinal,
            source.sourceKind,
            source.sourceAssetId,
            source.sourceRecordId,
            source.sourceKey,
            JSON.stringify(source.requestedLibrary),
            JSON.stringify(source.bindingIntentKeys)
          ],
        );
      }
      for (const context of request.contextIntents) {
        await database.query(
          `INSERT INTO portable_import_normalized_asset_contexts (
             operation_id,owner_user_id,asset_ordinal,intent_key,context_snapshot
           ) VALUES ($1,$2,$3,$4,$5::jsonb)`,
          [
            scope.operationId,
            scope.ownerUserId,
            assetOrdinal,
            context.intentKey,
            JSON.stringify(context)
          ],
        );
      }
      for (const reference of request.referencePolicy.intents) {
        await database.query(
          `INSERT INTO portable_import_normalized_asset_references (
             operation_id,owner_user_id,asset_ordinal,intent_key,reference_snapshot
           ) VALUES ($1,$2,$3,$4,$5::jsonb)`,
          [
            scope.operationId,
            scope.ownerUserId,
            assetOrdinal,
            reference.intentKey,
            JSON.stringify(reference)
          ],
        );
      }
    }
  }
  const exact = await readIntentRows(database, scope);
  if (exact.length !== requests.length
    || exact.some((row, assetOrdinal) => row.asset_ordinal !== assetOrdinal
      || row.request_fingerprint !== requestFingerprint(requests[assetOrdinal]!)
      || row.request_idempotency_key_hash !== requestIdempotencyHash(requests[assetOrdinal]!))) {
    throw stableError("portable_normalized_publication_intent_mismatch");
  }
  for (const [assetOrdinal, request] of requests.entries()) {
    const childAuthority = await database.query<{
      sources_match: boolean;
      contexts_match: boolean;
      references_match: boolean;
    }>(
      `SELECT
         (SELECT COALESCE(jsonb_agg(jsonb_build_array(
                   source_ordinal,source_kind,source_asset_id,source_record_id,source_key,
                   requested_library_snapshot,binding_intent_keys
                 ) ORDER BY source_ordinal),'[]'::jsonb)
            FROM portable_import_normalized_asset_sources
           WHERE operation_id=$1 AND owner_user_id=$2 AND asset_ordinal=$3
         )=$4::jsonb AS sources_match,
         (SELECT COALESCE(jsonb_agg(jsonb_build_array(intent_key,context_snapshot)
                   ORDER BY intent_key),'[]'::jsonb)
            FROM portable_import_normalized_asset_contexts
           WHERE operation_id=$1 AND owner_user_id=$2 AND asset_ordinal=$3
         )=$5::jsonb AS contexts_match,
         (SELECT COALESCE(jsonb_agg(jsonb_build_array(intent_key,reference_snapshot)
                   ORDER BY intent_key),'[]'::jsonb)
            FROM portable_import_normalized_asset_references
           WHERE operation_id=$1 AND owner_user_id=$2 AND asset_ordinal=$3
         )=$6::jsonb AS references_match`,
      [
        scope.operationId,
        scope.ownerUserId,
        assetOrdinal,
        JSON.stringify(request.sourceRecords.map((source, sourceOrdinal) => [
          sourceOrdinal,
          source.sourceKind,
          source.sourceAssetId,
          source.sourceRecordId,
          source.sourceKey,
          source.requestedLibrary,
          source.bindingIntentKeys
        ])),
        JSON.stringify(request.contextIntents.map((context) => [context.intentKey, context])),
        JSON.stringify(request.referencePolicy.intents.map((reference) => [
          reference.intentKey,
          reference
        ]))
      ],
    );
    const authority = childAuthority.rows[0];
    if (!authority?.sources_match || !authority.contexts_match || !authority.references_match) {
      throw stableError("portable_normalized_publication_intent_mismatch");
    }
  }
}

export type PostgresPortableNormalizedAssetPublicationRepository = Readonly<{
  recordReservationIntents(
    scope: PrivatePortableNormalizedPublicationScope,
    intents: readonly PrivatePortableNormalizedPublicationIntent[],
  ): Promise<void>;
  bindReservedRequests(
    scope: PrivatePortableNormalizedPublicationScope,
    intents: readonly PrivatePortableNormalizedPublicationIntent[],
  ): Promise<void>;
  recordAndBindReservedRequests(
    scope: PrivatePortableNormalizedPublicationScope,
    intents: readonly PrivatePortableNormalizedPublicationIntent[],
    reserve: (
      database: object,
      requests: readonly PrivateNormalizedAssetPublicationRequest[],
    ) => Promise<void>,
  ): Promise<void>;
  recordAttachedInTransaction(
    database: object,
    scope: PrivatePortableNormalizedPublicationScope,
    importId: string,
    publications: readonly PrivatePortableNormalizedAttachedPublication[],
  ): Promise<void>;
  beginRetirementInTransaction(
    database: object,
    scope: PrivatePortableNormalizedPublicationScope,
    reason: PrivatePortableNormalizedRetirementReason,
  ): Promise<void>;
  beginOptionalOmission(
    scope: PrivatePortableNormalizedPublicationScope,
    intents: readonly PrivatePortableNormalizedPublicationIntent[],
  ): Promise<void>;
  retireAbandonedOperationInTransaction(
    database: object,
    input: Readonly<{ operationId: string; ownerUserId: string }>,
  ): Promise<void>;
  reconcileRetirements(
    ownerUserId: string,
    operationId: string,
  ): Promise<Readonly<{ retired: number; pending: number }>>;
  reconcileCommittedRetirements(
    ownerUserId: string,
    previewToken: string,
  ): Promise<Readonly<{ retired: number; pending: number }>>;
  loadFinalizations(
    ownerUserId: string,
    operationId: string,
  ): Promise<readonly PrivatePortableNormalizedPendingFinalization[]>;
  loadCommittedFinalizations(
    ownerUserId: string,
    previewToken: string,
  ): Promise<readonly PrivatePortableNormalizedPendingFinalization[]>;
  recordFinalizationRecoverable(input: PrivatePortableNormalizedPendingFinalization): Promise<void>;
  markFinalizationPublished(input: PrivatePortableNormalizedPendingFinalization): Promise<void>;
}>;

export function createPostgresPortableNormalizedAssetPublicationRepository(
  pool: DatabasePool,
): PostgresPortableNormalizedAssetPublicationRepository {
  const loadRows = async (
    where: string,
    parameters: readonly unknown[],
  ): Promise<readonly PrivatePortableNormalizedPendingFinalization[]> => {
    const selected = await pool.query<Readonly<{
      operation_id: string;
      owner_user_id: string;
      asset_ordinal: number;
      safe_result: PrivatePortableNormalizedPendingFinalization["result"];
      finalization_locator: string;
      publication_state: "committed_finalization_pending" | "published";
    }>>(
      `SELECT mapping.operation_id,mapping.owner_user_id,mapping.asset_ordinal,
              mapping.safe_result,mapping.finalization_locator,mapping.publication_state
         FROM portable_import_normalized_asset_publications mapping
         JOIN portable_import_operations operation
           ON operation.id=mapping.operation_id AND operation.owner_user_id=mapping.owner_user_id
        WHERE ${where}
          AND operation.status='committed'
          AND mapping.publication_state IN ('committed_finalization_pending','published')
        ORDER BY mapping.asset_ordinal`,
      [...parameters],
    );
    return Object.freeze(selected.rows.map((row) => Object.freeze({
      operationId: row.operation_id,
      ownerUserId: row.owner_user_id,
      assetOrdinal: row.asset_ordinal,
      result: Object.freeze(row.safe_result),
      finalization: row.finalization_locator as PrivatePortableNormalizedPendingFinalization["finalization"],
      publicationState: row.publication_state
    })));
  };

  const reconcileRetirementsWithDatabase = async (
    database: DatabaseClient,
    ownerUserId: string,
    operationWhere: string,
    operationParameter: string,
  ): Promise<Readonly<{ retired: number; pending: number }>> => {
    // Keep the same lock order as commit: operation -> work -> mappings ->
    // normalized request/identity -> exact filesystem operations.
    const operation = await database.query<{
      id: string;
      status: string;
      import_kind: string;
      result_projection: Readonly<{ duplicate?: unknown }> | null;
      completed_import: boolean;
    }>(
      `SELECT operation.id,operation.status,operation.import_kind,operation.result_projection,
              EXISTS (
                SELECT 1 FROM imports imported
                 WHERE imported.id=operation.import_id
                   AND imported.owner_user_id=operation.owner_user_id
                   AND imported.source_hash=operation.authority_fingerprint
                   AND imported.status='completed'
              ) AS completed_import
         FROM portable_import_operations operation
        WHERE operation.owner_user_id=$1 AND ${operationWhere}
        FOR UPDATE OF operation`,
      [ownerUserId, operationParameter],
    );
    const operationRow = operation.rows[0];
    if (!operationRow) {
      throw stableError("portable_normalized_publication_retirement_unavailable");
    }
    const work = await database.query<{ status: string }>(
      `SELECT status
         FROM portable_import_work
        WHERE operation_id=$1 AND owner_user_id=$2
        FOR UPDATE`,
      [operationRow.id, ownerUserId],
    );
    const workRow = work.rows[0];
    if (!workRow) {
      throw stableError("portable_normalized_publication_retirement_unavailable");
    }
    const mappings = await database.query<{
      asset_ordinal: number;
      request_id: string | null;
      retirement_reason: PrivatePortableNormalizedRetirementReason;
    }>(
      `SELECT asset_ordinal,request_id,retirement_reason
         FROM portable_import_normalized_asset_publications
        WHERE operation_id=$1 AND owner_user_id=$2
          AND publication_state='retirement_pending'
        ORDER BY asset_ordinal
        FOR UPDATE`,
      [operationRow.id, ownerUserId],
    );
    if (mappings.rows.length === 0) return Object.freeze({ retired: 0, pending: 0 });
    const authorized = (reason: PrivatePortableNormalizedRetirementReason): boolean => {
      if (reason === "duplicate") {
        return operationRow.status === "committed"
          && operationRow.result_projection?.duplicate === true
          && operationRow.completed_import
          && ["running", "recoverable", "completed"].includes(workRow.status);
      }
      if (reason === "abandoned") {
        return (operationRow.status === "failed" && workRow.status === "aborted")
          || (operationRow.status === "expired" && workRow.status === "expired");
      }
      return operationRow.import_kind === "legacy_story"
        && ((["previewed", "consuming"].includes(operationRow.status)
          && ["running", "recoverable"].includes(workRow.status))
          || (operationRow.status === "committed"
            && operationRow.completed_import
            && ["running", "recoverable", "completed"].includes(workRow.status)));
    };
    if (mappings.rows.some((mapping) => !authorized(mapping.retirement_reason))) {
      throw stableError("portable_normalized_publication_retirement_unavailable");
    }

    let retired = 0;
    let pending = 0;
    for (const mapping of mappings.rows) {
      if (mapping.request_id === null) {
        const completed = await database.query(
          `UPDATE portable_import_normalized_asset_publications
              SET publication_state='retired',retired_at=clock_timestamp()
            WHERE operation_id=$1 AND owner_user_id=$2 AND asset_ordinal=$3
              AND publication_state='retirement_pending' AND request_id IS NULL`,
          [operationRow.id, ownerUserId, mapping.asset_ordinal],
        );
        if (completed.rowCount === 1) retired += 1;
        else pending += 1;
        continue;
      }
      const selectedRequest = await database.query<{
        lifecycle: string;
        canonical_asset_id: string | null;
      }>(
        `SELECT lifecycle,canonical_asset_id
           FROM asset_publication_requests
          WHERE id=$1 AND owner_user_id=$2
          FOR UPDATE`,
        [mapping.request_id, ownerUserId],
      );
      const request = selectedRequest.rows[0];
      if (!request || !["prepared", "failed"].includes(request.lifecycle)) {
        pending += 1;
        continue;
      }
      if (request.canonical_asset_id !== null) {
        const selectedIdentity = await database.query<{ lifecycle: string }>(
          `SELECT lifecycle
             FROM asset_publication_identities
            WHERE asset_id=$1 AND owner_user_id=$2
            FOR UPDATE`,
          [request.canonical_asset_id, ownerUserId],
        );
        const identity = selectedIdentity.rows[0];
        if (!identity || !["prepared", "cleanup_pending", "published"].includes(identity.lifecycle)) {
          pending += 1;
          continue;
        }
        if (identity.lifecycle !== "published") {
          const operations = await database.query<{ lifecycle: string }>(
            `SELECT lifecycle
               FROM durable_filesystem_operations
              WHERE asset_id=$1 AND owner_user_id=$2
              ORDER BY id
              FOR UPDATE`,
            [request.canonical_asset_id, ownerUserId],
          );
          if (operations.rows.some((filesystemOperation) => filesystemOperation.lifecycle !== "cleaned")) {
            pending += 1;
            continue;
          }
          if (identity.lifecycle === "prepared") {
            const retiredIdentity = await database.query(
              `UPDATE asset_publication_identities
                  SET lifecycle='cleanup_pending',updated_at=clock_timestamp()
                WHERE asset_id=$1 AND owner_user_id=$2 AND lifecycle='prepared'`,
              [request.canonical_asset_id, ownerUserId],
            );
            if (retiredIdentity.rowCount !== 1) {
              pending += 1;
              continue;
            }
          }
        }
      }
      if (request.lifecycle === "prepared") {
        const retiredRequest = await database.query(
          `UPDATE asset_publication_requests
              SET lifecycle='failed',updated_at=clock_timestamp()
            WHERE id=$1 AND owner_user_id=$2 AND lifecycle='prepared'`,
          [mapping.request_id, ownerUserId],
        );
        if (retiredRequest.rowCount !== 1) {
          pending += 1;
          continue;
        }
      }
      const completed = await database.query(
        `UPDATE portable_import_normalized_asset_publications
            SET publication_state='retired',retired_at=clock_timestamp()
          WHERE operation_id=$1 AND owner_user_id=$2 AND asset_ordinal=$3
            AND publication_state='retirement_pending'`,
        [operationRow.id, ownerUserId, mapping.asset_ordinal],
      );
      if (completed.rowCount === 1) retired += 1;
      else pending += 1;
    }
    return Object.freeze({ retired, pending });
  };

  const beginRetirementWithDatabase = async (
    database: DatabaseClient,
    input: Readonly<{
      operationId: string;
      ownerUserId: string;
      reason: PrivatePortableNormalizedRetirementReason;
      scope?: PrivatePortableNormalizedPublicationScope;
    }>,
  ): Promise<void> => {
    const selectedOperation = await database.query<{
      import_kind: "campaign_zip" | "legacy_story";
      authority_fingerprint: string;
      idempotency_key_hash: string | null;
      status: string;
      result_projection: Readonly<{ duplicate?: unknown }> | null;
      completed_import: boolean;
    }>(
      `SELECT operation.import_kind,operation.authority_fingerprint,
              operation.idempotency_key_hash,operation.status,operation.result_projection,
              EXISTS (
                SELECT 1 FROM imports imported
                 WHERE imported.id=operation.import_id
                   AND imported.owner_user_id=operation.owner_user_id
                   AND imported.source_hash=operation.authority_fingerprint
                   AND imported.status='completed'
              ) AS completed_import
         FROM portable_import_operations operation
        WHERE operation.id=$1 AND operation.owner_user_id=$2
        FOR UPDATE OF operation`,
      [input.operationId, input.ownerUserId],
    );
    const operation = selectedOperation.rows[0];
    if (!operation || (input.scope
      && (operation.import_kind !== input.scope.importKind
        || operation.authority_fingerprint !== input.scope.authorityFingerprint
        || (input.reason === "duplicate"
          && operation.idempotency_key_hash !== input.scope.commitIdempotencyKeyHash)))) {
      throw stableError("portable_normalized_publication_retirement_unavailable");
    }
    const selectedWork = await database.query<{ status: string }>(
      `SELECT status FROM portable_import_work
        WHERE operation_id=$1 AND owner_user_id=$2
        FOR UPDATE`,
      [input.operationId, input.ownerUserId],
    );
    const work = selectedWork.rows[0];
    const authorized = input.reason === "duplicate"
      ? operation.status === "committed"
        && operation.result_projection?.duplicate === true
        && operation.completed_import
        && ["running", "recoverable", "completed"].includes(work?.status ?? "")
      : input.reason === "abandoned"
        ? (operation.status === "failed" && work?.status === "aborted")
          || (operation.status === "expired" && work?.status === "expired")
        : operation.import_kind === "legacy_story"
          && operation.status === "previewed"
          && ["running", "recoverable"].includes(work?.status ?? "");
    if (!authorized) {
      throw stableError("portable_normalized_publication_retirement_unavailable");
    }

    const selected = await database.query<{
      asset_ordinal: number;
      publication_state: string;
      retirement_reason: string | null;
      import_kind: string;
      authority_fingerprint: string;
      commit_idempotency_key_hash: string;
    }>(
      `SELECT asset_ordinal,publication_state,retirement_reason,import_kind,
              authority_fingerprint,commit_idempotency_key_hash
         FROM portable_import_normalized_asset_publications
        WHERE operation_id=$1 AND owner_user_id=$2
        ORDER BY asset_ordinal
        FOR UPDATE`,
      [input.operationId, input.ownerUserId],
    );
    const initialStates = input.reason === "duplicate"
      ? ["reserved", "retirement_pending", "retired"]
      : ["reservation_intent", "reserved", "retirement_pending", "retired"];
    if (selected.rows.some((row) => !initialStates.includes(row.publication_state)
      || row.import_kind !== operation.import_kind
      || row.authority_fingerprint !== operation.authority_fingerprint
      || (input.scope
        && row.commit_idempotency_key_hash !== input.scope.commitIdempotencyKeyHash)
      || (["retirement_pending", "retired"].includes(row.publication_state)
        && row.retirement_reason !== input.reason))) {
      throw stableError("portable_normalized_publication_retirement_unavailable");
    }

    if (input.reason !== "duplicate") {
      await database.query(
        `UPDATE portable_import_normalized_asset_publications mapping
            SET request_id=request.id,publication_state='retirement_pending',
                retirement_reason=$3,retirement_requested_at=clock_timestamp()
           FROM asset_publication_requests request
          WHERE mapping.operation_id=$1 AND mapping.owner_user_id=$2
            AND mapping.publication_state='reservation_intent'
            AND request.owner_user_id=mapping.owner_user_id
            AND request.request_fingerprint=mapping.request_fingerprint
            AND request.idempotency_key_hash=mapping.request_idempotency_key_hash
            AND request.provenance_snapshot->>'kind'='import'
            AND request.provenance_snapshot->>'importKind'=mapping.import_kind
            AND request.provenance_snapshot->>'importOperationId'=mapping.operation_id::text`,
        [input.operationId, input.ownerUserId, input.reason],
      );
      await database.query(
        `UPDATE portable_import_normalized_asset_publications
            SET publication_state='retirement_pending',retirement_reason=$3,
                retirement_requested_at=clock_timestamp()
          WHERE operation_id=$1 AND owner_user_id=$2
            AND publication_state='reservation_intent'`,
        [input.operationId, input.ownerUserId, input.reason],
      );
    }
    await database.query(
      `UPDATE portable_import_normalized_asset_publications
          SET publication_state='retirement_pending',retirement_reason=$3,
              retirement_requested_at=clock_timestamp()
        WHERE operation_id=$1 AND owner_user_id=$2
          AND publication_state='reserved'`,
      [input.operationId, input.ownerUserId, input.reason],
    );
    const exact = await database.query<{ publication_state: string; retirement_reason: string | null }>(
      `SELECT publication_state,retirement_reason
         FROM portable_import_normalized_asset_publications
        WHERE operation_id=$1 AND owner_user_id=$2
        ORDER BY asset_ordinal
        FOR UPDATE`,
      [input.operationId, input.ownerUserId],
    );
    if (exact.rows.length !== selected.rows.length || exact.rows.some((row) => (
      !["retirement_pending", "retired"].includes(row.publication_state)
      || row.retirement_reason !== input.reason
    ))) {
      throw stableError("portable_normalized_publication_retirement_unavailable");
    }
  };

  return Object.freeze({
    async recordReservationIntents(scope, intents) {
      validateScope(scope);
      const requests = validateRequests(scope, intents);
      if (requests.length === 0) return;
      await withTransaction(pool, async (database) => {
        await lockOperation(database, scope, "previewed");
        await recordReservationIntentsWithDatabase(database, scope, requests);
      });
    },

    async bindReservedRequests(scope, intents) {
      validateScope(scope);
      const requests = validateRequests(scope, intents);
      if (requests.length === 0) return;
      await withTransaction(pool, async (database) => {
        await lockOperation(database, scope, "previewed");
        await bindReservedRequestsWithDatabase(database, scope, requests);
      });
    },

    async recordAndBindReservedRequests(scope, intents, reserve) {
      validateScope(scope);
      const requests = validateRequests(scope, intents);
      if (requests.length === 0) return;
      return withTransaction(pool, async (database) => {
        await lockOperation(database, scope, "previewed");
        // Prewrite, generic request reservation, and exact request binding are
        // one DB transaction. Physical e2 work starts only after this commits.
        await recordReservationIntentsWithDatabase(database, scope, requests);
        await reserve(database, requests);
        await bindReservedRequestsWithDatabase(database, scope, requests);
      });
    },

    async recordAttachedInTransaction(databaseValue, scope, importId, publications) {
      validateScope(scope);
      if (!UUID_PATTERN.test(importId)
        || publications.length > MAXIMUM_PORTABLE_PUBLICATION_BATCH
        || publications.some((publication, assetOrdinal) => publication.assetOrdinal !== assetOrdinal)) {
        throw stableError("portable_normalized_publication_attachment_invalid");
      }
      const database = databaseClient(databaseValue);
      await lockOperation(database, scope, "consuming");
      for (const publication of publications) {
        const updated = await database.query(
          `UPDATE portable_import_normalized_asset_publications
              SET import_id=$4,finalization_locator=$5,safe_result=$6::jsonb,
                  publication_state='committed_finalization_pending'
            WHERE operation_id=$1 AND owner_user_id=$2 AND asset_ordinal=$3
              AND publication_state='reserved'`,
          [
            scope.operationId,
            scope.ownerUserId,
            publication.assetOrdinal,
            importId,
            publication.finalization,
            JSON.stringify(publication.result)
          ],
        );
        if (updated.rowCount !== 1) {
          throw stableError("portable_normalized_publication_attachment_unavailable");
        }
      }
    },

    async beginRetirementInTransaction(databaseValue, scope, reason) {
      validateScope(scope);
      if (reason !== "duplicate") {
        throw stableError("portable_normalized_publication_retirement_invalid");
      }
      const database = databaseClient(databaseValue);
      await beginRetirementWithDatabase(database, {
        operationId: scope.operationId,
        ownerUserId: scope.ownerUserId,
        reason,
        scope
      });
    },

    async beginOptionalOmission(scope, intents) {
      validateScope(scope);
      if (scope.importKind !== "legacy_story") {
        throw stableError("portable_normalized_publication_retirement_invalid");
      }
      const requests = validateRequests(scope, intents);
      await withTransaction(pool, async (database) => {
        await lockOperation(database, scope, "previewed");
        // A fresh Legacy process may be unable to reconstruct requests after
        // an earlier exact prewrite. Non-empty first-attempt requests still
        // receive the full exact replay comparison; an empty recovery input
        // can only retire rows authorized by the locked operation scope below.
        if (requests.length > 0) {
          await recordReservationIntentsWithDatabase(database, scope, requests);
        }
        await beginRetirementWithDatabase(database, {
          operationId: scope.operationId,
          ownerUserId: scope.ownerUserId,
          reason: "optional_unavailable",
          scope
        });
        await reconcileRetirementsWithDatabase(
          database,
          scope.ownerUserId,
          "operation.id=$2",
          scope.operationId,
        );
      });
    },

    async retireAbandonedOperationInTransaction(databaseValue, input) {
      if (!UUID_PATTERN.test(input.operationId) || !UUID_PATTERN.test(input.ownerUserId)) {
        throw stableError("portable_normalized_publication_scope_invalid");
      }
      const database = databaseClient(databaseValue);
      await beginRetirementWithDatabase(database, {
        operationId: input.operationId,
        ownerUserId: input.ownerUserId,
        reason: "abandoned"
      });
      await reconcileRetirementsWithDatabase(
        database,
        input.ownerUserId,
        "operation.id=$2",
        input.operationId,
      );
    },

    async reconcileRetirements(ownerUserId, operationId) {
      if (!UUID_PATTERN.test(ownerUserId) || !UUID_PATTERN.test(operationId)) {
        throw stableError("portable_normalized_publication_scope_invalid");
      }
      return withTransaction(pool, (database) => reconcileRetirementsWithDatabase(
        database,
        ownerUserId,
        "operation.id=$2",
        operationId,
      ));
    },

    async reconcileCommittedRetirements(ownerUserId, previewToken) {
      if (!UUID_PATTERN.test(ownerUserId) || !previewToken) {
        throw stableError("portable_normalized_publication_scope_invalid");
      }
      return withTransaction(pool, (database) => reconcileRetirementsWithDatabase(
        database,
        ownerUserId,
        "operation.preview_token_hash=$2",
        sha256(previewToken),
      ));
    },

    loadFinalizations(ownerUserId, operationId) {
      if (!UUID_PATTERN.test(ownerUserId) || !UUID_PATTERN.test(operationId)) {
        throw stableError("portable_normalized_publication_scope_invalid");
      }
      return loadRows(
        "mapping.owner_user_id=$1 AND mapping.operation_id=$2",
        [ownerUserId, operationId],
      );
    },

    loadCommittedFinalizations(ownerUserId, previewToken) {
      if (!UUID_PATTERN.test(ownerUserId) || !previewToken) {
        throw stableError("portable_normalized_publication_scope_invalid");
      }
      return loadRows(
        "mapping.owner_user_id=$1 AND operation.preview_token_hash=$2",
        [ownerUserId, sha256(previewToken)],
      );
    },

    async recordFinalizationRecoverable(input) {
      await pool.query(
        `UPDATE portable_import_normalized_asset_publications
            SET finalization_attempts=finalization_attempts+1,
                last_diagnostic='asset_publication_finalization_recoverable',
                last_attempt_at=clock_timestamp()
          WHERE operation_id=$1 AND owner_user_id=$2 AND asset_ordinal=$3
            AND publication_state='committed_finalization_pending'
            AND finalization_locator=$4 AND safe_result=$5::jsonb`,
        [
          input.operationId,
          input.ownerUserId,
          input.assetOrdinal,
          input.finalization,
          JSON.stringify(input.result)
        ],
      );
    },

    async markFinalizationPublished(input) {
      const updated = await pool.query(
        `UPDATE portable_import_normalized_asset_publications
            SET publication_state='published',finalization_attempts=finalization_attempts+1,
                last_diagnostic=NULL,last_attempt_at=clock_timestamp(),published_at=clock_timestamp()
          WHERE operation_id=$1 AND owner_user_id=$2 AND asset_ordinal=$3
            AND publication_state='committed_finalization_pending'
            AND finalization_locator=$4 AND safe_result=$5::jsonb`,
        [
          input.operationId,
          input.ownerUserId,
          input.assetOrdinal,
          input.finalization,
          JSON.stringify(input.result)
        ],
      );
      if (updated.rowCount === 1) return;
      const replay = await pool.query(
        `SELECT 1 FROM portable_import_normalized_asset_publications
          WHERE operation_id=$1 AND owner_user_id=$2 AND asset_ordinal=$3
            AND publication_state='published'
            AND finalization_locator=$4 AND safe_result=$5::jsonb`,
        [
          input.operationId,
          input.ownerUserId,
          input.assetOrdinal,
          input.finalization,
          JSON.stringify(input.result)
        ],
      );
      if (replay.rowCount !== 1) {
        throw stableError("portable_normalized_publication_finalization_unavailable");
      }
    }
  });
}
