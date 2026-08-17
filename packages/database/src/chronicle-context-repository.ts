import { createHash } from "node:crypto";
import type { ChronicleContextPreview, MemoryGenerationTransactionPort } from "../../application/src/memory/index.js";
import { requireCampaignWorldVersionScope } from "../../application/src/memory/helpers.js";
import { toSafeProviderConfiguration } from "../../application/src/providers/index.js";
import {
  CHRONICLE_RETRIEVAL_VERSION,
  type ChronicleRetrievalCandidate,
  type ChronicleRetrievalComparison,
  type ChronicleRetrievalAudit,
  type CompressionLevel
} from "../../contracts/src/memory.js";
type RetrievalDiagnosticMode = "production" | "shadow";
const CHRONICLE_TELEMETRY_CANDIDATE_LIMIT = 1_000;
import {
  buildChronicleEntityCatalog,
  CHRONICLE_EMBEDDING_PROTOCOL_VERSION,
  chronicleContentHash,
  modelAwareEmbeddingPrefixes,
  sanitizeChronicleFictionString,
  sanitizeChronicleFictionValue
} from "../../domain/src/chronicle-memory-helpers.js";
import {
  selectDiverseChronicleParents,
  type ChronicleParentSelectionDiagnostics
} from "../../domain/src/chronicle-diversity.js";
import {
  expandEntityQuery,
  matchEntityReferences,
  normalizeEntityTerm,
  type EntityReference
} from "../../domain/src/entity-references.js";
import {
  CHRONICLE_CHUNK_PROTOCOL_VERSION,
  CHRONICLE_CHUNK_SKIP_REASONS,
  type ChronicleChunkKind
} from "../../domain/src/chronicle-chunking.js";
import {
  planChronicleQueries,
  type ChronicleQueryKind,
  type ChronicleQueryVariant
} from "../../domain/src/chronicle-query-plan.js";
import {
  fuseChronicleRanks,
  type ChronicleRankCandidate,
  type ChronicleRankInput,
  type ChronicleRankSignal
} from "../../domain/src/chronicle-rank-fusion.js";
import { CHRONICLE_RETRIEVAL_PROFILE_V2 } from "../../domain/src/generated/chronicle-retrieval-profile-v2.js";
import { estimateTokens, stableStringify, truncateAtBoundary } from "../../domain/src/text.js";
import { characterNarrativeContext } from "../../domain/src/world-characters.js";
import { compressTurnMemory } from "../../story-engine/src/chronicle.js";
import type {
  ChronicleGenerationTransactionDependencies,
  ChronicleTransactionEmbeddingExecution,
  ChronicleTransactionEmbeddingResolution
} from "./chronicle-repository.js";
import {
  buildChronicleRetrievalAudit,
  emptyChronicleRetrievalAuditTrace,
  mergeChronicleRetrievalAuditTraces,
  type ChronicleRetrievalAuditProvider,
  type ChronicleRetrievalAuditTrace
} from "./chronicle-retrieval-audit.js";
import {
  CHRONICLE_RANK_COMPATIBLE_EMBEDDING_SQL,
  CHRONICLE_READINESS_COMPATIBLE_EMBEDDING_SQL,
  CHRONICLE_READINESS_EMBEDDING_IDENTITY_SQL
} from "./chronicle-embedding-compatibility.js";
import {
  createPostgresChronicleQueryCacheRepository,
  type ChronicleQueryEmbeddingCacheKey
} from "./chronicle-query-cache-repository.js";
import { recordRetrievalComparison } from "./chronicle-retrieval-observability-repository.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";

type EmbeddingConfigRow = Readonly<{
  embedding_enabled: boolean;
  embedding_provider_profile_id: string | null;
  embedding_model: string;
  embedding_batch_size: number;
  embedding_document_prefix: string | null;
  embedding_query_prefix: string | null;
  retrieval_implementation: "legacy_hybrid" | "chunked_hybrid";
  retrieval_shadow_enabled: boolean;
}>;

type CampaignProjectionRow = Readonly<{
  id: string;
  world_version_id: string;
  world_content: Record<string, unknown>;
  character_snapshot: Record<string, unknown> | null;
  character_profile: Record<string, unknown> | null;
}>;

type ContextCampaignRow = CampaignProjectionRow & Readonly<{
  title: string;
  active_turn_number: number;
  selected_character_id: string | null;
  character_profile_revision: number;
  scratchpad_private: string;
  scratchpad_safe_for_prompt: boolean;
  trackers: unknown;
}>;

type ContextMemoryRow = Readonly<{
  id: string;
  turn_id: string | null;
  memory_kind: "turn_fiction" | "legacy_summary" | "campaign_summary" | "canonical_fact" | "open_thread";
  ordinal: number;
  content: string;
  token_estimate: number;
  importance: number;
  entities: string[];
  entity_ids: string[];
  metadata: Record<string, unknown>;
  relevance: number;
  embedding_content_hash?: string;
  semantic_relevance?: number;
}> & {
  lexicalRelevance?: number;
  semanticRelevance?: number;
  relevance: number;
};

type ChunkCandidateRow = Readonly<{
  candidate_id: string;
  parent_memory_id: string;
  parent_turn_id: string | null;
  parent_memory_kind: ContextMemoryRow["memory_kind"];
  parent_ordinal: number;
  parent_content: string;
  parent_token_estimate: number;
  parent_importance: number;
  parent_entities: string[];
  parent_entity_ids: string[];
  parent_metadata: Record<string, unknown>;
  chunk_ordinal: number;
  chunk_kind: ChronicleChunkKind;
  chunk_content: string;
  active_fact: boolean;
}>;

type ChunkedRankFusionResult = Readonly<{
  retrieval: Record<string, unknown>;
  selectedParentContent: ReadonlyMap<string, string>;
  providerFingerprint: string | null;
  costIds: readonly string[];
  telemetryCandidates: readonly ChronicleRetrievalCandidate[];
  auditTrace: ChronicleRetrievalAuditTrace;
  legacyFallbackReason?: string;
}>;

type ChunkEmbeddingIdentity = Readonly<{
  providerProfileId: string;
  model: string;
  fingerprint: string;
  dimensions: number | null;
  provider: ChronicleTransactionEmbeddingExecution;
  prefixes: ReturnType<typeof modelAwareEmbeddingPrefixes>;
  auditTrace: ChronicleRetrievalAuditTrace;
}>;

type LegacyRetrievalResult = Readonly<{
  retrieval: Record<string, unknown>;
  providerFingerprint: string | null;
  costIds: readonly string[];
  auditTrace: ChronicleRetrievalAuditTrace;
}>;

type RetrievalExecution = Readonly<{
  implementation: ChronicleRetrievalComparison["implementation"];
  effectiveImplementation: "legacy_hybrid" | "chunked_hybrid";
  memories: ContextMemoryRow[];
  retrieval: Record<string, unknown>;
  selectedParentContent: ReadonlyMap<string, string> | null;
  latencyMs: number;
  providerFingerprint: string | null;
  costIds: readonly string[];
  auditTrace: ChronicleRetrievalAuditTrace;
  telemetryCandidates?: readonly ChronicleRetrievalCandidate[];
}>;

type ContextMetricRow = Readonly<{
  turns: string;
  characters: string;
  estimated_tokens: string;
  memory_count: string;
  memory_tokens: string;
  embedded_memories: string;
  turn_memory_tokens: string;
  recent_turn_tokens: string;
  summary_tokens: string;
}>;

function auditProviderFromResolution(
  resolution: ChronicleTransactionEmbeddingResolution,
): ChronicleRetrievalAuditProvider {
  if (resolution.status === "unconfigured") {
    return { resolutionSource: "none", resolvedRole: null, providerType: null, model: null };
  }
  return {
    resolutionSource: resolution.resolutionSource,
    resolvedRole: resolution.resolvedRole,
    providerType: resolution.providerType,
    model: resolution.model
  };
}

function auditTraceFromResolution(
  resolution: ChronicleTransactionEmbeddingResolution,
): ChronicleRetrievalAuditTrace {
  return { ...emptyChronicleRetrievalAuditTrace(), provider: auditProviderFromResolution(resolution) };
}

export type ContextMetrics = Readonly<{
  turns: number;
  completeHistoryCharacters: number;
  estimatedCompleteHistoryTokens: number;
  memoryCount: number;
  memoryTokens: number;
  embeddedMemories: number;
  compressionEstimates: Readonly<Record<Exclude<CompressionLevel, "auto">, number>>;
}>;

function budgetTokenEstimate(text: string): number {
  return Math.max(estimateTokens(text), Math.ceil(text.length / 3));
}

function compareDeterministically(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function relevanceTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_'-]{3,}/gu) ?? [])].slice(0, 64);
}

function selectWorldItems(items: unknown, query: string, limit: number): unknown[] {
  if (!Array.isArray(items)) return [];
  const terms = relevanceTerms(query);
  return items.map((item, index) => {
    const serialized = stableStringify(item).toLowerCase();
    const score = terms.reduce((total, term) => total + (serialized.includes(term) ? 1 : 0), 0);
    return { item, index, score };
  }).sort((left, right) => (right.score - left.score) || (left.index - right.index))
    .slice(0, limit)
    .map(({ item }) => sanitizeChronicleFictionValue(item))
    .filter((item) => item !== undefined);
}

function worldFictionCanon(
  content: Record<string, unknown>,
  characterProfile: unknown,
  characterSnapshot: unknown,
  query: string,
  maximumTokens: number,
): Record<string, unknown> {
  const sourceWorld = typeof content.world === "object" && content.world !== null
    ? content.world as Record<string, unknown>
    : content;
  const { character: _storedCharacter, ...world } = sourceWorld;
  const allowed = ["title", "genre", "tone", "backgroundStory", "premise", "firstAction"];
  const perOverviewLimit = Math.max(24, Math.floor(maximumTokens * 2.4 / allowed.length));
  const result: Record<string, unknown> = {};
  for (const key of allowed) {
    const sanitized = sanitizeChronicleFictionString(world[key], perOverviewLimit);
    if (!sanitized) continue;
    const next = { ...result, [key]: sanitized };
    if (budgetTokenEstimate(stableStringify(next)) <= maximumTokens) result[key] = sanitized;
  }
  const playerCharacter = sanitizeChronicleFictionValue(characterNarrativeContext(
    characterProfile,
    characterSnapshot,
    Math.max(80, Math.floor(maximumTokens * 2.4)),
    Math.max(24, Math.floor(maximumTokens * 0.32))
  ));
  if (playerCharacter && typeof playerCharacter === "object"
    && budgetTokenEstimate(stableStringify({ ...result, playerCharacter })) <= maximumTokens) {
    result.playerCharacter = playerCharacter;
  }
  for (const [key, items] of [["entities", content.entities], ["relationships", content.relationships]] as const) {
    const accepted: unknown[] = [];
    for (const item of selectWorldItems(items, query, 16)) {
      if (budgetTokenEstimate(stableStringify({ ...result, [key]: [...accepted, item] })) > maximumTokens) break;
      accepted.push(item);
    }
    if (accepted.length) result[key] = accepted;
  }
  return result;
}

function campaignFictionCanon(campaign: ContextCampaignRow, maximumTokens: number): Record<string, unknown> {
  const result: Record<string, unknown> = {
    campaignTitle: sanitizeChronicleFictionString(
      campaign.title,
      Math.max(24, Math.floor(maximumTokens * 1.5))
    ),
    acceptedTurns: campaign.active_turn_number
  };
  const scratchpad = campaign.scratchpad_safe_for_prompt
    ? sanitizeChronicleFictionString(campaign.scratchpad_private, Math.max(24, Math.floor(maximumTokens * 1.4)))
    : "";
  if (scratchpad
    && budgetTokenEstimate(stableStringify({ ...result, continuityScratchpad: scratchpad })) <= maximumTokens) {
    result.continuityScratchpad = scratchpad;
  }
  const trackers = Array.isArray(campaign.trackers) ? campaign.trackers : [];
  const accepted: unknown[] = [];
  for (const tracker of trackers.slice(0, 200)) {
    const sanitized = sanitizeChronicleFictionValue(tracker);
    if (sanitized === undefined) continue;
    if (budgetTokenEstimate(stableStringify({ ...result, trackers: [...accepted, sanitized] })) > maximumTokens) break;
    accepted.push(sanitized);
  }
  if (accepted.length) result.trackers = accepted;
  return result;
}

