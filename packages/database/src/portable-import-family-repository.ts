import { createHash, randomUUID } from "node:crypto";
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
import { importPrivatePortableWorldAtExactTarget } from "./world-repository.js";
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

type ProgressRow = WorkRow & Readonly<{
  operation_status: "previewed" | "consuming" | "committed" | "expired" | "failed";
}>;

type AuthorityRow = Readonly<{
  operation_id: string;
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;

type ReservationIntentRow = Readonly<{
  ordinal: number;
  asset_id: string;
  asset_idempotency_key_hash: string;
  asset_request_fingerprint: string;
  commit_idempotency_key_hash: string;
  command_fingerprint: string;
  identity_lifecycle?: string;
}>;

function exactAssetIds(assetIds: readonly string[]): void {
  if (assetIds.length > 1000
    || assetIds.some((assetId) => !UUID_PATTERN.test(assetId))
    || new Set(assetIds).size !== assetIds.length) {
    throw new Error("portable_import_asset_reservations_invalid");
  }
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
): Promise<ProgressRow | null> {
  const selected = await client.query<ProgressRow>(
    `SELECT ${JOINED_WORK_COLUMNS},operation.status AS operation_status
       FROM portable_import_operations operation
       JOIN portable_import_work work
         ON work.operation_id=operation.id AND work.owner_user_id=operation.owner_user_id
      WHERE operation.owner_user_id=$1 AND operation.preview_token_hash=$2
      ${lock ? "FOR UPDATE OF operation,work" : ""}`,
    [owner.ownerUserId, sha256(previewToken)]
  );
  return selected.rows[0] ?? null;
}

export function createPostgresPortableImportAuthorityRepository(
  pool: DatabasePool,
  portable: PostgresPortableImportRepository,
  normalizedRetirement?: Readonly<{
    retireAbandonedOperationInTransaction(
      database: object,
      input: Readonly<{ operationId: string; ownerUserId: string }>,
    ): Promise<void>;
  }>,
): PostgresPortableImportAuthorityRepository {
  const readPreviewAuthority = async (input: Readonly<{
    command: PortableImportCommitCommand;
  }>): Promise<Readonly<{
    operationId: string;
    authority: PortableCanonicalImportAuthority;
    authorityFingerprint: string;
  }> | null> => {
    const destination = destinationParameters(input.command.destination);
    const selected = await pool.query<AuthorityRow>(
      `SELECT id AS operation_id,normalized_payload,authority_fingerprint,provider_configuration_fingerprint,
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
    return Object.freeze({
      operationId: row.operation_id,
      authority,
      authorityFingerprint: row.authority_fingerprint
    });
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
      `SELECT id AS operation_id,normalized_payload,authority_fingerprint,provider_configuration_fingerprint,
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
    if (updated.rowCount === 1) return;
    const alreadyCompleted = await database.query(
      `SELECT 1
         FROM portable_import_work work
         JOIN portable_import_operations operation
           ON operation.id=work.operation_id AND operation.owner_user_id=work.owner_user_id
        WHERE work.operation_id=$1 AND work.owner_user_id=$2
          AND work.status='completed' AND operation.status='committed'`,
      [claim.operationId, claim.ownerUserId],
    );
    if (alreadyCompleted.rowCount !== 1) throw new Error("portable_import_claim_lost");
  };

  const readReservationIntents = async (
    database: DatabaseClient,
    operationId: string,
    ownerUserId: string,
    lock: boolean,
  ): Promise<readonly ReservationIntentRow[]> => {
    const selected = await database.query<ReservationIntentRow>(
      `SELECT intent.ordinal,intent.asset_id,intent.asset_idempotency_key_hash,
              intent.asset_request_fingerprint,intent.commit_idempotency_key_hash,
              intent.command_fingerprint,identity.lifecycle AS identity_lifecycle
         FROM portable_import_asset_reservation_intents intent
         JOIN asset_publication_identities identity
           ON identity.asset_id=intent.asset_id
          AND identity.owner_user_id=intent.owner_user_id
        WHERE intent.operation_id=$1 AND intent.owner_user_id=$2
        ORDER BY intent.ordinal
        ${lock ? "FOR UPDATE OF intent,identity" : ""}`,
      [operationId, ownerUserId],
    );
    return selected.rows;
  };

  const lockAssetReservationIntentAuthority: PrivatePortableImportAuthorityPort["lockAssetReservationIntentAuthority"] = async (
    databaseContext,
    input,
  ) => {
    if (!UUID_PATTERN.test(input.operationId) || !HASH_PATTERN.test(input.authorityFingerprint)) {
      throw new Error("portable_import_asset_reservations_invalid");
    }
    const database = databaseContext as DatabaseClient;
    const operation = await database.query(
      `SELECT 1 FROM portable_import_operations operation
        JOIN portable_import_work work
          ON work.operation_id=operation.id AND work.owner_user_id=operation.owner_user_id
       WHERE operation.id=$1 AND operation.owner_user_id=$2
         AND operation.import_kind IN ('campaign_zip','legacy_story')
         AND operation.status='previewed'
         AND operation.authority_fingerprint=$3
         AND operation.expires_at > clock_timestamp()
         AND work.status IN ('running','recoverable') AND work.expires_at > clock_timestamp()
       FOR UPDATE OF operation,work`,
      [input.operationId, input.owner.ownerUserId, input.authorityFingerprint],
    );
    if (operation.rowCount !== 1) throw new Error("portable_import_asset_reservations_unavailable");
  };

  const recordAssetReservationIntents: PrivatePortableImportAuthorityPort["recordAssetReservationIntents"] = async (
    databaseContext,
    input,
  ) => {
    const database = databaseContext as DatabaseClient;
    exactAssetIds(input.assetIds);
    if (!UUID_PATTERN.test(input.operationId)
      || !HASH_PATTERN.test(input.authorityFingerprint)
      || !HASH_PATTERN.test(input.commitIdempotencyKeyHash)
      || !HASH_PATTERN.test(input.commandFingerprint)) {
      throw new Error("portable_import_asset_reservations_invalid");
    }
    await lockAssetReservationIntentAuthority(database, input);
    if (input.assetIds.length > 0) {
      await database.query(
        `INSERT INTO portable_import_asset_reservation_intents (
           operation_id,owner_user_id,ordinal,asset_id,commit_idempotency_key_hash,
           command_fingerprint,asset_idempotency_key_hash,asset_request_fingerprint
         )
         SELECT $1,$2,asset.ordinality-1,identity.asset_id,$4,$5,
                identity.idempotency_key_hash,identity.request_fingerprint
           FROM unnest($3::uuid[]) WITH ORDINALITY AS asset(asset_id,ordinality)
           JOIN asset_publication_identities identity
             ON identity.asset_id=asset.asset_id AND identity.owner_user_id=$2
          WHERE identity.lifecycle='prepared'
         ON CONFLICT DO NOTHING`,
        [
          input.operationId,
          input.owner.ownerUserId,
          input.assetIds,
          input.commitIdempotencyKeyHash,
          input.commandFingerprint
        ],
      );
    }
    const exact = await readReservationIntents(
      database,
      input.operationId,
      input.owner.ownerUserId,
      true,
    );
    if (exact.length !== input.assetIds.length
      || exact.some((intent, ordinal) => intent.ordinal !== ordinal
        || intent.asset_id !== input.assetIds[ordinal]
        || intent.commit_idempotency_key_hash !== input.commitIdempotencyKeyHash
        || intent.command_fingerprint !== input.commandFingerprint
        || intent.identity_lifecycle !== "prepared")) {
      throw new Error("portable_import_asset_reservation_mismatch");
    }
  };

  const releaseAssetReservationIntents: PrivatePortableImportAuthorityPort["releaseAssetReservationIntents"] = async (
    databaseContext,
    input,
  ) => {
    const database = databaseContext as DatabaseClient;
    exactAssetIds(input.assetIds);
    if (!UUID_PATTERN.test(input.operationId)) {
      throw new Error("portable_import_asset_reservations_invalid");
    }
    const exact = await readReservationIntents(
      database,
      input.operationId,
      input.owner.ownerUserId,
      true,
    );
    if (exact.length !== input.assetIds.length
      || exact.some((intent, ordinal) => intent.ordinal !== ordinal
        || intent.asset_id !== input.assetIds[ordinal])) {
      throw new Error("portable_import_asset_reservation_mismatch");
    }
    if (exact.length === 0) return;
    const removed = await database.query(
      `DELETE FROM portable_import_asset_reservation_intents
        WHERE operation_id=$1 AND owner_user_id=$2`,
      [input.operationId, input.owner.ownerUserId],
    );
    if (removed.rowCount !== exact.length) {
      throw new Error("portable_import_asset_reservations_unavailable");
    }
  };

  const recordAssetPublications = async (
    database: DatabaseClient,
    claim: PrivatePortableImportWorkClaim,
    importId: string,
    assetIds: readonly string[],
  ): Promise<void> => {
    if (!UUID_PATTERN.test(importId)) {
      throw new Error("portable_import_asset_publications_invalid");
    }
    exactAssetIds(assetIds);
    if (assetIds.length === 0) return;
    const intents = await readReservationIntents(database, claim.operationId, claim.ownerUserId, true);
    if (intents.length !== assetIds.length
      || intents.some((intent, ordinal) => intent.ordinal !== ordinal
        || intent.asset_id !== assetIds[ordinal]
        || !["attached", "published"].includes(intent.identity_lifecycle ?? ""))) {
      throw new Error("portable_import_asset_reservation_mismatch");
    }
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
    const retired = await database.query(
      `DELETE FROM portable_import_asset_reservation_intents
        WHERE operation_id=$1 AND owner_user_id=$2`,
      [claim.operationId, claim.ownerUserId],
    );
    if (retired.rowCount !== assetIds.length) {
      throw new Error("portable_import_asset_reservations_unavailable");
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
         FROM portable_import_operations replay
         JOIN imports imported
           ON imported.id=replay.import_id
          AND imported.owner_user_id=replay.owner_user_id
          AND imported.source_hash=replay.authority_fingerprint
          AND imported.source_type=CASE replay.import_kind
            WHEN 'campaign_zip' THEN 'portable_campaign_zip'
            WHEN 'legacy_story' THEN 'portable_legacy_story'
          END
          AND imported.status='completed'
         LEFT JOIN LATERAL (
           SELECT mapped.asset_id
             FROM portable_import_asset_publications mapped
             JOIN portable_import_operations canonical
               ON canonical.id=mapped.operation_id
              AND canonical.owner_user_id=mapped.owner_user_id
              AND canonical.import_id=mapped.import_id
              AND canonical.import_kind=replay.import_kind
              AND canonical.status='committed'
              AND canonical.authority_fingerprint=replay.authority_fingerprint
            WHERE mapped.owner_user_id=replay.owner_user_id
              AND mapped.import_id=replay.import_id
         ) publication ON true
        WHERE replay.owner_user_id=$1 AND replay.preview_token_hash=$2
          AND replay.import_kind IN ('campaign_zip','legacy_story')
          AND replay.status='committed'
        GROUP BY replay.id`,
      [owner.ownerUserId, sha256(previewToken)],
    );
    const row = selected.rows[0];
    if (!row) throw new Error("portable_import_replay_unavailable");
    return Object.freeze(row.asset_ids);
  };

  const discardAbandonedReservationIntents = async (
    database: DatabaseClient,
    operationId: string,
    ownerUserId: string,
  ): Promise<void> => {
    const intents = await readReservationIntents(database, operationId, ownerUserId, true);
    if (intents.some((intent) => !["prepared", "cleanup_pending"].includes(intent.identity_lifecycle ?? ""))) {
      throw new Error("portable_import_asset_reservation_advanced");
    }
    if (intents.length === 0) return;
    const removed = await database.query(
      `DELETE FROM portable_import_asset_reservation_intents
        WHERE operation_id=$1 AND owner_user_id=$2`,
      [operationId, ownerUserId],
    );
    if (removed.rowCount !== intents.length) {
      throw new Error("portable_import_asset_reservations_unavailable");
    }
    for (const intent of intents) {
      if (intent.identity_lifecycle === "cleanup_pending") continue;
      const operations = await database.query<{ lifecycle: string }>(
        `SELECT lifecycle FROM durable_filesystem_operations
          WHERE asset_id=$1 AND owner_user_id=$2 FOR UPDATE`,
        [intent.asset_id, ownerUserId],
      );
      if (operations.rows.some((operation) => operation.lifecycle !== "cleaned")) {
        throw new Error("portable_import_asset_reservation_advanced");
      }
      if (operations.rows.length === 0) {
        const deleted = await database.query(
          `DELETE FROM asset_publication_identities
            WHERE asset_id=$1 AND owner_user_id=$2 AND lifecycle='prepared'
              AND idempotency_key_hash=$3 AND request_fingerprint=$4`,
          [
            intent.asset_id,
            ownerUserId,
            intent.asset_idempotency_key_hash,
            intent.asset_request_fingerprint
          ],
        );
        if (deleted.rowCount !== 1) throw new Error("portable_import_asset_reservation_mismatch");
      } else {
        const retired = await database.query(
          `UPDATE asset_publication_identities
              SET lifecycle='cleanup_pending',updated_at=clock_timestamp()
            WHERE asset_id=$1 AND owner_user_id=$2 AND lifecycle='prepared'
              AND idempotency_key_hash=$3 AND request_fingerprint=$4`,
          [
            intent.asset_id,
            ownerUserId,
            intent.asset_idempotency_key_hash,
            intent.asset_request_fingerprint
          ],
        );
        if (retired.rowCount !== 1) throw new Error("portable_import_asset_reservation_mismatch");
      }
    }
  };

  const expireOrRead = async (owner: ImportOwnerScope, previewToken: string): Promise<PortableImportProgressView | null> => (
    withTransaction(pool, async (database) => {
      let row = await progressByPreview(database, owner, previewToken, true);
      if (!row) return null;
      if (row.operation_status === "previewed"
        && ["running", "recoverable"].includes(row.status)
        && row.expires_at.getTime() <= Date.now()) {
        await discardAbandonedReservationIntents(
          database,
          row.operation_id,
          row.owner_user_id,
        );
        const expiredOperation = await database.query(
          `UPDATE portable_import_operations
              SET status='expired',updated_at=clock_timestamp()
            WHERE id=$1 AND owner_user_id=$2 AND status='previewed'`,
          [row.operation_id, row.owner_user_id],
        );
        const expired = await database.query<WorkRow>(
          `UPDATE portable_import_work
              SET status='expired',diagnostic_code='archive_expired',
                  lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,
                  terminal_at=clock_timestamp(),updated_at=clock_timestamp()
            WHERE operation_id=$1 AND owner_user_id=$2 AND status IN ('running','recoverable')
          RETURNING ${WORK_COLUMNS}`,
          [row.operation_id, row.owner_user_id]
        );
        if (expiredOperation.rowCount !== 1 || expired.rowCount !== 1) {
          throw new Error("portable_import_reap_conflict");
        }
        await normalizedRetirement?.retireAbandonedOperationInTransaction(database, {
          operationId: row.operation_id,
          ownerUserId: row.owner_user_id
        });
        row = expired.rows[0]
          ? Object.freeze({ ...expired.rows[0], operation_status: "expired" as const })
          : row;
      } else if ((row.operation_status === "failed" && row.status === "aborted")
        || (row.operation_status === "expired" && row.status === "expired")) {
        await normalizedRetirement?.retireAbandonedOperationInTransaction(database, {
          operationId: row.operation_id,
          ownerUserId: row.owner_user_id
        });
      }
      return safePortableImportProgress(workRecord(row));
    })
  );

  const abort = async (owner: ImportOwnerScope, previewToken: string): Promise<PortableImportProgressView | null> => (
    withTransaction(pool, async (database) => {
      const row = await progressByPreview(database, owner, previewToken, true);
      if (!row) return null;
      if (["aborted", "completed", "expired"].includes(row.status)) {
        if ((row.operation_status === "failed" && row.status === "aborted")
          || (row.operation_status === "expired" && row.status === "expired")) {
          await normalizedRetirement?.retireAbandonedOperationInTransaction(database, {
            operationId: row.operation_id,
            ownerUserId: row.owner_user_id
          });
        }
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
      await discardAbandonedReservationIntents(
        database,
        row.operation_id,
        row.owner_user_id,
      );
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
      if (aborted.rowCount !== 1) throw new Error("portable_import_abort_conflict");
      await normalizedRetirement?.retireAbandonedOperationInTransaction(database, {
        operationId: row.operation_id,
        ownerUserId: row.owner_user_id
      });
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
         FROM portable_import_operations operation
         JOIN portable_import_work work
           ON work.operation_id=operation.id AND work.owner_user_id=operation.owner_user_id
        WHERE operation.owner_user_id=$1 AND operation.preview_token_hash=$2
        FOR UPDATE OF operation,work`,
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
           FROM portable_import_operations operation
           JOIN portable_import_work work
             ON work.operation_id=operation.id AND work.owner_user_id=operation.owner_user_id
          WHERE work.status IN ('running','recoverable')
            AND work.expires_at <= clock_timestamp()
            AND operation.status='previewed'
          ORDER BY work.expires_at,work.operation_id
          FOR UPDATE OF operation,work SKIP LOCKED
          LIMIT $1`,
        [limit],
      );
      for (const row of due.rows) {
        await discardAbandonedReservationIntents(
          database,
          row.operation_id,
          row.owner_user_id,
        );
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
        await normalizedRetirement?.retireAbandonedOperationInTransaction(database, {
          operationId: row.operation_id,
          ownerUserId: row.owner_user_id
        });
      }
      return due.rows.length;
    });
  };

  return Object.freeze({
    readPreviewAuthority,
    persistPreviewAuthority,
    claimPreviewAuthority,
    updateProgress,
    lockAssetReservationIntentAuthority,
    recordAssetReservationIntents,
    releaseAssetReservationIntents,
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

function safePortableExternalImageUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function isPortableAbsoluteImageValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  const segments = trimmed.split("/");
  if (trimmed.startsWith("/") || trimmed.startsWith("\\") || trimmed.includes("\\")
    || segments.some((segment) => segment === "." || segment === "..")) {
    return true;
  }
  try {
    return /^[a-z][a-z0-9+.-]*:/iu.test(trimmed) && Boolean(new URL(trimmed).protocol);
  } catch {
    return false;
  }
}

function portableDataImageHash(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(value);
  if (!match) return null;
  const bytes = Buffer.from(match[1]!, "base64");
  return bytes.byteLength > 0 ? createHash("sha256").update(bytes).digest("hex") : null;
}

function portableLegacyAssetLookupKeys(value: unknown): readonly string[] {
  if (typeof value !== "string") return [];
  const uuid = value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu)?.[0];
  const name = value.split("/").pop()?.split("?")[0];
  const stem = name?.split(".")[0];
  return [...new Set([value, uuid, name, stem].filter((key): key is string => Boolean(key)))];
}

function unknownRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function unknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function jsonValue(value: unknown, fallback: unknown): string {
  return JSON.stringify(value === undefined ? fallback : value);
}

function portableDate(value: unknown): string {
  const parsed = typeof value === "string" ? new Date(value) : new Date(Number.NaN);
  return Number.isNaN(parsed.valueOf()) ? new Date().toISOString() : parsed.toISOString();
}

function rewritePortableAssetPointers(value: unknown, assetIds: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((child) => rewritePortableAssetPointers(child, assetIds));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => [key, rewritePortableAssetPointers(child, assetIds)]));
  }
  if (typeof value !== "string") return value;
  return value.replaceAll(/\/api\/v1\/assets\/([0-9a-f-]{36})/giu, (_whole, sourceAssetId: string) => {
    const assetId = assetIds.get(sourceAssetId) ?? assetIds.get(sourceAssetId.toLowerCase());
    if (!assetId) throw new Error("portable_import_asset_mapping_invalid");
    return `/api/v1/assets/${assetId}`;
  });
}

type RichIdMaps = Readonly<{
  campaign: Map<string, string>;
  turn: Map<string, string>;
  illustrationSet: Map<string, string>;
  illustrationSegment: Map<string, string>;
  generationContext: Map<string, string>;
}>;

function mapRichId(map: Map<string, string>, source: unknown): string {
  if (typeof source !== "string" || !source.trim()) throw new Error("portable_import_reference_invalid");
  const existing = map.get(source);
  if (existing) return existing;
  const id = randomUUID();
  map.set(source, id);
  return id;
}

function requireRichId(map: ReadonlyMap<string, string>, source: unknown): string {
  if (typeof source !== "string") throw new Error("portable_import_reference_invalid");
  const id = map.get(source);
  if (!id) throw new Error("portable_import_reference_invalid");
  return id;
}

function plannedIdMap(
  values: readonly Readonly<{ sourceId: string; targetId: string }>[] | undefined,
): Map<string, string> {
  return new Map((values ?? []).map(({ sourceId, targetId }) => [sourceId, targetId]));
}

async function attachNormalizedPortableChildren(
  database: DatabaseClient,
  ownerUserId: string,
  publication: import("../../application/src/imports/private-portable-composition.js").PrivatePortablePublishedAsset,
): Promise<import("../../application/src/assets/private-normalized-asset-publication.js").PrivateNormalizedAssetRequestChildBindingsInput> {
  const plan = publication.normalizedChildren;
  if (!plan) return Object.freeze({ contexts: Object.freeze([]), references: Object.freeze([]) });
  const contexts = [];
  for (const child of plan.contexts) {
    await database.query(
      `INSERT INTO asset_generation_contexts (
         id,owner_user_id,asset_id,created_by_user_id,world_id,world_version_id,
         campaign_id,turn_id,target_type,variant_index
       ) VALUES ($1,$2,$3,$2,$4,$5,$6,$7,$8,$9)`,
      [
        child.contextId,
        ownerUserId,
        publication.result.assetId,
        child.intent.worldId ?? null,
        child.intent.worldVersionId ?? null,
        child.intent.campaignId ?? null,
        child.intent.turnId ?? null,
        child.intent.targetType,
        child.intent.variantIndex
      ],
    );
    contexts.push(Object.freeze({ intentKey: child.intent.intentKey, contextId: child.contextId }));
  }
  const references = [];
  for (const child of plan.references) {
    const inserted = await database.query<{ id: string }>(
      `INSERT INTO asset_references (
         id,owner_user_id,asset_id,campaign_id,turn_id,asset_role
       ) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        child.referenceId,
        ownerUserId,
        publication.result.assetId,
        child.intent.campaignId,
        child.intent.turnId ?? null,
        child.intent.assetRole
      ],
    );
    const referenceId = inserted.rows[0]?.id ?? (await database.query<{ id: string }>(
      `SELECT id
         FROM asset_references
        WHERE owner_user_id=$1 AND asset_id=$2 AND campaign_id=$3
          AND turn_id IS NOT DISTINCT FROM $4::uuid AND asset_role=$5
        FOR KEY SHARE`,
      [
        ownerUserId,
        publication.result.assetId,
        child.intent.campaignId,
        child.intent.turnId ?? null,
        child.intent.assetRole
      ],
    )).rows[0]?.id;
    if (!referenceId) throw new Error("portable_import_asset_mapping_invalid");
    references.push(Object.freeze({ intentKey: child.intent.intentKey, referenceId }));
  }
  return Object.freeze({ contexts: Object.freeze(contexts), references: Object.freeze(references) });
}

async function restoreRichPortableAssets(
  database: DatabaseClient,
  ownerUserId: string,
  worldId: string,
  worldVersionId: string,
  campaignId: string,
  maps: RichIdMaps,
  publishedAssets: readonly import("../../application/src/imports/private-portable-composition.js").PrivatePortablePublishedAsset[],
): Promise<Readonly<{
  assetIds: ReadonlyMap<string, string>;
  childBindings: readonly import("../../application/src/assets/private-normalized-asset-publication.js").PrivateNormalizedAssetRequestChildBindingsInput[];
}>> {
  const assetIds = new Map<string, string>();
  for (const publication of publishedAssets) {
    if (publication.sourceAssetIds.length !== publication.records.length
      || publication.records.some((record) => record.contentHash !== publication.result.contentHash
        || record.byteLength !== publication.result.byteLength
        || record.mimeType !== publication.result.mimeType)) {
      throw new Error("portable_import_asset_mapping_invalid");
    }
    for (const sourceAssetId of publication.sourceAssetIds) assetIds.set(sourceAssetId, publication.result.assetId);
    if (!publication.normalizedChildren) {
      const representative = publication.records[0];
      if (!representative) throw new Error("portable_import_asset_mapping_invalid");
      await database.query(
        `UPDATE assets
            SET pixel_width=$3,pixel_height=$4,technical_metadata=$5::jsonb
          WHERE id=$1 AND owner_user_id=$2`,
        [publication.result.assetId, ownerUserId, representative.pixelWidth, representative.pixelHeight,
          JSON.stringify(representative.technicalMetadata)]
      );
      await database.query(
        `UPDATE asset_library_entries
            SET title=$3,caption=$4,notes=$5,tags=$6,origin=$7,review_status=$8,
                reuse_scope=$9,automatic_reuse_enabled=$10,content_categories=$11,
                favorite=$12,archived_at=$13,updated_at=clock_timestamp()
          WHERE asset_id=$1 AND owner_user_id=$2`,
        [publication.result.assetId, ownerUserId, representative.library.title, representative.library.caption,
          representative.library.notes, representative.library.tags, representative.library.origin,
          representative.library.reviewStatus, representative.library.reuseScope,
          representative.library.automaticReuseEnabled, representative.library.contentCategories,
          representative.library.favorite, representative.library.archivedAt]
      );
    }
  }
  const childBindings = [];
  for (const publication of publishedAssets) {
    childBindings.push(await attachNormalizedPortableChildren(database, ownerUserId, publication));
    for (const record of publication.records) {
      const assetId = assetIds.get(record.sourceAssetId);
      if (!assetId) throw new Error("portable_import_asset_mapping_invalid");
      if (!publication.normalizedChildren) {
        await database.query(
          `INSERT INTO asset_references (owner_user_id,asset_id,campaign_id,asset_role)
           VALUES ($1,$2,$3,'import_attachment') ON CONFLICT DO NOTHING`,
          [ownerUserId, assetId, campaignId]
        );
      }
      for (const binding of record.bindings) {
        if (binding.role === "world_cover") {
          await database.query("UPDATE worlds SET cover_asset_id=$3 WHERE id=$1 AND owner_user_id=$2", [worldId, ownerUserId, assetId]);
        } else if (binding.role === "turn_illustration") {
          const turnId = requireRichId(maps.turn, binding.turnId);
          if (!publication.normalizedChildren) {
            await database.query(
              `INSERT INTO asset_references (owner_user_id,asset_id,campaign_id,turn_id,asset_role)
               VALUES ($1,$2,$3,$4,'turn_illustration') ON CONFLICT DO NOTHING`,
              [ownerUserId, assetId, campaignId, turnId]
            );
          }
          await database.query(
            "UPDATE turns SET image_url=$3 WHERE id=$1 AND owner_user_id=$2 AND campaign_id=$4",
            [turnId, ownerUserId, `/api/v1/assets/${assetId}`, campaignId]
          );
        } else if (binding.role === "campaign_asset") {
          if (!publication.normalizedChildren) {
            await database.query(
              `INSERT INTO asset_references (owner_user_id,asset_id,campaign_id,asset_role)
               VALUES ($1,$2,$3,'world_asset') ON CONFLICT DO NOTHING`,
              [ownerUserId, assetId, campaignId]
            );
          }
        } else if (binding.role === "imported_attachment" && binding.turnId) {
          const turnId = requireRichId(maps.turn, binding.turnId);
          if (!publication.normalizedChildren) {
            await database.query(
              `INSERT INTO asset_references (owner_user_id,asset_id,campaign_id,turn_id,asset_role)
               VALUES ($1,$2,$3,$4,'import_attachment') ON CONFLICT DO NOTHING`,
              [ownerUserId, assetId, campaignId, turnId]
            );
          }
        } else if (binding.role === "illustration_segment_variant") {
          await database.query(
            `INSERT INTO turn_illustration_segment_assets (segment_id,owner_user_id,asset_id,variant_index)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (segment_id,variant_index) DO UPDATE SET asset_id=EXCLUDED.asset_id`,
            [requireRichId(maps.illustrationSegment, binding.segmentId), ownerUserId, assetId, binding.variantIndex]
          );
        } else if (binding.role === "generation_context") {
          if (!publication.normalizedChildren) {
            const contextId = mapRichId(maps.generationContext, binding.sourceContextId);
            await database.query(
              `INSERT INTO asset_generation_contexts (
                 id,owner_user_id,asset_id,created_by_user_id,world_id,world_version_id,campaign_id,turn_id,target_type,variant_index
               ) VALUES ($1,$2,$3,$2,$4,$5,$6,$7,'other',0)
               ON CONFLICT (id) DO UPDATE SET asset_id=EXCLUDED.asset_id`,
              [contextId, ownerUserId, assetId,
                binding.worldId === null ? null : worldId,
                binding.worldVersionId === null ? null : worldVersionId,
                binding.campaignId === null ? null : campaignId,
                binding.turnId === null ? null : requireRichId(maps.turn, binding.turnId)]
            );
          }
        }
      }
    }
  }
  return Object.freeze({ assetIds, childBindings: Object.freeze(childBindings) });
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

async function commitRichPortableCampaign(
  database: DatabaseClient,
  input: Readonly<{
    owner: ImportOwnerScope;
    destination: Extract<PortablePreviewDestination, { kind: "existing_world_version" }>;
    authorityFingerprint: string;
    payload: Readonly<Record<string, PortableJsonValue>>;
    targetPlan?: import("../../application/src/imports/private-portable-composition.js").PrivatePortableFamilyTargetPlan;
    publishedAssets: readonly import("../../application/src/imports/private-portable-composition.js").PrivatePortablePublishedAsset[];
    createdWorld: boolean;
  }>,
): Promise<PrivatePortableFamilyMutationResult> {
  const campaignPayload = unknownRecord(input.payload.campaign);
  const worldPayload = unknownRecord(input.payload.world);
  const chronicle = unknownRecord(input.payload.chronicle);
  const sourceCampaign = unknownRecord(campaignPayload.campaign);
  const archiveRecords = unknownRecord(campaignPayload.archiveRecords);
  if (!Array.isArray(campaignPayload.turns) || archiveRecords.formatVersion !== 1
    || chronicle.formatVersion !== 1 || !Array.isArray(chronicle.memories) || !Array.isArray(chronicle.summaries)) {
    throw new Error("portable_import_payload_invalid");
  }
  const duplicate = await existingImportResult(database, input.owner.ownerUserId, input.authorityFingerprint);
  if (duplicate) return existingMutationResult(duplicate, "campaign_zip");
  const imported = await database.query<{ id: string }>(
    `INSERT INTO imports (owner_user_id,source_type,source_name,source_hash,status)
     VALUES ($1,'portable_campaign_zip',$2,$3,'processing') RETURNING id`,
    [input.owner.ownerUserId, portableString(input.payload.sourceName, "campaign.zip"), input.authorityFingerprint]
  );
  const importId = imported.rows[0]!.id;
  const turns = campaignPayload.turns;
  const settings = unknownRecord(campaignPayload.settings);
  const activeTurnNumber = Math.max(0, ...turns.map((turn) => Number(unknownRecord(turn).turnNumber ?? 0)));
  const campaignId = input.targetPlan?.campaignId ?? randomUUID();
  await database.query(
    `INSERT INTO campaigns (
       id,owner_user_id,world_version_id,title,active_turn_number,legacy_settings,story_length_profile,
       turn_control_style,selected_character_id,character_snapshot,character_profile,character_profile_revision
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10::jsonb,$11::jsonb,$12)`,
    [campaignId, input.owner.ownerUserId, input.destination.worldVersionId,
      typeof sourceCampaign.title === "string" && sourceCampaign.title.trim() ? sourceCampaign.title : "Imported campaign",
      activeTurnNumber, JSON.stringify(settings),
      typeof settings.storyLength === "string" ? settings.storyLength : "standard",
      ["action_only", "flexible_auto", "flexible_action", "flexible_scene"].includes(String(settings.turnControlStyle))
        ? settings.turnControlStyle : "flexible_action",
      typeof sourceCampaign.selectedCharacterId === "string" ? sourceCampaign.selectedCharacterId : null,
      sourceCampaign.characterSnapshot == null ? null : JSON.stringify(sourceCampaign.characterSnapshot),
      sourceCampaign.characterProfile == null ? null : JSON.stringify(sourceCampaign.characterProfile),
      Number(sourceCampaign.characterProfileRevision ?? 0)]
  );
  const maps: RichIdMaps = {
    campaign: new Map([[String(sourceCampaign.sourceCampaignId ?? "source-campaign"), campaignId]]),
    turn: new Map((input.targetPlan?.turns ?? []).map((turn) => [turn.sourceTurnId ?? `ordinal:${turn.ordinal}`, turn.targetTurnId])),
    illustrationSet: plannedIdMap(input.targetPlan?.illustrationSets),
    illustrationSegment: plannedIdMap(input.targetPlan?.illustrationSegments),
    generationContext: plannedIdMap(input.targetPlan?.generationContexts)
  };
  if (input.targetPlan && input.targetPlan.turns.length !== turns.length) {
    throw new Error("portable_import_reference_invalid");
  }
  for (const [ordinal, turn] of turns.entries()) {
    const sourceTurnId = unknownRecord(turn).id;
    if (input.targetPlan) {
      const planned = input.targetPlan.turns[ordinal];
      if (!planned || planned.ordinal !== ordinal || planned.sourceTurnId !== sourceTurnId) {
        throw new Error("portable_import_reference_invalid");
      }
      maps.turn.set(String(sourceTurnId), planned.targetTurnId);
    } else {
      mapRichId(maps.turn, sourceTurnId);
    }
  }
  for (const set of unknownArray(archiveRecords.illustrationSets)) mapRichId(maps.illustrationSet, unknownRecord(set).id);
  for (const segment of unknownArray(archiveRecords.illustrationSegments)) mapRichId(maps.illustrationSegment, unknownRecord(segment).id);
  await database.query(
    `INSERT INTO campaign_state (
       campaign_id,owner_user_id,scratchpad_private,trackers,default_triggers,event_triggers,
       pending_event_triggers,rpg_stats,import_provenance,initial_state_snapshot,revision
     ) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11)`,
    [campaignId, input.owner.ownerUserId, String(campaignPayload.scratchpad ?? ""),
      jsonValue(campaignPayload.trackers, []), jsonValue(campaignPayload.defaultTriggers, []),
      jsonValue(campaignPayload.eventTriggers, []), jsonValue(campaignPayload.pendingEventTriggers, []),
      jsonValue(campaignPayload.rpgStats, []), JSON.stringify({ sourceType: "portable_campaign_zip", importId }),
      jsonValue({ scratchpad: "", trackers: campaignPayload.baseTrackersAtStart ?? [] }, {}),
      Number(sourceCampaign.stateRevision ?? 0)]
  );
  for (const [index, turnValue] of turns.entries()) {
    const turn = unknownRecord(turnValue);
    await database.query(
      `INSERT INTO turns (
         id,owner_user_id,campaign_id,turn_number,source_turn_id,action,input_mode,input_mode_source,narration,
         choices,custom_action_suggestion,image_prompt,image_url,mechanics_private,state_snapshot_private,
         model_metadata,import_metadata,accepted_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14::jsonb,$15::jsonb,$16::jsonb,$17::jsonb,$18)`,
      [requireRichId(maps.turn, turn.id), input.owner.ownerUserId, campaignId,
        Number(turn.turnNumber ?? index + 1), String(turn.id), String(turn.action ?? ""),
        typeof turn.inputMode === "string" ? turn.inputMode : "action",
        typeof turn.inputModeSource === "string" ? turn.inputModeSource : "explicit",
        narration(turn), jsonValue(turn.choices, []), String(turn.customActionSuggestion ?? ""),
        String(turn.imagePrompt ?? ""), typeof turn.imageUrl === "string" && /^https:\/\//u.test(turn.imageUrl) ? turn.imageUrl : "",
        jsonValue(turn.roll, null), jsonValue(turn.worldStateSnapshot, {}), jsonValue(turn.llmModelInfo, {}),
        jsonValue({ importedFrom: "portable_campaign_zip", sourceTurnId: turn.id }, {}), portableDate(turn.createdAt)]
    );
  }
  for (const value of unknownArray(archiveRecords.characterProfileEdits)) {
    const row = unknownRecord(value);
    await database.query(
      `INSERT INTO campaign_character_profile_edits (
         owner_user_id,campaign_id,revision,previous_profile,next_profile,edit_source,created_at
       ) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)`,
      [input.owner.ownerUserId, campaignId, Number(row.revision ?? 1), jsonValue(row.previous_profile, null),
        jsonValue(row.next_profile, {}), ["world_version_seed", "manual", "ai_organized", "imported", "branch", "transfer"]
          .includes(String(row.edit_source)) ? row.edit_source : "imported", portableDate(row.created_at)]
    );
  }
  for (const value of unknownArray(archiveRecords.stateEdits)) {
    const row = unknownRecord(value);
    await database.query(
      `INSERT INTO campaign_state_edits (
         owner_user_id,campaign_id,effective_turn_number,revision,state_snapshot_private,changed_fields,created_at
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`,
      [input.owner.ownerUserId, campaignId, Number(row.effective_turn_number ?? 0), Number(row.revision ?? 1),
        jsonValue(row.state_snapshot_private, {}), jsonValue(row.changed_fields, []), portableDate(row.created_at)]
    );
  }
  for (const memoryValue of chronicle.memories) {
    const memory = unknownRecord(memoryValue);
    await database.query(
      `INSERT INTO chronicle_memories (
         owner_user_id,campaign_id,world_version_id,turn_id,memory_kind,ordinal,content,token_estimate,
         importance,entities,entity_ids,metadata,created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)`,
      [input.owner.ownerUserId, campaignId, input.destination.worldVersionId,
        memory.turn_id ? requireRichId(maps.turn, memory.turn_id) : null,
        String(memory.memory_kind ?? "legacy_summary"), Number(memory.ordinal ?? 0), String(memory.content ?? ""),
        Number(memory.lexicalUnitEstimate ?? 0), Number(memory.importance ?? 0.5), memory.entities ?? [], memory.entity_ids ?? [],
        jsonValue(memory.metadata, {}), portableDate(memory.created_at)]
    );
  }
  for (const summaryValue of chronicle.summaries) {
    const summary = unknownRecord(summaryValue);
    await database.query(
      `INSERT INTO summary_checkpoints (
         owner_user_id,campaign_id,through_turn,summary_kind,content,token_estimate,created_at
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
      [input.owner.ownerUserId, campaignId, Number(summary.through_turn ?? 0),
        String(summary.summary_kind ?? "campaign_summary"), jsonValue(summary.content, {}),
        Number(summary.lexicalUnitEstimate ?? 0), portableDate(summary.created_at)]
    );
  }
  const config = unknownRecord(archiveRecords.illustrationConfig);
  if (Object.keys(config).length > 0) {
    const sourcePolicy = ["off", "library_only", "library_then_generate", "generate_only"].includes(String(config.source_policy))
      ? String(config.source_policy) : "off";
    await database.query(
      `INSERT INTO campaign_illustration_configs (
         campaign_id,owner_user_id,enabled,source_policy,matching_scope,confidence_profile,repetition_window,
         model,size,aspect_ratio,quality,output_format,max_attempts,segment_word_count,images_per_segment,
         segment_prompt_mode,refinement_prompt
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [campaignId, input.owner.ownerUserId, sourcePolicy !== "off", sourcePolicy,
        ["campaign", "world", "owner_library", "shared"].includes(String(config.matching_scope)) ? config.matching_scope : "world",
        ["strict", "balanced", "broad"].includes(String(config.confidence_profile)) ? config.confidence_profile : "balanced",
        Number(config.repetition_window ?? 5), String(config.model ?? ""), String(config.size ?? "1024x1024"),
        String(config.aspect_ratio ?? "1:1"), ["auto", "low", "medium", "high"].includes(String(config.quality)) ? config.quality : "auto",
        ["png", "jpeg", "webp"].includes(String(config.output_format)) ? config.output_format : "png",
        Number(config.max_attempts ?? 3), Number(config.segment_word_count ?? 500), Number(config.images_per_segment ?? 1),
        ["direct", "ai_refined"].includes(String(config.segment_prompt_mode)) ? config.segment_prompt_mode : "direct",
        String(config.refinement_prompt ?? "")]
    );
  }
  for (const setValue of unknownArray(archiveRecords.illustrationSets)) {
    const set = unknownRecord(setValue);
    await database.query(
      `INSERT INTO turn_illustration_sets (
         id,owner_user_id,campaign_id,turn_id,source_text_hash,segment_word_count,images_per_segment,
         prompt_mode,status,is_active,character_visual_reference,created_at,completed_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [requireRichId(maps.illustrationSet, set.id), input.owner.ownerUserId, campaignId,
        requireRichId(maps.turn, set.turn_id), String(set.source_text_hash ?? ""), Number(set.segment_word_count ?? 500),
        Number(set.images_per_segment ?? 1), ["direct", "ai_refined", "legacy"].includes(String(set.prompt_mode)) ? set.prompt_mode : "legacy",
        ["queued", "refining", "generating", "completed", "partial", "failed", "superseded"].includes(String(set.status)) ? set.status : "failed",
        Boolean(set.is_active), String(set.character_visual_reference ?? ""), portableDate(set.created_at),
        set.completed_at ? portableDate(set.completed_at) : null]
    );
  }
  for (const segmentValue of unknownArray(archiveRecords.illustrationSegments)) {
    const segment = unknownRecord(segmentValue);
    await database.query(
      `INSERT INTO turn_illustration_segments (
         id,owner_user_id,illustration_set_id,campaign_id,turn_id,ordinal,start_offset,end_offset,start_word,end_word,
         source_text,source_text_hash,direct_prompt,resolved_prompt,prompt_source,status,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)`,
      [requireRichId(maps.illustrationSegment, segment.id), input.owner.ownerUserId,
        requireRichId(maps.illustrationSet, segment.illustration_set_id), campaignId,
        requireRichId(maps.turn, segment.turn_id), Number(segment.ordinal ?? 0), Number(segment.start_offset ?? 0),
        Number(segment.end_offset ?? 0), Number(segment.start_word ?? 0), Number(segment.end_word ?? 0),
        String(segment.source_text ?? ""), String(segment.source_text_hash ?? ""), String(segment.direct_prompt ?? ""),
        String(segment.resolved_prompt ?? ""), ["direct", "ai_refined", "ai_fallback", "legacy"].includes(String(segment.prompt_source)) ? segment.prompt_source : "legacy",
        ["queued", "refining", "generating", "completed", "recoverable", "failed"].includes(String(segment.status)) ? segment.status : "failed",
        portableDate(segment.created_at)]
    );
  }
  for (const costValue of unknownArray(archiveRecords.costs)) {
    const cost = unknownRecord(costValue);
    await database.query(
      `INSERT INTO provider_cost_events (
         owner_user_id,campaign_id,turn_id,local_call_id,provider_type,category,operation,requested_model,
         resolved_model,amount,currency,usage_metadata,occurred_at,created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$13)`,
      [input.owner.ownerUserId, campaignId, cost.turn_id ? requireRichId(maps.turn, cost.turn_id) : null,
        randomUUID(), String(cost.provider_type ?? "openai_compatible"),
        ["story", "image", "memory"].includes(String(cost.category)) ? cost.category : "image",
        String(cost.operation ?? "illustration"), String(cost.requested_model ?? ""), String(cost.resolved_model ?? ""),
        String(cost.amount ?? "0"), /^[A-Z]{3}$/u.test(String(cost.currency)) ? cost.currency : "USD",
        jsonValue(cost.usage_metadata, {}), portableDate(cost.occurred_at)]
    );
  }
  const restoredAssets = await restoreRichPortableAssets(
    database, input.owner.ownerUserId, input.destination.worldId, input.destination.worldVersionId,
    campaignId, maps, input.publishedAssets,
  );
  if (input.createdWorld) {
    await database.query(
      "UPDATE world_versions SET content=$2::jsonb WHERE id=$1 AND owner_user_id=$3",
      [input.destination.worldVersionId, JSON.stringify(rewritePortableAssetPointers(worldPayload.content, restoredAssets.assetIds)), input.owner.ownerUserId]
    );
  }
  const stats = {
    turnCount: turns.length,
    memoryCount: chronicle.memories.length,
    summaryCount: chronicle.summaries.length,
    assetCount: input.publishedAssets.length,
    assetBytes: input.publishedAssets.reduce((sum, asset) => sum + asset.result.byteLength, 0)
  };
  await database.query(
    `UPDATE imports SET status='completed',world_id=$2,world_version_id=$3,campaign_id=$4,
       stats=$5::jsonb,completed_at=clock_timestamp()
     WHERE id=$1 AND owner_user_id=$6 AND status='processing'`,
    [importId, input.destination.worldId, input.destination.worldVersionId, campaignId,
      JSON.stringify(stats), input.owner.ownerUserId]
  );
  return {
    importId,
    importedRecordId: importId,
    worldId: input.destination.worldId,
    worldVersionId: input.destination.worldVersionId,
    campaignId,
    duplicate: false,
    normalizedChildBindings: restoredAssets.childBindings,
    result: {
      importId, worldId: input.destination.worldId, worldVersionId: input.destination.worldVersionId,
      campaignId, duplicate: false, stats
    }
  };
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
  input: Omit<Parameters<PrivatePortableFamilyMutationPort["commitLegacyStory"]>[1], "publishedAssets">,
  sourceType: "portable_legacy_story" | "portable_story_text" | "portable_campaign_zip",
  publishedAssets: readonly (
    import("../../application/src/assets/private-asset-publication.js").PrivateAssetPublicationResult
    | import("../../application/src/imports/private-portable-composition.js").PrivatePortablePublishedAsset
  )[] = [],
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
  const campaignId = input.targetPlan?.campaignId ?? randomUUID();
  await database.query(
    `INSERT INTO campaigns (id,owner_user_id,world_version_id,title,active_turn_number,legacy_settings)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [campaignId, input.owner.ownerUserId, input.destination.worldVersionId, title, story.turns.length, JSON.stringify(story.settings ?? {})]
  );
  if (input.targetPlan && input.targetPlan.turns.length !== story.turns.length) {
    throw new Error("portable_import_reference_invalid");
  }
  const publicationResults = publishedAssets.map((asset) => "result" in asset ? asset.result : asset);
  const publicationByHash = new Map(publicationResults.map((asset) => [asset.contentHash, asset]));
  const publicationBySourceKey = new Map<string, (typeof publicationResults)[number]>();
  for (const publication of publishedAssets) {
    if (!("result" in publication)) continue;
    for (const sourceKey of publication.sourceKeys ?? []) {
      for (const key of portableLegacyAssetLookupKeys(sourceKey)) publicationBySourceKey.set(key, publication.result);
    }
  }
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
  const sourceTurnIds = new Map<string, string>();
  for (const [index, turnValue] of story.turns.entries()) {
    const turn = turnValue as Readonly<Record<string, unknown>>;
    const sourceTurnId = typeof turn.id === "string" ? turn.id : null;
    const externalImageUrl = safePortableExternalImageUrl(turn.imageUrl);
    const plannedTurn = input.targetPlan?.turns[index];
    if (plannedTurn && (plannedTurn.ordinal !== index || plannedTurn.sourceTurnId !== sourceTurnId)) {
      throw new Error("portable_import_reference_invalid");
    }
    const turnId = plannedTurn?.targetTurnId ?? randomUUID();
    await database.query(
      `INSERT INTO turns (
         id,owner_user_id,campaign_id,turn_number,source_turn_id,action,narration,choices,
         custom_action_suggestion,image_prompt,image_url,mechanics_private,
         state_snapshot_private,model_metadata,import_metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,NULL,$12::jsonb,'{}'::jsonb,$13::jsonb)`,
      [
        turnId,
        input.owner.ownerUserId,
        campaignId,
        index + 1,
        sourceTurnId,
        typeof turn.action === "string" ? turn.action : "",
        narration(turn),
        JSON.stringify(Array.isArray(turn.choices) ? turn.choices.slice(0, 4) : []),
        typeof turn.customActionSuggestion === "string" ? turn.customActionSuggestion : "",
        typeof turn.imagePrompt === "string" ? turn.imagePrompt : "",
        externalImageUrl,
        JSON.stringify(turn.worldStateSnapshot ?? {}),
        JSON.stringify({ importedFrom: sourceType, sourceTurnId: turn.id ?? null })
      ]
    );
    turnIds.push(turnId);
    if (typeof turn.id === "string") sourceTurnIds.set(turn.id, turnId);
    const ordinalAsset = publishedAssets.find((publication) => (
      "result" in publication
      && publication.legacyTurnBindings?.some((binding) => binding.turnOrdinal === index)
    ));
    const inlineAsset = publicationByHash.get(portableDataImageHash(turn.imageUrl) ?? "");
    const companionAsset = externalImageUrl || isPortableAbsoluteImageValue(turn.imageUrl)
      ? undefined
      : portableLegacyAssetLookupKeys(turn.imageUrl)
        .map((key) => publicationBySourceKey.get(key)).find(Boolean);
    const turnAsset = ordinalAsset && "result" in ordinalAsset
      ? ordinalAsset.result
      : inlineAsset ?? companionAsset;
    if (turnAsset) {
      const normalizedPublication = publishedAssets.find((publication) => (
        "result" in publication
        && publication.result.assetId === turnAsset.assetId
        && publication.normalizedChildren
      ));
      if (!normalizedPublication) {
        await database.query(
          `INSERT INTO asset_references (owner_user_id,asset_id,campaign_id,turn_id,asset_role)
           VALUES ($1,$2,$3,$4,'turn_illustration') ON CONFLICT DO NOTHING`,
          [input.owner.ownerUserId, turnAsset.assetId, campaignId, turnId]
        );
      }
      await database.query(
        "UPDATE turns SET image_url=$2 WHERE id=$1 AND owner_user_id=$3",
        [turnId, `/api/v1/assets/${turnAsset.assetId}`, input.owner.ownerUserId]
      );
    }
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
        turnId,
        index + 1,
        fiction,
        Math.ceil(fiction.length / 4),
        JSON.stringify({ imported: true })
      ]
    );
  }
  const normalizedChildBindings = [];
  for (const publication of publishedAssets) {
    if ("result" in publication && publication.normalizedChildren) {
      normalizedChildBindings.push(await attachNormalizedPortableChildren(
        database,
        input.owner.ownerUserId,
        publication,
      ));
    } else {
      const asset = "result" in publication ? publication.result : publication;
      await database.query(
        `INSERT INTO asset_references (owner_user_id,asset_id,campaign_id,asset_role)
         VALUES ($1,$2,$3,'import_attachment') ON CONFLICT DO NOTHING`,
        [input.owner.ownerUserId, asset.assetId, campaignId]
      );
      normalizedChildBindings.push(Object.freeze({ contexts: Object.freeze([]), references: Object.freeze([]) }));
    }
  }
  const worldCoverAssetIds = new Set(publishedAssets.flatMap((publication) => (
    "result" in publication
      && publication.records.some((record) => record.bindings.some((binding) => binding.role === "world_cover"))
      ? [publication.result.assetId]
      : []
  )));
  if (worldCoverAssetIds.size > 1) throw new Error("portable_import_reference_invalid");
  const worldCoverAssetId = [...worldCoverAssetIds][0];
  if (worldCoverAssetId) {
    const updatedCover = await database.query(
      `UPDATE worlds
          SET cover_asset_id=$3,updated_at=clock_timestamp()
        WHERE id=$1 AND owner_user_id=$2`,
      [input.destination.worldId, input.owner.ownerUserId, worldCoverAssetId],
    );
    if (updatedCover.rowCount !== 1) throw new Error("portable_import_destination_invalid");
  }
  if (sourceType === "portable_campaign_zip") {
    for (const publication of publishedAssets) {
      if (!("result" in publication) || publication.normalizedChildren) continue;
      for (const record of publication.records) {
        for (const binding of record.bindings) {
          if (binding.role !== "turn_illustration") continue;
          const turnId = sourceTurnIds.get(binding.turnId);
          if (!turnId) throw new Error("portable_import_reference_invalid");
          if (!publication.normalizedChildren) {
            await database.query(
              `INSERT INTO asset_references (owner_user_id,asset_id,campaign_id,turn_id,asset_role)
               VALUES ($1,$2,$3,$4,'turn_illustration') ON CONFLICT DO NOTHING`,
              [input.owner.ownerUserId, publication.result.assetId, campaignId, turnId]
            );
          }
          await database.query(
            "UPDATE turns SET image_url=$2 WHERE id=$1 AND owner_user_id=$3",
            [turnId, `/api/v1/assets/${publication.result.assetId}`, input.owner.ownerUserId]
          );
        }
      }
    }
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
    assetCount: publicationResults.length,
    assetBytes: publicationResults.reduce((sum, asset) => sum + asset.byteLength, 0)
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
    normalizedChildBindings: Object.freeze(normalizedChildBindings),
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
      const richArchive = input.payload.archiveFormat === "manifest_v1";
      const richPublishedAssets = input.publishedAssets.filter(
        (asset): asset is import("../../application/src/imports/private-portable-composition.js").PrivatePortablePublishedAsset => "result" in asset,
      );
      if (input.destination.kind === "embedded") {
        const request = worldImportRequestSchema.parse(input.payload.embeddedWorldImportRequest);
        const imported = await runPostgresWorldCampaignCommandWithClient(
          client,
          (transaction) => input.targetPlan
            ? importPrivatePortableWorldAtExactTarget(transaction, input.owner, request, {
              worldId: input.targetPlan.worldId,
              worldVersionId: input.targetPlan.worldVersionId,
              sourceHash: `portable-campaign-world:${input.authorityFingerprint}`
            })
            : worlds.importWorld(transaction, input.owner, request),
        );
        if (!imported.ok) throw new Error(`portable_world_import_${imported.failure.reason}`);
        if (input.targetPlan && (imported.value.worldId !== input.targetPlan.worldId
          || imported.value.worldVersionId !== input.targetPlan.worldVersionId)) {
          throw new Error("portable_import_target_plan_invalid");
        }
        if (richArchive) {
          if (richPublishedAssets.length !== input.publishedAssets.length) {
            throw new Error("portable_import_asset_mapping_invalid");
          }
          return commitRichPortableCampaign(client, {
            ...input,
            destination: {
              kind: "existing_world_version",
              worldId: imported.value.worldId,
              worldVersionId: imported.value.worldVersionId
            },
            publishedAssets: richPublishedAssets,
            createdWorld: !imported.value.duplicate
          });
        }
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
      if (richArchive) {
        if (input.destination.kind !== "existing_world_version") {
          throw new Error("portable_import_destination_invalid");
        }
        if (richPublishedAssets.length !== input.publishedAssets.length) {
          throw new Error("portable_import_asset_mapping_invalid");
        }
        return commitRichPortableCampaign(client, {
          ...input,
          destination: input.destination,
          publishedAssets: richPublishedAssets,
          createdWorld: false
        });
      }
      return commitPortableCampaign(
        client,
        input,
        "portable_campaign_zip",
        input.publishedAssets,
      );
    },
    commitLegacyStory(database, input) {
      return commitPortableCampaign(
        portableDatabaseClient(database),
        input,
        "portable_legacy_story",
        input.publishedAssets ?? [],
      );
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
