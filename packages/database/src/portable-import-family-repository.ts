import { createHash } from "node:crypto";
import {
  canonicalPortableImportAuthority,
  safePortableImportProgress,
  type PortableCanonicalImportAuthority,
  type PortableImportProgressPhase,
  type PortableImportProgressView,
  type PrivatePortableImportAuthorityPort,
  type PrivatePortableImportProgressRecord,
  type PrivatePortableImportWorkClaim
} from "../../application/src/imports/private-portable-composition.js";
import type {
  PrivatePortableFamilyMutationPort,
  PrivatePortableFamilyMutationResult,
  PortableJsonValue
} from "../../application/src/imports/private-portable-composition.js";
import type { WorldRepositoryPort } from "../../application/src/world-campaign/ports.js";
import { legacyStorySchema, worldImportRequestSchema } from "../../contracts/src/index.js";
import type {
  ImportOwnerScope,
  PortableArchiveDiagnosticCode,
  PortableImportCommitCommand,
  PortableImportCommitView,
  PortableImportKind,
  PortableImportPreviewCommand,
  PortableImportPreviewView,
  PortablePreviewDestination
} from "../../application/src/imports/types.js";
import {
  type CompletePortableImportRequest,
  type PortableImportCommitClaim,
  type PortableImportCommitRepositoryCommand,
  type PostgresPortableImportRepository
} from "./import-repository.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";
import { withTransaction } from "./pool.js";
import { runPostgresWorldCampaignCommandWithClient } from "./world-campaign-transaction.js";

type WorkRow = Readonly<{
  operation_id: string;
  owner_user_id: string;
  phase: PortableImportProgressPhase;
  percentage: number;
  diagnostic_code: PortableArchiveDiagnosticCode | null;
  work_version: number;
  status: PrivatePortableImportProgressRecord["status"];
  lease_id: string | null;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  expires_at: Date;
  updated_at: Date;
}>;

type AuthorityRow = Readonly<{
  normalized_payload: unknown;
  authority_fingerprint: string | null;
  provider_configuration_fingerprint: string | null;
  selected_character_id: string | null;
  source_installation_id: string | null;
  source_record_id: string | null;
}>;

function destinationParameters(destination: PortablePreviewDestination): readonly [string, string | null, string | null] {
  if (destination.kind === "existing_world_version") {
    return [destination.kind, destination.worldId, destination.worldVersionId];
  }
  return [destination.kind === "embedded" ? "embedded_create_world" : "create_world", null, null];
}

export type PostgresPortableImportAuthorityClaim =
  Readonly<{
    outcome: "ready";
    authority: PortableCanonicalImportAuthority;
    claim: PrivatePortableImportWorkClaim;
    commitClaim: PortableImportCommitClaim;
  }> | Readonly<{ outcome: "replay"; view: PortableImportCommitView }>;

export interface PostgresPortableImportAuthorityRepository extends PrivatePortableImportAuthorityPort {
  claimPreviewAuthority(database: DatabaseClient, input: Readonly<{
    command: PortableImportCommitCommand;
    leaseOwner: string;
    leaseSeconds: number;
  }>): Promise<PostgresPortableImportAuthorityClaim>;
  completeImport(
    database: DatabaseClient,
    claim: PortableImportCommitClaim,
    completion: CompletePortableImportRequest<PortableImportKind>,
  ): Promise<PortableImportCommitView>;
  markRecoverable(
    claim: PrivatePortableImportWorkClaim,
    diagnosticCode: PortableArchiveDiagnosticCode,
  ): Promise<PortableImportProgressView | null>;
  completeCommittedReplay(owner: ImportOwnerScope, previewToken: string): Promise<void>;
  expireDueWork(limit: number): Promise<number>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonObject(value: unknown): Readonly<Record<string, import("../../application/src/imports/private-portable-composition.js").PortableJsonValue>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("portable_import_authority_invalid");
  }
  return value as Readonly<Record<string, import("../../application/src/imports/private-portable-composition.js").PortableJsonValue>>;
}

function claimRequest(input: Readonly<{ leaseOwner: string; leaseSeconds: number }>): void {
  if (input.leaseOwner.trim().length === 0
    || input.leaseOwner.length > 512
    || !Number.isSafeInteger(input.leaseSeconds)
    || input.leaseSeconds <= 0
    || input.leaseSeconds > 300) {
    throw new Error("portable_import_claim_invalid");
  }
}

