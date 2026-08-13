import type { PrivateNormalizedAssetFinalizationHandle } from "../../application/src/assets/private-normalized-asset-publication.js";
import { withTransaction, type DatabaseClient, type DatabasePool } from "./pool.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;

export type PrivateFilesystemRecoveryReconciliationTargets = Readonly<{
  normalizedFinalizations: readonly PrivateNormalizedAssetFinalizationHandle[];
  portableFinalizationOperations: readonly string[];
  portableRetirementOperations: readonly string[];
}>;

function requireScope(input: Readonly<{ operationId: string; ownerUserId: string }>): void {
  if (!UUID_PATTERN.test(input.operationId) || !UUID_PATTERN.test(input.ownerUserId)) {
    throw new Error("filesystem_recovery_reconciliation_scope_invalid");
  }
}

function finalizationHandle(row: Readonly<{ request_fingerprint: string; idempotency_key_hash: string }>): PrivateNormalizedAssetFinalizationHandle {
  if (!HASH_PATTERN.test(row.request_fingerprint) || !HASH_PATTERN.test(row.idempotency_key_hash)) {
    throw new Error("filesystem_recovery_reconciliation_authority_invalid");
  }
  return `narp1.${row.request_fingerprint}.${row.idempotency_key_hash}` as PrivateNormalizedAssetFinalizationHandle;
}

/**
 * Resolves only safe opaque reconciler locators from one terminal asset
 * operation. Lock order is operation -> normalized request -> e4 mapping;
 * callers never submit a request, import operation, owner, or filesystem path.
 */
export function createPostgresFilesystemRecoveryReconciliationRepository(pool: DatabasePool): Readonly<{
  targets(input: Readonly<{ operationId: string; ownerUserId: string }>): Promise<PrivateFilesystemRecoveryReconciliationTargets>;
}> {
  return Object.freeze({
    async targets(input) {
      requireScope(input);
      return withTransaction(pool, async (database: DatabaseClient) => {
        const operation = await database.query<Readonly<{
          asset_id: string | null;
          lifecycle: "finalized" | "cleaned";
        }>>(
          `SELECT asset_id,lifecycle FROM durable_filesystem_operations
            WHERE id=$1 AND owner_user_id=$2 AND resource_kind='asset'
              AND lifecycle IN ('finalized','cleaned')
            FOR UPDATE`,
          [input.operationId, input.ownerUserId],
        );
        const terminalOperation = operation.rows[0];
        const assetId = terminalOperation?.asset_id;
        if (!assetId || !terminalOperation) return Object.freeze({
          normalizedFinalizations: Object.freeze([]),
          portableFinalizationOperations: Object.freeze([]),
          portableRetirementOperations: Object.freeze([]),
        });
        const requests = await database.query<Readonly<{
          id: string;
          request_fingerprint: string;
          idempotency_key_hash: string;
          lifecycle: "attached" | "failed" | "prepared";
        }>>(
          `SELECT request.id,request.request_fingerprint,request.idempotency_key_hash,request.lifecycle
             FROM asset_publication_requests request
            WHERE request.owner_user_id=$1 AND request.canonical_asset_id=$2
              AND request.lifecycle IN ('attached','failed','prepared')
            ORDER BY request.id
            FOR UPDATE`,
          [input.ownerUserId, assetId],
        );
        const requestIds = requests.rows.map((request) => request.id);
        if (requestIds.length === 0) return Object.freeze({
          normalizedFinalizations: Object.freeze(requests.rows.map(finalizationHandle)),
          portableFinalizationOperations: Object.freeze([]),
          portableRetirementOperations: Object.freeze([]),
        });
        const mappings = await database.query<Readonly<{
          operation_id: string;
          request_id: string;
          publication_state: "committed_finalization_pending" | "retirement_pending";
        }>>(
          `SELECT mapping.operation_id,mapping.request_id,mapping.publication_state
             FROM portable_import_normalized_asset_publications mapping
            WHERE mapping.owner_user_id=$1 AND mapping.request_id=ANY($2::uuid[])
              AND mapping.publication_state IN ('committed_finalization_pending','retirement_pending')
            ORDER BY mapping.operation_id
            FOR UPDATE`,
          [input.ownerUserId, requestIds],
        );
        const attachedRequestIds = terminalOperation.lifecycle === "finalized"
          ? new Set(requests.rows
          .filter((request) => request.lifecycle === "attached")
          .map((request) => request.id))
          : new Set<string>();
        const mappedFinalizations = new Set(
          mappings.rows.filter((mapping) => mapping.publication_state === "committed_finalization_pending"
            && attachedRequestIds.has(mapping.request_id))
            .map((mapping) => mapping.operation_id),
        );
        const mappedRetirements = new Set(
          mappings.rows.filter((mapping) => mapping.publication_state === "retirement_pending")
            .map((mapping) => mapping.operation_id),
        );
        const mappedRequestIds = new Set(mappings.rows
          .filter((mapping) => mapping.publication_state === "committed_finalization_pending")
          .map((mapping) => mapping.request_id));
        return Object.freeze({
          // A mapped request is reconciled by the e4 owner as a batch so its
          // import mapping cannot become published ahead of a sibling.
          normalizedFinalizations: Object.freeze(requests.rows
            .filter((request) => terminalOperation.lifecycle === "finalized"
              && request.lifecycle === "attached" && !mappedRequestIds.has(request.id))
            .map(finalizationHandle)),
          portableFinalizationOperations: Object.freeze([...mappedFinalizations]),
          portableRetirementOperations: Object.freeze([...mappedRetirements]),
        });
      });
    },
  });
}