async function loadContextCampaign(
  client: DatabaseClient,
  scope: Parameters<MemoryGenerationTransactionPort["buildContextPreview"]>[1],
): Promise<ContextCampaignRow> {
  const result = await client.query<ContextCampaignRow>(
    `SELECT c.id, c.title, c.active_turn_number, c.world_version_id, c.selected_character_id,
            c.character_snapshot, c.character_profile, c.character_profile_revision,
            wv.content AS world_content,
            cs.scratchpad_private, cs.scratchpad_safe_for_prompt, cs.trackers
       FROM campaigns c
       JOIN world_versions wv ON wv.id = c.world_version_id AND wv.owner_user_id = c.owner_user_id
       JOIN campaign_state cs ON cs.campaign_id = c.id AND cs.owner_user_id = c.owner_user_id
      WHERE c.id = $1 AND c.owner_user_id = $2`,
    [scope.campaignId, scope.ownerUserId]
  );
  const campaign = requireCampaignWorldVersionScope(scope, result.rows[0]);
  return {
    ...campaign,
    ...(scope.request.throughTurnNumber === undefined
      ? {}
      : { active_turn_number: scope.request.throughTurnNumber }),
    ...(scope.stateOverride ? {
      scratchpad_private: typeof scope.stateOverride.scratchpad === "string" ? scope.stateOverride.scratchpad : "",
      scratchpad_safe_for_prompt: scope.scratchpadSafeForPrompt === true,
      trackers: Array.isArray(scope.stateOverride.trackers) ? scope.stateOverride.trackers : []
    } : {})
  };
}

async function loadContextMemories(
  client: DatabaseClient,
  scope: Parameters<MemoryGenerationTransactionPort["buildContextPreview"]>[1],
  query: string,
  queryEntityIds: string[],
): Promise<ContextMemoryRow[]> {
  const result = await client.query<ContextMemoryRow>(
    `WITH base AS (
       SELECT id, turn_id, memory_kind, ordinal, content, token_estimate, importance, entities, entity_ids, metadata,
              created_at,
              CASE WHEN $4 = '' THEN 0::real
                   ELSE ts_rank_cd(search_document, websearch_to_tsquery('english', $4)) END AS relevance
         FROM chronicle_memories
        WHERE owner_user_id = $1 AND campaign_id = $2 AND world_version_id = $3
          AND ($6::integer IS NULL OR ordinal <= $6::integer)
          AND ($6::integer IS NULL OR memory_kind NOT IN ('legacy_summary','canonical_fact'))
          AND (memory_kind <> 'canonical_fact' OR CASE WHEN jsonb_typeof(metadata->'structuredFactIds')='array' THEN
              jsonb_array_length(metadata->'structuredFactIds')>0
              AND NOT EXISTS (
                SELECT 1
                  FROM jsonb_array_elements_text(metadata->'structuredFactIds') fact_id(value)
                  LEFT JOIN campaign_canonical_facts fact
                    ON fact.id::text=fact_id.value
                   AND fact.owner_user_id = $1 AND fact.campaign_id = $2 AND fact.world_version_id = $3
                 WHERE fact.id IS NULL OR fact.valid_until_turn IS NOT NULL
              )
            ELSE false
          END)
     ), ranked AS (
       SELECT *,
              row_number() OVER (PARTITION BY memory_kind ORDER BY ordinal DESC, created_at DESC) AS recent_rank,
              row_number() OVER (PARTITION BY memory_kind ORDER BY ordinal ASC, created_at ASC) AS sequence_rank,
              count(*) OVER (PARTITION BY memory_kind) AS kind_count,
              row_number() OVER (PARTITION BY memory_kind ORDER BY relevance DESC, ordinal DESC) AS lexical_rank,
              row_number() OVER (PARTITION BY memory_kind ORDER BY CASE WHEN entity_ids && $7::text[] THEN 1 ELSE 0 END DESC, ordinal DESC) AS entity_rank
         FROM base
     )
     SELECT id, turn_id, memory_kind, ordinal, content, token_estimate, importance, entities, entity_ids, metadata,
            relevance
       FROM ranked
      WHERE memory_kind IN ('campaign_summary','legacy_summary','open_thread')
         OR (memory_kind = 'canonical_fact' AND (recent_rank <= 64 OR ($4 <> '' AND lexical_rank <= 64)
              OR (entity_ids && $7::text[] AND entity_rank <= 64)))
         OR (memory_kind = 'turn_fiction' AND (
              recent_rank <= GREATEST(32, $5::integer * 2) OR sequence_rank <= 8
              OR mod(sequence_rank - 1, GREATEST(1, CEIL(kind_count / 32.0)::integer)) = 0
              OR ($4 <> '' AND lexical_rank <= 96) OR (entity_ids && $7::text[] AND entity_rank <= 64)))
      ORDER BY ordinal ASC, memory_kind, id
      LIMIT 512`,
    [scope.ownerUserId, scope.campaignId, scope.worldVersionId, query.trim(), scope.request.recentTurns,
      scope.request.throughTurnNumber ?? null, queryEntityIds]
  );
  if (scope.request.throughTurnNumber === undefined) return [...result.rows];
  const historical = await client.query<ContextMemoryRow>(
    `SELECT id, source_turn_id AS turn_id, 'canonical_fact'::text AS memory_kind,
            source_turn_number AS ordinal, '- [fact_id: ' || id || '] ' || content AS content,
            GREATEST(1, CEIL(length(content) / 4.0))::integer AS token_estimate,
            0.85::real AS importance, entities, entity_ids,
            jsonb_build_object('structuredFactIds', jsonb_build_array(id::text)) AS metadata,
            CASE WHEN $4 = '' THEN 0::real
                 ELSE ts_rank_cd(to_tsvector('english', content), websearch_to_tsquery('english', $4)) END AS relevance
       FROM campaign_canonical_facts
      WHERE owner_user_id = $1 AND campaign_id = $2 AND world_version_id = $3
        AND valid_from_turn <= $5 AND (valid_until_turn IS NULL OR valid_until_turn > $5)
      ORDER BY source_turn_number DESC, source_fact_index
      LIMIT 256`,
    [scope.ownerUserId, scope.campaignId, scope.worldVersionId, query.trim(), scope.request.throughTurnNumber]
  );
  return [...result.rows, ...historical.rows];
}

function contextMetrics(row: ContextMetricRow): ContextMetrics {
  const turnTokens = Number(row.turn_memory_tokens);
  const recent = Number(row.recent_turn_tokens);
  const summaryTokens = Number(row.summary_tokens);
  return {
    turns: Number(row.turns),
    completeHistoryCharacters: Number(row.characters),
    estimatedCompleteHistoryTokens: Number(row.estimated_tokens),
    memoryCount: Number(row.memory_count),
    memoryTokens: Number(row.memory_tokens),
    embeddedMemories: Number(row.embedded_memories),
    compressionEstimates: {
      full: turnTokens,
      balanced: Math.ceil(turnTokens * 0.62),
      compact: Math.ceil(turnTokens * 0.3),
      summary: summaryTokens + recent
    }
  };
}

export async function loadPostgresChronicleContextMetrics(
  client: DatabasePool | DatabaseClient,
  scope: Parameters<MemoryGenerationTransactionPort["buildContextPreview"]>[1],
): Promise<ContextMetrics> {
  const result = await client.query<ContextMetricRow>(
    `SELECT
       (SELECT count(*) FROM turns WHERE owner_user_id = $1 AND campaign_id = $2
          AND ($4::integer IS NULL OR turn_number <= $4::integer))::text AS turns,
       (SELECT COALESCE(sum(length(turn_row.action) + length(effective.effective_narration)), 0)
          FROM turns turn_row JOIN effective_turn_narrations effective
            ON effective.turn_id=turn_row.id AND effective.campaign_id=turn_row.campaign_id
           AND effective.owner_user_id=turn_row.owner_user_id
         WHERE turn_row.owner_user_id = $1 AND turn_row.campaign_id = $2
           AND ($4::integer IS NULL OR turn_row.turn_number <= $4::integer))::text AS characters,
       (SELECT COALESCE(sum(CEIL((length(turn_row.action) + length(effective.effective_narration))::numeric / 4)), 0)
          FROM turns turn_row JOIN effective_turn_narrations effective
            ON effective.turn_id=turn_row.id AND effective.campaign_id=turn_row.campaign_id
           AND effective.owner_user_id=turn_row.owner_user_id
         WHERE turn_row.owner_user_id = $1 AND turn_row.campaign_id = $2
           AND ($4::integer IS NULL OR turn_row.turn_number <= $4::integer))::text AS estimated_tokens,
       count(*)::text AS memory_count,
       COALESCE(sum(token_estimate), 0)::text AS memory_tokens,
       count(embedding)::text AS embedded_memories,
       COALESCE(sum(token_estimate) FILTER (WHERE memory_kind = 'turn_fiction'), 0)::text AS turn_memory_tokens,
       (SELECT COALESCE(sum(token_estimate), 0) FROM (
          SELECT token_estimate FROM chronicle_memories
           WHERE owner_user_id = $1 AND campaign_id = $2 AND world_version_id = $3
             AND memory_kind = 'turn_fiction' AND ($4::integer IS NULL OR ordinal <= $4::integer)
           ORDER BY ordinal DESC LIMIT 4
        ) recent)::text AS recent_turn_tokens,
       COALESCE(
         (SELECT token_estimate FROM chronicle_memories
           WHERE owner_user_id = $1 AND campaign_id = $2 AND world_version_id = $3
             AND memory_kind = 'campaign_summary' AND ($4::integer IS NULL OR ordinal <= $4::integer)
           ORDER BY ordinal DESC, updated_at DESC LIMIT 1),
         (SELECT token_estimate FROM chronicle_memories
           WHERE owner_user_id = $1 AND campaign_id = $2 AND world_version_id = $3
             AND memory_kind = 'legacy_summary' ORDER BY created_at DESC LIMIT 1), 0
       )::text AS summary_tokens
     FROM chronicle_memories
     WHERE owner_user_id = $1 AND campaign_id = $2 AND world_version_id = $3
       AND ($4::integer IS NULL OR ordinal <= $4::integer)`,
    [scope.ownerUserId, scope.campaignId, scope.worldVersionId, scope.request.throughTurnNumber ?? null]
  );
  const row = result.rows[0];
  if (!row) throw new Error("Could not calculate Chronicle metrics.");
  return contextMetrics(row);
}

function automaticCompression(metrics: ContextMetrics, availableTokens: number): Exclude<CompressionLevel, "auto"> {
  if (metrics.compressionEstimates.full <= availableTokens) return "full";
  if (metrics.compressionEstimates.balanced <= availableTokens) return "balanced";
  if (metrics.compressionEstimates.compact <= availableTokens) return "compact";
  return "summary";
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

function parseVector(value: unknown): readonly number[] | null {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0
    || !parsed.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
    return null;
  }
  return parsed;
}

function queryHash(value: string): string {
  // `value` is the normalized expanded-query fragment sent to the provider.
  // Hash its exact bytes so cache hits can never substitute a different input.
  return createHash("sha256").update(value).digest("hex");
}

function exactHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function queryCache(
  client: DatabaseClient,
  scope: Parameters<MemoryGenerationTransactionPort["buildContextPreview"]>[1],
  dependencies: ChronicleGenerationTransactionDependencies,
) {
  return createPostgresChronicleQueryCacheRepository(client, {
    logDiagnostic(error, context) {
      dependencies.embeddings.logDiagnostic(error, {
        campaignId: scope.campaignId,
        generationJobId: scope.costAttribution?.generationJobId ?? null,
        memoryOperation: "chronicle_query_embedding_cache",
        cacheOperation: context.cacheOperation
      });
    }
  });
}

function queryCacheKey(
  query: string,
  providerProfileId: string,
  model: string,
  providerFingerprint: string,
  queryPrefix: string,
): ChronicleQueryEmbeddingCacheKey {
  return {
    normalizedQueryHash: queryHash(query),
    providerProfileId,
    model,
    providerFingerprint,
    queryPrefixHash: exactHash(queryPrefix),
    embeddingProtocolVersion: CHRONICLE_EMBEDDING_PROTOCOL_VERSION
  };
}

async function loadContextConfig(
  client: DatabaseClient,
  scope: Parameters<MemoryGenerationTransactionPort["buildContextPreview"]>[1],
): Promise<EmbeddingConfigRow | undefined> {
  const result = await client.query<EmbeddingConfigRow>(
    `SELECT embedding_enabled, embedding_provider_profile_id, embedding_model, embedding_batch_size,
            embedding_document_prefix, embedding_query_prefix, retrieval_implementation,
            retrieval_shadow_enabled
       FROM campaign_memory_configs WHERE campaign_id = $1 AND owner_user_id = $2`,
    [scope.campaignId, scope.ownerUserId]
  );
  return result.rows[0];
}

async function applyContextSemanticRelevance(
  client: DatabaseClient,
  scope: Parameters<MemoryGenerationTransactionPort["buildContextPreview"]>[1],
  query: string,
  memories: ContextMemoryRow[],
  queryEntityIds: string[],
  dependencies: ChronicleGenerationTransactionDependencies,
  config: EmbeddingConfigRow | undefined,
  diagnosticMode: RetrievalDiagnosticMode = "production",
  diagnosticImplementation: RetrievalExecution["implementation"] = "legacy_hybrid",
): Promise<LegacyRetrievalResult> {
  const normalizedQuery = query.toLowerCase();
  const queryEntityIdSet = new Set(queryEntityIds);
  const newestOrdinal = memories.reduce((maximum, memory) => Math.max(maximum, memory.ordinal), 0);
  for (const memory of memories) {
    memory.lexicalRelevance = Number(memory.relevance);
    const lexical = Math.min(1, Math.max(0, Number(memory.lexicalRelevance || 0) * 8));
    const entityScore = memory.entity_ids.some((id) => queryEntityIdSet.has(id))
      || memory.entities.some((entity) => normalizedQuery.includes(entity.toLowerCase())) ? 1 : 0;
    const recencyScore = newestOrdinal > 0
      ? Math.max(0, 1 - (newestOrdinal - memory.ordinal) / Math.max(20, newestOrdinal))
      : 0;
    memory.relevance = lexical > 0 || entityScore > 0
      ? lexical * 0.65 + entityScore * 0.15 + recencyScore * 0.1 + memory.importance * 0.1
      : 0;
  }
  if (!query.trim()) return {
    retrieval: { mode: "lexical", semanticAvailable: false, fallbackReason: "empty_query" },
    providerFingerprint: null,
    costIds: [],
    auditTrace: emptyChronicleRetrievalAuditTrace()
  };
  if (!config?.embedding_enabled || !config.embedding_provider_profile_id || !config.embedding_model) {
    return {
    retrieval: { mode: "lexical", semanticAvailable: false, fallbackReason: "semantic_not_configured" },
    providerFingerprint: null,
    costIds: [],
    auditTrace: emptyChronicleRetrievalAuditTrace()
    };
  }
  let embeddingRequests = 0;
  let queryCacheHits = 0;
  let queryCacheMisses = 0;
  let auditTrace = emptyChronicleRetrievalAuditTrace();
  const resolution = await dependencies.embeddings.resolve(client, {
    ownerUserId: scope.ownerUserId,
    campaignId: scope.campaignId,
    selectedProviderProfileId: config.embedding_provider_profile_id
  });
  auditTrace = auditTraceFromResolution(resolution);
  if (resolution.status === "unconfigured") return {
    retrieval: { mode: "lexical", semanticAvailable: false, fallbackReason: "provider_unavailable" },
    providerFingerprint: null,
    costIds: [],
    auditTrace
  };
  const providerProfileId = resolution.providerProfileId;
  const providerScope = { ownerUserId: scope.ownerUserId, providerProfileId, model: config.embedding_model };
  try {
    const provider = await dependencies.embeddings.load(client, providerScope);
    const prefixes = modelAwareEmbeddingPrefixes(
      config.embedding_model,
      config.embedding_document_prefix,
      config.embedding_query_prefix
    );
    const fingerprint = await dependencies.embeddings.fingerprint(provider, prefixes);
    const cache = queryCache(client, scope, dependencies);
    const cacheKey = queryCacheKey(query.trim(), providerProfileId, config.embedding_model, fingerprint, prefixes.queryPrefix);
    let queryVector = await cache.getQueryEmbedding(scope, cacheKey);
    let costId: string | null = null;
    if (queryVector) {
      queryCacheHits = 1;
    } else {
      queryCacheMisses = 1;
      embeddingRequests = 1;
      const result = await dependencies.embeddings.embed(provider, [`${prefixes.queryPrefix}${query.trim()}`]);
      costId = await dependencies.embeddings.recordCost(client, provider, {
        ownerUserId: scope.ownerUserId,
        campaignId: scope.campaignId,
        ...(scope.costAttribution?.generationJobId
          ? { generationJobId: scope.costAttribution.generationJobId }
          : {}),
        operation: scope.costAttribution?.operation ?? "context_preview_embedding"
      }, result);
      queryVector = result.embeddings[0] ?? null;
      if (!queryVector?.length) throw new Error("Embedding provider returned no query vector.");
      auditTrace = { ...auditTrace, providerCallOutcome: "succeeded", queryEmbeddingRequests: embeddingRequests };
      await cache.putQueryEmbedding(scope, cacheKey, queryVector);
    }
    const scored = await client.query<ContextMemoryRow>(
      `SELECT id, turn_id, memory_kind, ordinal, content, token_estimate, importance, entities, entity_ids,
              0::real AS relevance, embedding_content_hash,
              (1 - (embedding <=> $6::vector))::real AS semantic_relevance
         FROM chronicle_memories
        WHERE owner_user_id = $1 AND campaign_id = $2 AND world_version_id = $3
          AND ($9::integer IS NULL OR ordinal <= $9::integer)
          AND ($9::integer IS NULL OR memory_kind NOT IN ('legacy_summary','canonical_fact'))
          AND embedding_provider_profile_id = $4 AND embedding_model = $5
          AND embedding_dimensions = $7 AND embedding_provider_fingerprint = $8
          AND embedding IS NOT NULL
         ORDER BY embedding <=> $6::vector
         LIMIT 96`,
      [scope.ownerUserId, scope.campaignId, scope.worldVersionId, providerProfileId, config.embedding_model,
        vectorLiteral(queryVector), queryVector.length, fingerprint, scope.request.throughTurnNumber ?? null]
    );
    const freshScores = scored.rows.filter((row) => row.embedding_content_hash
      && row.embedding_content_hash === chronicleContentHash(row.content));
    const existingIds = new Set(memories.map((memory) => memory.id));
    for (const row of freshScores) {
      if (!existingIds.has(row.id)) {
        memories.push({ ...row, relevance: 0, lexicalRelevance: 0 });
        existingIds.add(row.id);
      }
    }
    const semantic = new Map(freshScores.map((row) => [row.id, Number(row.semantic_relevance)]));
    for (const memory of memories) {
      const lexical = Math.min(1, Math.max(0, Number(memory.lexicalRelevance || 0) * 8));
      const semanticScore = Math.max(0, semantic.get(memory.id) ?? 0);
      const entityScore = memory.entity_ids.some((id) => queryEntityIdSet.has(id))
        || memory.entities.some((entity) => normalizedQuery.includes(entity.toLowerCase())) ? 1 : 0;
      const recencyScore = newestOrdinal > 0
        ? Math.max(0, 1 - (newestOrdinal - memory.ordinal) / Math.max(20, newestOrdinal))
        : 0;
      memory.semanticRelevance = semanticScore;
      memory.relevance = semanticScore >= 0.2 || lexical > 0 || entityScore > 0
        ? semanticScore * 0.55 + lexical * 0.25 + entityScore * 0.1 + recencyScore * 0.05 + memory.importance * 0.05
        : 0;
    }
    if (diagnosticMode === "production") {
      await dependencies.embeddings.recordHealth(client, providerScope, true);
    }
    return {
      retrieval: {
        mode: "hybrid",
        semanticAvailable: true,
        embeddedCandidates: freshScores.length,
        model: config.embedding_model,
        queryExpanded: true,
        effectiveQueryPrefix: prefixes.queryPrefix,
        embeddingRequests,
        queryCacheHits,
        queryCacheMisses
      },
      providerFingerprint: fingerprint,
      costIds: costId ? [costId] : [],
      auditTrace: {
        ...auditTrace,
        queryEmbeddingRequests: embeddingRequests,
        queryCacheHits,
        queryCacheMisses
      }
    };
  } catch (error) {
    if (diagnosticMode === "shadow") {
      try {
        dependencies.embeddings.logDiagnostic(new Error("chronicle_retrieval_shadow_failed"), {
          campaignId: scope.campaignId,
          generationJobId: scope.costAttribution?.generationJobId ?? null,
          memoryOperation: "chronicle_retrieval_shadow",
          retrievalImplementation: diagnosticImplementation
        });
      } catch {
        // Shadow diagnostics are best-effort and cannot affect production retrieval.
      }
    } else {
      try {
        dependencies.embeddings.logDiagnostic(new Error("chronicle_retrieval_failed"), {
          campaignId: scope.campaignId,
          providerProfileId,
          generationJobId: scope.costAttribution?.generationJobId ?? null,
          memoryOperation: scope.costAttribution?.operation ?? "context_preview_embedding"
        });
      } catch {
        // Diagnostics are best-effort; semantic failures must retain lexical fallback.
      }
      await dependencies.embeddings.recordHealth(client, providerScope, false, "chronicle_retrieval_failed").catch(() => undefined);
    }
    if (embeddingRequests > 0 && auditTrace.providerCallOutcome !== "succeeded") {
      auditTrace = { ...auditTrace, providerCallOutcome: "failed" };
    }
    return {
      retrieval: {
        mode: "lexical_fallback",
        semanticAvailable: false,
        fallbackReason: "semantic_retrieval_unavailable",
        embeddingRequests,
        queryCacheHits,
        queryCacheMisses
      },
      providerFingerprint: null,
      costIds: [],
      auditTrace: {
        ...auditTrace,
        queryEmbeddingRequests: embeddingRequests,
        queryCacheHits,
        queryCacheMisses
      }
    };
  }
}

/**
 * Renders a compile-time Chronicle protocol constant as a SQL literal. Values are
 * whitelisted rather than interpolated blindly so no unchecked text can reach a query.
 */
/**
 * Legacy retrieval used to add every turn memory for chronological coverage, so a 100-turn
 * campaign put 100 Chronicle entries in the prompt and only the token budget trimmed them.
 * That crowds out the relevance-selected entries and makes the prompt grow with campaign
 * length. Coverage is kept, but as a deterministic evenly-spaced sample anchored on the most
 * recent turns, so early, middle, and late history all survive within a bounded size.
 */
const LEGACY_CHRONOLOGICAL_COVERAGE_LIMIT = 32;