function workRecord(row: WorkRow): PrivatePortableImportProgressRecord {
  return {
    operationId: row.operation_id,
    ownerUserId: row.owner_user_id,
    phase: row.phase,
    percentage: row.percentage,
    diagnosticCode: row.diagnostic_code,
    workVersion: row.work_version,
    status: row.status,
    leaseOwner: row.lease_owner,
    leaseId: row.lease_id,
    leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString()
  };
}

function workClaim(row: WorkRow): PrivatePortableImportWorkClaim {
  if (!row.lease_id || !row.lease_owner || !row.lease_expires_at) {
    throw new Error("portable_import_claim_unavailable");
  }
  return Object.freeze({
    operationId: row.operation_id,
    ownerUserId: row.owner_user_id,
    workVersion: row.work_version,
    leaseId: row.lease_id,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at.toISOString()
  });
}

const WORK_COLUMNS = `operation_id,owner_user_id,phase,percentage,diagnostic_code,
  work_version,status,lease_id,lease_owner,lease_expires_at,expires_at,updated_at`;
const JOINED_WORK_COLUMNS = `work.operation_id,work.owner_user_id,work.phase,work.percentage,
  work.diagnostic_code,work.work_version,work.status,work.lease_id,work.lease_owner,
  work.lease_expires_at,work.expires_at,work.updated_at`;

function exactClaimParameters(claim: PrivatePortableImportWorkClaim): readonly unknown[] {
  return [
    claim.operationId,
    claim.ownerUserId,
    claim.workVersion,
    claim.leaseId,
    claim.leaseOwner,
    claim.leaseExpiresAt
  ];
}

async function progressByPreview(
  client: DatabaseClient,
  owner: ImportOwnerScope,
  previewToken: string,
  lock: boolean,
): Promise<WorkRow | null> {
  const selected = await client.query<WorkRow>(
    `SELECT ${JOINED_WORK_COLUMNS}
       FROM portable_import_work work
       JOIN portable_import_operations operation
         ON operation.id=work.operation_id AND operation.owner_user_id=work.owner_user_id
      WHERE work.owner_user_id=$1 AND operation.preview_token_hash=$2
      ${lock ? "FOR UPDATE OF work,operation" : ""}`,
    [owner.ownerUserId, sha256(previewToken)]
  );
  return selected.rows[0] ?? null;
}

