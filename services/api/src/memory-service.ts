import { createHash } from "node:crypto";
import type { DatabaseClient, DatabasePool } from "../../../packages/database/src/pool.js";
import { initialOwnerId, withTransaction } from "../../../packages/database/src/pool.js";
import { DEFAULT_EMBEDDING_MODEL, type CampaignEmbeddingConfig, type CompressionLevel, type MemoryContextQuery } from "../../../packages/contracts/src/memory.js";
import { compressTurnMemory, buildTurnFictionMemory } from "../../../packages/story-engine/src/chronicle.js";
import { callEmbeddingProvider } from "../../../packages/story-engine/src/providers.js";
import { estimateTokens, extractEntities, stableStringify, stripMechanicsLeakage, truncateAtBoundary } from "../../../packages/domain/src/text.js";
import { loadEmbeddingProvider, recordProviderHealth, resolveEffectiveProviderId } from "./provider-service.js";
import { recordProfileCost } from "./cost-service.js";

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

type CampaignScopeRow = {
  id: string;
  title: string;
  active_turn_number: number;
  world_version_id: string;
  world_content: Record<string, unknown>;
  scratchpad_private: string;
  scratchpad_safe_for_prompt: boolean;
  trackers: unknown;
};

type MemoryRow = {
  id: string;
  turn_id: string | null;
  memory_kind: "turn_fiction" | "legacy_summary" | "campaign_summary" | "canonical_fact" | "open_thread";
  ordinal: number;
  content: string;
  token_estimate: number;
  importance: number;
  entities: string[];
  relevance: number;
  lexicalRelevance?: number;
  semanticRelevance?: number;
};

type CompleteMetricsRow = {
  turns: string;
  characters: string;
  estimated_tokens: string;
  memory_count: string;
  memory_tokens: string;
  embedded_memories: string;
  turn_memory_tokens: string;
  recent_turn_tokens: string;
  summary_tokens: string;
};

type EmbeddingConfigRow = {
  embedding_enabled: boolean;
  embedding_provider_profile_id: string | null;
  embedding_model: string;
  embedding_batch_size: number;
  embedding_document_prefix: string | null;
  embedding_query_prefix: string | null;
  updated_at: Date;
};

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function budgetTokenEstimate(text: string): number {
  return Math.max(estimateTokens(text), Math.ceil(text.length / 3));
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

function modelAwarePrefixes(model: string, documentPrefix: string | null, queryPrefix: string | null) {
  const nomic = /(?:^|[\/_-])nomic(?:[\/_-]|$)/i.test(model);
  return {
    documentPrefix: documentPrefix ?? (nomic ? "search_document: " : ""),
    queryPrefix: queryPrefix ?? (nomic ? "search_query: " : ""),
    automatic: documentPrefix === null && queryPrefix === null
  };
}

function providerFingerprint(
  provider: Awaited<ReturnType<typeof loadEmbeddingProvider>>,
  prefixes: ReturnType<typeof modelAwarePrefixes>
): string {
  return contentHash(stableStringify({
    providerType: provider.providerType,
    baseUrl: provider.baseUrl.replace(/\/+$/, ""),
    model: provider.model,
    configuration: provider.configuration ?? {},
    documentPrefix: prefixes.documentPrefix,
    queryPrefix: prefixes.queryPrefix
  }));
}

function publicEmbeddingConfig(row?: EmbeddingConfigRow) {
  const model = row?.embedding_model || DEFAULT_EMBEDDING_MODEL;
  const prefixes = modelAwarePrefixes(model, row?.embedding_document_prefix ?? null, row?.embedding_query_prefix ?? null);
  return {
    enabled: row?.embedding_enabled ?? false,
    providerProfileId: row?.embedding_provider_profile_id ?? null,
    model,
    batchSize: row?.embedding_batch_size ?? 16,
    documentPrefix: row?.embedding_document_prefix ?? null,
    queryPrefix: row?.embedding_query_prefix ?? null,
    effectiveDocumentPrefix: prefixes.documentPrefix,
    effectiveQueryPrefix: prefixes.queryPrefix,
    prefixesAutomatic: prefixes.automatic
  };
}

async function resolveCampaignEmbeddingProviderId(
  client: DatabaseClient | DatabasePool,
  ownerUserId: string,
  campaignId: string,
  selectedProviderId?: string | null
): Promise<string | null> {
  const embeddingProviders = await client.query<{ id: string }>(
    "SELECT id FROM provider_profiles WHERE owner_user_id = $1 AND provider_role = 'embedding' AND enabled = true",
    [ownerUserId]
  );
  if (selectedProviderId) {
    const selectedProvider = await client.query<{ provider_role: "text" | "embedding" }>(
      "SELECT provider_role FROM provider_profiles WHERE id = $1 AND owner_user_id = $2 AND enabled = true AND provider_role IN ('embedding','text')",
      [selectedProviderId, ownerUserId]
    );
    const selectedRole = selectedProvider.rows[0]?.provider_role;
    if (selectedRole === "embedding" || selectedRole === "text") return selectedProviderId;
  }
  if (embeddingProviders.rowCount) return resolveEffectiveProviderId(client, ownerUserId, "embedding");
  const campaign = await client.query<{ text_provider_profile_id: string | null }>(
    "SELECT text_provider_profile_id FROM campaigns WHERE id = $1 AND owner_user_id = $2",
    [campaignId, ownerUserId]
  );
  return resolveEffectiveProviderId(client, ownerUserId, "text", campaign.rows[0]?.text_provider_profile_id);
}

async function embeddingConfig(
  client: DatabaseClient | DatabasePool,
  ownerUserId: string,
  campaignId: string
): Promise<EmbeddingConfigRow | undefined> {
  const result = await client.query<EmbeddingConfigRow>(
    `SELECT embedding_enabled, embedding_provider_profile_id, embedding_model, embedding_batch_size,
            embedding_document_prefix, embedding_query_prefix, updated_at
       FROM campaign_memory_configs WHERE campaign_id = $1 AND owner_user_id = $2`,
    [campaignId, ownerUserId]
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    ...row,
    embedding_provider_profile_id: await resolveCampaignEmbeddingProviderId(
      client,
      ownerUserId,
      campaignId,
      row.embedding_provider_profile_id
    )
  };
}

export async function getCampaignEmbeddingConfig(pool: DatabasePool, campaignId: string) {
  const ownerUserId = await initialOwnerId(pool);
  await campaignScope(pool, ownerUserId, campaignId);
  const row = await embeddingConfig(pool, ownerUserId, campaignId);
  if (row) return publicEmbeddingConfig(row);
  return {
    ...publicEmbeddingConfig(),
    providerProfileId: await resolveCampaignEmbeddingProviderId(pool, ownerUserId, campaignId)
  };
}

export async function setCampaignEmbeddingConfig(pool: DatabasePool, campaignId: string, input: CampaignEmbeddingConfig) {
  const ownerUserId = await initialOwnerId(pool);
  const embeddingModel = input.model || DEFAULT_EMBEDDING_MODEL;
  await campaignScope(pool, ownerUserId, campaignId);
  const embeddingProviders = await pool.query<{ id: string }>("SELECT id FROM provider_profiles WHERE owner_user_id = $1 AND provider_role = 'embedding' AND enabled = true", [ownerUserId]);
  const campaign = await pool.query<{ text_provider_profile_id: string | null }>("SELECT text_provider_profile_id FROM campaigns WHERE id = $1 AND owner_user_id = $2", [campaignId, ownerUserId]);
  let providerProfileId = input.providerProfileId;
  if (providerProfileId) {
    const provider = await pool.query<{ provider_role: "text" | "embedding" }>("SELECT provider_role FROM provider_profiles WHERE id = $1 AND owner_user_id = $2 AND enabled = true AND provider_role IN ('embedding','text')", [providerProfileId, ownerUserId]);
    const role = provider.rows[0]?.provider_role;
    if (!role || (role === "text" && embeddingProviders.rowCount)) throw Object.assign(new Error("Select an enabled embedding provider. Text fallback is available only when no embedding provider is enabled."), { statusCode: 400 });
  } else if (embeddingProviders.rowCount) {
    providerProfileId = await resolveEffectiveProviderId(pool, ownerUserId, "embedding");
  } else {
    providerProfileId = await resolveEffectiveProviderId(pool, ownerUserId, "text", campaign.rows[0]?.text_provider_profile_id);
  }
  if (input.enabled && !providerProfileId) throw Object.assign(new Error("Add a text or embedding provider before enabling semantic memory."), { statusCode: 400 });
  const result = await withTransaction(pool, async (client) => {
    const saved = await client.query<EmbeddingConfigRow>(
      `INSERT INTO campaign_memory_configs (
         campaign_id, owner_user_id, embedding_enabled, embedding_provider_profile_id, embedding_model, embedding_batch_size,
         embedding_document_prefix, embedding_query_prefix
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (campaign_id) DO UPDATE SET
         embedding_enabled = EXCLUDED.embedding_enabled,
         embedding_provider_profile_id = EXCLUDED.embedding_provider_profile_id,
          embedding_model = EXCLUDED.embedding_model,
          embedding_batch_size = EXCLUDED.embedding_batch_size,
          embedding_document_prefix = EXCLUDED.embedding_document_prefix,
          embedding_query_prefix = EXCLUDED.embedding_query_prefix,
          updated_at = now()
       RETURNING embedding_enabled, embedding_provider_profile_id, embedding_model, embedding_batch_size,
                 embedding_document_prefix, embedding_query_prefix, updated_at`,
      [campaignId, ownerUserId, input.enabled, providerProfileId, embeddingModel, input.batchSize,
        input.documentPrefix ?? null, input.queryPrefix ?? null]
    );
    if (!input.enabled) {
      await client.query(
        `UPDATE chronicle_memories SET embedding = NULL, embedding_provider_profile_id = NULL,
                embedding_model = NULL, embedding_dimensions = NULL, embedding_content_hash = NULL, embedding_updated_at = NULL,
                embedding_provider_fingerprint = NULL
          WHERE campaign_id = $1 AND owner_user_id = $2`,
        [campaignId, ownerUserId]
      );
    }
    return saved.rows[0];
  });
  return publicEmbeddingConfig(result);
}

export type ChronicleMetrics = {
  turns: number;
  completeHistoryCharacters: number;
  estimatedCompleteHistoryTokens: number;
  memoryCount: number;
  memoryTokens: number;
  embeddedMemories: number;
  semanticHealth: {
    status: "disabled" | "indexing" | "healthy" | "degraded" | "failed" | "unavailable";
    message: string;
    enabled: boolean;
    providerProfileId: string | null;
    providerName: string;
    providerHealth: "unknown" | "healthy" | "degraded" | "unavailable";
    model: string;
    indexedMemories: number;
    totalMemories: number;
    coveragePercent: number;
    jobId: string | null;
    jobStatus: "queued" | "running" | "completed" | "failed" | null;
    progress: { embedded?: number; total?: number; updated?: number; skipped?: number };
    errorMessage: string;
    lastCompletedAt: Date | null;
  };
  compressionEstimates: Record<"full" | "balanced" | "compact" | "summary", number>;
};

type ChronicleMetricCounts = Omit<ChronicleMetrics, "semanticHealth">;

function sanitizedFictionString(value: unknown, maximumCharacters = 4000): string {
  if (typeof value !== "string") return "";
  return truncateAtBoundary(stripMechanicsLeakage(value).text, maximumCharacters);
}

function sanitizedFictionValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return undefined;
  if (typeof value === "string") return sanitizedFictionString(value, 2000);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((entry) => sanitizedFictionValue(entry, depth + 1));
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => {
    const normalizedKey = key.replaceAll(/[^a-z]/gi, "").toLocaleLowerCase();
    if (["stat", "stats", "statistic", "statistics"].includes(normalizedKey)
      || ["roll", "dice", "check", "score", "target", "modifier", "difficulty", "reasoning", "diagnostic"]
        .some((prefix) => normalizedKey.startsWith(prefix))) return [];
    const sanitized = sanitizedFictionValue(entry, depth + 1);
    return sanitized === undefined || sanitized === "" ? [] : [[key, sanitized]];
  }));
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
    .map(({ item }) => sanitizedFictionValue(item))
    .filter((item) => item !== undefined);
}

