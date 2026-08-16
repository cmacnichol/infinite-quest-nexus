import type { MemoryGenerationTransactionPort } from "../../application/src/memory/index.js";
import { requireCampaignWorldVersionScope } from "../../application/src/memory/helpers.js";
import type { CompressionLevel } from "../../contracts/src/memory.js";
import {
  buildChronicleEntityCatalog,
  CHRONICLE_EMBEDDING_PROTOCOL_VERSION,
  chronicleContentHash,
  modelAwareEmbeddingPrefixes,
  sanitizeChronicleFictionString,
  sanitizeChronicleFictionValue
} from "../../domain/src/chronicle-memory-helpers.js";
import {
  expandEntityQuery,
  matchEntityReferences,
  normalizeEntityTerm,
  type EntityReference
} from "../../domain/src/entity-references.js";
import { CHRONICLE_CHUNK_PROTOCOL_VERSION } from "../../domain/src/chronicle-chunking.js";
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
import { estimateTokens, stableStringify, truncateAtBoundary } from "../../domain/src/text.js";
import { characterNarrativeContext } from "../../domain/src/world-characters.js";
import { compressTurnMemory } from "../../story-engine/src/chronicle.js";
import type { ChronicleGenerationTransactionDependencies } from "./chronicle-repository.js";
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
  active_fact: boolean;
}>;

const CHUNK_CANDIDATE_LIMIT = 96;
const CHUNK_FUSION_PROFILE = Object.freeze({
  rrfK: 60,
  weights: {
    signals: {
      semantic: 1,
      full_text: 1,
      entity: 1,
      recency: 1,
      chronology: 1,
      importance: 1,
      kind: 1,
      temporal: 1
    },
    variants: { action: 1, entity_expanded: 1, scene: 1, open_thread: 1 }
  }
} as const);

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

