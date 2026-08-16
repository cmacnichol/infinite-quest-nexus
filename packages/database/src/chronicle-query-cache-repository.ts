import { createHash } from "node:crypto";
import type { DatabaseClient } from "./pool.js";

const CACHE_ENTRY_LIMIT = 256;
const CACHE_LIFETIME = "7 days";
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const PROTOCOL_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,199}$/u;

export type ChronicleQueryEmbeddingCacheScope = Readonly<{
  ownerUserId: string;
  campaignId: string;
}>;

export type ChronicleQueryEmbeddingCacheKey = Readonly<{
  normalizedQueryHash: string;
  providerProfileId: string;
  model: string;
  providerFingerprint: string;
  queryPrefixHash: string;
  embeddingProtocolVersion: string;
}>;

export type ChronicleQueryEmbeddingCacheRepository = Readonly<{
  getQueryEmbedding(
    scope: ChronicleQueryEmbeddingCacheScope,
    key: ChronicleQueryEmbeddingCacheKey,
  ): Promise<readonly number[] | null>;
  putQueryEmbedding(
    scope: ChronicleQueryEmbeddingCacheScope,
    key: ChronicleQueryEmbeddingCacheKey,
    vector: readonly number[],
  ): Promise<void>;
}>;

type CacheDiagnosticContext = Readonly<{
  campaignId: string;
  cacheOperation: "get" | "put";
}>;

type ChronicleQueryCacheDependencies = Readonly<{
  logDiagnostic?: (error: unknown, context: CacheDiagnosticContext) => void;
}>;

type CacheRow = Readonly<{
  embedding: unknown;
  embedding_dimensions: number;
}>;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

function parseVector(value: unknown, expectedDimensions: number): readonly number[] | null {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed)
    || parsed.length !== expectedDimensions
    || parsed.length < 1
    || parsed.length > 16_000
    || !parsed.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
    return null;
  }
  return parsed;
}

function safeKey(scope: ChronicleQueryEmbeddingCacheScope, key: ChronicleQueryEmbeddingCacheKey): boolean {
  return typeof scope.ownerUserId === "string" && scope.ownerUserId.length > 0
    && typeof scope.campaignId === "string" && scope.campaignId.length > 0
    && HASH_PATTERN.test(key.normalizedQueryHash)
    && typeof key.providerProfileId === "string" && key.providerProfileId.length > 0
    && typeof key.model === "string" && key.model.trim().length > 0 && key.model.length <= 500
    && typeof key.providerFingerprint === "string"
    && key.providerFingerprint.length > 0 && key.providerFingerprint.length <= 512
    && HASH_PATTERN.test(key.queryPrefixHash)
    && PROTOCOL_PATTERN.test(key.embeddingProtocolVersion);
}