function worldFictionCanon(content: Record<string, unknown>, query: string, maximumTokens: number): Record<string, unknown> {
  const world = typeof content.world === "object" && content.world !== null
    ? content.world as Record<string, unknown>
    : content;
  const allowed = ["title", "genre", "tone", "backgroundStory", "character", "premise", "firstAction", "rules"];
  const perOverviewLimit = Math.max(300, Math.floor(maximumTokens * 2.6 / allowed.length));
  const overview = Object.fromEntries(allowed.flatMap((key) => {
    const value = world[key];
    const sanitized = sanitizedFictionString(value, perOverviewLimit);
    return sanitized ? [[key, sanitized]] : [];
  }));
  const result: Record<string, unknown> = { ...overview };
  for (const [key, items] of [["entities", content.entities], ["relationships", content.relationships]] as const) {
    const selected = selectWorldItems(items, query, 16);
    const accepted: unknown[] = [];
    for (const item of selected) {
      const candidate = { ...result, [key]: [...accepted, item] };
      if (budgetTokenEstimate(stableStringify(candidate)) > maximumTokens) break;
      accepted.push(item);
    }
    if (accepted.length) result[key] = accepted;
  }
  return result;
}

function campaignFictionCanon(campaign: CampaignScopeRow, maximumTokens: number): Record<string, unknown> {
  const result: Record<string, unknown> = {
    campaignTitle: campaign.title,
    acceptedTurns: campaign.active_turn_number
  };
  const scratchpad = campaign.scratchpad_safe_for_prompt
    ? sanitizedFictionString(campaign.scratchpad_private, Math.max(400, Math.floor(maximumTokens * 1.8))) : "";
  if (scratchpad) result.continuityScratchpad = scratchpad;
  const trackerItems = Array.isArray(campaign.trackers) ? campaign.trackers : [];
  const accepted: unknown[] = [];
  for (const tracker of trackerItems.slice(0, 200)) {
    const sanitized = sanitizedFictionValue(tracker);
    if (sanitized === undefined) continue;
    const candidate = { ...result, trackers: [...accepted, sanitized] };
    if (budgetTokenEstimate(stableStringify(candidate)) > maximumTokens) break;
    accepted.push(sanitized);
  }
  if (accepted.length) result.trackers = accepted;
  return result;
}