export function createPostgresPortableImportAuthorityRepository(
  pool: DatabasePool,
  portable: PostgresPortableImportRepository,
): PostgresPortableImportAuthorityRepository {
  const readPreviewAuthority = async (input: Readonly<{
    command: PortableImportCommitCommand;
  }>): Promise<Readonly<{
    authority: PortableCanonicalImportAuthority;
    authorityFingerprint: string;
  }> | null> => {
    const destination = destinationParameters(input.command.destination);
    const selected = await pool.query<AuthorityRow>(
      `SELECT normalized_payload,authority_fingerprint,provider_configuration_fingerprint,
              selected_character_id,source_installation_id,source_record_id
         FROM portable_import_operations
        WHERE owner_user_id=$1 AND import_kind=$2 AND preview_token_hash=$3
          AND destination_kind=$4
          AND destination_world_id IS NOT DISTINCT FROM $5::uuid
          AND destination_world_version_id IS NOT DISTINCT FROM $6::uuid
          AND status='previewed' AND expires_at > clock_timestamp()`,
      [
        input.command.ownerUserId,
        input.command.kind,
        sha256(input.command.previewHandle.token),
        ...destination
      ]
    );
    const row = selected.rows[0];
    if (!row?.authority_fingerprint || row.normalized_payload === null) return null;
    const authority: PortableCanonicalImportAuthority = {
      kind: input.command.kind,
      destination: input.command.destination,
      normalizedPayload: jsonObject(row.normalized_payload),
      sourceInstallationId: row.source_installation_id,
      sourceRecordId: row.source_record_id,
      selectedCharacterId: row.selected_character_id,
      providerConfigurationFingerprint: row.provider_configuration_fingerprint
    };
    if (sha256(canonicalPortableImportAuthority(authority)) !== row.authority_fingerprint) {
      throw new Error("portable_import_authority_mismatch");
    }
    return Object.freeze({ authority, authorityFingerprint: row.authority_fingerprint });
  };
  const persistPreviewAuthority = async <Command extends PortableImportPreviewCommand>(input: Readonly<{
    command: Command;
    authority: PortableCanonicalImportAuthority;
    authorityFingerprint: string;
    projection: PortableImportPreviewView<Command>["projection"];
    diagnostics: readonly PortableArchiveDiagnosticCode[];
    expiresAt: string;
  }>): Promise<PortableImportPreviewView<Command>> => portable.createCanonicalPreview({
    command: input.command,
    authority: input.authority,
    authorityFingerprint: input.authorityFingerprint,
    contentFingerprint: input.authorityFingerprint,
    projection: input.projection,
    diagnostics: input.diagnostics,
    expiresAt: input.expiresAt
  });

  const claimPreviewAuthority = async (
    database: DatabaseClient,
    input: Readonly<{
      command: PortableImportCommitCommand;
      leaseOwner: string;
      leaseSeconds: number;
    }>,
  ): Promise<PostgresPortableImportAuthorityClaim> => {
    claimRequest(input);
    const begun = await portable.beginImport<PortableImportKind, PortablePreviewDestination>(
      database,
      input.command as PortableImportCommitRepositoryCommand<PortableImportKind, PortablePreviewDestination>,
    );
    if (begun.outcome === "replay") return begun;
    const selected = await database.query<AuthorityRow>(
      `SELECT normalized_payload,authority_fingerprint,provider_configuration_fingerprint,
              selected_character_id,source_installation_id,source_record_id
         FROM portable_import_operations
        WHERE id=$1 AND owner_user_id=$2 AND import_kind=$3 AND status='consuming'
        FOR UPDATE`,
      [begun.claim.operationId, begun.claim.ownerUserId, begun.claim.kind]
    );
    const row = selected.rows[0];
    if (!row || !row.authority_fingerprint) throw new Error("portable_import_authority_unavailable");
    const authority: PortableCanonicalImportAuthority = {
      kind: input.command.kind,
      destination: input.command.destination,
      normalizedPayload: jsonObject(row.normalized_payload),
      sourceInstallationId: row.source_installation_id,
      sourceRecordId: row.source_record_id,
      selectedCharacterId: row.selected_character_id,
      providerConfigurationFingerprint: row.provider_configuration_fingerprint
    };
    if (sha256(canonicalPortableImportAuthority(authority)) !== row.authority_fingerprint) {
      throw new Error("portable_import_authority_mismatch");
    }
    const claimed = await database.query<WorkRow>(
      `UPDATE portable_import_work
          SET phase='claiming',percentage=30,status='running',diagnostic_code=NULL,
              work_version=work_version+1,lease_id=gen_random_uuid(),lease_owner=$2,
              lease_expires_at=LEAST(expires_at,clock_timestamp()+($3::text || ' seconds')::interval),
              updated_at=clock_timestamp()
        WHERE operation_id=$1 AND owner_user_id=$4
          AND status IN ('running','recoverable') AND expires_at > clock_timestamp()
          AND (lease_id IS NULL OR lease_expires_at <= clock_timestamp())
      RETURNING ${WORK_COLUMNS}`,
      [begun.claim.operationId, input.leaseOwner, input.leaseSeconds, begun.claim.ownerUserId]
    );
    const work = claimed.rows[0];
    if (!work) throw new Error("portable_import_claim_unavailable");
    return {
      outcome: "ready",
      authority,
      claim: workClaim(work),
      commitClaim: begun.claim
    };
  };

  const updateProgress = async (
    database: DatabaseClient,
    claim: PrivatePortableImportWorkClaim,
    input: Readonly<{
      phase: PortableImportProgressPhase;
      percentage: number;
      diagnosticCode: PortableArchiveDiagnosticCode | null;
    }>,
  ): Promise<PrivatePortableImportWorkClaim> => {
    if (!Number.isInteger(input.percentage) || input.percentage < 0 || input.percentage > 99) {
      throw new Error("portable_import_progress_invalid");
    }
    const updated = await database.query<WorkRow>(
      `UPDATE portable_import_work
          SET phase=$7,percentage=$8,diagnostic_code=$9,updated_at=clock_timestamp()
        WHERE operation_id=$1 AND owner_user_id=$2 AND work_version=$3
          AND lease_id=$4 AND lease_owner=$5
          AND date_trunc('milliseconds',lease_expires_at)=$6::timestamptz
          AND status='running' AND lease_expires_at > clock_timestamp()
          AND expires_at > clock_timestamp() AND percentage <= $8
      RETURNING ${WORK_COLUMNS}`,
      [...exactClaimParameters(claim), input.phase, input.percentage, input.diagnosticCode]
    );
    const row = updated.rows[0];
    if (!row) throw new Error("portable_import_claim_lost");
    return workClaim(row);
  };

  const completeProgress = async (
    database: DatabaseClient,
    claim: PrivatePortableImportWorkClaim,
  ): Promise<void> => {
    const updated = await database.query(
      `UPDATE portable_import_work
          SET phase='completed',percentage=100,status='completed',diagnostic_code=NULL,
              lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,
              terminal_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE operation_id=$1 AND owner_user_id=$2 AND work_version=$3
          AND lease_id=$4 AND lease_owner=$5
          AND date_trunc('milliseconds',lease_expires_at)=$6::timestamptz
          AND status='running' AND lease_expires_at > clock_timestamp()`,
      [...exactClaimParameters(claim)]
    );
    if (updated.rowCount !== 1) throw new Error("portable_import_claim_lost");
  };

  const recordAssetPublications = async (
    database: DatabaseClient,
    claim: PrivatePortableImportWorkClaim,
    importId: string,
    assetIds: readonly string[],
  ): Promise<void> => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(importId)
      || assetIds.length > 1000
      || assetIds.some((assetId) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(assetId))
      || new Set(assetIds).size !== assetIds.length) {
      throw new Error("portable_import_asset_publications_invalid");
    }
    if (assetIds.length === 0) return;
    const inserted = await database.query<{ asset_id: string }>(
      `WITH exact_claim AS (
         SELECT operation_id,owner_user_id
           FROM portable_import_work
          WHERE operation_id=$1 AND owner_user_id=$2 AND work_version=$3
            AND lease_id=$4 AND lease_owner=$5
            AND date_trunc('milliseconds',lease_expires_at)=$6::timestamptz
            AND status='running' AND lease_expires_at > clock_timestamp()
       )
       INSERT INTO portable_import_asset_publications (
         operation_id,owner_user_id,import_id,asset_id
       )
       SELECT exact_claim.operation_id,exact_claim.owner_user_id,$7,asset_id
         FROM exact_claim CROSS JOIN unnest($8::uuid[]) AS asset(asset_id)
       RETURNING asset_id`,
      [...exactClaimParameters(claim), importId, assetIds],
    );
    if (inserted.rows.length !== assetIds.length) {
      throw new Error("portable_import_asset_publications_unavailable");
    }
  };

  const readCommittedAssetPublicationIds = async (
    owner: ImportOwnerScope,
    previewToken: string,
  ): Promise<readonly string[]> => {
    const selected = await pool.query<{ asset_ids: string[] }>(
      `SELECT COALESCE(
                array_agg(publication.asset_id ORDER BY publication.asset_id)
                  FILTER (WHERE publication.asset_id IS NOT NULL),
                '{}'::uuid[]
              ) AS asset_ids
         FROM portable_import_operations operation
         LEFT JOIN portable_import_asset_publications publication
           ON publication.operation_id=operation.id
          AND publication.owner_user_id=operation.owner_user_id
          AND publication.import_id=operation.import_id
        WHERE operation.owner_user_id=$1 AND operation.preview_token_hash=$2
          AND operation.status='committed'
        GROUP BY operation.id`,
      [owner.ownerUserId, sha256(previewToken)],
    );
    const row = selected.rows[0];
    if (!row) throw new Error("portable_import_replay_unavailable");
    return Object.freeze(row.asset_ids);
  };

  const expireOrRead = async (owner: ImportOwnerScope, previewToken: string): Promise<PortableImportProgressView | null> => (
    withTransaction(pool, async (database) => {
      let row = await progressByPreview(database, owner, previewToken, true);
      if (!row) return null;
      if (["running", "recoverable"].includes(row.status) && row.expires_at.getTime() <= Date.now()) {
        const expired = await database.query<WorkRow>(
          `UPDATE portable_import_work
              SET status='expired',diagnostic_code='archive_expired',
                  lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,
                  terminal_at=clock_timestamp(),updated_at=clock_timestamp()
            WHERE operation_id=$1 AND owner_user_id=$2 AND status IN ('running','recoverable')
          RETURNING ${WORK_COLUMNS}`,
          [row.operation_id, row.owner_user_id]
        );
        row = expired.rows[0] ?? row;
      }
      return safePortableImportProgress(workRecord(row));
    })
  );

  const abort = async (owner: ImportOwnerScope, previewToken: string): Promise<PortableImportProgressView | null> => (
    withTransaction(pool, async (database) => {
      const row = await progressByPreview(database, owner, previewToken, true);
      if (!row) return null;
      if (["aborted", "completed", "expired"].includes(row.status)) {
        return safePortableImportProgress(workRecord(row));
      }
      const operation = await database.query<{ status: string; staged_input_id: string }>(
        `SELECT status,staged_input_id FROM portable_import_operations
          WHERE id=$1 AND owner_user_id=$2 FOR UPDATE`,
        [row.operation_id, row.owner_user_id]
      );
      const current = operation.rows[0];
      if (!current) return null;
      if (current.status === "committed") return safePortableImportProgress(workRecord(row));
      if (current.status !== "previewed") throw new Error("portable_import_abort_conflict");
      await database.query(
        `UPDATE portable_import_operations SET status='failed',updated_at=clock_timestamp()
          WHERE id=$1 AND owner_user_id=$2 AND status='previewed'`,
        [row.operation_id, row.owner_user_id]
      );
      await database.query(
        `UPDATE portable_staged_inputs SET status='failed',updated_at=clock_timestamp()
          WHERE id=$1 AND owner_user_id=$2 AND status='staged'`,
        [current.staged_input_id, row.owner_user_id]
      );
      const aborted = await database.query<WorkRow>(
        `UPDATE portable_import_work
            SET status='aborted',diagnostic_code=NULL,
                lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,
                terminal_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE operation_id=$1 AND owner_user_id=$2 AND status IN ('running','recoverable')
        RETURNING ${WORK_COLUMNS}`,
        [row.operation_id, row.owner_user_id]
      );
      return aborted.rows[0] ? safePortableImportProgress(workRecord(aborted.rows[0])) : null;
    })
  );

  const markRecoverable = async (
    claim: PrivatePortableImportWorkClaim,
    diagnosticCode: PortableArchiveDiagnosticCode,
  ): Promise<PortableImportProgressView | null> => withTransaction(pool, async (database) => {
    const updated = await database.query<WorkRow>(
      `UPDATE portable_import_work
          SET status='recoverable',diagnostic_code=$7,
              lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
        WHERE operation_id=$1 AND owner_user_id=$2 AND work_version=$3
          AND lease_id=$4 AND lease_owner=$5
          AND date_trunc('milliseconds',lease_expires_at)=$6::timestamptz
          AND status='running'
      RETURNING ${WORK_COLUMNS}`,
      [...exactClaimParameters(claim), diagnosticCode]
    );
    return updated.rows[0] ? safePortableImportProgress(workRecord(updated.rows[0])) : null;
  });

  const completeCommittedReplay = async (
    owner: ImportOwnerScope,
    previewToken: string,
  ): Promise<void> => withTransaction(pool, async (database) => {
    const selected = await database.query<WorkRow & { operation_status: string }>(
      `SELECT ${JOINED_WORK_COLUMNS},operation.status AS operation_status
         FROM portable_import_work work
         JOIN portable_import_operations operation
           ON operation.id=work.operation_id AND operation.owner_user_id=work.owner_user_id
        WHERE work.owner_user_id=$1 AND operation.preview_token_hash=$2
        FOR UPDATE OF work,operation`,
      [owner.ownerUserId, sha256(previewToken)],
    );
    const row = selected.rows[0];
    if (!row || row.operation_status !== "committed") {
      throw new Error("portable_import_replay_unavailable");
    }
    if (row.status === "completed") return;
    const completed = await database.query(
      `UPDATE portable_import_work
          SET phase='completed',percentage=100,status='completed',diagnostic_code=NULL,
              lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,
              terminal_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE operation_id=$1 AND owner_user_id=$2 AND status IN ('running','recoverable')`,
      [row.operation_id, row.owner_user_id],
    );
    if (completed.rowCount !== 1) throw new Error("portable_import_replay_unavailable");
  });

  const expireDueWork = async (limit: number): Promise<number> => {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1000) {
      throw new Error("portable_import_reap_invalid");
    }
    return withTransaction(pool, async (database) => {
      const due = await database.query<Pick<WorkRow, "operation_id" | "owner_user_id">>(
        `SELECT work.operation_id,work.owner_user_id
           FROM portable_import_work work
           JOIN portable_import_operations operation
             ON operation.id=work.operation_id AND operation.owner_user_id=work.owner_user_id
          WHERE work.status IN ('running','recoverable')
            AND work.expires_at <= clock_timestamp()
            AND operation.status='previewed'
          ORDER BY work.expires_at,work.operation_id
          FOR UPDATE OF work,operation SKIP LOCKED
          LIMIT $1`,
        [limit],
      );
      for (const row of due.rows) {
        const expiredOperation = await database.query(
          `UPDATE portable_import_operations
              SET status='expired',updated_at=clock_timestamp()
            WHERE id=$1 AND owner_user_id=$2 AND status='previewed'`,
          [row.operation_id, row.owner_user_id],
        );
        const expiredWork = await database.query(
          `UPDATE portable_import_work
              SET status='expired',diagnostic_code='archive_expired',
                  lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,
                  terminal_at=clock_timestamp(),updated_at=clock_timestamp()
            WHERE operation_id=$1 AND owner_user_id=$2 AND status IN ('running','recoverable')`,
          [row.operation_id, row.owner_user_id],
        );
        if (expiredOperation.rowCount !== 1 || expiredWork.rowCount !== 1) {
          throw new Error("portable_import_reap_conflict");
        }
      }
      return due.rows.length;
    });
  };

  return Object.freeze({
    readPreviewAuthority,
    persistPreviewAuthority,
    claimPreviewAuthority,
    updateProgress,
    recordAssetPublications,
    readCommittedAssetPublicationIds,
    completeProgress,
    readProgress: expireOrRead,
    abort,
    completeImport(
      database: DatabaseClient,
      claim: PortableImportCommitClaim,
      completion: CompletePortableImportRequest<PortableImportKind>,
    ) {
      return portable.completeImport<PortableImportKind>(database, claim, completion);
    },
    markRecoverable,
    completeCommittedReplay,
    expireDueWork
  });
}

