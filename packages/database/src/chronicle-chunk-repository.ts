import { randomUUID } from "node:crypto";
import type {
  CampaignWorldVersionMemoryScope,
  ChronicleChunkBatchPort,
  ChronicleChunkJobProgress,
  ChronicleChunkJobStatePort,
  ChronicleChunkLeaseScope,
  ChronicleChunkParentPort,
  MemoryTransactionContext
} from "../../application/src/memory/index.js";
import type { ChronicleTransactionEmbeddingPort } from "./chronicle-repository.js";
import {
  CHRONICLE_CHUNK_PROTOCOL_VERSION,
  sanitizeChronicleChunkSkipReason
} from "../../domain/src/chronicle-chunking.js";
import { toSafeProviderConfiguration } from "../../application/src/providers/index.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";
import { withTransaction } from "./pool.js";

type ChunkJobRow = Readonly<{
  id: string;
  owner_user_id: string;
  campaign_id: string;
  world_version_id: string;
  work_version: number | string;
  progress: Record<string, unknown>;
}>;

type ChunkParentRow = Readonly<{
  id: string;
  ordinal: number;
  memory_kind: "turn_fiction" | "legacy_summary" | "campaign_summary" | "canonical_fact" | "open_thread";
  content: string;
  content_hash: string;
  entities: string[];
  entity_ids: string[];
  metadata: Record<string, unknown>;
}>;

type ChunkConfigRow = Readonly<{
  embedding_enabled: boolean;
  embedding_provider_profile_id: string | null;
  embedding_model: string;
  embedding_batch_size: number;
  embedding_document_prefix: string | null;
  embedding_query_prefix: string | null;
  retrieval_implementation: "legacy_hybrid" | "chunked_hybrid";
  retrieval_shadow_enabled: boolean;
}>;

type ChunkCapabilityRow = Readonly<{
  context_window_tokens: number;
  request_timeout_ms: number;
  configuration: unknown;
}>;

export type ChronicleChunkBatchDependencies = Readonly<{
  recordCost: ChronicleTransactionEmbeddingPort["recordCost"];
}>;