function chronologicalCoverage<T>(turnMemories: readonly T[]): readonly T[] {
  if (turnMemories.length <= LEGACY_CHRONOLOGICAL_COVERAGE_LIMIT) return turnMemories;
  const selectedIndexes = new Set<number>();
  const last = turnMemories.length - 1;
  for (let step = 0; step < LEGACY_CHRONOLOGICAL_COVERAGE_LIMIT; step += 1) {
    selectedIndexes.add(Math.round(step * last / (LEGACY_CHRONOLOGICAL_COVERAGE_LIMIT - 1)));
  }
  return turnMemories.filter((_, index) => selectedIndexes.has(index));
}

function protocolLiteral(value: string): string {
  if (!/^[a-z0-9][a-z0-9_.:-]*$/u.test(value)) {
    throw new Error("Chronicle protocol constants must be safe lowercase identifiers.");
  }
  return `'${value}'`;
}

const CHUNK_PROTOCOL_LITERAL = protocolLiteral(CHRONICLE_CHUNK_PROTOCOL_VERSION);

const SANITIZED_SKIPPED_CHUNK_PREDICATE = `(chunk.embedding_status='skipped'
                   AND chunk.embedding_skip_reason IN (${
  CHRONICLE_CHUNK_SKIP_REASONS.map(protocolLiteral).join(",")
}))`;

/** A chunk is terminal when it carries a vector or any sanitized skip reason from the closed set. */
const TERMINAL_CHUNK_PREDICATE = `(chunk.embedding_status='embedded'
               OR ${SANITIZED_SKIPPED_CHUNK_PREDICATE})`;

async function resolveChunkEmbeddingIdentity(
  client: DatabaseClient,
  scope: Parameters<MemoryGenerationTransactionPort["buildContextPreview"]>[1],
  config: EmbeddingConfigRow | undefined,
  dependencies: ChronicleGenerationTransactionDependencies,
  resolution: ChronicleTransactionEmbeddingResolution,
): Promise<ChunkEmbeddingIdentity | null> {
  if (!config?.embedding_enabled || !config.embedding_provider_profile_id || !config.embedding_model) return null;
  if (resolution.status === "unconfigured") return null;
  const providerProfileId = resolution.providerProfileId;
  const provider = await dependencies.embeddings.load(client, {
    ownerUserId: scope.ownerUserId,
    providerProfileId,
    model: config.embedding_model
  });
  const prefixes = modelAwareEmbeddingPrefixes(
    config.embedding_model,
    config.embedding_document_prefix,
    config.embedding_query_prefix
  );
  const fingerprint = await dependencies.embeddings.fingerprint(provider, prefixes);
  const dimensions = toSafeProviderConfiguration(provider.configuration).embeddingDimensions ?? null;
  return {
    providerProfileId,
    model: config.embedding_model,
    fingerprint,
    dimensions,
    provider,
    prefixes,
    auditTrace: auditTraceFromResolution(resolution)
  };
}

async function chunkIndexReady(
  client: DatabaseClient,
  scope: Parameters<MemoryGenerationTransactionPort["buildContextPreview"]>[1],
  identity: ChunkEmbeddingIdentity,
): Promise<boolean> {
  const result = await client.query<{ chunk_index_ready: boolean }>(
    `WITH current_parents AS MATERIALIZED (
       SELECT parent.id,parent.content_hash
         FROM chronicle_memories parent
        WHERE parent.owner_user_id = $1 AND parent.campaign_id = $2 AND parent.world_version_id = $3
     ), latest_job AS (
       SELECT status FROM chronicle_chunk_jobs
        WHERE owner_user_id = $1 AND campaign_id = $2
        ORDER BY updated_at DESC,id DESC LIMIT 1
     ), compatible_dimension AS (
       SELECT CASE
         WHEN $6::integer IS NOT NULL THEN $6::integer
         WHEN count(DISTINCT chunk.embedding_dimensions) = 1 THEN min(chunk.embedding_dimensions)
         ELSE NULL
       END AS expected_dimensions
         FROM chronicle_memory_chunks chunk
         JOIN current_parents parent ON parent.id=chunk.parent_memory_id
          AND parent.content_hash=chunk.parent_content_hash
        WHERE chunk.owner_user_id = $1 AND chunk.campaign_id = $2 AND chunk.world_version_id = $3
          AND chunk.chunking_protocol_version=${CHUNK_PROTOCOL_LITERAL}
          AND ${CHRONICLE_READINESS_EMBEDDING_IDENTITY_SQL}
     )
     SELECT (
       (SELECT expected_dimensions IS NOT NULL FROM compatible_dimension)
       AND
       EXISTS (
         SELECT 1 FROM chronicle_memory_chunks chunk
         JOIN current_parents parent ON parent.id=chunk.parent_memory_id
          AND parent.content_hash=chunk.parent_content_hash
        WHERE chunk.owner_user_id = $1 AND chunk.campaign_id = $2 AND chunk.world_version_id = $3
          AND chunk.chunking_protocol_version=${CHUNK_PROTOCOL_LITERAL}
          AND ${CHRONICLE_READINESS_COMPATIBLE_EMBEDDING_SQL}
       )
       AND NOT EXISTS (
         SELECT 1 FROM current_parents parent
          WHERE NOT EXISTS (
            SELECT 1 FROM chronicle_memory_chunks chunk
             WHERE chunk.parent_memory_id=parent.id AND chunk.parent_content_hash=parent.content_hash
               AND chunk.owner_user_id = $1 AND chunk.campaign_id = $2 AND chunk.world_version_id = $3
               AND chunk.chunking_protocol_version=${CHUNK_PROTOCOL_LITERAL}
               AND (${CHRONICLE_READINESS_COMPATIBLE_EMBEDDING_SQL}
                    OR ${SANITIZED_SKIPPED_CHUNK_PREDICATE})
          )
       )
       AND NOT EXISTS (
         SELECT 1 FROM chronicle_memory_chunks chunk
         JOIN current_parents parent ON parent.id=chunk.parent_memory_id
          AND parent.content_hash=chunk.parent_content_hash
        WHERE chunk.owner_user_id = $1 AND chunk.campaign_id = $2 AND chunk.world_version_id = $3
          AND chunk.chunking_protocol_version=${CHUNK_PROTOCOL_LITERAL}
          AND NOT (${CHRONICLE_READINESS_COMPATIBLE_EMBEDDING_SQL}
                   OR ${SANITIZED_SKIPPED_CHUNK_PREDICATE})
       )
       AND COALESCE((SELECT status='completed' FROM latest_job),true)
     ) AS chunk_index_ready`,
    [scope.ownerUserId, scope.campaignId, scope.worldVersionId, identity.providerProfileId,
      identity.model, identity.dimensions, identity.fingerprint]
  );
  return result.rows[0]?.chunk_index_ready === true;
}

function authorizedChunkCte(): string {
  return `authorized AS MATERIALIZED (
       SELECT chunk.id AS candidate_id,chunk.parent_memory_id,
              parent.turn_id AS parent_turn_id,parent.memory_kind AS parent_memory_kind,
              parent.ordinal AS parent_ordinal,parent.content AS parent_content,
              parent.token_estimate AS parent_token_estimate,parent.importance AS parent_importance,
              parent.entities AS parent_entities,parent.entity_ids AS parent_entity_ids,
              parent.metadata AS parent_metadata,chunk.chunk_ordinal,chunk.chunk_kind,
              chunk.content AS chunk_content,
              chunk.entities,chunk.entity_ids,chunk.search_document,chunk.embedding,
              chunk.embedding_status,chunk.embedding_provider_profile_id,chunk.embedding_model,
              chunk.embedding_dimensions,chunk.embedding_protocol_version,
              chunk.embedding_provider_fingerprint,chunk.embedding_content_hash,chunk.content_hash,
              true AS active_fact
         FROM chronicle_memory_chunks chunk
         JOIN chronicle_memories parent
           ON parent.id=chunk.parent_memory_id
          AND parent.owner_user_id = $1 AND parent.campaign_id = $2 AND parent.world_version_id = $3
          AND parent.content_hash=chunk.parent_content_hash
        WHERE chunk.owner_user_id = $1 AND chunk.campaign_id = $2 AND chunk.world_version_id = $3
          AND chunk.chunking_protocol_version=${CHUNK_PROTOCOL_LITERAL}
          AND ${TERMINAL_CHUNK_PREDICATE}
          AND ($4::integer IS NULL OR parent.ordinal <= $4::integer)
          AND ($4::integer IS NULL OR parent.memory_kind NOT IN ('legacy_summary','canonical_fact'))
          AND (parent.memory_kind <> 'canonical_fact' OR CASE WHEN jsonb_typeof(parent.metadata->'structuredFactIds')='array'
             AND $4::integer IS NULL THEN
              jsonb_array_length(parent.metadata->'structuredFactIds')>0
              AND NOT EXISTS (
                SELECT 1
                  FROM jsonb_array_elements_text(parent.metadata->'structuredFactIds') fact_id(value)
                  LEFT JOIN campaign_canonical_facts fact
                    ON fact.id::text=fact_id.value
                   AND fact.owner_user_id = $1 AND fact.campaign_id = $2 AND fact.world_version_id = $3
                 WHERE fact.id IS NULL OR fact.valid_until_turn IS NOT NULL
              )
            ELSE false
          END)
     )`;
}

function rankCandidate(row: ChunkCandidateRow): ChronicleRankCandidate {
  return {
    candidateId: row.candidate_id,
    parentMemoryId: row.parent_memory_id,
    parentTurnId: row.parent_turn_id,
    parentOrdinal: row.parent_ordinal,
    memoryKind: row.parent_memory_kind,
    activeFact: row.active_fact
  };
}

type ChunkRankRequest = Readonly<{
  signal: ChronicleRankSignal;
  variant: ChronicleQueryVariant;
  query?: string;
  entityIds?: readonly string[];
  vector?: readonly number[];
  providerProfileId?: string;
  model?: string;
  fingerprint?: string;
  temporalAnchor?: number;
}>;

async function loadAuthorizedChunkRank(
  client: DatabaseClient,
  scope: Parameters<MemoryGenerationTransactionPort["buildContextPreview"]>[1],
  request: ChunkRankRequest,
  candidateLimit: number,
): Promise<readonly ChunkCandidateRow[]> {
  const baseValues: unknown[] = [
    scope.ownerUserId,
    scope.campaignId,
    scope.worldVersionId,
    scope.request.throughTurnNumber ?? null
  ];
  let predicate = "true";
  let order = "parent_memory_id,candidate_id";
  let limitParameter = 5;
  if (request.signal === "semantic") {
    predicate = CHRONICLE_RANK_COMPATIBLE_EMBEDDING_SQL;
    order = "embedding <=> $5::vector,parent_memory_id,candidate_id";
    baseValues.push(vectorLiteral(request.vector ?? []), request.providerProfileId, request.model,
      request.vector?.length ?? 0, request.fingerprint);
    limitParameter = 10;
  } else if (request.signal === "full_text") {
    predicate = "$5::text <> '' AND search_document @@ websearch_to_tsquery('english',$5::text)";
    order = "ts_rank_cd(search_document,websearch_to_tsquery('english',$5::text)) DESC,parent_memory_id,candidate_id";
    baseValues.push(request.query?.trim() ?? "");
    limitParameter = 6;
  } else if (request.signal === "entity") {
    predicate = "entity_ids && $5::text[]";
    order = "cardinality(ARRAY(SELECT unnest(entity_ids) INTERSECT SELECT unnest($5::text[]))) DESC,parent_memory_id,candidate_id";
    baseValues.push([...(request.entityIds ?? [])]);
    limitParameter = 6;
  } else if (request.signal === "recency") {
    order = "parent_ordinal DESC,parent_memory_id,candidate_id";
  } else if (request.signal === "chronology") {
    order = "parent_ordinal ASC,parent_memory_id,candidate_id";
  } else if (request.signal === "importance") {
    order = "parent_importance DESC,parent_ordinal DESC,parent_memory_id,candidate_id";
  } else if (request.signal === "kind") {
    order = `CASE parent_memory_kind
      WHEN 'canonical_fact' THEN 0 WHEN 'open_thread' THEN 1 WHEN 'campaign_summary' THEN 2
      WHEN 'turn_fiction' THEN 3 ELSE 4 END,parent_ordinal DESC,parent_memory_id,candidate_id`;
  } else {
    order = "abs(parent_ordinal-$5::integer),parent_ordinal DESC,parent_memory_id,candidate_id";
    baseValues.push(request.temporalAnchor ?? 0);
    limitParameter = 6;
  }
  baseValues.push(candidateLimit);
  const result = await client.query<ChunkCandidateRow>(
    `/* chronicle_rank:${request.signal}:${request.variant.kind} */
     WITH ${authorizedChunkCte()}, ranked AS (
       SELECT *,row_number() OVER (ORDER BY ${order}) AS signal_rank
         FROM authorized
        WHERE ${predicate}
     )
     SELECT candidate_id,parent_memory_id,parent_turn_id,parent_memory_kind,parent_ordinal,
            parent_content,parent_token_estimate,parent_importance,parent_entities,parent_entity_ids,parent_metadata,
            chunk_ordinal,chunk_kind,chunk_content,active_fact
       FROM ranked
      ORDER BY signal_rank,parent_memory_id,candidate_id
      LIMIT $${limitParameter}`,
    baseValues
  );
  return result.rows;
}