function portableRecord(value: PortableJsonValue | undefined): Readonly<Record<string, PortableJsonValue>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("portable_import_payload_invalid");
  }
  return value as Readonly<Record<string, PortableJsonValue>>;
}

function portableString(value: PortableJsonValue | undefined, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function portableDatabaseClient(context: object): DatabaseClient {
  if (!("query" in context) || typeof (context as { query?: unknown }).query !== "function") {
    throw new Error("portable_import_transaction_invalid");
  }
  return context as DatabaseClient;
}

function narration(turn: Readonly<Record<string, unknown>>): string {
  for (const key of ["narration", "story", "text"] as const) {
    if (typeof turn[key] === "string" && turn[key].trim()) return turn[key].trim();
  }
  return "Imported story turn.";
}

async function existingImportResult(
  database: DatabaseClient,
  ownerUserId: string,
  sourceHash: string,
): Promise<Readonly<{ id: string; world_id: string; world_version_id: string; campaign_id: string; stats: Record<string, unknown> }> | null> {
  const selected = await database.query<Readonly<{
    id: string;
    world_id: string;
    world_version_id: string;
    campaign_id: string;
    stats: Record<string, unknown>;
  }>>(
    `SELECT id,world_id,world_version_id,campaign_id,stats
       FROM imports
      WHERE owner_user_id=$1 AND source_hash=$2 AND status='completed'
        AND world_id IS NOT NULL AND world_version_id IS NOT NULL AND campaign_id IS NOT NULL
      FOR KEY SHARE`,
    [ownerUserId, sourceHash]
  );
  return selected.rows[0] ?? null;
}

function existingMutationResult(
  value: NonNullable<Awaited<ReturnType<typeof existingImportResult>>>,
  kind: "campaign_zip" | "legacy_story" | "story_text",
): PrivatePortableFamilyMutationResult {
  return {
    importId: value.id,
    importedRecordId: value.id,
    worldId: value.world_id,
    worldVersionId: value.world_version_id,
    campaignId: value.campaign_id,
    duplicate: true,
    result: {
      ...(kind === "story_text" ? { kind: "campaign" } : {}),
      importId: value.id,
      worldId: value.world_id,
      worldVersionId: value.world_version_id,
      campaignId: value.campaign_id,
      duplicate: true,
      stats: value.stats as Readonly<Record<string, PortableJsonValue>>
    }
  };
}

async function commitPortableCampaign(
  database: DatabaseClient,
  input: Parameters<PrivatePortableFamilyMutationPort["commitLegacyStory"]>[1],
  sourceType: "portable_legacy_story" | "portable_story_text" | "portable_campaign_zip",
  publishedAssets: readonly import("../../application/src/assets/private-asset-publication.js").PrivateAssetPublicationResult[] = [],
): Promise<PrivatePortableFamilyMutationResult> {
  if (!/^[0-9a-f]{64}$/u.test(input.authorityFingerprint)
    || input.destination.kind !== "existing_world_version") {
    throw new Error("portable_import_destination_invalid");
  }
  const destination = await database.query(
    `SELECT 1
       FROM worlds world
       JOIN world_versions version
         ON version.world_id=world.id AND version.owner_user_id=world.owner_user_id
      WHERE world.id=$1 AND version.id=$2 AND world.owner_user_id=$3
      FOR KEY SHARE OF world,version`,
    [input.destination.worldId, input.destination.worldVersionId, input.owner.ownerUserId],
  );
  if (destination.rowCount !== 1) throw new Error("portable_import_destination_invalid");
  const duplicate = await existingImportResult(database, input.owner.ownerUserId, input.authorityFingerprint);
  if (duplicate) return existingMutationResult(
    duplicate,
    sourceType === "portable_campaign_zip"
      ? "campaign_zip"
      : sourceType === "portable_story_text" ? "story_text" : "legacy_story",
  );
  const storyValue = input.payload.story ?? input.payload.campaign;
  const story = legacyStorySchema.parse(storyValue);
  const title = story.campaign?.title?.trim() || story.world.title?.trim() || "Imported campaign";
  const imported = await database.query<{ id: string }>(
    `INSERT INTO imports (owner_user_id,source_type,source_name,source_hash,status)
     VALUES ($1,$2,$3,$4,'processing') RETURNING id`,
    [input.owner.ownerUserId, sourceType, portableString(input.payload.sourceName, "portable-import"), input.authorityFingerprint]
  );
  const importId = imported.rows[0]!.id;
  const campaign = await database.query<{ id: string }>(
    `INSERT INTO campaigns (owner_user_id,world_version_id,title,active_turn_number,legacy_settings)
     VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id`,
    [input.owner.ownerUserId, input.destination.worldVersionId, title, story.turns.length, JSON.stringify(story.settings ?? {})]
  );
  const campaignId = campaign.rows[0]!.id;
  await database.query(
    `INSERT INTO campaign_state (
       campaign_id,owner_user_id,scratchpad_private,trackers,default_triggers,
       event_triggers,pending_event_triggers,rpg_stats,import_provenance
     ) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb)`,
    [
      campaignId,
      input.owner.ownerUserId,
      story.scratchpad ?? "",
      JSON.stringify(story.trackers ?? []),
      JSON.stringify(story.defaultTriggers ?? []),
      JSON.stringify(story.eventTriggers ?? []),
      JSON.stringify(story.pendingEventTriggers ?? []),
      JSON.stringify(story.rpgStats ?? []),
      JSON.stringify({ sourceType, importId })
    ]
  );
  const turnIds: string[] = [];
  for (const [index, turnValue] of story.turns.entries()) {
    const turn = turnValue as Readonly<Record<string, unknown>>;
    const inserted = await database.query<{ id: string }>(
      `INSERT INTO turns (
         owner_user_id,campaign_id,turn_number,source_turn_id,action,narration,choices,
         custom_action_suggestion,image_prompt,image_url,mechanics_private,
         state_snapshot_private,model_metadata,import_metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,NULL,$11::jsonb,'{}'::jsonb,$12::jsonb)
       RETURNING id`,
      [
        input.owner.ownerUserId,
        campaignId,
        index + 1,
        typeof turn.id === "string" ? turn.id : null,
        typeof turn.action === "string" ? turn.action : "",
        narration(turn),
        JSON.stringify(Array.isArray(turn.choices) ? turn.choices.slice(0, 4) : []),
        typeof turn.customActionSuggestion === "string" ? turn.customActionSuggestion : "",
        typeof turn.imagePrompt === "string" ? turn.imagePrompt : "",
        typeof turn.imageUrl === "string" ? turn.imageUrl : "",
        JSON.stringify(turn.worldStateSnapshot ?? {}),
        JSON.stringify({ importedFrom: sourceType, sourceTurnId: turn.id ?? null })
      ]
    );
    turnIds.push(inserted.rows[0]!.id);
    const fiction = narration(turn);
    await database.query(
      `INSERT INTO chronicle_memories (
         owner_user_id,campaign_id,world_version_id,turn_id,memory_kind,ordinal,
         content,token_estimate,importance,metadata
       ) VALUES ($1,$2,$3,$4,'turn_fiction',$5,$6,$7,0.5,$8::jsonb)`,
      [
        input.owner.ownerUserId,
        campaignId,
        input.destination.worldVersionId,
        inserted.rows[0]!.id,
        index + 1,
        fiction,
        Math.ceil(fiction.length / 4),
        JSON.stringify({ imported: true })
      ]
    );
  }
  for (const asset of publishedAssets) {
    await database.query(
      `INSERT INTO asset_references (owner_user_id,asset_id,campaign_id,asset_role)
       VALUES ($1,$2,$3,'import_attachment') ON CONFLICT DO NOTHING`,
      [input.owner.ownerUserId, asset.assetId, campaignId]
    );
  }
  const legacyStats = {
    turnCount: story.turns.length,
    memoryCount: story.turns.length,
    completeHistoryCharacters: typeof story.fullHistory === "string" ? story.fullHistory.length : 0,
    estimatedHistoryTokens: typeof story.fullHistory === "string" ? Math.ceil(story.fullHistory.length / 4) : 0,
    importedSummary: false,
    sanitizedMemoryCount: story.turns.length
  };
  const campaignStats = {
    turnCount: story.turns.length,
    memoryCount: story.turns.length,
    summaryCount: 0,
    assetCount: publishedAssets.length,
    assetBytes: publishedAssets.reduce((sum, asset) => sum + asset.byteLength, 0)
  };
  const stats = sourceType === "portable_campaign_zip" ? campaignStats : legacyStats;
  await database.query(
    `UPDATE imports
        SET status='completed',world_id=$2,world_version_id=$3,campaign_id=$4,
            stats=$5::jsonb,completed_at=clock_timestamp()
      WHERE id=$1 AND owner_user_id=$6 AND status='processing'`,
    [importId, input.destination.worldId, input.destination.worldVersionId, campaignId, JSON.stringify(stats), input.owner.ownerUserId]
  );
  const result = sourceType === "portable_campaign_zip"
    ? {
      importId,
      worldId: input.destination.worldId,
      worldVersionId: input.destination.worldVersionId,
      campaignId,
      duplicate: false,
      stats: campaignStats
    }
    : {
      ...(sourceType === "portable_story_text" ? { kind: "campaign" } : {}),
      importId,
      worldId: input.destination.worldId,
      worldVersionId: input.destination.worldVersionId,
      campaignId,
      duplicate: false,
      stats: legacyStats
    };
  return {
    importId,
    importedRecordId: importId,
    worldId: input.destination.worldId,
    worldVersionId: input.destination.worldVersionId,
    campaignId,
    duplicate: false,
    result: result as Readonly<Record<string, PortableJsonValue>>
  };
}

/**
 * Caller-client family mutations used only by the private 14e3d composition.
 * The world repository remains the sole world/version SQL authority.
 */
export function createPostgresPortableFamilyMutationRepository(
  worlds: WorldRepositoryPort,
): PrivatePortableFamilyMutationPort {
  const repository: PrivatePortableFamilyMutationPort = {
    async findCampaignDuplicate(database, input) {
      const client = portableDatabaseClient(database);
      if (!/^[0-9a-f]{64}$/u.test(input.authorityFingerprint)) {
        throw new Error("portable_import_authority_invalid");
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `infinite-quest-nexus:portable-campaign:${input.owner.ownerUserId}:${input.authorityFingerprint}`
      ]);
      const duplicate = await existingImportResult(
        client,
        input.owner.ownerUserId,
        input.authorityFingerprint,
      );
      return duplicate ? existingMutationResult(duplicate, input.kind) : null;
    },
    async commitCampaignZip(database, input) {
      const client = portableDatabaseClient(database);
      if (input.destination.kind === "embedded") {
        const request = worldImportRequestSchema.parse(input.payload.embeddedWorldImportRequest);
        const imported = await runPostgresWorldCampaignCommandWithClient(
          client,
          (transaction) => worlds.importWorld(transaction, input.owner, request),
        );
        if (!imported.ok) throw new Error(`portable_world_import_${imported.failure.reason}`);
        return commitPortableCampaign(
          client,
          {
            ...input,
            destination: {
              kind: "existing_world_version",
              worldId: imported.value.worldId,
              worldVersionId: imported.value.worldVersionId
            }
          },
          "portable_campaign_zip",
          input.publishedAssets,
        );
      }
      return commitPortableCampaign(
        client,
        input,
        "portable_campaign_zip",
        input.publishedAssets,
      );
    },
    commitLegacyStory(database, input) {
      return commitPortableCampaign(portableDatabaseClient(database), input, "portable_legacy_story");
    },
    async commitWorld(database, input) {
      const client = portableDatabaseClient(database);
      if (!/^[0-9a-f]{64}$/u.test(input.authorityFingerprint)) {
        throw new Error("portable_import_authority_invalid");
      }
      const request = worldImportRequestSchema.parse(input.payload.worldImportRequest);
      const imported = await runPostgresWorldCampaignCommandWithClient(
        client,
        (transaction) => worlds.importWorld(transaction, input.owner, request),
      );
      if (!imported.ok) throw new Error(`portable_world_import_${imported.failure.reason}`);
      return {
        importId: imported.value.importId,
        importedRecordId: imported.value.importId,
        worldId: imported.value.worldId,
        worldVersionId: imported.value.worldVersionId,
        campaignId: null,
        duplicate: imported.value.duplicate,
        result: {
          kind: "world",
          importId: imported.value.importId,
          worldId: imported.value.worldId,
          worldVersionId: imported.value.worldVersionId,
          duplicate: imported.value.duplicate
        }
      };
    },
    commitStoryText(database, input) {
      return commitPortableCampaign(portableDatabaseClient(database), input, "portable_story_text");
    }
  };
  return Object.freeze(repository);
}