async function campaignScope(client: DatabaseClient | DatabasePool, ownerUserId: string, campaignId: string): Promise<CampaignScopeRow> {
  const result = await client.query<CampaignScopeRow>(
    `SELECT c.id, c.title, c.active_turn_number, c.world_version_id, wv.content AS world_content,
            cs.scratchpad_private, cs.scratchpad_safe_for_prompt, cs.trackers
       FROM campaigns c
       JOIN world_versions wv ON wv.id = c.world_version_id AND wv.owner_user_id = c.owner_user_id
       JOIN campaign_state cs ON cs.campaign_id = c.id AND cs.owner_user_id = c.owner_user_id
      WHERE c.id = $1 AND c.owner_user_id = $2`,
    [campaignId, ownerUserId]
  );
  const campaign = result.rows[0];
  if (!campaign) throw Object.assign(new Error("Campaign not found."), { statusCode: 404 });
  return campaign;
}

async function allMemories(
  client: DatabaseClient | DatabasePool,
  ownerUserId: string,
  campaignId: string,
  query: string,
  recentTurns = 8
): Promise<MemoryRow[]> {
  const result = await client.query<MemoryRow>(
    `WITH base AS (
       SELECT id, turn_id, memory_kind, ordinal, content, token_estimate, importance, entities, created_at,
              CASE WHEN $3 = '' THEN 0::real
                   ELSE ts_rank_cd(search_document, websearch_to_tsquery('english', $3)) END AS relevance
         FROM chronicle_memories
        WHERE owner_user_id = $1 AND campaign_id = $2
     ), ranked AS (
       SELECT *,
              row_number() OVER (PARTITION BY memory_kind ORDER BY ordinal DESC, created_at DESC) AS recent_rank,
              row_number() OVER (PARTITION BY memory_kind ORDER BY ordinal ASC, created_at ASC) AS sequence_rank,
              count(*) OVER (PARTITION BY memory_kind) AS kind_count,
              row_number() OVER (PARTITION BY memory_kind ORDER BY relevance DESC, ordinal DESC) AS lexical_rank
         FROM base
     )
     SELECT id, turn_id, memory_kind, ordinal, content, token_estimate, importance, entities, relevance
       FROM ranked
      WHERE memory_kind IN ('campaign_summary','legacy_summary','open_thread')
         OR (memory_kind = 'canonical_fact' AND (recent_rank <= 64 OR ($3 <> '' AND lexical_rank <= 64)))
         OR (memory_kind = 'turn_fiction' AND (
              recent_rank <= GREATEST(32, $4::integer * 2)
              OR sequence_rank <= 8
              OR mod(sequence_rank - 1, GREATEST(1, CEIL(kind_count / 32.0)::integer)) = 0
              OR ($3 <> '' AND lexical_rank <= 96)
            ))
      ORDER BY ordinal ASC, memory_kind, id
      LIMIT 512`,
    [ownerUserId, campaignId, query.trim(), recentTurns]
  );
  return result.rows;
}

function selectAutomaticLevel(metrics: ChronicleMetricCounts, availableTokens: number): Exclude<CompressionLevel, "auto"> {
  if (metrics.compressionEstimates.full <= availableTokens) return "full";
  if (metrics.compressionEstimates.balanced <= availableTokens) return "balanced";
  if (metrics.compressionEstimates.compact <= availableTokens) return "compact";
  return "summary";
}