function aliasAttestedByMemories(
  entity: EntityReference,
  alias: string,
  memories: readonly ContextMemoryRow[],
): boolean {
  const aliasKey = normalizeEntityTerm(alias);
  const aliasOnlyReference: EntityReference = { ...entity, displayName: alias, aliases: [alias] };
  return memories.some((memory) => (
    memory.entities.some((term) => normalizeEntityTerm(term) === aliasKey)
    || matchEntityReferences(memory.content, [aliasOnlyReference]).length > 0
  ));
}

function cutoffSafeEntityCatalog(
  catalog: readonly EntityReference[],
  memories: readonly ContextMemoryRow[],
  throughTurnNumber: number | undefined,
): readonly EntityReference[] {
  if (throughTurnNumber === undefined) return catalog;
  return catalog.flatMap((entity) => {
    if (entity.source === "world") return [entity];
    const aliases = entity.aliases.filter((alias) => aliasAttestedByMemories(entity, alias, memories));
    if (!aliases.length) return [];
    const displayName = aliases.some((alias) => normalizeEntityTerm(alias) === normalizeEntityTerm(entity.displayName))
      ? entity.displayName
      : aliases[0]!;
    return [{ ...entity, displayName, aliases }];
  });
}

function plannedChunkQueries(
  scope: Parameters<MemoryGenerationTransactionPort["buildContextPreview"]>[1],
  memories: readonly ContextMemoryRow[],
  entityCatalog: readonly EntityReference[],
): readonly ChronicleQueryVariant[] {
  const entityHints = matchEntityReferences(scope.request.query, entityCatalog).flatMap(({ entity, matchedAlias }) => {
    const authorizedMemories = memories.filter((memory) => memory.entity_ids.includes(entity.id));
    if (!authorizedMemories.length) return [];
    const historicallyAttested = scope.request.throughTurnNumber === undefined
      || entity.source === "world"
      || aliasAttestedByMemories(entity, matchedAlias, authorizedMemories);
    if (!historicallyAttested) return [];
    const catalogTerms = new Set([entity.displayName, ...entity.aliases]
      .map(normalizeEntityTerm));
    const terms = [...new Set(authorizedMemories.flatMap((memory) => memory.entities)
      .filter((term) => catalogTerms.has(normalizeEntityTerm(term))))]
      .sort(compareDeterministically);
    return terms.length === 0 ? [] : [{
      ordinal: Math.min(...authorizedMemories.map((memory) => memory.ordinal)),
      entityId: entity.id,
      terms
    }];
  });
  return planChronicleQueries({
    action: scope.request.query,
    ...(scope.request.throughTurnNumber === undefined ? {} : { throughTurnNumber: scope.request.throughTurnNumber }),
    entityHints,
    sceneHints: memories.filter((memory) => memory.memory_kind === "turn_fiction")
      .map((memory) => ({ ordinal: memory.ordinal, content: memory.content })),
    openThreadHints: memories.filter((memory) => memory.memory_kind === "open_thread")
      .map((memory) => ({ ordinal: memory.ordinal, content: memory.content }))
  });
}

function contextMemoryFromChunk(row: ChunkCandidateRow): ContextMemoryRow {
  return {
    id: row.parent_memory_id,
    turn_id: row.parent_turn_id,
    memory_kind: row.parent_memory_kind,
    ordinal: row.parent_ordinal,
    content: row.parent_content,
    token_estimate: row.parent_token_estimate,
    importance: Number(row.parent_importance),
    entities: row.parent_entities,
    entity_ids: row.parent_entity_ids,
    metadata: row.parent_metadata,
    relevance: 0,
    lexicalRelevance: 0
  };
}