function relevanceTerms(query: string): string[] {
  return [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_'-]{3,}/gu) ?? [])].slice(0, 64);
}

function selectWorldItems(items: unknown, query: string, limit: number): unknown[] {
  if (!Array.isArray(items)) return [];
  const terms = relevanceTerms(query);
  return items.map((item, index) => {
    const serialized = stableStringify(item).toLocaleLowerCase();
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
  const perOverviewLimit = Math.max(300, Math.floor(maximumTokens * 2.6 / allowed.length));
  const result: Record<string, unknown> = Object.fromEntries(allowed.flatMap((key) => {
    const sanitized = sanitizeChronicleFictionString(world[key], perOverviewLimit);
    return sanitized ? [[key, sanitized]] : [];
  }));
  const playerCharacter = sanitizeChronicleFictionValue(characterNarrativeContext(
    characterProfile,
    characterSnapshot,
    Math.max(800, Math.floor(maximumTokens * 3.2)),
    Math.max(240, Math.floor(maximumTokens * 0.42))
  ));
  if (playerCharacter && typeof playerCharacter === "object") result.playerCharacter = playerCharacter;
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
    campaignTitle: campaign.title,
    acceptedTurns: campaign.active_turn_number
  };
  const scratchpad = campaign.scratchpad_safe_for_prompt
    ? sanitizeChronicleFictionString(campaign.scratchpad_private, Math.max(400, Math.floor(maximumTokens * 1.8)))
    : "";
  if (scratchpad) result.continuityScratchpad = scratchpad;
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
       SELECT id, turn_id, memory_kind, ordinal, content, token_estimate, importance, entities, entity_ids, created_at,
              CASE WHEN $4 = '' THEN 0::real
                   ELSE ts_rank_cd(search_document, websearch_to_tsquery('english', $4)) END AS relevance
         FROM chronicle_memories
        WHERE owner_user_id = $1 AND campaign_id = $2 AND world_version_id = $3
          AND ($6::integer IS NULL OR ordinal <= $6::integer)
          AND ($6::integer IS NULL OR memory_kind NOT IN ('legacy_summary','canonical_fact'))
     ), ranked AS (
       SELECT *,
              row_number() OVER (PARTITION BY memory_kind ORDER BY ordinal DESC, created_at DESC) AS recent_rank,
              row_number() OVER (PARTITION BY memory_kind ORDER BY ordinal ASC, created_at ASC) AS sequence_rank,
              count(*) OVER (PARTITION BY memory_kind) AS kind_count,
              row_number() OVER (PARTITION BY memory_kind ORDER BY relevance DESC, ordinal DESC) AS lexical_rank,
              row_number() OVER (PARTITION BY memory_kind ORDER BY CASE WHEN entity_ids && $7::text[] THEN 1 ELSE 0 END DESC, ordinal DESC) AS entity_rank
         FROM base
     )
     SELECT id, turn_id, memory_kind, ordinal, content, token_estimate, importance, entities, entity_ids, relevance
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
): Promise<Record<string, unknown>> {
  const normalizedQuery = query.toLocaleLowerCase();
  const queryEntityIdSet = new Set(queryEntityIds);
  const newestOrdinal = memories.reduce((maximum, memory) => Math.max(maximum, memory.ordinal), 0);
  for (const memory of memories) {
    memory.lexicalRelevance = Number(memory.relevance);
    const lexical = Math.min(1, Math.max(0, Number(memory.lexicalRelevance || 0) * 8));
    const entityScore = memory.entity_ids.some((id) => queryEntityIdSet.has(id))
      || memory.entities.some((entity) => normalizedQuery.includes(entity.toLocaleLowerCase())) ? 1 : 0;
    const recencyScore = newestOrdinal > 0
      ? Math.max(0, 1 - (newestOrdinal - memory.ordinal) / Math.max(20, newestOrdinal))
      : 0;
    memory.relevance = lexical > 0 || entityScore > 0
      ? lexical * 0.65 + entityScore * 0.15 + recencyScore * 0.1 + memory.importance * 0.1
      : 0;
  }
  if (!query.trim()) return { mode: "lexical", semanticAvailable: false, fallbackReason: "empty_query" };
  if (!config?.embedding_enabled || !config.embedding_provider_profile_id || !config.embedding_model) {
    return { mode: "lexical", semanticAvailable: false, fallbackReason: "semantic_not_configured" };
  }
  const providerProfileId = await dependencies.embeddings.resolve(client, {
    ownerUserId: scope.ownerUserId,
    campaignId: scope.campaignId,
    selectedProviderProfileId: config.embedding_provider_profile_id
  });
  if (!providerProfileId) return { mode: "lexical", semanticAvailable: false, fallbackReason: "provider_unavailable" };
  const providerScope = { ownerUserId: scope.ownerUserId, providerProfileId, model: config.embedding_model };
  try {
    const provider = await dependencies.embeddings.load(client, providerScope);
    const prefixes = modelAwareEmbeddingPrefixes(
      config.embedding_model,
      config.embedding_document_prefix,
      config.embedding_query_prefix
    );
    const fingerprint = await dependencies.embeddings.fingerprint(provider, prefixes);
    const result = await dependencies.embeddings.embed(provider, [`${prefixes.queryPrefix}${query.trim()}`]);
    await dependencies.embeddings.recordCost(client, provider, {
      ownerUserId: scope.ownerUserId,
      campaignId: scope.campaignId,
      ...(scope.costAttribution?.generationJobId
        ? { generationJobId: scope.costAttribution.generationJobId }
        : {}),
      operation: scope.costAttribution?.operation ?? "context_preview_embedding"
    }, result);
    const queryVector = result.embeddings[0];
    if (!queryVector?.length) throw new Error("Embedding provider returned no query vector.");
    const scored = await client.query<ContextMemoryRow>(
      `SELECT id, turn_id, memory_kind, ordinal, content, token_estimate, importance, entities, entity_ids,
              0::real AS relevance, embedding_content_hash,
              (1 - (embedding <=> $6::vector))::real AS semantic_relevance
         FROM chronicle_memories
        WHERE owner_user_id = $1 AND campaign_id = $2 AND world_version_id = $3
          AND ($9::integer IS NULL OR ordinal <= $9::integer)
          AND ($9::integer IS NULL OR memory_kind <> 'legacy_summary')
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
        || memory.entities.some((entity) => normalizedQuery.includes(entity.toLocaleLowerCase())) ? 1 : 0;
      const recencyScore = newestOrdinal > 0
        ? Math.max(0, 1 - (newestOrdinal - memory.ordinal) / Math.max(20, newestOrdinal))
        : 0;
      memory.semanticRelevance = semanticScore;
      memory.relevance = semanticScore >= 0.2 || lexical > 0 || entityScore > 0
        ? semanticScore * 0.55 + lexical * 0.25 + entityScore * 0.1 + recencyScore * 0.05 + memory.importance * 0.05
        : 0;
    }
    await dependencies.embeddings.recordHealth(client, providerScope, true);
    return {
      mode: "hybrid",
      semanticAvailable: true,
      embeddedCandidates: freshScores.length,
      model: config.embedding_model,
      queryExpanded: true,
      effectiveQueryPrefix: prefixes.queryPrefix
    };
  } catch (error) {
    dependencies.embeddings.logDiagnostic(error, {
      campaignId: scope.campaignId,
      providerProfileId,
      generationJobId: scope.costAttribution?.generationJobId ?? null,
      memoryOperation: scope.costAttribution?.operation ?? "context_preview_embedding"
    });
    await dependencies.embeddings.recordHealth(client, providerScope, false, "chronicle_retrieval_failed").catch(() => undefined);
    return { mode: "lexical_fallback", semanticAvailable: false, fallbackReason: "semantic_retrieval_unavailable" };
  }
}

async function chunkIndexReady(
  client: DatabaseClient,
  scope: Parameters<MemoryGenerationTransactionPort["buildContextPreview"]>[1],
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
     )
     SELECT (
       EXISTS (
         SELECT 1 FROM chronicle_memory_chunks chunk
         JOIN current_parents parent ON parent.id=chunk.parent_memory_id
          AND parent.content_hash=chunk.parent_content_hash
        WHERE chunk.owner_user_id = $1 AND chunk.campaign_id = $2 AND chunk.world_version_id = $3
          AND chunk.chunking_protocol_version='${CHRONICLE_CHUNK_PROTOCOL_VERSION}'
          AND chunk.embedding_status='embedded'
       )
       AND NOT EXISTS (
         SELECT 1 FROM current_parents parent
          WHERE NOT EXISTS (
            SELECT 1 FROM chronicle_memory_chunks chunk
             WHERE chunk.parent_memory_id=parent.id AND chunk.parent_content_hash=parent.content_hash
               AND chunk.owner_user_id = $1 AND chunk.campaign_id = $2 AND chunk.world_version_id = $3
               AND chunk.chunking_protocol_version='${CHRONICLE_CHUNK_PROTOCOL_VERSION}'
               AND (chunk.embedding_status='embedded'
                    OR (chunk.embedding_status='skipped'
                        AND chunk.embedding_skip_reason='chunk_embedding_skipped'))
          )
       )
       AND NOT EXISTS (
         SELECT 1 FROM chronicle_memory_chunks chunk
         JOIN current_parents parent ON parent.id=chunk.parent_memory_id
          AND parent.content_hash=chunk.parent_content_hash
        WHERE chunk.owner_user_id = $1 AND chunk.campaign_id = $2 AND chunk.world_version_id = $3
          AND chunk.chunking_protocol_version='${CHRONICLE_CHUNK_PROTOCOL_VERSION}'
          AND NOT (chunk.embedding_status='embedded'
                   OR (chunk.embedding_status='skipped'
                       AND chunk.embedding_skip_reason='chunk_embedding_skipped'))
       )
       AND COALESCE((SELECT status='completed' FROM latest_job),true)
     ) AS chunk_index_ready`,
    [scope.ownerUserId, scope.campaignId, scope.worldVersionId]
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
          AND chunk.chunking_protocol_version='${CHRONICLE_CHUNK_PROTOCOL_VERSION}'
          AND (chunk.embedding_status='embedded'
               OR (chunk.embedding_status='skipped' AND chunk.embedding_skip_reason='chunk_embedding_skipped'))
          AND ($4::integer IS NULL OR parent.ordinal <= $4::integer)
          AND ($4::integer IS NULL OR parent.memory_kind <> 'canonical_fact')
          AND (parent.memory_kind <> 'canonical_fact' OR (
            $4::integer IS NULL
            AND jsonb_typeof(parent.metadata->'structuredFactIds')='array'
            AND jsonb_array_length(parent.metadata->'structuredFactIds')>0
            AND NOT EXISTS (
              SELECT 1
                FROM jsonb_array_elements_text(parent.metadata->'structuredFactIds') fact_id(value)
                LEFT JOIN campaign_canonical_facts fact
                  ON fact.id::text=fact_id.value
                 AND fact.owner_user_id = $1 AND fact.campaign_id = $2 AND fact.world_version_id = $3
               WHERE fact.id IS NULL OR fact.valid_until_turn IS NOT NULL
            )
          ))
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
    predicate = `embedding_status='embedded' AND embedding IS NOT NULL
      AND embedding_provider_profile_id=$6 AND embedding_model=$7
      AND embedding_dimensions=$8 AND embedding_protocol_version='${CHRONICLE_EMBEDDING_PROTOCOL_VERSION}'
      AND embedding_provider_fingerprint=$9 AND embedding_content_hash=content_hash`;
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
  baseValues.push(CHUNK_CANDIDATE_LIMIT);
  const result = await client.query<ChunkCandidateRow>(
    `/* chronicle_rank:${request.signal}:${request.variant.kind} */
     WITH ${authorizedChunkCte()}, ranked AS (
       SELECT *,row_number() OVER (ORDER BY ${order}) AS signal_rank
         FROM authorized
        WHERE ${predicate}
     )
     SELECT candidate_id,parent_memory_id,parent_turn_id,parent_memory_kind,parent_ordinal,
            parent_content,parent_token_estimate,parent_importance,parent_entities,parent_entity_ids,active_fact
       FROM ranked
      ORDER BY signal_rank,parent_memory_id,candidate_id
      LIMIT $${limitParameter}`,
    baseValues
  );
  return result.rows;
}

function plannedChunkQueries(
  scope: Parameters<MemoryGenerationTransactionPort["buildContextPreview"]>[1],
  memories: readonly ContextMemoryRow[],
  entityCatalog: readonly EntityReference[],
): readonly ChronicleQueryVariant[] {
  const entityHints = matchEntityReferences(scope.request.query, entityCatalog).flatMap(({ entity, matchedAlias }) => {
    const authorizedMemories = memories.filter((memory) => memory.entity_ids.includes(entity.id));
    if (!authorizedMemories.length) return [];
    const aliasKey = normalizeEntityTerm(matchedAlias);
    const historicallyAttested = scope.request.throughTurnNumber === undefined
      || entity.source === "world"
      || authorizedMemories.some((memory) => (
        memory.entities.some((term) => normalizeEntityTerm(term) === aliasKey)
        || matchEntityReferences(memory.content, [entity])
          .some((match) => normalizeEntityTerm(match.matchedAlias) === aliasKey)
      ));
    if (!historicallyAttested) return [];
    const catalogTerms = new Set([entity.displayName, ...entity.aliases]
      .map(normalizeEntityTerm));
    const terms = [...new Set(authorizedMemories.flatMap((memory) => memory.entities)
      .filter((term) => catalogTerms.has(normalizeEntityTerm(term))))]
      .sort((left, right) => left.localeCompare(right));
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
): Promise<Record<string, unknown>> {
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
  if (!variants.length) {
    semanticFallbackReason = "empty_query";
  } else if (!config.embedding_enabled || !config.embedding_provider_profile_id || !config.embedding_model) {
    semanticFallbackReason = "semantic_not_configured";
  } else {
    const selectedProviderProfileId = config.embedding_provider_profile_id;
    try {
      const providerProfileId = await dependencies.embeddings.resolve(client, {
        ownerUserId: scope.ownerUserId,
        campaignId: scope.campaignId,
        selectedProviderProfileId
      });
      if (!providerProfileId) {
        semanticFallbackReason = "provider_unavailable";
      } else {
        const providerScope = { ownerUserId: scope.ownerUserId, providerProfileId, model: config.embedding_model };
        const provider = await dependencies.embeddings.load(client, providerScope);
        const prefixes = modelAwareEmbeddingPrefixes(
          config.embedding_model,
          config.embedding_document_prefix,
          config.embedding_query_prefix
        );
        effectiveQueryPrefix = prefixes.queryPrefix;
        const fingerprint = await dependencies.embeddings.fingerprint(provider, prefixes);
        const result = await dependencies.embeddings.embed(
          provider,
          variants.map((variant) => `${prefixes.queryPrefix}${variant.query}`)
        );
        await dependencies.embeddings.recordCost(client, provider, {
          ownerUserId: scope.ownerUserId,
          campaignId: scope.campaignId,
          ...(scope.costAttribution?.generationJobId
            ? { generationJobId: scope.costAttribution.generationJobId }
            : {}),
          operation: scope.costAttribution?.operation ?? "context_preview_embedding"
        }, result);
        if (result.embeddings.length !== variants.length) {
          throw new Error("Embedding provider returned an incomplete Chronicle query batch.");
        }
        const semanticRanks: Array<Readonly<{
          variant: ChronicleQueryVariant;
          rows: readonly ChunkCandidateRow[];
        }>> = [];
        for (let index = 0; index < variants.length; index += 1) {
          const variant = variants[index]!;
          const vector = result.embeddings[index];
          if (!vector?.length) throw new Error("Embedding provider returned an empty Chronicle query vector.");
          const rows = await loadAuthorizedChunkRank(client, scope, {
            signal: "semantic",
            variant,
            vector,
            providerProfileId,
            model: config.embedding_model,
            fingerprint
          });
          semanticRanks.push({ variant, rows });
        }
        await dependencies.embeddings.recordHealth(client, providerScope, true);
        semanticRanks.forEach(({ variant, rows }) => {
          embeddedCandidates += rows.length;
          addRank("semantic", variant, rows);
        });
        semanticAvailable = true;
      }
    } catch (error) {
      semanticFallbackReason = "semantic_retrieval_unavailable";
      dependencies.embeddings.logDiagnostic(error, {
        campaignId: scope.campaignId,
        providerProfileId: selectedProviderProfileId,
        generationJobId: scope.costAttribution?.generationJobId ?? null,
        memoryOperation: scope.costAttribution?.operation ?? "context_preview_embedding"
      });
      await dependencies.embeddings.recordHealth(client, {
        ownerUserId: scope.ownerUserId,
        providerProfileId: selectedProviderProfileId,
        model: config.embedding_model
      }, false, "chronicle_retrieval_failed").catch(() => undefined);
    }
  }

  for (const variant of variants) {
    addRank("full_text", variant, await loadAuthorizedChunkRank(client, scope, {
      signal: "full_text", variant, query: variant.query
    }));
    if (variant.entityIds.length) {
      addRank("entity", variant, await loadAuthorizedChunkRank(client, scope, {
        signal: "entity", variant, entityIds: variant.entityIds
      }));
    }
  }
  for (const signal of ["recency", "chronology", "importance", "kind"] as const) {
    addRank(signal, actionVariant, await loadAuthorizedChunkRank(client, scope, { signal, variant: actionVariant }));
  }
  addRank("temporal", actionVariant, await loadAuthorizedChunkRank(client, scope, {
    signal: "temporal",
    variant: actionVariant,
    temporalAnchor: scope.request.throughTurnNumber ?? campaign.active_turn_number
  }));

  const fused = fuseChronicleRanks(inputs, CHUNK_FUSION_PROFILE);
  const maximumScore = fused[0]?.score ?? 0;
  const memoriesById = new Map(memories.map((memory) => [memory.id, memory]));
  for (const candidate of fused) {
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
    implementation: "chunked_hybrid",
    mode: semanticAvailable ? "hybrid" : semanticFallbackReason === "semantic_retrieval_unavailable"
      ? "lexical_fallback"
      : "lexical",
    semanticAvailable,
    ...(semanticFallbackReason ? { fallbackReason: semanticFallbackReason } : {}),
    embeddedCandidates,
    rankedCandidates: fused.length,
    queryExpanded: variants.length > 1,
    effectiveQueryPrefix
  };
}

export async function buildPostgresChronicleContextPreview(
  client: DatabaseClient,
  scope: Parameters<MemoryGenerationTransactionPort["buildContextPreview"]>[1],
  dependencies: ChronicleGenerationTransactionDependencies,
): Promise<Record<string, unknown>> {
  const campaign = await loadContextCampaign(client, scope);
  const entityCatalog = buildChronicleEntityCatalog({
    worldContent: campaign.world_content,
    characterSnapshot: campaign.character_snapshot,
    characterProfile: campaign.character_profile
  });
  const entityExpandedQuery = expandEntityQuery(scope.request.query, entityCatalog);
  const queryEntityIds = matchEntityReferences(scope.request.query, entityCatalog).map((match) => match.entity.id);
  const memories = await loadContextMemories(client, scope, entityExpandedQuery, queryEntityIds);
  // Count only the already owner/campaign/world-version/cutoff-filtered rows.
  // This safe aggregate lets callers verify scope eligibility without exposing
  // candidate IDs, content, entity names, or provider diagnostics.
  const scopeEligibleCandidates = memories.length;
  const latestHint = memories.filter((memory) => memory.memory_kind === "turn_fiction").at(-1)?.content ?? "";
  const expandedQuery = [entityExpandedQuery, truncateAtBoundary(latestHint, 1200)].filter(Boolean).join("\n");
  const config = await loadContextConfig(client, scope);
  let retrievalResult: Record<string, unknown>;
  if (config?.retrieval_implementation === "chunked_hybrid") {
    if (await chunkIndexReady(client, scope)) {
      retrievalResult = await applyChunkedRankFusion(
        client,
        campaign,
        scope,
        memories,
        entityCatalog,
        config,
        dependencies
      );
    } else {
      retrievalResult = {
        ...await applyContextSemanticRelevance(
          client,
          scope,
          expandedQuery,
          memories,
          queryEntityIds,
          dependencies,
          config
        ),
        fallbackReason: "chunk_index_not_ready"
      };
    }
  } else {
    retrievalResult = await applyContextSemanticRelevance(
      client,
      scope,
      expandedQuery,
      memories,
      queryEntityIds,
      dependencies,
      config
    );
  }
  const retrieval = {
    ...retrievalResult,
    scopeEligibleCandidates
  };
  const metrics = await loadPostgresChronicleContextMetrics(client, scope);
  const sourceWorld = typeof campaign.world_content.world === "object" && campaign.world_content.world !== null
    ? campaign.world_content.world as Record<string, unknown>
    : campaign.world_content;
  const authoritativeRules = sanitizeChronicleFictionString(
    sourceWorld.rules,
    Math.max(1200, Math.floor(scope.request.budgetTokens * 0.18 * 3.2))
  );
  const worldCanon = worldFictionCanon(
    campaign.world_content,
    campaign.character_profile,
    campaign.character_snapshot,
    expandedQuery,
    Math.max(384, Math.floor(scope.request.budgetTokens * 0.30))
  );
  const campaignCanon = campaignFictionCanon(campaign, Math.max(256, Math.floor(scope.request.budgetTokens * 0.18)));
  const turnMemories = memories.filter((memory) => memory.memory_kind === "turn_fiction");
  const latest = turnMemories.at(-1) ?? null;
  const currentScene = latest ? {
    memoryId: latest.id,
    ordinal: latest.ordinal,
    content: truncateAtBoundary(latest.content, Math.max(800, Math.floor(scope.request.budgetTokens * 0.18 * 3.2)))
  } : null;
  const fixedScopes = { authoritativeRules, worldCanon, campaignCanon, chronicle: [], currentScene };
  const fixedScopeTokens = budgetTokenEstimate(stableStringify(fixedScopes));
  const availableTokens = Math.max(0, scope.request.budgetTokens - fixedScopeTokens);
  const selectedLevel = scope.request.compression === "auto"
    ? automaticCompression(metrics, availableTokens)
    : scope.request.compression;
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
  const summary = memories.filter((memory) => memory.memory_kind === "campaign_summary")
    .sort((left, right) => right.ordinal - left.ordinal)[0]
    ?? (selectedLevel === "summary" ? memories.find((memory) => memory.memory_kind === "legacy_summary") : undefined);
  if (summary) addMemory(summary, summary.content, "summary_checkpoint");
  const openThreads = memories.filter((memory) => memory.memory_kind === "open_thread")
    .sort((left, right) => right.ordinal - left.ordinal)[0];
  if (openThreads) addMemory(openThreads, openThreads.content, "open_threads");
  memories.filter((memory) => memory.memory_kind === "canonical_fact")
    .forEach((memory) => addMemory(memory, memory.content, "canonical_fact"));
  for (const memory of turnMemories.slice(-Math.max(1, scope.request.recentTurns))) {
    const rendered = memory.ordinal > campaign.active_turn_number - 3
      ? memory.content
      : compressTurnMemory(memory.content, renderLevel);
    addMemory(memory, rendered, "recent");
  }
  const selectedIds = new Set(selected.keys());
  memories.filter((memory) => ["turn_fiction", "canonical_fact", "open_thread"].includes(memory.memory_kind)
    && !selectedIds.has(memory.id) && memory.relevance > 0)
    .sort((left, right) => (right.relevance - left.relevance)
      || (right.importance - left.importance) || (right.ordinal - left.ordinal))
    .slice(0, 16)
    .forEach((memory) => addMemory(memory, compressTurnMemory(memory.content, renderLevel), "relevant"));
  if (selectedLevel !== "summary") {
    turnMemories.forEach((memory) => addMemory(memory, compressTurnMemory(memory.content, renderLevel), "chronological"));
  }
  const chronicle = [...selected.values()]
    .sort((left, right) => left.memory.ordinal - right.memory.ordinal)
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
  const scopes = { authoritativeRules, worldCanon, campaignCanon, chronicle, currentScene };
  const actualTokens = budgetTokenEstimate(stableStringify(scopes));
  const expectedForLevel = metrics.compressionEstimates[selectedLevel];
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
    scopes,
    exclusions: [
      "mechanics and roll records",
      "private scratchpad",
      "parser diagnostics and rejected output",
      "provider credentials"
    ]
  };
}