function safeVector(vector: readonly number[]): boolean {
  return Array.isArray(vector)
    && vector.length > 0
    && vector.length <= 16_000
    && vector.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

function diagnostic(
  dependencies: ChronicleQueryCacheDependencies,
  scope: ChronicleQueryEmbeddingCacheScope,
  operation: "get" | "put",
): void {
  try {
    dependencies.logDiagnostic?.(new Error("chronicle_query_embedding_cache_failed"), {
      campaignId: scope.campaignId,
      cacheOperation: operation
    });
  } catch {
    // Cache diagnostics are best-effort; the cache must never affect retrieval.
  }
}

function keyValues(scope: ChronicleQueryEmbeddingCacheScope, key: ChronicleQueryEmbeddingCacheKey): unknown[] {
  return [
    scope.ownerUserId,
    scope.campaignId,
    key.normalizedQueryHash,
    key.providerProfileId,
    digest(key.model),
    digest(key.providerFingerprint),
    key.queryPrefixHash,
    key.embeddingProtocolVersion
  ];
}

async function recoverSavepoint(client: DatabaseClient, savepoint: string): Promise<void> {
  try {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  } catch {
    // The caller owns the surrounding transaction and decides how to recover it.
  }
}

export function createPostgresChronicleQueryCacheRepository(
  client: DatabaseClient,
  dependencies: ChronicleQueryCacheDependencies = {},
): ChronicleQueryEmbeddingCacheRepository {
  return {
    async getQueryEmbedding(scope, key) {
      if (!safeKey(scope, key)) {
        diagnostic(dependencies, scope, "get");
        return null;
      }
      const savepoint = "chronicle_query_embedding_cache_get";
      try {
        await client.query(`SAVEPOINT ${savepoint}`);
        const result = await client.query<CacheRow>(
          `UPDATE chronicle_query_embedding_cache
              SET last_accessed_at=clock_timestamp(),hit_count=hit_count+1
            WHERE owner_user_id=$1 AND campaign_id=$2 AND normalized_query_hash=$3
              AND provider_profile_id=$4 AND embedding_model_hash=$5
              AND provider_fingerprint_hash=$6 AND query_prefix_hash=$7
              AND embedding_protocol_version=$8 AND expires_at>clock_timestamp()
          RETURNING embedding::text,embedding_dimensions`,
          keyValues(scope, key)
        );
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        const row = result.rows[0];
        if (!row) return null;
        const vector = parseVector(row.embedding, row.embedding_dimensions);
        if (!vector) {
          diagnostic(dependencies, scope, "get");
          return null;
        }
        return vector;
      } catch {
        await recoverSavepoint(client, savepoint);
        diagnostic(dependencies, scope, "get");
        return null;
      }
    },

    async putQueryEmbedding(scope, key, vector) {
      if (!safeKey(scope, key) || !safeVector(vector)) {
        diagnostic(dependencies, scope, "put");
        return;
      }
      const savepoint = "chronicle_query_embedding_cache_put";
      try {
        await client.query(`SAVEPOINT ${savepoint}`);
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`chronicle-query-cache:${scope.ownerUserId}:${scope.campaignId}`]
        );
        await client.query(
          `INSERT INTO chronicle_query_embedding_cache
             (owner_user_id,campaign_id,normalized_query_hash,provider_profile_id,
              embedding_model_hash,provider_fingerprint_hash,query_prefix_hash,
              embedding_protocol_version,embedding,embedding_dimensions,created_at,last_accessed_at,expires_at,hit_count)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::vector,$10,clock_timestamp(),clock_timestamp(),
                  clock_timestamp()+$11::interval,0)
           ON CONFLICT (owner_user_id,campaign_id,normalized_query_hash,provider_profile_id,
                        embedding_model_hash,provider_fingerprint_hash,query_prefix_hash,embedding_protocol_version)
           DO UPDATE SET embedding=EXCLUDED.embedding,embedding_dimensions=EXCLUDED.embedding_dimensions,
                         created_at=EXCLUDED.created_at,last_accessed_at=EXCLUDED.last_accessed_at,
                         expires_at=EXCLUDED.expires_at,hit_count=0`,
          [...keyValues(scope, key), vectorLiteral(vector), vector.length, CACHE_LIFETIME]
        );
        await client.query(
          `DELETE FROM chronicle_query_embedding_cache
            WHERE owner_user_id=$1 AND campaign_id=$2 AND expires_at<=clock_timestamp()`,
          [scope.ownerUserId, scope.campaignId]
        );
        await client.query(
          `DELETE FROM chronicle_query_embedding_cache
            WHERE id IN (
              SELECT id FROM chronicle_query_embedding_cache
               WHERE owner_user_id=$1 AND campaign_id=$2
               ORDER BY last_accessed_at DESC,created_at DESC,id DESC
               OFFSET $3
            )`,
          [scope.ownerUserId, scope.campaignId, CACHE_ENTRY_LIMIT]
        );
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      } catch {
        await recoverSavepoint(client, savepoint);
        diagnostic(dependencies, scope, "put");
      }
    }
  };
}