async function applyChunkedRankFusion(
  client: DatabaseClient,
  campaign: ContextCampaignRow,
  scope: Parameters<MemoryGenerationTransactionPort["buildContextPreview"]>[1],
  memories: ContextMemoryRow[],
  entityCatalog: readonly EntityReference[],
  config: EmbeddingConfigRow,
  dependencies: ChronicleGenerationTransactionDependencies,
  diagnosticMode: RetrievalDiagnosticMode = "production",
  embeddingIdentity?: ChunkEmbeddingIdentity,
): Promise<ChunkedRankFusionResult> {
  const rankFusionProfile = dependencies.rankFusionProfile ?? CHRONICLE_RETRIEVAL_PROFILE_V2;
  const candidateLimit = Math.max(1, Math.floor(rankFusionProfile.candidateLimits.perSignal));
  const loadRank = (request: ChunkRankRequest): Promise<readonly ChunkCandidateRow[]> => (
    loadAuthorizedChunkRank(client, scope, request, candidateLimit)
  );
  const variants = plannedChunkQueries(scope, memories, entityCatalog);
  const actionVariant: ChronicleQueryVariant = variants[0] ?? { kind: "action", query: "", entityIds: [] };
  const inputs: ChronicleRankInput[] = [];
  const candidateRows = new Map<string, ChunkCandidateRow>();
  const addRank = (
    signal: ChronicleRankSignal,
    variant: ChronicleQueryVariant,
    rows: readonly ChunkCandidateRow[],
  ): void => {
    rows.forEach((row) => candidateRows.set(row.candidate_id, row));
    inputs.push({ signal, variant: variant.kind, candidates: rows.map(rankCandidate) });
  };

  let semanticAvailable = false;
  let semanticFallbackReason: string | undefined;
  let effectiveQueryPrefix = "";
  let embeddedCandidates = 0;
  let providerFingerprint: string | null = null;
  let embeddingRequests = 0;
  let queryCacheHits = 0;
  let queryCacheMisses = 0;
  let auditTrace = embeddingIdentity?.auditTrace ?? emptyChronicleRetrievalAuditTrace();
  const costIds: string[] = [];
  if (!variants.length) {
    semanticFallbackReason = "empty_query";
  } else if (!config.embedding_enabled || !config.embedding_provider_profile_id || !config.embedding_model) {
    semanticFallbackReason = "semantic_not_configured";
  } else {
    const selectedProviderProfileId = config.embedding_provider_profile_id;
    try {
      const resolution = embeddingIdentity ? null : await dependencies.embeddings.resolve(client, {
        ownerUserId: scope.ownerUserId,
        campaignId: scope.campaignId,
        selectedProviderProfileId
      });
      if (resolution) auditTrace = auditTraceFromResolution(resolution);
      const providerProfileId = embeddingIdentity?.providerProfileId
        ?? (resolution?.status === "resolved" ? resolution.providerProfileId : null);
      if (!providerProfileId) {
        semanticFallbackReason = "provider_unavailable";
      } else {
        const providerScope = { ownerUserId: scope.ownerUserId, providerProfileId, model: config.embedding_model };
        const provider = embeddingIdentity?.provider ?? await dependencies.embeddings.load(client, providerScope);
        const prefixes = embeddingIdentity?.prefixes ?? modelAwareEmbeddingPrefixes(
          config.embedding_model, config.embedding_document_prefix, config.embedding_query_prefix
        );
        effectiveQueryPrefix = prefixes.queryPrefix;
        const fingerprint = embeddingIdentity?.fingerprint
          ?? await dependencies.embeddings.fingerprint(provider, prefixes);
        providerFingerprint = fingerprint;
        const cache = queryCache(client, scope, dependencies);
        const cacheKeys = variants.map((variant) => queryCacheKey(
          variant.query,
          providerProfileId,
          config.embedding_model,
          fingerprint,
          prefixes.queryPrefix
        ));
        const queryVectors: Array<readonly number[] | null> = [];
        const missedIndexes: number[] = [];
        for (let index = 0; index < variants.length; index += 1) {
          const vector = await cache.getQueryEmbedding(scope, cacheKeys[index]!);
          queryVectors.push(vector);
          if (vector) {
            queryCacheHits += 1;
          } else {
            queryCacheMisses += 1;
            missedIndexes.push(index);
          }
        }
        if (missedIndexes.length > 0) {
          embeddingRequests = 1;
          const result = await dependencies.embeddings.embed(
            provider,
            missedIndexes.map((index) => `${prefixes.queryPrefix}${variants[index]!.query}`)
          );
          const costId = await dependencies.embeddings.recordCost(client, provider, {
            ownerUserId: scope.ownerUserId,
            campaignId: scope.campaignId,
            ...(scope.costAttribution?.generationJobId
              ? { generationJobId: scope.costAttribution.generationJobId }
              : {}),
            operation: scope.costAttribution?.operation ?? "context_preview_embedding"
          }, result);
          if (costId) costIds.push(costId);
          if (result.embeddings.length !== missedIndexes.length) {
            throw new Error("Embedding provider returned an incomplete Chronicle query batch.");
          }
          for (let resultIndex = 0; resultIndex < missedIndexes.length; resultIndex += 1) {
            const variantIndex = missedIndexes[resultIndex]!;
            const vector = result.embeddings[resultIndex];
            if (!vector?.length) throw new Error("Embedding provider returned an empty Chronicle query vector.");
            queryVectors[variantIndex] = vector;
            await cache.putQueryEmbedding(scope, cacheKeys[variantIndex]!, vector);
          }
          auditTrace = { ...auditTrace, providerCallOutcome: "succeeded", queryEmbeddingRequests: embeddingRequests };
        }
        const semanticRanks: Array<Readonly<{
          variant: ChronicleQueryVariant;
          rows: readonly ChunkCandidateRow[];
        }>> = [];
        for (let index = 0; index < variants.length; index += 1) {
          const variant = variants[index]!;
          const vector = queryVectors[index];
          if (!vector?.length) throw new Error("Embedding provider returned an empty Chronicle query vector.");
          const rows = await loadRank({
            signal: "semantic",
            variant,
            vector,
            providerProfileId,
            model: config.embedding_model,
            fingerprint
          });
          semanticRanks.push({ variant, rows });
        }
        if (diagnosticMode === "production") {
          await dependencies.embeddings.recordHealth(client, providerScope, true);
        }
        semanticRanks.forEach(({ variant, rows }) => {
          embeddedCandidates += rows.length;
          addRank("semantic", variant, rows);
        });
        if (embeddedCandidates > 0) {
          semanticAvailable = true;
        } else {
          semanticFallbackReason = "incompatible_chunk_embeddings";
        }
      }
    } catch (error) {
      semanticFallbackReason = "semantic_retrieval_unavailable";
      if (embeddingRequests > 0 && auditTrace.providerCallOutcome !== "succeeded") {
        auditTrace = { ...auditTrace, providerCallOutcome: "failed" };
      }
      if (diagnosticMode === "shadow") {
        try {
          dependencies.embeddings.logDiagnostic(new Error("chronicle_retrieval_shadow_failed"), {
            campaignId: scope.campaignId,
            generationJobId: scope.costAttribution?.generationJobId ?? null,
            memoryOperation: "chronicle_retrieval_shadow",
            retrievalImplementation: "chunked_hybrid"
          });
        } catch {
          // Shadow diagnostics are best-effort and cannot affect production retrieval.
        }
      } else {
        try {
          dependencies.embeddings.logDiagnostic(new Error("chronicle_retrieval_failed"), {
            campaignId: scope.campaignId,
            providerProfileId: selectedProviderProfileId,
            generationJobId: scope.costAttribution?.generationJobId ?? null,
            memoryOperation: scope.costAttribution?.operation ?? "context_preview_embedding"
          });
        } catch {
          // Diagnostics are best-effort; semantic failures must retain lexical fallback.
        }
        await dependencies.embeddings.recordHealth(client, {
          ownerUserId: scope.ownerUserId,
          providerProfileId: selectedProviderProfileId,
          model: config.embedding_model
        }, false, "chronicle_retrieval_failed").catch(() => undefined);
      }
    }
  }

  const legacyFallbackReason = diagnosticMode === "production" && [
    "provider_unavailable",
    "semantic_retrieval_unavailable",
    "incompatible_chunk_embeddings"
  ].includes(semanticFallbackReason ?? "")
    ? semanticFallbackReason
    : undefined;
  if (legacyFallbackReason) {
    return {
      retrieval: {
        implementation: "chunked_hybrid",
        mode: "lexical_fallback",
        semanticAvailable: false,
        fallbackReason: legacyFallbackReason,
        embeddedCandidates,
        rankedCandidates: 0,
        queryExpanded: variants.length > 1,
        effectiveQueryPrefix,
        embeddingRequests,
        queryCacheHits,
        queryCacheMisses
      },
      selectedParentContent: new Map(),
      providerFingerprint,
      costIds,
      auditTrace: {
        ...auditTrace,
        queryEmbeddingRequests: embeddingRequests,
        queryCacheHits,
        queryCacheMisses
      },
      telemetryCandidates: [],
      legacyFallbackReason
    };
  }

  for (const variant of variants) {
    addRank("full_text", variant, await loadRank({
      signal: "full_text", variant, query: variant.query
    }));
    if (variant.entityIds.length) {
      addRank("entity", variant, await loadRank({
        signal: "entity", variant, entityIds: variant.entityIds
      }));
    }
  }
  for (const signal of ["recency", "chronology", "importance", "kind"] as const) {
    addRank(signal, actionVariant, await loadRank({ signal, variant: actionVariant }));
  }
  addRank("temporal", actionVariant, await loadRank({
    signal: "temporal",
    variant: actionVariant,
    temporalAnchor: scope.request.throughTurnNumber ?? campaign.active_turn_number
  }));

  const fused = fuseChronicleRanks(inputs, rankFusionProfile);
  const fusedRankByCandidateId = new Map<string, number>();
  let previousFusedScore: number | null = null;
  let currentFusedRank = 0;
  fused.forEach((candidate, index) => {
    if (previousFusedScore === null || candidate.score !== previousFusedScore) {
      currentFusedRank = index + 1;
    }
    fusedRankByCandidateId.set(candidate.candidateId, currentFusedRank);
    previousFusedScore = candidate.score;
  });
  const historicalCanonicalFusedRank = (fusedRankByCandidateId.size > 0
    ? Math.max(...fusedRankByCandidateId.values())
    : 0) + 1;
  const latestSceneParentMemoryId = memories.filter((memory) => memory.memory_kind === "turn_fiction")
    .sort((left, right) => left.ordinal - right.ordinal || compareDeterministically(left.id, right.id))
    .at(-1)?.id ?? null;
  // Vectors are only needed for the maximal-marginal-relevance penalty over fused candidates.
  // Selecting them inside every rank query rendered the whole campaign's vectors as text once
  // per signal per variant, which is what made retrieval latency grow with campaign length.
  const fusedCandidateIds = fused.map((candidate) => candidate.candidateId);
  const embeddingByCandidateId = new Map<string, readonly number[] | null>();
  if (fusedCandidateIds.length) {
    const vectors = await client.query<{ id: string; embedding: string | null }>(
      `SELECT id,embedding::text AS embedding
         FROM chronicle_memory_chunks
        WHERE owner_user_id=$1 AND campaign_id=$2 AND world_version_id=$3
          AND id=ANY($4::uuid[]) AND embedding IS NOT NULL`,
      [scope.ownerUserId, scope.campaignId, scope.worldVersionId, fusedCandidateIds]
    );
    for (const row of vectors.rows) embeddingByCandidateId.set(row.id, parseVector(row.embedding));
  }
  const rankedChunkParents = fused.flatMap((candidate, index) => {
    const row = candidateRows.get(candidate.candidateId);
    return row ? [{
      candidateId: candidate.candidateId,
      parentMemoryId: candidate.parentMemoryId,
      parentTurnId: candidate.parentTurnId,
      ordinal: candidate.parentOrdinal,
      memoryKind: candidate.memoryKind,
      parentContent: row.parent_content,
      parentMetadata: row.parent_metadata,
      entities: row.parent_entities,
      entityIds: row.parent_entity_ids,
      chunkOrdinal: row.chunk_ordinal,
      chunkKind: row.chunk_kind,
      chunkContent: row.chunk_content,
      embedding: embeddingByCandidateId.get(candidate.candidateId) ?? null,
      fusedRank: fusedRankByCandidateId.get(candidate.candidateId) ?? index + 1
    }] : [];
  });
  // Cutoff-mode canonical rows come from loadContextMemories' independently scoped validity-window query.
  const historicalCanonicalParents = scope.request.throughTurnNumber === undefined
    ? []
    : memories.filter((memory) => memory.memory_kind === "canonical_fact")
      .map((memory) => ({
        candidateId: `historical-canonical:${memory.id}`,
        parentMemoryId: memory.id,
        parentTurnId: memory.turn_id,
        ordinal: memory.ordinal,
        memoryKind: memory.memory_kind,
        parentContent: memory.content,
        parentMetadata: memory.metadata,
        entities: memory.entities,
        entityIds: memory.entity_ids,
        chunkOrdinal: 0,
        chunkKind: "canonical_fact" as const,
        chunkContent: memory.content,
        embedding: null,
        fusedRank: historicalCanonicalFusedRank
      }));
  const parentSelection = selectDiverseChronicleParents([
    ...rankedChunkParents,
    ...historicalCanonicalParents
  ], {
    ...rankFusionProfile.diversityPolicy,
    latestSceneParentMemoryId
  });
  const selectedParentContent = new Map(parentSelection.parents.map((parent) => (
    [parent.parentMemoryId, parent.content] as const
  )));
  const selectedParentIds = new Set(selectedParentContent.keys());
  const maximumScore = fused[0]?.score ?? 0;
  const memoriesById = new Map(memories.map((memory) => [memory.id, memory]));
  for (const candidate of fused) {
    if (!selectedParentIds.has(candidate.parentMemoryId)) continue;
    const row = candidateRows.get(candidate.candidateId);
    if (!row) continue;
    const memory = memoriesById.get(candidate.parentMemoryId) ?? contextMemoryFromChunk(row);
    const normalizedScore = maximumScore > 0 ? candidate.score / maximumScore : 0;
    const normalizedSignalScore = (signal: ChronicleRankSignal): number => maximumScore > 0
      ? candidate.contributions
        .filter((contribution) => contribution.signal === signal)
        .reduce((total, contribution) => total + contribution.score, 0) / maximumScore
      : 0;
    memory.relevance = Math.max(memory.relevance, normalizedScore);
    memory.lexicalRelevance = Math.max(memory.lexicalRelevance ?? 0, normalizedSignalScore("full_text"));
    if (semanticAvailable) {
      memory.semanticRelevance = Math.max(memory.semanticRelevance ?? 0, normalizedSignalScore("semantic"));
    }
    if (!memoriesById.has(memory.id)) {
      memories.push(memory);
      memoriesById.set(memory.id, memory);
    }
  }

  return {
    retrieval: {
      implementation: "chunked_hybrid",
      mode: semanticAvailable ? "hybrid" : [
        "semantic_retrieval_unavailable",
        "incompatible_chunk_embeddings"
      ].includes(semanticFallbackReason ?? "")
        ? "lexical_fallback"
        : "lexical",
      semanticAvailable,
      ...(semanticFallbackReason ? { fallbackReason: semanticFallbackReason } : {}),
      embeddedCandidates,
      rankedCandidates: fused.length,
      queryExpanded: variants.length > 1,
      effectiveQueryPrefix,
      embeddingRequests,
      queryCacheHits,
      queryCacheMisses,
      diversity: parentSelection.diagnostics satisfies ChronicleParentSelectionDiagnostics
    },
    selectedParentContent,
    providerFingerprint,
    costIds,
    auditTrace: {
      ...auditTrace,
      queryEmbeddingRequests: embeddingRequests,
      queryCacheHits,
      queryCacheMisses
    },
    telemetryCandidates: rankedChunkParents.slice(0, CHRONICLE_TELEMETRY_CANDIDATE_LIMIT).map((candidate) => ({
      candidateId: candidate.candidateId,
      parentMemoryId: candidate.parentMemoryId,
      rank: candidate.fusedRank,
      reason: "fused_rank",
      tokenEstimate: Math.max(0, estimateTokens(candidate.parentContent)),
      selected: selectedParentIds.has(candidate.parentMemoryId)
    }))
  };
}

function cloneContextMemories(memories: readonly ContextMemoryRow[]): ContextMemoryRow[] {
  return memories.map((memory) => ({
    ...memory,
    entities: [...memory.entities],
    entity_ids: [...memory.entity_ids],
    metadata: { ...memory.metadata }
  }));
}

function retrievalFallbackCode(retrieval: Readonly<Record<string, unknown>>): string | null {
  return typeof retrieval.fallbackReason === "string" ? retrieval.fallbackReason : null;
}

function auditRetrievalFallbackCode(
  retrieval: Readonly<Record<string, unknown>>,
): ChronicleRetrievalAudit["fallbackCode"] {
  const value = retrievalFallbackCode(retrieval);
  return [
    "empty_query",
    "semantic_not_configured",
    "provider_unavailable",
    "semantic_retrieval_unavailable",
    "chunk_index_not_ready",
    "incompatible_chunk_embeddings"
  ].includes(value ?? "") ? value as ChronicleRetrievalAudit["fallbackCode"] : null;
}

function rankedMemoryTelemetryCandidates(
  memories: readonly ContextMemoryRow[],
  selectedParentIds?: ReadonlySet<string>,
): readonly ChronicleRetrievalCandidate[] {
  return [...memories]
    .sort((left, right) => (right.relevance - left.relevance)
      || (right.importance - left.importance)
      || (right.ordinal - left.ordinal)
      || compareDeterministically(left.id, right.id))
    .slice(0, 1_000)
    .map((memory, index) => ({
      candidateId: memory.id,
      parentMemoryId: memory.id,
      rank: index + 1,
      reason: "memory_rank",
      tokenEstimate: Math.max(0, memory.token_estimate),
      selected: selectedParentIds?.has(memory.id) ?? (memory.relevance > 0 && index < 16)
    }));
}