function memoryMetricsFromRows(row: CompleteMetricsRow): ChronicleMetricCounts {
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

async function metricsRow(client: DatabaseClient | DatabasePool, ownerUserId: string, campaignId: string): Promise<CompleteMetricsRow> {
  const result = await client.query<CompleteMetricsRow>(
    `SELECT
       (SELECT count(*) FROM turns WHERE owner_user_id = $1 AND campaign_id = $2)::text AS turns,
       (SELECT COALESCE(sum(length(action) + length(narration)), 0) FROM turns WHERE owner_user_id = $1 AND campaign_id = $2)::text AS characters,
       (SELECT COALESCE(sum(CEIL((length(action) + length(narration))::numeric / 4)), 0) FROM turns WHERE owner_user_id = $1 AND campaign_id = $2)::text AS estimated_tokens,
       count(*)::text AS memory_count,
       COALESCE(sum(token_estimate), 0)::text AS memory_tokens,
       count(embedding)::text AS embedded_memories,
       COALESCE(sum(token_estimate) FILTER (WHERE memory_kind = 'turn_fiction'), 0)::text AS turn_memory_tokens,
       (SELECT COALESCE(sum(token_estimate), 0) FROM (
          SELECT token_estimate FROM chronicle_memories
           WHERE owner_user_id = $1 AND campaign_id = $2 AND memory_kind = 'turn_fiction'
           ORDER BY ordinal DESC LIMIT 4
        ) recent)::text AS recent_turn_tokens,
       COALESCE(
         (SELECT token_estimate FROM chronicle_memories
           WHERE owner_user_id = $1 AND campaign_id = $2 AND memory_kind = 'campaign_summary'
           ORDER BY ordinal DESC, updated_at DESC LIMIT 1),
         (SELECT token_estimate FROM chronicle_memories
           WHERE owner_user_id = $1 AND campaign_id = $2 AND memory_kind = 'legacy_summary'
           ORDER BY created_at DESC LIMIT 1),
         0
       )::text AS summary_tokens
     FROM chronicle_memories
     WHERE owner_user_id = $1 AND campaign_id = $2`,
    [ownerUserId, campaignId]
  );
  const row = result.rows[0];
  if (!row) throw new Error("Could not calculate Chronicle metrics.");
  return row;
}

async function semanticMemoryHealth(
  pool: DatabasePool,
  ownerUserId: string,
  campaignId: string,
  metrics: ChronicleMetricCounts
): Promise<ChronicleMetrics["semanticHealth"]> {
  const config = await embeddingConfig(pool, ownerUserId, campaignId);
  const disabled = {
    status: "disabled" as const,
    message: "Semantic memory is disabled. Chronicle is using lexical, entity, chronology, and recency retrieval.",
    enabled: false,
    providerProfileId: null,
    providerName: "",
    providerHealth: "unknown" as const,
    model: config?.embedding_model || "",
    indexedMemories: 0,
    totalMemories: metrics.memoryCount,
    coveragePercent: 0,
    jobId: null,
    jobStatus: null,
    progress: {},
    errorMessage: "",
    lastCompletedAt: null
  };
  if (!config?.embedding_enabled) return disabled;

  const [providerResult, indexedResult, jobResult] = await Promise.all([
    config.embedding_provider_profile_id
      ? pool.query<{
          id: string;
          name: string;
          enabled: boolean;
          health_status: "unknown" | "healthy" | "degraded" | "unavailable";
        }>(
          `SELECT id, name, enabled, health_status FROM provider_profiles
            WHERE id = $1 AND owner_user_id = $2 AND provider_role IN ('embedding','text')`,
          [config.embedding_provider_profile_id, ownerUserId]
        )
      : Promise.resolve({ rows: [] }),
    config.embedding_provider_profile_id
      ? pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM chronicle_memories
            WHERE owner_user_id = $1 AND campaign_id = $2 AND embedding IS NOT NULL
              AND embedding_provider_profile_id = $3 AND embedding_model = $4
              AND embedding_content_hash IS NOT NULL AND embedding_provider_fingerprint IS NOT NULL`,
          [ownerUserId, campaignId, config.embedding_provider_profile_id, config.embedding_model]
        )
      : Promise.resolve({ rows: [{ count: "0" }] }),
    pool.query<{
      id: string;
      status: "queued" | "running" | "completed" | "failed";
      progress: ChronicleMetrics["semanticHealth"]["progress"];
      error_message: string | null;
      completed_at: Date | null;
    }>(
      `SELECT id, status, progress, error_message, completed_at
         FROM chronicle_jobs
        WHERE owner_user_id = $1 AND campaign_id = $2 AND job_type = 'embed_campaign'
        ORDER BY created_at DESC, updated_at DESC, id DESC LIMIT 1`,
      [ownerUserId, campaignId]
    )
  ]);
  const provider = providerResult.rows[0];
  const indexedMemories = Number(indexedResult.rows[0]?.count || 0);
  const coveragePercent = metrics.memoryCount ? Math.min(100, Math.round(indexedMemories / metrics.memoryCount * 100)) : 100;
  const job = jobResult.rows[0];
  const base = {
    enabled: true,
    providerProfileId: config.embedding_provider_profile_id,
    providerName: provider?.name || "",
    providerHealth: provider?.health_status || ("unavailable" as const),
    model: config.embedding_model,
    indexedMemories,
    totalMemories: metrics.memoryCount,
    coveragePercent,
    jobId: job?.id || null,
    jobStatus: job?.status || null,
    progress: job?.progress || {},
    errorMessage: job?.error_message || "",
    lastCompletedAt: job?.completed_at || null
  };
  if (job?.status === "queued" || job?.status === "running") {
    const completed = Number(job.progress?.embedded || 0);
    const total = Number(job.progress?.total || metrics.memoryCount);
    return { ...base, status: "indexing", message: job.status === "queued"
      ? "Semantic indexing is queued and waiting for a Chronicle worker."
      : `Semantic indexing is running${total ? `: ${completed} of ${total} memories processed` : ""}.` };
  }
  if (job?.status === "failed") {
    return { ...base, status: "failed", message: job.error_message || "Semantic indexing failed. Save and index again to retry." };
  }
  if (!provider || !provider.enabled || provider.health_status === "unavailable") {
    return { ...base, status: "unavailable", message: "The configured embedding provider is disabled or unavailable. Lexical Chronicle retrieval remains active." };
  }
  const configIsFresh = Boolean(job?.completed_at && job.completed_at.getTime() >= config.updated_at.getTime());
  if (!configIsFresh || coveragePercent < 100 || provider.health_status === "degraded") {
    const reason = !configIsFresh
      ? "The current semantic configuration has not completed indexing."
      : provider.health_status === "degraded"
        ? "The embedding provider is reporting degraded health."
        : `${indexedMemories} of ${metrics.memoryCount} Chronicle memories are indexed.`;
    return { ...base, status: "degraded", message: `${reason} Lexical retrieval remains available while semantic coverage recovers.` };
  }
  return { ...base, status: "healthy", message: metrics.memoryCount
    ? `All ${metrics.memoryCount} Chronicle memories are indexed with ${config.embedding_model}.`
    : `Semantic memory is ready with ${config.embedding_model}; memories will be indexed as turns are accepted.` };
}

export async function getChronicleMetrics(pool: DatabasePool, campaignId: string): Promise<ChronicleMetrics> {
  const ownerUserId = await initialOwnerId(pool);
  await campaignScope(pool, ownerUserId, campaignId);
  const metrics = memoryMetricsFromRows(await metricsRow(pool, ownerUserId, campaignId));
  return { ...metrics, semanticHealth: await semanticMemoryHealth(pool, ownerUserId, campaignId, metrics) };
}

function topRelevant(memories: MemoryRow[], excluded: Set<string>, limit: number): MemoryRow[] {
  return memories
    .filter((memory) => ["turn_fiction", "canonical_fact", "open_thread"].includes(memory.memory_kind)
      && !excluded.has(memory.id) && memory.relevance > 0)
    .sort((left, right) => (right.relevance - left.relevance) || (right.importance - left.importance) || (right.ordinal - left.ordinal))
    .slice(0, limit);
}

async function applySemanticRelevance(
  pool: DatabasePool,
  ownerUserId: string,
  campaignId: string,
  query: string,
  memories: MemoryRow[],
  credentialSecret: string,
  costAttribution: { generationJobId?: string; operation?: "retrieval_embedding" | "context_preview_embedding" }
) {
  const normalizedQuery = query.toLocaleLowerCase();
  const newestOrdinal = memories.reduce((maximum, memory) => Math.max(maximum, memory.ordinal), 0);
  for (const memory of memories) {
    memory.lexicalRelevance = Number(memory.relevance);
    const lexical = Math.min(1, Math.max(0, Number(memory.lexicalRelevance || 0) * 8));
    const entityScore = memory.entities.some((entity) => normalizedQuery.includes(entity.toLocaleLowerCase())) ? 1 : 0;
    const recencyScore = newestOrdinal > 0 ? Math.max(0, 1 - (newestOrdinal - memory.ordinal) / Math.max(20, newestOrdinal)) : 0;
    memory.relevance = lexical > 0 || entityScore > 0
      ? lexical * 0.65 + entityScore * 0.15 + recencyScore * 0.1 + memory.importance * 0.1
      : 0;
  }
  const config = await embeddingConfig(pool, ownerUserId, campaignId);
  if (!query.trim()) {
    return { mode: "lexical", semanticAvailable: false, fallbackReason: "the retrieval query is empty" };
  }
  if (!config?.embedding_enabled || !config.embedding_provider_profile_id || !config.embedding_model) {
    return { mode: "lexical", semanticAvailable: false, fallbackReason: "semantic memory is not configured" };
  }
  try {
    const provider = await loadEmbeddingProvider(
      pool,
      ownerUserId,
      config.embedding_provider_profile_id,
      credentialSecret,
      config.embedding_model
    );
    const prefixes = modelAwarePrefixes(config.embedding_model, config.embedding_document_prefix, config.embedding_query_prefix);
    const fingerprint = providerFingerprint(provider, prefixes);
    const result = await callEmbeddingProvider(provider, [`${prefixes.queryPrefix}${query.trim()}`]);
    await recordProfileCost(pool, provider, {
      ownerUserId,
      campaignId,
      generationJobId: costAttribution.generationJobId || null,
      category: "memory",
      operation: costAttribution.operation || "context_preview_embedding"
    }, result);
    const queryVector = result.embeddings[0];
    if (!queryVector) throw new Error("Embedding provider returned no query vector.");
    const scored = await pool.query<MemoryRow & { embedding_content_hash: string; semantic_relevance: number }>(
      `SELECT id, turn_id, memory_kind, ordinal, content, token_estimate, importance, entities,
              0::real AS relevance, embedding_content_hash,
              (1 - (embedding <=> $5::vector))::real AS semantic_relevance
         FROM chronicle_memories
        WHERE owner_user_id = $1 AND campaign_id = $2
           AND embedding_provider_profile_id = $3 AND embedding_model = $4
           AND embedding_dimensions = $6 AND embedding_provider_fingerprint = $7
           AND embedding IS NOT NULL
         ORDER BY embedding <=> $5::vector
         LIMIT 96`,
      [ownerUserId, campaignId, config.embedding_provider_profile_id, config.embedding_model, vectorLiteral(queryVector), queryVector.length, fingerprint]
    );
    const freshScores = scored.rows.filter((row) => row.embedding_content_hash === contentHash(row.content));
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
      const entityScore = memory.entities.some((entity) => normalizedQuery.includes(entity.toLocaleLowerCase())) ? 1 : 0;
      const recencyScore = newestOrdinal > 0 ? Math.max(0, 1 - (newestOrdinal - memory.ordinal) / Math.max(20, newestOrdinal)) : 0;
      memory.semanticRelevance = semanticScore;
      const semanticMatched = semanticScore >= 0.2;
      memory.relevance = semanticMatched || lexical > 0 || entityScore > 0
        ? semanticScore * 0.55 + lexical * 0.25 + entityScore * 0.1 + recencyScore * 0.05 + memory.importance * 0.05
        : 0;
    }
    return { mode: "hybrid", semanticAvailable: true, embeddedCandidates: freshScores.length, model: config.embedding_model,
      queryExpanded: true, effectiveQueryPrefix: prefixes.queryPrefix };
  } catch (error) {
    return {
      mode: "lexical_fallback",
      semanticAvailable: false,
      fallbackReason: (error instanceof Error ? error.message : String(error)).slice(0, 500)
    };
  }
}

export async function buildContextPreview(
  pool: DatabasePool,
  campaignId: string,
  options: MemoryContextQuery,
  credentialSecret = "",
  costAttribution: { generationJobId?: string; operation?: "retrieval_embedding" | "context_preview_embedding" } = {}
) {
  const ownerUserId = await initialOwnerId(pool);
  const campaign = await campaignScope(pool, ownerUserId, campaignId);
  const memories = await allMemories(pool, ownerUserId, campaignId, options.query, options.recentTurns);
  const latestHint = memories.filter((memory) => memory.memory_kind === "turn_fiction").at(-1)?.content ?? "";
  const expandedQuery = [options.query, truncateAtBoundary(latestHint, 1200)].filter(Boolean).join("\n");
  const retrieval = await applySemanticRelevance(pool, ownerUserId, campaignId, expandedQuery, memories, credentialSecret, costAttribution);
  const metrics = memoryMetricsFromRows(await metricsRow(pool, ownerUserId, campaignId));
  const worldCanon = worldFictionCanon(campaign.world_content, expandedQuery, Math.max(384, Math.floor(options.budgetTokens * 0.34)));
  const campaignCanon = campaignFictionCanon(campaign, Math.max(256, Math.floor(options.budgetTokens * 0.18)));
  const turnMemories = memories.filter((memory) => memory.memory_kind === "turn_fiction");
  const latest = turnMemories.at(-1) ?? null;
  const currentSceneContent = latest
    ? truncateAtBoundary(latest.content, Math.max(800, Math.floor(options.budgetTokens * 0.18 * 3.2)))
    : "";
  const currentScene = latest ? { memoryId: latest.id, ordinal: latest.ordinal, content: currentSceneContent } : null;
  const fixedScopes = { worldCanon, campaignCanon, chronicle: [], currentScene };
  const fixedScopeTokens = budgetTokenEstimate(stableStringify(fixedScopes));
  const availableTokens = Math.max(0, options.budgetTokens - fixedScopeTokens);
  const selectedLevel = options.compression === "auto"
    ? selectAutomaticLevel(metrics, availableTokens)
    : options.compression;
  const recentCandidates = turnMemories.slice(-Math.max(1, options.recentTurns));
  const selected = new Map<string, { memory: MemoryRow; rendered: string; reason: string }>();
  let consumedTokens = 0;

  const addMemory = (memory: MemoryRow, rendered: string, reason: string): boolean => {
    if (selected.has(memory.id) || memory.id === latest?.id) return false;
    const tokens = budgetTokenEstimate(stableStringify({
      id: memory.id,
      turnId: memory.turn_id,
      ordinal: memory.ordinal,
      kind: memory.memory_kind,
      reason,
      relevance: memory.relevance,
      lexicalRelevance: memory.lexicalRelevance ?? memory.relevance,
      semanticRelevance: memory.semanticRelevance ?? null,
      entities: memory.entities,
      content: rendered,
      estimatedTokens: estimateTokens(rendered)
    }));
    if (consumedTokens + tokens > availableTokens) return false;
    selected.set(memory.id, { memory, rendered, reason });
    consumedTokens += tokens;
    return true;
  };

  const renderLevel = selectedLevel === "summary" ? "compact" : selectedLevel;
  const campaignSummary = memories.filter((memory) => memory.memory_kind === "campaign_summary")
    .sort((left, right) => right.ordinal - left.ordinal)[0];
  const legacySummary = memories.find((memory) => memory.memory_kind === "legacy_summary");
  const summary = campaignSummary ?? (selectedLevel === "summary" ? legacySummary : undefined);
  if (summary) addMemory(summary, summary.content, "summary_checkpoint");
  const openThreads = memories.filter((memory) => memory.memory_kind === "open_thread")
    .sort((left, right) => right.ordinal - left.ordinal)[0];
  if (openThreads) addMemory(openThreads, openThreads.content, "open_threads");

  for (const memory of recentCandidates) {
    const isVeryRecent = memory.ordinal > campaign.active_turn_number - 3;
    const rendered = isVeryRecent ? memory.content : compressTurnMemory(memory.content, renderLevel);
    addMemory(memory, rendered, "recent");
  }

  const selectedIds = new Set(selected.keys());
  for (const memory of topRelevant(memories, selectedIds, 16)) {
    addMemory(memory, compressTurnMemory(memory.content, renderLevel), "relevant");
  }

  if (selectedLevel !== "summary") {
    for (const memory of turnMemories) {
      addMemory(memory, compressTurnMemory(memory.content, renderLevel), "chronological");
    }
  }

  const chronicleEntries = [...selected.values()]
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
  const scopes = { worldCanon, campaignCanon, chronicle: chronicleEntries, currentScene };
  const actualTokens = budgetTokenEstimate(stableStringify(scopes));
  const expectedForLevel = metrics.compressionEstimates[selectedLevel];

  return {
    campaign: { id: campaign.id, title: campaign.title, activeTurnNumber: campaign.active_turn_number },
    selectedCompression: selectedLevel,
    requestedCompression: options.compression,
    budget: {
      configuredTokens: options.budgetTokens,
      reservedCanonTokens: fixedScopeTokens,
      fixedScopeTokens,
      availableChronicleTokens: availableTokens,
      estimatedSelectedTokens: actualTokens,
      completeHistoryTokens: metrics.estimatedCompleteHistoryTokens,
      expectedTokensForCompression: expectedForLevel,
      truncated: actualTokens > options.budgetTokens || expectedForLevel > availableTokens
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

export async function enqueueChronicleReindex(pool: DatabasePool, campaignId: string): Promise<string> {
  const ownerUserId = await initialOwnerId(pool);
  await campaignScope(pool, ownerUserId, campaignId);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO chronicle_jobs (owner_user_id, campaign_id, job_type)
     VALUES ($1,$2,'reindex_campaign')
     ON CONFLICT (campaign_id, job_type) WHERE status IN ('queued', 'running')
     DO UPDATE SET work_version = chronicle_jobs.work_version + 1, updated_at = now()
     RETURNING id`,
    [ownerUserId, campaignId]
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("Could not enqueue the Chronicle reindex job.");
  return id;
}

export async function enqueueEmbeddingReindex(client: DatabaseClient | DatabasePool, campaignId: string): Promise<string | null> {
  const ownerUserId = await initialOwnerId(client);
  await campaignScope(client, ownerUserId, campaignId);
  const config = await embeddingConfig(client, ownerUserId, campaignId);
  if (!config?.embedding_enabled || !config.embedding_provider_profile_id || !config.embedding_model) return null;
  const result = await client.query<{ id: string }>(
    `INSERT INTO chronicle_jobs (owner_user_id, campaign_id, job_type)
     VALUES ($1,$2,'embed_campaign')
     ON CONFLICT (campaign_id, job_type) WHERE status IN ('queued', 'running')
     DO UPDATE SET work_version = chronicle_jobs.work_version + 1, updated_at = now()
     RETURNING id`,
    [ownerUserId, campaignId]
  );
  return result.rows[0]?.id ?? null;
}

export type DerivedStoryMemory = {
  continuitySummary?: string;
  canonicalFacts?: string[];
  supersededFacts?: string[];
  openThreads?: string[];
};

function sanitizedMemoryLines(values: string[] | undefined, limit = 100): string[] {
  return [...new Set((values ?? []).flatMap((value) => {
    const sanitized = sanitizedFictionString(value, 4000);
    return sanitized ? [sanitized] : [];
  }))].slice(0, limit);
}

export async function storeDerivedTurnMemories(
  client: DatabaseClient,
  ownerUserId: string,
  campaignId: string,
  worldVersionId: string,
  turnId: string,
  ordinal: number,
  derived: DerivedStoryMemory
): Promise<void> {
  const summary = sanitizedFictionString(derived.continuitySummary, 20_000);
  const facts = sanitizedMemoryLines(derived.canonicalFacts);
  const supersededFacts = sanitizedMemoryLines(derived.supersededFacts);
  const threads = sanitizedMemoryLines(derived.openThreads);
  if (supersededFacts.length) {
    const priorFacts = await client.query<{ id: string; content: string; metadata: Record<string, unknown> }>(
      `SELECT id, content, metadata FROM chronicle_memories
        WHERE owner_user_id = $1 AND campaign_id = $2 AND memory_kind = 'canonical_fact' AND ordinal < $3`,
      [ownerUserId, campaignId, ordinal]
    );
    const normalizedSuperseded = new Set(supersededFacts.map((fact) => fact.toLocaleLowerCase().replace(/^[-•]\s*/, "").trim()));
    for (const prior of priorFacts.rows) {
      const header = prior.content.split("\n")[0] ?? "Canonical facts";
      const remaining = prior.content.split("\n").slice(1).filter((line) => {
        const normalized = line.toLocaleLowerCase().replace(/^[-•]\s*/, "").trim();
        return !normalizedSuperseded.has(normalized);
      });
      if (!remaining.length) {
        await client.query("DELETE FROM chronicle_memories WHERE id = $1 AND owner_user_id = $2", [prior.id, ownerUserId]);
      } else if (remaining.length !== prior.content.split("\n").slice(1).length) {
        const content = [header, ...remaining].join("\n");
        await client.query(
          `UPDATE chronicle_memories SET content = $3, token_estimate = $4, entities = $5,
                  metadata = metadata || $6::jsonb, embedding = NULL, embedding_provider_profile_id = NULL,
                  embedding_model = NULL, embedding_dimensions = NULL, embedding_content_hash = NULL,
                  embedding_updated_at = NULL, embedding_provider_fingerprint = NULL, updated_at = now()
            WHERE id = $1 AND owner_user_id = $2`,
          [prior.id, ownerUserId, content, estimateTokens(content), extractEntities(content),
            json({ supersededAtTurn: ordinal, supersededFacts })]
        );
      }
    }
  }
  if (summary) {
    await client.query(
      `INSERT INTO chronicle_memories (
         owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content,
         token_estimate, importance, entities, metadata
       ) VALUES ($1,$2,$3,'campaign_summary',$4,$5,$6,0.9,$7,$8)
       ON CONFLICT (campaign_id, turn_id, memory_kind) DO UPDATE SET
         world_version_id = EXCLUDED.world_version_id, ordinal = EXCLUDED.ordinal, content = EXCLUDED.content, token_estimate = EXCLUDED.token_estimate,
         importance = EXCLUDED.importance, entities = EXCLUDED.entities, metadata = EXCLUDED.metadata,
         embedding = NULL, embedding_provider_profile_id = NULL, embedding_model = NULL,
         embedding_dimensions = NULL, embedding_content_hash = NULL, embedding_updated_at = NULL,
         embedding_provider_fingerprint = NULL, updated_at = now()`,
      [ownerUserId, campaignId, worldVersionId, ordinal, summary, estimateTokens(summary), extractEntities(summary),
        json({ throughTurn: ordinal, generatedFromAcceptedTurn: true })]
    );
    if (ordinal % 8 === 0) {
      await client.query(
        `INSERT INTO summary_checkpoints (owner_user_id, campaign_id, through_turn, summary_kind, content, token_estimate)
         VALUES ($1,$2,$3,'campaign_continuity',$4,$5)`,
        [ownerUserId, campaignId, ordinal, json({ summary }), estimateTokens(summary)]
      );
    }
  }
  if (facts.length) {
    const content = [`Canonical facts established or corrected at turn ${ordinal}`, ...facts.map((fact) => `- ${fact}`)].join("\n");
    await client.query(
      `INSERT INTO chronicle_memories (
         owner_user_id, campaign_id, world_version_id, turn_id, memory_kind, ordinal, content,
         token_estimate, importance, entities, metadata
       ) VALUES ($1,$2,$3,$4,'canonical_fact',$5,$6,$7,0.85,$8,$9)
       ON CONFLICT (campaign_id, turn_id, memory_kind) DO UPDATE SET
         content = EXCLUDED.content, token_estimate = EXCLUDED.token_estimate, entities = EXCLUDED.entities,
         metadata = EXCLUDED.metadata, embedding = NULL, embedding_provider_profile_id = NULL,
         embedding_model = NULL, embedding_dimensions = NULL, embedding_content_hash = NULL,
         embedding_updated_at = NULL, embedding_provider_fingerprint = NULL, updated_at = now()`,
      [ownerUserId, campaignId, worldVersionId, turnId, ordinal, content, estimateTokens(content), extractEntities(content),
        json({ sourceTurn: ordinal, generatedFromAcceptedTurn: true })]
    );
  }
  if (threads.length) {
    const content = [`Open story threads after turn ${ordinal}`, ...threads.map((thread) => `- ${thread}`)].join("\n");
    await client.query(
      `INSERT INTO chronicle_memories (
         owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content,
         token_estimate, importance, entities, metadata
       ) VALUES ($1,$2,$3,'open_thread',$4,$5,$6,0.95,$7,$8)
       ON CONFLICT (campaign_id, turn_id, memory_kind) DO UPDATE SET
         world_version_id = EXCLUDED.world_version_id, ordinal = EXCLUDED.ordinal, content = EXCLUDED.content, token_estimate = EXCLUDED.token_estimate,
         importance = EXCLUDED.importance, entities = EXCLUDED.entities, metadata = EXCLUDED.metadata,
         embedding = NULL, embedding_provider_profile_id = NULL, embedding_model = NULL,
         embedding_dimensions = NULL, embedding_content_hash = NULL, embedding_updated_at = NULL,
         embedding_provider_fingerprint = NULL, updated_at = now()`,
      [ownerUserId, campaignId, worldVersionId, ordinal, content, estimateTokens(content), extractEntities(content),
        json({ throughTurn: ordinal, replacesPriorOpenThreads: true, generatedFromAcceptedTurn: true })]
    );
  } else if (derived.openThreads) {
    await client.query(
      `DELETE FROM chronicle_memories
        WHERE owner_user_id = $1 AND campaign_id = $2 AND memory_kind = 'open_thread' AND turn_id IS NULL`,
      [ownerUserId, campaignId]
    );
  }
}

async function embedCampaignMemories(
  pool: DatabasePool,
  ownerUserId: string,
  campaignId: string,
  credentialSecret: string,
  jobId: string,
  workerId: string,
  leaseSeconds: number
): Promise<{ embedded: number; skipped: number; dimensions: number; providerProfileId: string; model: string }> {
  const config = await embeddingConfig(pool, ownerUserId, campaignId);
  if (!config?.embedding_enabled || !config.embedding_provider_profile_id || !config.embedding_model) {
    throw new Error("Semantic Chronicle indexing is not enabled for this campaign.");
  }
  const provider = await loadEmbeddingProvider(
    pool,
    ownerUserId,
    config.embedding_provider_profile_id,
    credentialSecret,
    config.embedding_model
  );
  const prefixes = modelAwarePrefixes(config.embedding_model, config.embedding_document_prefix, config.embedding_query_prefix);
  const fingerprint = providerFingerprint(provider, prefixes);
  const result = await pool.query<{
    id: string;
    turn_id: string | null;
    content: string;
    embedding_provider_profile_id: string | null;
    embedding_model: string | null;
    embedding_content_hash: string | null;
    embedding_provider_fingerprint: string | null;
  }>(
    `SELECT id, turn_id, content, embedding_provider_profile_id, embedding_model, embedding_content_hash,
            embedding_provider_fingerprint
       FROM chronicle_memories
      WHERE owner_user_id = $1 AND campaign_id = $2
      ORDER BY ordinal, created_at`,
    [ownerUserId, campaignId]
  );
  const pending = result.rows.filter((memory) => (
    memory.embedding_provider_profile_id !== provider.id
    || memory.embedding_model !== provider.model
    || memory.embedding_content_hash !== contentHash(memory.content)
    || memory.embedding_provider_fingerprint !== fingerprint
  ));
  let embedded = 0;
  let dimensions = 0;
  for (let offset = 0; offset < pending.length; offset += config.embedding_batch_size) {
    const batch = pending.slice(offset, offset + config.embedding_batch_size);
    const response = await callEmbeddingProvider(provider, batch.map((memory) => `${prefixes.documentPrefix}${memory.content}`));
    const batchDimensions = response.embeddings[0]?.length ?? 0;
    if (!batchDimensions) throw new Error("Embedding provider returned an empty vector batch.");
    if (dimensions && batchDimensions !== dimensions) throw new Error("Embedding provider changed vector dimensions during the campaign rebuild.");
    dimensions = batchDimensions;
    await withTransaction(pool, async (client) => {
      for (let index = 0; index < batch.length; index += 1) {
        const memory = batch[index];
        const vector = response.embeddings[index];
        if (!memory || !vector) throw new Error("Embedding batch response was incomplete.");
        await client.query(
          `UPDATE chronicle_memories SET embedding = $4::vector, embedding_provider_profile_id = $5,
                  embedding_model = $6, embedding_dimensions = $7, embedding_content_hash = $8, embedding_updated_at = now(),
                  embedding_provider_fingerprint = $9
            WHERE id = $1 AND owner_user_id = $2 AND campaign_id = $3 AND content = $10`,
          [memory.id, ownerUserId, campaignId, vectorLiteral(vector), provider.id, provider.model, vector.length,
            contentHash(memory.content), fingerprint, memory.content]
        );
      }
      const batchTurnIds = [...new Set(batch.map((memory) => memory.turn_id).filter((turnId): turnId is string => Boolean(turnId)))];
      const singleTurnId = batchTurnIds[0] || null;
      const turnId = singleTurnId && batchTurnIds.length === 1 && batch.every((memory) => memory.turn_id === singleTurnId)
        ? singleTurnId
        : null;
      await recordProfileCost(client, provider, {
        ownerUserId,
        campaignId,
        turnId,
        chronicleJobId: jobId,
        category: "memory",
        operation: "memory_embedding"
      }, response);
      const heartbeat = await client.query(
        `UPDATE chronicle_jobs SET progress = $3::jsonb,
                lease_expires_at = now() + ($4::text || ' seconds')::interval, updated_at = now()
          WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
        [jobId, workerId, json({ embedded: offset + batch.length, total: pending.length }), leaseSeconds]
      );
      if (!heartbeat.rowCount) throw new Error("Chronicle embedding lease was lost before the batch could be committed.");
    });
    embedded += batch.length;
  }
  return { embedded, skipped: result.rows.length - pending.length, dimensions, providerProfileId: provider.id, model: provider.model };
}

export async function rebuildCampaignMemories(client: DatabaseClient, ownerUserId: string, campaignId: string): Promise<number> {
  const scope = await campaignScope(client, ownerUserId, campaignId);
  const turns = await client.query<{
    id: string;
    turn_number: number;
    action: string;
    narration: string;
    state_snapshot_private: Record<string, unknown>;
  }>(
    `SELECT id, turn_number, action, narration, state_snapshot_private
       FROM turns WHERE owner_user_id = $1 AND campaign_id = $2 ORDER BY turn_number`,
    [ownerUserId, campaignId]
  );
  await client.query(
    `DELETE FROM chronicle_memories
      WHERE owner_user_id = $1 AND campaign_id = $2 AND memory_kind = 'turn_fiction'`,
    [ownerUserId, campaignId]
  );
  await client.query(
    `DELETE FROM summary_checkpoints
      WHERE owner_user_id = $1 AND campaign_id = $2 AND summary_kind = 'campaign_continuity'`,
    [ownerUserId, campaignId]
  );
  await client.query(
    `DELETE FROM chronicle_memories
      WHERE owner_user_id = $1 AND campaign_id = $2
        AND memory_kind IN ('campaign_summary','canonical_fact','open_thread')
        AND metadata->>'generatedFromAcceptedTurn' = 'true'`,
    [ownerUserId, campaignId]
  );
  for (const turn of turns.rows) {
    const memory = buildTurnFictionMemory({ action: turn.action, narration: turn.narration }, turn.turn_number);
    await client.query(
      `INSERT INTO chronicle_memories (
         owner_user_id, campaign_id, world_version_id, turn_id, memory_kind, ordinal,
         content, token_estimate, importance, entities, metadata
       ) VALUES ($1,$2,$3,$4,'turn_fiction',$5,$6,$7,$8,$9,$10)`,
      [
        ownerUserId,
        campaignId,
        scope.world_version_id,
        turn.id,
        turn.turn_number,
        memory.content,
        memory.tokenEstimate,
        Math.min(1, 0.45 + turn.turn_number / Math.max(20, turns.rows.length * 2)),
        memory.entities,
        json({ sanitized: memory.sanitized, removedMechanicsSegments: memory.removedMechanicsSegments, reindexed: true })
      ]
    );
    const openThreads = Array.isArray(turn.state_snapshot_private?.openThreads)
      ? turn.state_snapshot_private.openThreads.filter((value): value is string => typeof value === "string") : undefined;
    await storeDerivedTurnMemories(client, ownerUserId, campaignId, scope.world_version_id, turn.id, turn.turn_number, {
      continuitySummary: typeof turn.state_snapshot_private?.continuitySummary === "string"
        ? turn.state_snapshot_private.continuitySummary : "",
      canonicalFacts: Array.isArray(turn.state_snapshot_private?.canonicalFacts)
        ? turn.state_snapshot_private.canonicalFacts.filter((value): value is string => typeof value === "string") : [],
      supersededFacts: Array.isArray(turn.state_snapshot_private?.supersededFacts)
        ? turn.state_snapshot_private.supersededFacts.filter((value): value is string => typeof value === "string") : [],
      ...(openThreads ? { openThreads } : {})
    });
  }
  return turns.rows.length;
}

export async function runChronicleJob(pool: DatabasePool, workerId: string, leaseSeconds: number, credentialSecret = ""): Promise<boolean> {
  const claimed = await withTransaction(pool, async (client) => {
    const result = await client.query<{ id: string; owner_user_id: string; campaign_id: string; job_type: "reindex_campaign" | "embed_campaign"; work_version: number }>(
      `WITH candidate AS (
         SELECT j.id FROM chronicle_jobs j
          WHERE (j.status = 'queued' OR (j.status = 'running' AND j.lease_expires_at < now()))
            AND NOT EXISTS (
              SELECT 1 FROM chronicle_jobs active
               WHERE active.campaign_id = j.campaign_id AND active.status = 'running'
                 AND active.lease_expires_at >= now() AND active.id <> j.id
            )
          ORDER BY CASE WHEN j.status = 'running' THEN 0 ELSE 1 END, j.created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE chronicle_jobs j
          SET status = 'running', attempts = attempts + 1, lease_owner = $1,
              lease_expires_at = now() + ($2::text || ' seconds')::interval,
              progress = '{}'::jsonb, updated_at = now()
         FROM candidate
        WHERE j.id = candidate.id
       RETURNING j.id, j.owner_user_id, j.campaign_id, j.job_type, j.work_version`,
      [workerId, leaseSeconds]
    );
    return result.rows[0] ?? null;
  });
  if (!claimed) return false;

  const heartbeat = setInterval(() => {
    void pool.query(
      `UPDATE chronicle_jobs SET lease_expires_at = now() + ($3::text || ' seconds')::interval, updated_at = now()
        WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
      [claimed.id, workerId, leaseSeconds]
    ).catch(() => undefined);
  }, Math.max(5000, Math.floor(leaseSeconds * 1000 / 3)));
  try {
    const details = claimed.job_type === "reindex_campaign"
      ? { memoryCount: await withTransaction(pool, (client) => rebuildCampaignMemories(client, claimed.owner_user_id, claimed.campaign_id)) }
      : await embedCampaignMemories(pool, claimed.owner_user_id, claimed.campaign_id, credentialSecret, claimed.id, workerId, leaseSeconds);
    const finalProgress = "embedded" in details
      ? { embedded: details.embedded + details.skipped, total: details.embedded + details.skipped,
          updated: details.embedded, skipped: details.skipped }
      : { rebuilt: details.memoryCount };
    const completed = await pool.query<{ id: string; status: string }>(
      `UPDATE chronicle_jobs SET
              status = CASE WHEN work_version > $3 THEN 'queued' ELSE 'completed' END,
              completed_at = CASE WHEN work_version > $3 THEN NULL ELSE now() END,
              progress = $4::jsonb, updated_at = now(), lease_owner = NULL, lease_expires_at = NULL, error_message = NULL
        WHERE id = $1 AND lease_owner = $2`,
      [claimed.id, workerId, claimed.work_version, json(finalProgress)]
    );
    if (!completed.rowCount) throw new Error("Chronicle job lease was lost before completion could be recorded.");
    await pool.query(
      `INSERT INTO activity_events (owner_user_id, campaign_id, event_type, correlation_id, details)
       VALUES ($1,$2,$3,$4,$5)`,
      [claimed.owner_user_id, claimed.campaign_id,
        claimed.job_type === "reindex_campaign" ? "chronicle_reindexed" : "chronicle_embedded",
        claimed.id, json(details)]
    );
    if (claimed.job_type === "reindex_campaign" && completed.rows[0]?.status === "completed") await enqueueEmbeddingReindex(pool, claimed.campaign_id);
    if (claimed.job_type === "embed_campaign" && "providerProfileId" in details) {
      await recordProviderHealth(pool, claimed.owner_user_id, details.providerProfileId, true);
      const current = await embeddingConfig(pool, claimed.owner_user_id, claimed.campaign_id);
      if (!current?.embedding_enabled) {
        await pool.query(
          `UPDATE chronicle_memories SET embedding = NULL, embedding_provider_profile_id = NULL,
                  embedding_model = NULL, embedding_dimensions = NULL, embedding_content_hash = NULL, embedding_updated_at = NULL,
                  embedding_provider_fingerprint = NULL
            WHERE owner_user_id = $1 AND campaign_id = $2`,
          [claimed.owner_user_id, claimed.campaign_id]
        );
      } else if (current.embedding_provider_profile_id !== details.providerProfileId || current.embedding_model !== details.model) {
        await enqueueEmbeddingReindex(pool, claimed.campaign_id);
      }
    }
  } catch (error) {
    if (claimed.job_type === "embed_campaign") {
      const current = await embeddingConfig(pool, claimed.owner_user_id, claimed.campaign_id).catch(() => undefined);
      if (current?.embedding_provider_profile_id) {
        await recordProviderHealth(
          pool,
          claimed.owner_user_id,
          current.embedding_provider_profile_id,
          false,
          error instanceof Error ? error.message : String(error)
        ).catch(() => undefined);
      }
    }
    await pool.query(
      `UPDATE chronicle_jobs SET status = 'failed', error_message = $2, updated_at = now(),
              lease_owner = NULL, lease_expires_at = NULL
        WHERE id = $1 AND lease_owner = $3`,
      [claimed.id, error instanceof Error ? error.message.slice(0, 4000) : String(error).slice(0, 4000), workerId]
    );
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}