function invalid(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function transactionClient(database: MemoryTransactionContext): DatabaseClient {
  const client = database as Partial<DatabaseClient>;
  if (!client || typeof client.query !== "function") throw invalid("A caller-owned Chronicle transaction is required.");
  return client as DatabaseClient;
}

function nonNegativeInteger(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function durableProgress(value: Record<string, unknown> | null | undefined): ChronicleChunkJobProgress {
  return Object.freeze({
    parentCursor: nullableString(value?.parentCursor),
    processedParents: nonNegativeInteger(value?.processedParents),
    embeddedChunks: nonNegativeInteger(value?.embeddedChunks),
    skippedChunks: nonNegativeInteger(value?.skippedChunks),
    totalParents: nonNegativeInteger(value?.totalParents),
    capabilityFingerprint: nullableString(value?.capabilityFingerprint)
  });
}

function claimed(
  row: ChunkJobRow,
  workerId: string,
  leaseToken: string,
  leaseSeconds: number,
): ChronicleChunkLeaseScope {
  return {
    jobId: row.id,
    ownerUserId: row.owner_user_id,
    campaignId: row.campaign_id,
    worldVersionId: row.world_version_id,
    jobType: "index_memory_chunks_v2",
    workVersion: Number(row.work_version),
    workerId,
    leaseToken,
    leaseSeconds,
    progress: durableProgress(row.progress)
  };
}

function parseCursor(cursor: string | null | undefined): { ordinal: number; id: string } | null {
  if (!cursor) return null;
  const [ordinalText, id] = cursor.split(":", 2);
  const ordinal = Number(ordinalText);
  if (!Number.isSafeInteger(ordinal)
    || !id
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) {
    throw invalid("Invalid Chronicle chunk parent cursor.");
  }
  return { ordinal, id };
}

function parentCursor(ordinal: number, id: string): string {
  return `${ordinal}:${id}`;
}

function vectorLiteral(vector: readonly number[]): string {
  if (!vector.length || vector.some((coordinate) => !Number.isFinite(coordinate))) {
    throw invalid("Chronicle chunk embedding dimensions are invalid.");
  }
  return `[${vector.join(",")}]`;
}

async function loadConfig(
  database: DatabasePool | DatabaseClient,
  scope: Readonly<{ ownerUserId: string; campaignId: string }>,
): Promise<ChunkConfigRow | null> {
  const result = await database.query<ChunkConfigRow>(
    `SELECT embedding_enabled, embedding_provider_profile_id, embedding_model, embedding_batch_size,
            embedding_document_prefix, embedding_query_prefix, retrieval_implementation,
            retrieval_shadow_enabled
       FROM campaign_memory_configs
      WHERE campaign_id = $1 AND owner_user_id = $2`,
    [scope.campaignId, scope.ownerUserId]
  );
  return result.rows[0] ?? null;
}

/** Enqueues only the separate v2 job table, preserving progress when authoritative parents are unchanged. */
export async function enqueuePostgresChronicleChunkIndex(
  database: DatabasePool | DatabaseClient,
  scope: CampaignWorldVersionMemoryScope,
  options: Readonly<{ forceNewWork?: boolean }> = {},
): Promise<string | null> {
  const eligibility = await database.query<ChunkConfigRow & Readonly<{ world_version_id: string }>>(
    `SELECT c.world_version_id, config.embedding_enabled, config.embedding_provider_profile_id,
            config.embedding_model, config.embedding_batch_size, config.embedding_document_prefix,
            config.embedding_query_prefix, config.retrieval_implementation, config.retrieval_shadow_enabled
       FROM campaigns c
       JOIN campaign_memory_configs config
         ON config.campaign_id = c.id AND config.owner_user_id = c.owner_user_id
      WHERE c.id = $1 AND c.owner_user_id = $2 AND c.world_version_id = $3`,
    [scope.campaignId, scope.ownerUserId, scope.worldVersionId]
  );
  const config = eligibility.rows[0];
  if (!config || (!config.embedding_enabled && !config.retrieval_shadow_enabled)) return null;
  const result = await database.query<{ id: string }>(
    `WITH desired AS (
       SELECT encode(digest(
                c.world_version_id::text || E'\\x1f' ||
                COALESCE(string_agg(
                  m.ordinal::text || ':' || m.id::text || ':' || m.content_hash,
                  E'\\x1e' ORDER BY m.ordinal,m.id
                ), ''),
                'sha256'
              ), 'hex') AS work_signature
         FROM campaigns c
         LEFT JOIN chronicle_memories m
           ON m.campaign_id=c.id AND m.owner_user_id=c.owner_user_id
          AND m.world_version_id=c.world_version_id
        WHERE c.id=$2 AND c.owner_user_id=$1 AND c.world_version_id=$3
        GROUP BY c.world_version_id
     ), resumable AS (
       /* The signature of the parents at or before each job's durable cursor. When it still
          matches the signature recorded when that cursor was written, every already-processed
          parent is unchanged and the cursor remains valid, so an unrelated tail change must not
          restart a long backfill from zero. */
       SELECT j.id,
              encode(digest(
                COALESCE(string_agg(
                  m.ordinal::text || ':' || m.id::text || ':' || m.content_hash,
                  E'\\x1e' ORDER BY m.ordinal,m.id
                ), ''),
                'sha256'
              ), 'hex') AS processed_signature
         FROM chronicle_chunk_jobs j
         LEFT JOIN chronicle_memories m
           ON m.campaign_id=j.campaign_id AND m.owner_user_id=j.owner_user_id
          AND m.world_version_id=$3
          AND (m.ordinal < split_part(j.progress->>'parentCursor',':',1)::integer
               OR (m.ordinal = split_part(j.progress->>'parentCursor',':',1)::integer
                   AND m.id <= split_part(j.progress->>'parentCursor',':',2)::uuid))
        WHERE j.campaign_id=$2 AND j.owner_user_id=$1
          AND j.status IN ('queued','running')
          AND j.progress->>'parentCursor' IS NOT NULL
        GROUP BY j.id
     ), upserted AS (
       INSERT INTO chronicle_chunk_jobs
         (owner_user_id,campaign_id,job_type,status,progress,work_signature)
       SELECT $1,$2,'index_memory_chunks_v2','queued','{}'::jsonb,work_signature
         FROM desired
       ON CONFLICT (campaign_id) WHERE status IN ('queued','running')
       DO UPDATE SET work_version=chronicle_chunk_jobs.work_version+1,
                     work_signature=EXCLUDED.work_signature,
                     progress=CASE
                       WHEN NOT $4::boolean
                        AND chronicle_chunk_jobs.processed_signature IS NOT NULL
                        AND chronicle_chunk_jobs.processed_signature
                            = (SELECT r.processed_signature FROM resumable r
                                WHERE r.id=chronicle_chunk_jobs.id)
                       THEN chronicle_chunk_jobs.progress
                       ELSE '{}'::jsonb
                     END,
                     processed_signature=CASE
                       WHEN NOT $4::boolean
                        AND chronicle_chunk_jobs.processed_signature IS NOT NULL
                        AND chronicle_chunk_jobs.processed_signature
                            = (SELECT r.processed_signature FROM resumable r
                                WHERE r.id=chronicle_chunk_jobs.id)
                       THEN chronicle_chunk_jobs.processed_signature
                       ELSE NULL
                     END,
                     error_message=NULL,completed_at=NULL,
                     updated_at=clock_timestamp()
       WHERE $4::boolean
          OR chronicle_chunk_jobs.work_signature IS DISTINCT FROM EXCLUDED.work_signature
       RETURNING id
     )
     SELECT id FROM upserted
     UNION ALL
     SELECT j.id
       FROM chronicle_chunk_jobs j
       JOIN desired d ON d.work_signature=j.work_signature
      WHERE j.campaign_id=$2 AND j.owner_user_id=$1
        AND j.status IN ('queued','running')
        AND NOT EXISTS (SELECT 1 FROM upserted)
     LIMIT 1`,
    [scope.ownerUserId, scope.campaignId, scope.worldVersionId, options.forceNewWork === true]
  );
  return result.rows[0]?.id ?? null;
}

export function createPostgresChronicleChunkJobStatePort(pool: DatabasePool): ChronicleChunkJobStatePort {
  return {
    async claimNext(request) {
      if (!Number.isSafeInteger(request.leaseSeconds) || request.leaseSeconds < 1 || !request.workerId.trim()) {
        throw invalid("Chronicle chunk claim parameters are invalid.");
      }
      return withTransaction(pool, async (client) => {
        const leaseToken = randomUUID();
        const result = await client.query<ChunkJobRow>(
          `WITH candidate AS (
             SELECT j.id
               FROM chronicle_chunk_jobs j
               JOIN campaigns c ON c.id = j.campaign_id AND c.owner_user_id = j.owner_user_id
              WHERE j.status = 'queued'
                 OR (j.status = 'running' AND j.lease_expires_at < clock_timestamp())
              ORDER BY j.created_at, j.id
              FOR UPDATE OF j, c SKIP LOCKED
              LIMIT 1
           )
           UPDATE chronicle_chunk_jobs j
              SET status = 'running', attempts = attempts + 1, lease_owner = $1, lease_token=$3,
                  lease_expires_at = clock_timestamp() + ($2::text || ' seconds')::interval,
                  updated_at = clock_timestamp()
             FROM candidate
            WHERE j.id = candidate.id
           RETURNING j.id, j.owner_user_id, j.campaign_id,
                     (SELECT c.world_version_id FROM campaigns c
                       WHERE c.id = j.campaign_id AND c.owner_user_id = j.owner_user_id) AS world_version_id,
                     j.work_version, j.progress`,
          [request.workerId, request.leaseSeconds, leaseToken]
        );
        const row = result.rows[0];
        return row ? claimed(row, request.workerId, leaseToken, request.leaseSeconds) : null;
      });
    },
    async loadClaimedJob(scope) {
      const result = await pool.query<ChunkJobRow>(
        `SELECT j.id,j.owner_user_id,j.campaign_id,c.world_version_id,j.work_version,j.progress
           FROM chronicle_chunk_jobs j
           JOIN campaigns c ON c.id=j.campaign_id AND c.owner_user_id=j.owner_user_id
          WHERE j.id=$1 AND j.owner_user_id=$2 AND j.campaign_id=$3 AND c.world_version_id=$4
            AND j.job_type='index_memory_chunks_v2' AND j.status='running'
            AND j.lease_owner=$5 AND j.work_version=$6 AND j.lease_token=$7
            AND j.lease_expires_at>=clock_timestamp()`,
        [scope.jobId, scope.ownerUserId, scope.campaignId, scope.worldVersionId,
          scope.workerId, scope.workVersion, scope.leaseToken]
      );
      const row = result.rows[0];
      return row ? claimed(row, scope.workerId, scope.leaseToken, scope.leaseSeconds) : null;
    },
    async heartbeatClaim(scope) {
      const result = await pool.query(
        `UPDATE chronicle_chunk_jobs j
            SET lease_expires_at=clock_timestamp()+($7::text || ' seconds')::interval,
                updated_at=clock_timestamp()
          WHERE j.id=$1 AND j.owner_user_id=$2 AND j.campaign_id=$3 AND j.lease_owner=$4
            AND j.status='running' AND j.work_version=$5 AND j.lease_token=$8
            AND j.lease_expires_at>=clock_timestamp()
            AND EXISTS (SELECT 1 FROM campaigns c
                         WHERE c.id=$3 AND c.owner_user_id=$2 AND c.world_version_id=$6)`,
        [scope.jobId, scope.ownerUserId, scope.campaignId, scope.workerId, scope.workVersion,
          scope.worldVersionId, scope.leaseSeconds, scope.leaseToken]
      );
      return result.rowCount === 1;
    },
    async completeClaim(scope, completion) {
      const result = await pool.query(
        `UPDATE chronicle_chunk_jobs j
            SET status=CASE WHEN work_version>$5 THEN 'queued' ELSE 'completed' END,
                completed_at=CASE WHEN work_version>$5 THEN NULL ELSE clock_timestamp() END,
                progress=CASE WHEN work_version>$5 THEN '{}'::jsonb ELSE $6::jsonb END,
                lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL, error_message=NULL,
                updated_at=clock_timestamp()
          WHERE j.id=$1 AND j.owner_user_id=$2 AND j.campaign_id=$3 AND j.lease_owner=$4
            AND j.status='running' AND j.work_version>=$5 AND j.lease_token=$8
            AND j.lease_expires_at>=clock_timestamp()
            AND EXISTS (SELECT 1 FROM campaigns c
                         WHERE c.id=$3 AND c.owner_user_id=$2 AND c.world_version_id=$7)`,
        [scope.jobId, scope.ownerUserId, scope.campaignId, scope.workerId, scope.workVersion,
          JSON.stringify(completion.progress), scope.worldVersionId, scope.leaseToken]
      );
      return result.rowCount === 1;
    },
    async failClaim(scope, failure) {
      const result = await pool.query(
        `UPDATE chronicle_chunk_jobs j
            SET status='failed',error_message=$6,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
                updated_at=clock_timestamp()
          WHERE j.id=$1 AND j.owner_user_id=$2 AND j.campaign_id=$3 AND j.lease_owner=$4
            AND j.status='running' AND j.work_version=$5 AND j.lease_token=$8
            AND j.lease_expires_at>=clock_timestamp()
            AND EXISTS (SELECT 1 FROM campaigns c
                         WHERE c.id=$3 AND c.owner_user_id=$2 AND c.world_version_id=$7)`,
        [scope.jobId, scope.ownerUserId, scope.campaignId, scope.workerId, scope.workVersion,
          failure.diagnosticCode.slice(0, 128), scope.worldVersionId, scope.leaseToken]
      );
      return result.rowCount === 1;
    }
  };
}

export function createPostgresChronicleChunkParentPort(pool: DatabasePool): ChronicleChunkParentPort {
  return {
    async loadForClaim(scope, request) {
      if (!Number.isSafeInteger(request.batchLimit) || request.batchLimit < 1 || request.batchLimit > 128) {
        throw invalid("Chronicle chunk parent batchLimit must be between 1 and 128.");
      }
      if (!await createPostgresChronicleChunkJobStatePort(pool).loadClaimedJob(scope)) {
        throw invalid("Chronicle chunk job lease is unavailable.");
      }
      const cursor = parseCursor(request.cursor);
      // Only parents whose current content is not already terminally chunked are returned.
      // Re-embedding every parent on every job made per-turn indexing cost grow with campaign
      // length, so a long campaign could never finish indexing between accepted turns.
      const result = await pool.query<ChunkParentRow>(
        `SELECT id,ordinal,memory_kind,content,content_hash,entities,entity_ids,metadata
           FROM chronicle_memories parent
          WHERE owner_user_id=$1 AND campaign_id=$2 AND world_version_id=$3
            AND ($4::integer IS NULL OR ordinal>$4 OR (ordinal=$4 AND id>$5::uuid))
            AND NOT EXISTS (
              SELECT 1 FROM chronicle_memory_chunks chunk
               WHERE chunk.parent_memory_id=parent.id
                 AND chunk.owner_user_id=parent.owner_user_id
                 AND chunk.campaign_id=parent.campaign_id
                 AND chunk.world_version_id=parent.world_version_id
                 AND chunk.parent_content_hash=parent.content_hash
                 AND chunk.chunking_protocol_version=$7
                 AND (chunk.embedding_status='embedded' OR chunk.embedding_status='skipped')
            )
          ORDER BY ordinal,id
          LIMIT $6`,
        [scope.ownerUserId, scope.campaignId, scope.worldVersionId,
          cursor?.ordinal ?? null, cursor?.id ?? null, request.batchLimit + 1,
          CHRONICLE_CHUNK_PROTOCOL_VERSION]
      );
      const rows = result.rows.slice(0, request.batchLimit);
      const tail = rows.at(-1);
      const total = await pool.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM chronicle_memories
          WHERE owner_user_id=$1 AND campaign_id=$2 AND world_version_id=$3`,
        [scope.ownerUserId, scope.campaignId, scope.worldVersionId]
      );
      const config = await loadConfig(pool, scope);
      if (!config) throw invalid("Chronicle chunk configuration is unavailable.");
      const capability = config.embedding_enabled && config.embedding_provider_profile_id
        ? await pool.query<ChunkCapabilityRow>(
          `SELECT context_window_tokens,request_timeout_ms,configuration
             FROM provider_profiles
            WHERE id=$1 AND owner_user_id=$2 AND provider_role IN ('text','embedding') AND enabled=true`,
          [config.embedding_provider_profile_id, scope.ownerUserId]
        )
        : null;
      const providerCapability = capability?.rows[0];
      return {
        config: {
          enabled: config.embedding_enabled,
          providerProfileId: config.embedding_provider_profile_id,
          model: config.embedding_model,
          batchSize: config.embedding_batch_size,
          documentPrefix: config.embedding_document_prefix,
          queryPrefix: config.embedding_query_prefix,
          retrievalImplementation: config.retrieval_implementation,
          retrievalShadowEnabled: config.retrieval_shadow_enabled
        },
        providerCapability: providerCapability ? {
          model: config.embedding_model,
          contextWindowTokens: providerCapability.context_window_tokens,
          requestTimeoutMs: providerCapability.request_timeout_ms,
          configuration: toSafeProviderConfiguration(providerCapability.configuration)
        } : null,
        parents: rows.map((row) => ({
          id: row.id,
          ordinal: row.ordinal,
          memoryKind: row.memory_kind,
          content: row.content,
          contentHash: row.content_hash,
          entities: row.entities,
          entityIds: row.entity_ids,
          metadata: row.metadata
        })),
        totalParents: Number(total.rows[0]?.total ?? 0),
        batchLimit: request.batchLimit,
        nextCursor: tail && result.rows.length > request.batchLimit ? parentCursor(tail.ordinal, tail.id) : null
      };
    }
  };
}

function validateProgress(
  previous: ChronicleChunkJobProgress,
  next: ChronicleChunkJobProgress,
  parent: Readonly<{ ordinal: number; id: string }>,
  capabilityFingerprint: string,
  embeddedChunks: number,
  skippedChunks: number,
): void {
  if (next.parentCursor !== parentCursor(parent.ordinal, parent.id)
    || next.processedParents !== previous.processedParents + 1
    || next.embeddedChunks !== previous.embeddedChunks + embeddedChunks
    || next.skippedChunks !== previous.skippedChunks + skippedChunks
    || (previous.totalParents !== 0 && next.totalParents !== previous.totalParents)
    || next.totalParents < next.processedParents
    || next.capabilityFingerprint !== capabilityFingerprint) {
    throw invalid("Chronicle chunk batch progress is stale.");
  }
}

export function createPostgresChronicleChunkBatchPort(
  pool: DatabasePool,
  dependencies: ChronicleChunkBatchDependencies,
): ChronicleChunkBatchPort {
  return {
    async prepareClaim(scope, input) {
      if (!input.capabilityFingerprint.trim()) throw invalid("Chronicle chunk capability fingerprint is required.");
      return withTransaction(pool, async (client) => {
        const active = await client.query<Pick<ChunkJobRow, "progress">>(
          `SELECT j.progress
             FROM chronicle_chunk_jobs j
             JOIN campaigns c ON c.id=j.campaign_id AND c.owner_user_id=j.owner_user_id
            WHERE j.id=$1 AND j.owner_user_id=$2 AND j.campaign_id=$3 AND j.lease_owner=$4
              AND j.status='running' AND j.work_version=$5
              AND j.lease_expires_at>=clock_timestamp() AND c.world_version_id=$6
              AND j.lease_token=$7
            FOR UPDATE OF j,c`,
          [scope.jobId, scope.ownerUserId, scope.campaignId, scope.workerId, scope.workVersion,
            scope.worldVersionId, scope.leaseToken]
        );
        const row = active.rows[0];
        if (!row) return "requeued";
        const progress = durableProgress(row.progress);
        if (progress.capabilityFingerprint && progress.capabilityFingerprint !== input.capabilityFingerprint) {
          await client.query(
            `UPDATE chronicle_memory_chunks
                SET embedding=NULL,embedding_status='pending',embedding_skip_reason=NULL,
                    embedding_provider_profile_id=NULL,embedding_model=NULL,embedding_dimensions=NULL,
                    embedding_protocol_version=NULL,embedding_provider_fingerprint=NULL,
                    embedding_content_hash=NULL,embedding_updated_at=NULL,updated_at=clock_timestamp()
              WHERE owner_user_id=$1 AND campaign_id=$2 AND world_version_id=$3`,
            [scope.ownerUserId, scope.campaignId, scope.worldVersionId]
          );
          await client.query(
            `UPDATE chronicle_chunk_jobs
                SET status='queued',work_version=work_version+1,progress='{}'::jsonb,
                    lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,completed_at=NULL,error_message=NULL,
                    updated_at=clock_timestamp()
              WHERE id=$1 AND owner_user_id=$2 AND campaign_id=$3 AND lease_owner=$4
                AND status='running' AND work_version=$5 AND lease_token=$7
                AND lease_expires_at>=clock_timestamp()
                AND EXISTS (SELECT 1 FROM campaigns c
                             WHERE c.id=$3 AND c.owner_user_id=$2 AND c.world_version_id=$6)`,
            [scope.jobId, scope.ownerUserId, scope.campaignId, scope.workerId,
              scope.workVersion, scope.worldVersionId, scope.leaseToken]
          );
          return "requeued";
        }
        const prepared = { ...progress, capabilityFingerprint: input.capabilityFingerprint };
        const updated = await client.query(
          `UPDATE chronicle_chunk_jobs
              SET progress=$6::jsonb,
                  lease_expires_at=clock_timestamp()+($7::text || ' seconds')::interval,
                  updated_at=clock_timestamp()
            WHERE id=$1 AND owner_user_id=$2 AND campaign_id=$3 AND lease_owner=$4
              AND status='running' AND work_version=$5 AND lease_token=$9
              AND lease_expires_at>=clock_timestamp()
              AND EXISTS (SELECT 1 FROM campaigns c
                           WHERE c.id=$3 AND c.owner_user_id=$2 AND c.world_version_id=$8)`,
          [scope.jobId, scope.ownerUserId, scope.campaignId, scope.workerId, scope.workVersion,
            JSON.stringify(prepared), scope.leaseSeconds, scope.worldVersionId, scope.leaseToken]
        );
        return updated.rowCount === 1 ? "ready" : "requeued";
      });
    },
    async commitParentBatch(scope, input) {
      if (!input.capabilityFingerprint.trim()
        || input.progress.capabilityFingerprint !== input.capabilityFingerprint
        || input.parent.id === ""
        || input.chunks.some((chunk, index) => chunk.chunkIndex !== index)) {
        throw invalid("Chronicle chunk batch is invalid.");
      }
      const embedded = input.chunks.filter((chunk) => chunk.embedding !== null);
      const skipped = input.chunks.filter((chunk) => chunk.skipReason !== null);
      if (embedded.length + skipped.length !== input.chunks.length
        || input.chunks.some((chunk) => (chunk.embedding === null) === (chunk.skipReason === null))) {
        throw invalid("Chronicle chunk terminal state is invalid.");
      }
      const resultEmbeddings = input.results.flatMap((result) => result.embeddings);
      if (resultEmbeddings.length !== embedded.length) {
        throw invalid("Chronicle chunk embedding response is incomplete.");
      }
      const batchDimensions = new Set(embedded.map((chunk) => chunk.embedding!.length));
      if (batchDimensions.size > 1) {
        throw invalid("Chronicle chunk embedding dimensions are inconsistent.");
      }
      for (const [index, chunk] of embedded.entries()) {
        const vector = chunk.embedding!;
        const returned = resultEmbeddings[index]!;
        if (vector.length !== returned.length || vector.some((value, coordinate) => value !== returned[coordinate])) {
          throw invalid("Chronicle chunk embedding response does not match the committed vectors.");
        }
      }

      return withTransaction(pool, async (client) => {
        const active = await client.query<Pick<ChunkJobRow, "progress">>(
          `SELECT j.progress
             FROM chronicle_chunk_jobs j
             JOIN campaigns c ON c.id=j.campaign_id AND c.owner_user_id=j.owner_user_id
            WHERE j.id=$1 AND j.owner_user_id=$2 AND j.campaign_id=$3 AND j.lease_owner=$4
              AND j.status='running' AND j.work_version=$5
              AND j.lease_expires_at>=clock_timestamp() AND c.world_version_id=$6
              AND j.lease_token=$7
            FOR UPDATE OF j,c`,
          [scope.jobId, scope.ownerUserId, scope.campaignId, scope.workerId, scope.workVersion,
            scope.worldVersionId, scope.leaseToken]
        );
        const job = active.rows[0];
        if (!job) return false;
        const previous = durableProgress(job.progress);
        if (previous.parentCursor !== input.previousParentCursor
          || previous.capabilityFingerprint !== input.capabilityFingerprint) {
          throw invalid("Chronicle chunk batch progress is stale.");
        }
        validateProgress(
          previous,
          input.progress,
          input.parent,
          input.capabilityFingerprint,
          embedded.length,
          skipped.length
        );

        const cursor = parseCursor(input.previousParentCursor);
        // Incremental indexing skips parents that are already terminally chunked, so the committed
        // parent is not necessarily the immediate successor of the cursor. Fence on the parent's
        // own identity instead, still requiring it to be strictly ahead of the durable cursor so
        // progress stays monotonic and a stale claimant cannot rewind it.
        const currentParent = await client.query<ChunkParentRow>(
          `SELECT id,ordinal,memory_kind,content,content_hash,entities,entity_ids,metadata
             FROM chronicle_memories
            WHERE owner_user_id=$1 AND campaign_id=$2 AND world_version_id=$3 AND id=$6::uuid
              AND ($4::integer IS NULL OR ordinal>$4 OR (ordinal=$4 AND id>$5::uuid))
            FOR UPDATE`,
          [scope.ownerUserId, scope.campaignId, scope.worldVersionId,
            cursor?.ordinal ?? null, cursor?.id ?? null, input.parent.id]
        );
        const parent = currentParent.rows[0];
        if (!parent
          || parent.id !== input.parent.id
          || parent.content !== input.parent.content
          || parent.content_hash !== input.parent.contentHash) {
          throw invalid("Chronicle chunk parent content changed before batch commit.");
        }
        const config = await loadConfig(client, scope);
        if (!config) throw invalid("Chronicle chunk configuration is unavailable.");
        if (input.provider) {
          if (!config.embedding_enabled
            || config.embedding_provider_profile_id !== input.provider.id
            || config.embedding_model !== input.provider.model
            || !input.providerFingerprint?.trim()) {
            throw invalid("Chronicle chunk provider configuration changed during the claimed job.");
          }
        } else if (config.embedding_enabled || !config.retrieval_shadow_enabled) {
          throw invalid("Chronicle chunk provider is required for this campaign.");
        }
        if (embedded.length) {
          const existingDimensions = await client.query<{ embedding_dimensions: number }>(
            `SELECT DISTINCT embedding_dimensions
               FROM chronicle_memory_chunks
              WHERE owner_user_id=$1 AND campaign_id=$2 AND world_version_id=$3
                AND embedding_status='embedded'
              LIMIT 2`,
            [scope.ownerUserId, scope.campaignId, scope.worldVersionId]
          );
          if (existingDimensions.rows.length > 1
            || (existingDimensions.rows[0]
              && existingDimensions.rows[0].embedding_dimensions !== embedded[0]!.embedding!.length)) {
            throw invalid("Chronicle chunk embedding dimensions changed during indexing.");
          }
        }

        await client.query(
          `DELETE FROM chronicle_memory_chunks
            WHERE parent_memory_id=$1 AND owner_user_id=$2 AND campaign_id=$3 AND world_version_id=$4
              AND (parent_content_hash<>$5 OR chunking_protocol_version<>$7
                   OR NOT (chunk_ordinal=ANY($6::integer[])))`,
          [parent.id, scope.ownerUserId, scope.campaignId, scope.worldVersionId,
            parent.content_hash, input.chunks.map((chunk) => chunk.chunkIndex),
            CHRONICLE_CHUNK_PROTOCOL_VERSION]
        );
        for (const chunk of input.chunks) {
          if (chunk.parentMemoryId !== parent.id || chunk.protocolVersion !== "chronicle-chunk-v1") {
            throw invalid("Chronicle chunk parent scope is invalid.");
          }
          const embedding = chunk.embedding ? vectorLiteral(chunk.embedding) : null;
          const dimensions = chunk.embedding?.length ?? null;
          const skipReason = sanitizeChronicleChunkSkipReason(chunk.skipReason);
          await client.query(
            `INSERT INTO chronicle_memory_chunks (
               owner_user_id,campaign_id,world_version_id,parent_memory_id,parent_content_hash,
               chunking_protocol_version,chunk_ordinal,chunk_kind,content,source_start_offset,
               source_end_offset,token_estimate,entities,entity_ids,metadata,
               embedding,embedding_status,embedding_skip_reason,embedding_provider_profile_id,
               embedding_model,embedding_dimensions,embedding_protocol_version,
               embedding_provider_fingerprint,embedding_content_hash,embedding_updated_at
             ) VALUES (
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,
               $16::vector,$17,$18,$19,$20,$21,$22,$23,$24,CASE WHEN $16::text IS NULL THEN NULL ELSE clock_timestamp() END
             )
             ON CONFLICT (parent_memory_id,parent_content_hash,chunking_protocol_version,chunk_ordinal)
             DO UPDATE SET chunk_kind=EXCLUDED.chunk_kind,content=EXCLUDED.content,
               source_start_offset=EXCLUDED.source_start_offset,source_end_offset=EXCLUDED.source_end_offset,
               token_estimate=EXCLUDED.token_estimate,entities=EXCLUDED.entities,entity_ids=EXCLUDED.entity_ids,
               metadata=EXCLUDED.metadata,embedding=EXCLUDED.embedding,
               embedding_status=EXCLUDED.embedding_status,embedding_skip_reason=EXCLUDED.embedding_skip_reason,
               embedding_provider_profile_id=EXCLUDED.embedding_provider_profile_id,
               embedding_model=EXCLUDED.embedding_model,embedding_dimensions=EXCLUDED.embedding_dimensions,
               embedding_protocol_version=EXCLUDED.embedding_protocol_version,
               embedding_provider_fingerprint=EXCLUDED.embedding_provider_fingerprint,
               embedding_content_hash=EXCLUDED.embedding_content_hash,
               embedding_updated_at=EXCLUDED.embedding_updated_at,updated_at=clock_timestamp()`,
            [scope.ownerUserId, scope.campaignId, scope.worldVersionId, parent.id, parent.content_hash,
              chunk.protocolVersion, chunk.chunkIndex, chunk.kind, chunk.content,
              chunk.sourceStartOffset, chunk.sourceEndOffset, chunk.estimatedTokens,
              parent.entities, parent.entity_ids, JSON.stringify(parent.metadata), embedding,
              chunk.embedding ? "embedded" : "skipped", skipReason,
              chunk.embedding ? input.provider?.id ?? null : null,
              chunk.embedding ? input.provider?.model ?? null : null,
              dimensions, chunk.embedding ? input.embeddingProtocolVersion : null,
              chunk.embedding ? input.providerFingerprint : null,
              chunk.embedding ? chunk.contentHash : null]
          );
        }
        if (input.provider) {
          for (const result of input.results) {
            await dependencies.recordCost(client, input.provider, {
              ownerUserId: scope.ownerUserId,
              campaignId: scope.campaignId,
              operation: "memory_embedding"
            }, result);
          }
        }
        const updated = await client.query(
          `UPDATE chronicle_chunk_jobs
              SET progress=$6::jsonb,
                  /* Recorded with the cursor it describes so a later enqueue can prove the
                     already-processed prefix is unchanged and resume instead of restarting. */
                  processed_signature=(
                    SELECT encode(digest(
                             COALESCE(string_agg(
                               m.ordinal::text || ':' || m.id::text || ':' || m.content_hash,
                               E'\x1e' ORDER BY m.ordinal,m.id
                             ), ''),
                             'sha256'
                           ), 'hex')
                      FROM chronicle_memories m
                     WHERE m.owner_user_id=$2 AND m.campaign_id=$3 AND m.world_version_id=$8
                       AND (m.ordinal < $10::integer
                            OR (m.ordinal = $10::integer AND m.id <= $11::uuid))
                  ),
                  lease_expires_at=clock_timestamp()+($7::text || ' seconds')::interval,
                  updated_at=clock_timestamp()
            WHERE id=$1 AND owner_user_id=$2 AND campaign_id=$3 AND lease_owner=$4
              AND status='running' AND work_version=$5 AND lease_token=$9
              AND lease_expires_at>=clock_timestamp()
              AND EXISTS (SELECT 1 FROM campaigns c
                           WHERE c.id=$3 AND c.owner_user_id=$2 AND c.world_version_id=$8)`,
          [scope.jobId, scope.ownerUserId, scope.campaignId, scope.workerId, scope.workVersion,
            JSON.stringify(input.progress), scope.leaseSeconds, scope.worldVersionId, scope.leaseToken,
            parent.ordinal, parent.id]
        );
        if (updated.rowCount !== 1) throw new Error("Chronicle chunk lease was lost before batch commit.");
        return true;
      });
    }
  };
}