export async function buildPostgresChronicleContextPreview(
  client: DatabaseClient,
  scope: Parameters<MemoryGenerationTransactionPort["buildContextPreview"]>[1],
  dependencies: ChronicleGenerationTransactionDependencies,
): Promise<ChronicleContextPreview> {
  const campaign = await loadContextCampaign(client, scope);
  const completeEntityCatalog = buildChronicleEntityCatalog({
    worldContent: campaign.world_content,
    characterSnapshot: campaign.character_snapshot,
    characterProfile: campaign.character_profile
  });
  let entityCatalog: readonly EntityReference[] = completeEntityCatalog;
  let entityExpandedQuery: string;
  let queryEntityIds: string[];
  let memories: ContextMemoryRow[];
  if (scope.request.throughTurnNumber !== undefined
    && completeEntityCatalog.some((entity) => entity.source === "character")) {
    const immutableWorldCatalog = completeEntityCatalog.filter((entity) => entity.source === "world");
    const preliminaryQuery = expandEntityQuery(scope.request.query, immutableWorldCatalog);
    const preliminaryEntityIds = matchEntityReferences(scope.request.query, immutableWorldCatalog)
      .map((match) => match.entity.id);
    const cutoffMemories = await loadContextMemories(client, scope, preliminaryQuery, preliminaryEntityIds);
    entityCatalog = cutoffSafeEntityCatalog(
      completeEntityCatalog,
      cutoffMemories,
      scope.request.throughTurnNumber
    );
    entityExpandedQuery = expandEntityQuery(scope.request.query, entityCatalog);
    queryEntityIds = matchEntityReferences(scope.request.query, entityCatalog).map((match) => match.entity.id);
    memories = await loadContextMemories(client, scope, entityExpandedQuery, queryEntityIds);
  } else {
    entityExpandedQuery = expandEntityQuery(scope.request.query, entityCatalog);
    queryEntityIds = matchEntityReferences(scope.request.query, entityCatalog).map((match) => match.entity.id);
    memories = await loadContextMemories(client, scope, entityExpandedQuery, queryEntityIds);
  }
  // Count only the already owner/campaign/world-version/cutoff-filtered rows.
  // This safe aggregate lets callers verify scope eligibility without exposing
  // candidate IDs, content, entity names, or provider diagnostics.
  const scopeEligibleCandidates = memories.length;
  const latestHint = memories.filter((memory) => memory.memory_kind === "turn_fiction").at(-1)?.content ?? "";
  const expandedQuery = [entityExpandedQuery, truncateAtBoundary(latestHint, 1200)].filter(Boolean).join("\n");
  const config = await loadContextConfig(client, scope);
  const productionImplementation = config?.retrieval_implementation ?? "legacy_hybrid";
  const executeLegacy = async (
    implementation: "lexical" | "legacy_hybrid",
    executionConfig: EmbeddingConfigRow | undefined,
    diagnosticMode: RetrievalDiagnosticMode = "production",
  ): Promise<RetrievalExecution> => {
    const executionMemories = cloneContextMemories(memories);
    const startedAt = performance.now();
    const result = await applyContextSemanticRelevance(
      client,
      scope,
      expandedQuery,
      executionMemories,
      queryEntityIds,
      dependencies,
      executionConfig,
      diagnosticMode,
      implementation
    );
    return {
      implementation,
      effectiveImplementation: "legacy_hybrid",
      memories: executionMemories,
      retrieval: { ...result.retrieval, implementation },
      selectedParentContent: null,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      providerFingerprint: result.providerFingerprint,
      costIds: result.costIds,
      auditTrace: result.auditTrace
    };
  };
  let chunkEmbeddingResolution: Promise<ChronicleTransactionEmbeddingResolution> | undefined;
  let chunkEmbeddingIdentity: Promise<ChunkEmbeddingIdentity | null> | undefined;
  let readyForChunked: boolean | undefined;
  const executeChunked = async (
    diagnosticMode: RetrievalDiagnosticMode = "production",
  ): Promise<RetrievalExecution> => {
    const startedAt = performance.now();
    const executeLegacyFallback = async (
      fallbackReason: string,
      executionConfig: EmbeddingConfigRow | undefined,
      priorCostIds: readonly string[] = [],
      priorFingerprint: string | null = null,
      priorAuditTrace: ChronicleRetrievalAuditTrace = emptyChronicleRetrievalAuditTrace(),
    ): Promise<RetrievalExecution> => {
      const legacy = await executeLegacy("legacy_hybrid", executionConfig, diagnosticMode);
      return {
        ...legacy,
        implementation: "chunked_hybrid",
        effectiveImplementation: "legacy_hybrid",
        retrieval: {
          ...legacy.retrieval,
          implementation: "chunked_hybrid",
          ...(["provider_unavailable", "semantic_retrieval_unavailable"].includes(fallbackReason)
            ? { mode: "lexical_fallback" }
            : {}),
          fallbackReason
        },
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        providerFingerprint: legacy.providerFingerprint ?? priorFingerprint,
        costIds: [...new Set([...priorCostIds, ...legacy.costIds])],
        auditTrace: mergeChronicleRetrievalAuditTraces(priorAuditTrace, legacy.auditTrace)
      };
    };
    if (!config?.embedding_enabled || !config.embedding_provider_profile_id || !config.embedding_model) {
      return executeLegacyFallback("semantic_not_configured", config);
    }
    const attemptSavepoint = `chronicle_retrieval_chunk_attempt_${diagnosticMode}`;
    type ChunkAttempt = Readonly<{
      kind: "fallback";
      reason: string;
      executionConfig: EmbeddingConfigRow | undefined;
      costIds?: readonly string[];
      fingerprint?: string | null;
      auditTrace?: ChronicleRetrievalAuditTrace;
    }> | Readonly<{
      kind: "chunked";
      executionMemories: ContextMemoryRow[];
      result: ChunkedRankFusionResult;
    }>;
    let attempt: ChunkAttempt;
    let chunkAttemptTrace = emptyChronicleRetrievalAuditTrace();
    await client.query(`SAVEPOINT ${attemptSavepoint}`);
    try {
      chunkEmbeddingResolution ??= dependencies.embeddings.resolve(client, {
        ownerUserId: scope.ownerUserId,
        campaignId: scope.campaignId,
        selectedProviderProfileId: config.embedding_provider_profile_id
      });
      const resolution = await chunkEmbeddingResolution;
      chunkAttemptTrace = auditTraceFromResolution(resolution);
      chunkEmbeddingIdentity ??= resolveChunkEmbeddingIdentity(client, scope, config, dependencies, resolution);
      const identity = await chunkEmbeddingIdentity;
      if (!identity) {
        attempt = {
          kind: "fallback",
          reason: "provider_unavailable",
          executionConfig: { ...config, embedding_enabled: false },
          auditTrace: chunkAttemptTrace
        };
      } else {
        readyForChunked ??= await chunkIndexReady(client, scope, identity);
        if (!readyForChunked) {
          attempt = { kind: "fallback", reason: "chunk_index_not_ready", executionConfig: config, auditTrace: identity.auditTrace };
        } else {
          const executionMemories = cloneContextMemories(memories);
          const result = await applyChunkedRankFusion(
            client,
            campaign,
            scope,
            executionMemories,
            entityCatalog,
            config,
            dependencies,
            diagnosticMode,
            identity
          );
          if (result.legacyFallbackReason) {
            attempt = {
              kind: "fallback",
              reason: result.legacyFallbackReason,
              executionConfig: result.legacyFallbackReason === "semantic_retrieval_unavailable"
                ? { ...config, embedding_enabled: false }
                : config,
              costIds: result.costIds,
              fingerprint: result.providerFingerprint,
              auditTrace: result.auditTrace
            };
          } else {
            attempt = { kind: "chunked", executionMemories, result };
          }
        }
      }
      await client.query(`RELEASE SAVEPOINT ${attemptSavepoint}`);
    } catch {
      await client.query(`ROLLBACK TO SAVEPOINT ${attemptSavepoint}`);
      await client.query(`RELEASE SAVEPOINT ${attemptSavepoint}`);
      try {
        dependencies.embeddings.logDiagnostic(new Error(
          diagnosticMode === "shadow" ? "chronicle_retrieval_shadow_failed" : "chronicle_retrieval_failed"
        ), {
          campaignId: scope.campaignId,
          generationJobId: scope.costAttribution?.generationJobId ?? null,
          memoryOperation: diagnosticMode === "shadow" ? "chronicle_retrieval_shadow" : "chronicle_retrieval",
          retrievalImplementation: "chunked_hybrid"
        });
      } catch {
        // Diagnostics cannot prevent the complete legacy fallback.
      }
      attempt = {
        kind: "fallback",
        reason: "semantic_retrieval_unavailable",
        executionConfig: { ...config, embedding_enabled: false },
        auditTrace: chunkAttemptTrace
      };
    }
    if (attempt.kind === "fallback") {
      return executeLegacyFallback(
        attempt.reason,
        attempt.executionConfig,
        attempt.costIds,
        attempt.fingerprint,
        attempt.auditTrace
      );
    }
    return {
      implementation: "chunked_hybrid",
      effectiveImplementation: "chunked_hybrid",
      memories: attempt.executionMemories,
      retrieval: attempt.result.retrieval,
      selectedParentContent: attempt.result.selectedParentContent,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      providerFingerprint: attempt.result.providerFingerprint,
      costIds: attempt.result.costIds,
      auditTrace: attempt.result.auditTrace,
      telemetryCandidates: attempt.result.telemetryCandidates
    };
  };
  const executeShadow = async (
    implementation: RetrievalExecution["implementation"],
    execute: () => Promise<RetrievalExecution>,
  ): Promise<RetrievalExecution> => {
    const startedAt = performance.now();
    const savepoint = `chronicle_retrieval_shadow_${implementation}`;
    await client.query(`SAVEPOINT ${savepoint}`);
    try {
      const execution = await execute();
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return execution;
    } catch {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      try {
        dependencies.embeddings.logDiagnostic(new Error("chronicle_retrieval_shadow_failed"), {
          campaignId: scope.campaignId,
          generationJobId: scope.costAttribution?.generationJobId ?? null,
          memoryOperation: "chronicle_retrieval_shadow",
          retrievalImplementation: implementation
        });
      } catch {
        // Shadow diagnostics are best-effort and must not affect production retrieval.
      }
      return {
        implementation,
        effectiveImplementation: "legacy_hybrid",
        memories: cloneContextMemories(memories),
        retrieval: {
          mode: "shadow_unavailable",
          semanticAvailable: false,
          fallbackReason: "shadow_execution_failed",
          implementation
        },
        selectedParentContent: null,
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        providerFingerprint: null,
        costIds: [],
        auditTrace: emptyChronicleRetrievalAuditTrace()
      };
    }
  };
  const executeProduction = async (
    implementation: RetrievalExecution["implementation"],
    execute: () => Promise<RetrievalExecution>,
  ): Promise<RetrievalExecution> => {
    const startedAt = performance.now();
    const savepoint = `chronicle_retrieval_production_${implementation}`;
    await client.query(`SAVEPOINT ${savepoint}`);
    try {
      const execution = await execute();
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return execution;
    } catch {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      try {
        dependencies.embeddings.logDiagnostic(new Error("chronicle_retrieval_failed"), {
          campaignId: scope.campaignId,
          generationJobId: scope.costAttribution?.generationJobId ?? null,
          memoryOperation: "chronicle_retrieval",
          retrievalImplementation: implementation
        });
      } catch {
        // Diagnostics are best-effort; semantic failures must retain lexical fallback.
      }
      return {
        implementation,
        effectiveImplementation: "legacy_hybrid",
        memories: cloneContextMemories(memories),
        retrieval: {
          mode: "lexical_fallback",
          semanticAvailable: false,
          fallbackReason: "semantic_retrieval_unavailable",
          implementation
        },
        selectedParentContent: null,
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        providerFingerprint: null,
        costIds: [],
        auditTrace: emptyChronicleRetrievalAuditTrace()
      };
    }
  };

  let retrievalExecutions: RetrievalExecution[];
  if (config?.retrieval_shadow_enabled) {
    const lexicalConfig = config ? { ...config, embedding_enabled: false } : undefined;
    const productionExecution = await executeProduction(
      productionImplementation,
      productionImplementation === "chunked_hybrid"
        ? () => executeChunked()
        : () => executeLegacy("legacy_hybrid", config)
    );
    const executions = new Map<RetrievalExecution["implementation"], RetrievalExecution>([
      [productionExecution.implementation, productionExecution]
    ]);
    if (!executions.has("lexical")) {
      executions.set("lexical", await executeShadow(
        "lexical",
        () => executeLegacy("lexical", lexicalConfig, "shadow")
      ));
    }
    if (!executions.has("legacy_hybrid")) {
      executions.set("legacy_hybrid", await executeShadow(
        "legacy_hybrid",
        () => executeLegacy("legacy_hybrid", config, "shadow")
      ));
    }
    if (!executions.has("chunked_hybrid")) {
      executions.set("chunked_hybrid", await executeShadow(
        "chunked_hybrid",
        () => executeChunked("shadow")
      ));
    }
    retrievalExecutions = (["lexical", "legacy_hybrid", "chunked_hybrid"] as const)
      .map((implementation) => executions.get(implementation)!);
  } else {
    retrievalExecutions = [await executeProduction(
      productionImplementation,
      productionImplementation === "chunked_hybrid"
        ? () => executeChunked()
        : () => executeLegacy("legacy_hybrid", config)
    )];
  }
  const productionExecution = retrievalExecutions.find((execution) => (
    execution.implementation === productionImplementation
  ))!;
  memories = productionExecution.memories;
  const retrievalResult = productionExecution.retrieval;
  const selectedParentContent = productionExecution.selectedParentContent;
  const retrieval = {
    ...retrievalResult,
    scopeEligibleCandidates
  };
  const chronicleRetrieval = buildChronicleRetrievalAudit({
    configuredImplementation: productionImplementation,
    effectiveImplementation: productionExecution.effectiveImplementation,
    semanticUsed: retrievalResult.semanticAvailable === true,
    fallbackCode: auditRetrievalFallbackCode(retrievalResult),
    trace: productionExecution.auditTrace
  });
  const metrics = await loadPostgresChronicleContextMetrics(client, scope);
  const sourceWorld = typeof campaign.world_content.world === "object" && campaign.world_content.world !== null
    ? campaign.world_content.world as Record<string, unknown>
    : campaign.world_content;
  const allTurnMemories = memories.filter((memory) => memory.memory_kind === "turn_fiction")
    .sort((left, right) => left.ordinal - right.ordinal || compareDeterministically(left.id, right.id));
  const latest = allTurnMemories.at(-1) ?? null;
  const buildFixedScopes = (scale: number) => {
    const authoritativeRules = sanitizeChronicleFictionString(
      sourceWorld.rules,
      Math.max(32, Math.floor(scope.request.budgetTokens * 0.18 * 3.2 * scale))
    );
    const worldCanon = worldFictionCanon(
      campaign.world_content,
      campaign.character_profile,
      campaign.character_snapshot,
      expandedQuery,
      Math.max(64, Math.floor(scope.request.budgetTokens * 0.30 * scale))
    );
    const campaignCanon = campaignFictionCanon(
      campaign,
      Math.max(48, Math.floor(scope.request.budgetTokens * 0.18 * scale))
    );
    const currentScene = latest ? {
      memoryId: latest.id,
      ordinal: latest.ordinal,
      content: truncateAtBoundary(
        latest.content,
        Math.max(64, Math.floor(scope.request.budgetTokens * 0.18 * 3.2 * scale))
      )
    } : null;
    return { authoritativeRules, worldCanon, campaignCanon, chronicle: [], currentScene };
  };
  let fixedScale = 1;
  let fixedScopes = buildFixedScopes(fixedScale);
  let fixedScopeTokens = budgetTokenEstimate(stableStringify(fixedScopes));
  while (fixedScopeTokens > scope.request.budgetTokens && fixedScale > 0.08) {
    fixedScale *= 0.78;
    fixedScopes = buildFixedScopes(fixedScale);
    fixedScopeTokens = budgetTokenEstimate(stableStringify(fixedScopes));
  }
  const { authoritativeRules, worldCanon, campaignCanon, currentScene } = fixedScopes;
  const availableTokens = Math.max(0, scope.request.budgetTokens - fixedScopeTokens);
  const selectedLevel = scope.request.compression === "auto"
    ? automaticCompression(metrics, availableTokens)
    : scope.request.compression;
  const optionalMemories = selectedParentContent === null
    ? memories
    : memories.filter((memory) => selectedParentContent.has(memory.id));
  const turnMemories = optionalMemories.filter((memory) => memory.memory_kind === "turn_fiction")
    .sort((left, right) => left.ordinal - right.ordinal || compareDeterministically(left.id, right.id));
  const parentContent = (memory: ContextMemoryRow): string => (
    selectedParentContent?.get(memory.id) ?? memory.content
  );
  const selected = new Map<string, { memory: ContextMemoryRow; rendered: string; reason: string }>();
  let consumedTokens = 0;
  const addMemory = (memory: ContextMemoryRow, rendered: string, reason: string): void => {
    if (selected.has(memory.id) || memory.id === latest?.id) return;
    const tokens = budgetTokenEstimate(stableStringify({
      id: memory.id,
      turnId: memory.turn_id,
      ordinal: memory.ordinal,
      kind: memory.memory_kind,
      reason,
      relevance: memory.relevance,
      entities: memory.entities,
      content: rendered,
      estimatedTokens: estimateTokens(rendered)
    }));
    if (consumedTokens + tokens > availableTokens) return;
    selected.set(memory.id, { memory, rendered, reason });
    consumedTokens += tokens;
  };
  const renderLevel = selectedLevel === "summary" ? "compact" : selectedLevel;
  const summary = optionalMemories.filter((memory) => memory.memory_kind === "campaign_summary")
    .sort((left, right) => right.ordinal - left.ordinal || compareDeterministically(left.id, right.id))[0]
    ?? (selectedLevel === "summary"
      ? optionalMemories.find((memory) => memory.memory_kind === "legacy_summary")
      : undefined);
  if (summary) addMemory(summary, parentContent(summary), "summary_checkpoint");
  const openThreads = optionalMemories.filter((memory) => memory.memory_kind === "open_thread")
    .sort((left, right) => right.ordinal - left.ordinal || compareDeterministically(left.id, right.id))[0];
  if (openThreads) addMemory(openThreads, parentContent(openThreads), "open_threads");
  optionalMemories.filter((memory) => memory.memory_kind === "canonical_fact")
    .forEach((memory) => addMemory(memory, parentContent(memory), "canonical_fact"));
  for (const memory of turnMemories.slice(-Math.max(1, scope.request.recentTurns))) {
    const content = parentContent(memory);
    const rendered = memory.ordinal > campaign.active_turn_number - 3
      ? content
      : compressTurnMemory(content, renderLevel);
    addMemory(memory, rendered, "recent");
  }
  const selectedIds = new Set(selected.keys());
  optionalMemories.filter((memory) => ["turn_fiction", "canonical_fact", "open_thread"].includes(memory.memory_kind)
    && !selectedIds.has(memory.id) && memory.relevance > 0)
    .sort((left, right) => (right.relevance - left.relevance)
      || (right.importance - left.importance) || (right.ordinal - left.ordinal))
    .slice(0, 16)
    .forEach((memory) => addMemory(memory, compressTurnMemory(parentContent(memory), renderLevel), "relevant"));
  if (selectedLevel !== "summary") {
    for (const memory of chronologicalCoverage(turnMemories)) {
      addMemory(memory, compressTurnMemory(parentContent(memory), renderLevel), "chronological");
    }
  }
  const renderChronicle = () => [...selected.values()]
    .sort((left, right) => left.memory.ordinal - right.memory.ordinal
      || compareDeterministically(left.memory.id, right.memory.id))
    .map(({ memory, rendered, reason }) => ({
      id: memory.id,
      turnId: memory.turn_id,
      ordinal: memory.ordinal,
      kind: memory.memory_kind,
      reason,
      relevance: Number(memory.relevance),
      lexicalRelevance: Number(memory.lexicalRelevance ?? memory.relevance),
      semanticRelevance: memory.semanticRelevance ?? null,
      entities: memory.entities,
      content: rendered,
      estimatedTokens: estimateTokens(rendered)
    }));
  let chronicle = renderChronicle();
  let scopes = { authoritativeRules, worldCanon, campaignCanon, chronicle, currentScene };
  let actualTokens = budgetTokenEstimate(stableStringify(scopes));
  while (actualTokens > scope.request.budgetTokens && selected.size > 0) {
    const lowestPriorityMemoryId = [...selected.keys()].at(-1);
    if (!lowestPriorityMemoryId) break;
    selected.delete(lowestPriorityMemoryId);
    chronicle = renderChronicle();
    scopes = { authoritativeRules, worldCanon, campaignCanon, chronicle, currentScene };
    actualTokens = budgetTokenEstimate(stableStringify(scopes));
  }
  const expectedForLevel = metrics.compressionEstimates[selectedLevel];
  if (config?.retrieval_shadow_enabled) {
    const productionSelectedParentIds = new Set(selected.keys());
    const comparisons: ChronicleRetrievalComparison[] = retrievalExecutions.map((execution) => ({
      implementation: execution.implementation,
      latencyMs: execution.latencyMs,
      fallbackCode: retrievalFallbackCode(execution.retrieval),
      selectedForProduction: execution.implementation === productionImplementation,
      candidates: (execution.telemetryCandidates
        ?? rankedMemoryTelemetryCandidates(execution.memories)).map((candidate) => ({
        ...candidate,
        selected: execution.implementation === productionImplementation
          ? productionSelectedParentIds.has(candidate.parentMemoryId)
          : candidate.selected
      }))
    }));
    try {
      await recordRetrievalComparison(client, {
        ownerUserId: scope.ownerUserId,
        campaignId: scope.campaignId,
        worldVersionId: scope.worldVersionId,
        queryHash: chronicleContentHash(scope.request.query),
        productionImplementation,
        shadowEnabled: true,
        retrievalVersion: CHRONICLE_RETRIEVAL_VERSION,
        embeddingProtocolVersion: CHRONICLE_EMBEDDING_PROTOCOL_VERSION,
        chunkProtocolVersion: CHRONICLE_CHUNK_PROTOCOL_VERSION,
        providerFingerprint: productionExecution.providerFingerprint
          ?? retrievalExecutions.find((execution) => execution.providerFingerprint)?.providerFingerprint
          ?? null,
        queryTokenEstimate: Math.max(0, estimateTokens(scope.request.query)),
        costIds: [...new Set(retrievalExecutions.flatMap((execution) => execution.costIds))],
        comparisons
      });
    } catch {
      try {
        dependencies.embeddings.logDiagnostic(new Error("chronicle_retrieval_telemetry_failed"), {
          campaignId: scope.campaignId,
          memoryOperation: "chronicle_retrieval_telemetry"
        });
      } catch {
        // Telemetry and its diagnostics are best-effort and cannot affect retrieval.
      }
    }
  }
  return {
    campaign: {
      id: campaign.id,
      title: campaign.title,
      activeTurnNumber: campaign.active_turn_number,
      worldVersionId: campaign.world_version_id,
      selectedCharacterId: campaign.selected_character_id,
      characterProfileRevision: campaign.character_profile_revision
    },
    selectedCompression: selectedLevel,
    requestedCompression: scope.request.compression,
    budget: {
      configuredTokens: scope.request.budgetTokens,
      reservedCanonTokens: fixedScopeTokens,
      fixedScopeTokens,
      availableChronicleTokens: availableTokens,
      estimatedSelectedTokens: actualTokens,
      completeHistoryTokens: metrics.estimatedCompleteHistoryTokens,
      expectedTokensForCompression: expectedForLevel,
      truncated: actualTokens > scope.request.budgetTokens || expectedForLevel > availableTokens
    },
    metrics,
    retrieval,
    chronicleRetrieval,
    scopes,
    exclusions: [
      "mechanics and roll records",
      "private scratchpad",
      "parser diagnostics and rejected output",
      "provider credentials"
    ]
  };
}
