import { createHash } from "node:crypto";
import type { DatabaseClient, DatabasePool } from "../../../packages/database/src/pool.js";
import { initialOwnerId, withTransaction } from "../../../packages/database/src/pool.js";
import type { CampaignEmbeddingConfig, CompressionLevel, MemoryContextQuery } from "../../../packages/contracts/src/memory.js";
import { compressTurnMemory, buildTurnFictionMemory } from "../../../packages/story-engine/src/chronicle.js";
import { callEmbeddingProvider } from "../../../packages/story-engine/src/providers.js";
import { estimateTokens } from "../../../packages/domain/src/text.js";
import { loadEmbeddingProvider } from "./provider-service.js";

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

type CampaignScopeRow = {
  id: string;
  title: string;
  active_turn_number: number;
  world_version_id: string;
  world_content: Record<string, unknown>;
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
};

type EmbeddingConfigRow = {
  embedding_enabled: boolean;
  embedding_provider_profile_id: string | null;
  embedding_model: string;
  embedding_batch_size: number;
};

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

function publicEmbeddingConfig(row?: EmbeddingConfigRow) {
  return {
    enabled: row?.embedding_enabled ?? false,
    providerProfileId: row?.embedding_provider_profile_id ?? null,
    model: row?.embedding_model ?? "",
    batchSize: row?.embedding_batch_size ?? 16
  };
}

async function embeddingConfig(
  client: DatabaseClient | DatabasePool,
  ownerUserId: string,
  campaignId: string
): Promise<EmbeddingConfigRow | undefined> {
  const result = await client.query<EmbeddingConfigRow>(
    `SELECT embedding_enabled, embedding_provider_profile_id, embedding_model, embedding_batch_size
       FROM campaign_memory_configs WHERE campaign_id = $1 AND owner_user_id = $2`,
    [campaignId, ownerUserId]
  );
  return result.rows[0];
}

export async function getCampaignEmbeddingConfig(pool: DatabasePool, campaignId: string) {
  const ownerUserId = await initialOwnerId(pool);
  await campaignScope(pool, ownerUserId, campaignId);
  return publicEmbeddingConfig(await embeddingConfig(pool, ownerUserId, campaignId));
}

export async function setCampaignEmbeddingConfig(pool: DatabasePool, campaignId: string, input: CampaignEmbeddingConfig) {
  const ownerUserId = await initialOwnerId(pool);
  await campaignScope(pool, ownerUserId, campaignId);
  if (input.providerProfileId) {
    const provider = await pool.query(
      `SELECT id FROM provider_profiles
        WHERE id = $1 AND owner_user_id = $2 AND provider_role = 'embedding' AND enabled = true`,
      [input.providerProfileId, ownerUserId]
    );
    if (!provider.rows[0]) throw Object.assign(new Error("Enabled embedding provider profile not found."), { statusCode: 400 });
  }
  const result = await withTransaction(pool, async (client) => {
    const saved = await client.query<EmbeddingConfigRow>(
      `INSERT INTO campaign_memory_configs (
         campaign_id, owner_user_id, embedding_enabled, embedding_provider_profile_id, embedding_model, embedding_batch_size
       ) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (campaign_id) DO UPDATE SET
         embedding_enabled = EXCLUDED.embedding_enabled,
         embedding_provider_profile_id = EXCLUDED.embedding_provider_profile_id,
         embedding_model = EXCLUDED.embedding_model,
         embedding_batch_size = EXCLUDED.embedding_batch_size,
         updated_at = now()
       RETURNING embedding_enabled, embedding_provider_profile_id, embedding_model, embedding_batch_size`,
      [campaignId, ownerUserId, input.enabled, input.providerProfileId, input.model, input.batchSize]
    );
    if (!input.enabled) {
      await client.query(
        `UPDATE chronicle_memories SET embedding = NULL, embedding_provider_profile_id = NULL,
                embedding_model = NULL, embedding_dimensions = NULL, embedding_content_hash = NULL, embedding_updated_at = NULL
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
  compressionEstimates: Record<"full" | "balanced" | "compact" | "summary", number>;
};

function worldFictionCanon(content: Record<string, unknown>): Record<string, unknown> {
  const world = typeof content.world === "object" && content.world !== null
    ? content.world as Record<string, unknown>
    : content;
  const allowed = ["title", "genre", "tone", "backgroundStory", "character", "premise", "firstAction"];
  return Object.fromEntries(allowed.flatMap((key) => {
    const value = world[key];
    return typeof value === "string" && value.trim() ? [[key, value.trim()]] : [];
  }));
}

async function campaignScope(client: DatabaseClient | DatabasePool, ownerUserId: string, campaignId: string): Promise<CampaignScopeRow> {
  const result = await client.query<CampaignScopeRow>(
    `SELECT c.id, c.title, c.active_turn_number, c.world_version_id, wv.content AS world_content
       FROM campaigns c
       JOIN world_versions wv ON wv.id = c.world_version_id AND wv.owner_user_id = c.owner_user_id
      WHERE c.id = $1 AND c.owner_user_id = $2`,
    [campaignId, ownerUserId]
  );
  const campaign = result.rows[0];
  if (!campaign) throw Object.assign(new Error("Campaign not found."), { statusCode: 404 });
  return campaign;
}

async function allMemories(client: DatabaseClient | DatabasePool, ownerUserId: string, campaignId: string, query: string): Promise<MemoryRow[]> {
  const result = await client.query<MemoryRow>(
    `SELECT id, turn_id, memory_kind, ordinal, content, token_estimate, importance, entities,
            CASE WHEN $3 = '' THEN 0::real
                 ELSE ts_rank_cd(search_document, websearch_to_tsquery('english', $3)) END AS relevance
       FROM chronicle_memories
      WHERE owner_user_id = $1 AND campaign_id = $2
      ORDER BY ordinal ASC, created_at ASC`,
    [ownerUserId, campaignId, query.trim()]
  );
  return result.rows;
}

function compressedTokens(memories: MemoryRow[], level: "full" | "balanced" | "compact"): number {
  return memories
    .filter((memory) => memory.memory_kind === "turn_fiction")
    .reduce((total, memory) => total + estimateTokens(compressTurnMemory(memory.content, level)), 0);
}

function selectAutomaticLevel(metrics: ChronicleMetrics, availableTokens: number): Exclude<CompressionLevel, "auto"> {
  if (metrics.compressionEstimates.full <= availableTokens) return "full";
  if (metrics.compressionEstimates.balanced <= availableTokens) return "balanced";
  if (metrics.compressionEstimates.compact <= availableTokens) return "compact";
  return "summary";
}

function memoryMetricsFromRows(row: CompleteMetricsRow, memories: MemoryRow[]): ChronicleMetrics {
  const turnMemories = memories.filter((memory) => memory.memory_kind === "turn_fiction");
  const summary = memories.find((memory) => memory.memory_kind === "campaign_summary")
    ?? memories.find((memory) => memory.memory_kind === "legacy_summary");
  const recent = turnMemories.slice(-4).reduce((total, memory) => total + memory.token_estimate, 0);
  return {
    turns: Number(row.turns),
    completeHistoryCharacters: Number(row.characters),
    estimatedCompleteHistoryTokens: Number(row.estimated_tokens),
    memoryCount: Number(row.memory_count),
    memoryTokens: Number(row.memory_tokens),
    embeddedMemories: Number(row.embedded_memories),
    compressionEstimates: {
      full: compressedTokens(turnMemories, "full"),
      balanced: compressedTokens(turnMemories, "balanced"),
      compact: compressedTokens(turnMemories, "compact"),
      summary: (summary?.token_estimate ?? 0) + recent
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
       count(embedding)::text AS embedded_memories
     FROM chronicle_memories
     WHERE owner_user_id = $1 AND campaign_id = $2`,
    [ownerUserId, campaignId]
  );
  const row = result.rows[0];
  if (!row) throw new Error("Could not calculate Chronicle metrics.");
  return row;
}

export async function getChronicleMetrics(pool: DatabasePool, campaignId: string): Promise<ChronicleMetrics> {
  const ownerUserId = await initialOwnerId(pool);
  await campaignScope(pool, ownerUserId, campaignId);
  const memories = await allMemories(pool, ownerUserId, campaignId, "");
  return memoryMetricsFromRows(await metricsRow(pool, ownerUserId, campaignId), memories);
}

function topRelevant(memories: MemoryRow[], excluded: Set<string>, limit: number): MemoryRow[] {
  return memories
    .filter((memory) => memory.memory_kind === "turn_fiction" && !excluded.has(memory.id) && memory.relevance > 0)
    .sort((left, right) => (right.relevance - left.relevance) || (right.importance - left.importance) || (right.ordinal - left.ordinal))
    .slice(0, limit);
}

async function applySemanticRelevance(
  pool: DatabasePool,
  ownerUserId: string,
  campaignId: string,
  query: string,
  memories: MemoryRow[],
  credentialSecret: string
) {
  for (const memory of memories) memory.lexicalRelevance = Number(memory.relevance);
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
    const result = await callEmbeddingProvider(provider, [query.trim()]);
    const queryVector = result.embeddings[0];
    if (!queryVector) throw new Error("Embedding provider returned no query vector.");
    const scored = await pool.query<{ id: string; content: string; embedding_content_hash: string; semantic_relevance: number }>(
      `SELECT id, content, embedding_content_hash, (1 - (embedding <=> $5::vector))::real AS semantic_relevance
         FROM chronicle_memories
        WHERE owner_user_id = $1 AND campaign_id = $2
          AND embedding_provider_profile_id = $3 AND embedding_model = $4
          AND embedding_dimensions = $6 AND embedding IS NOT NULL`,
      [ownerUserId, campaignId, config.embedding_provider_profile_id, config.embedding_model, vectorLiteral(queryVector), queryVector.length]
    );
    const freshScores = scored.rows.filter((row) => row.embedding_content_hash === contentHash(row.content));
    const semantic = new Map(freshScores.map((row) => [row.id, Number(row.semantic_relevance)]));
    for (const memory of memories) {
      const lexical = Math.min(1, Math.max(0, Number(memory.lexicalRelevance || 0) * 8));
      const semanticScore = Math.max(0, semantic.get(memory.id) ?? 0);
      memory.semanticRelevance = semanticScore;
      memory.relevance = semantic.has(memory.id) ? semanticScore * 0.65 + lexical * 0.35 : lexical;
    }
    return { mode: "hybrid", semanticAvailable: true, embeddedCandidates: freshScores.length, model: config.embedding_model };
  } catch (error) {
    return {
      mode: "lexical_fallback",
      semanticAvailable: false,
      fallbackReason: (error instanceof Error ? error.message : String(error)).slice(0, 500)
    };
  }
}

export async function buildContextPreview(pool: DatabasePool, campaignId: string, options: MemoryContextQuery, credentialSecret = "") {
  const ownerUserId = await initialOwnerId(pool);
  const campaign = await campaignScope(pool, ownerUserId, campaignId);
  const memories = await allMemories(pool, ownerUserId, campaignId, options.query);
  const retrieval = await applySemanticRelevance(pool, ownerUserId, campaignId, options.query, memories, credentialSecret);
  const metrics = memoryMetricsFromRows(await metricsRow(pool, ownerUserId, campaignId), memories);
  const worldCanon = worldFictionCanon(campaign.world_content);
  const canonTokens = estimateTokens(JSON.stringify(worldCanon));
  const reservedTokens = Math.min(Math.floor(options.budgetTokens * 0.2), Math.max(512, canonTokens + 256));
  const availableTokens = Math.max(256, options.budgetTokens - reservedTokens);
  const selectedLevel = options.compression === "auto"
    ? selectAutomaticLevel(metrics, availableTokens)
    : options.compression;
  const turnMemories = memories.filter((memory) => memory.memory_kind === "turn_fiction");
  const latest = turnMemories.at(-1) ?? null;
  const recentCandidates = turnMemories.slice(-Math.max(1, options.recentTurns));
  const selected = new Map<string, { memory: MemoryRow; rendered: string; reason: string }>();
  let consumedTokens = 0;

  const addMemory = (memory: MemoryRow, rendered: string, reason: string): boolean => {
    if (selected.has(memory.id) || memory.id === latest?.id) return false;
    const tokens = estimateTokens(rendered);
    if (consumedTokens + tokens > availableTokens) return false;
    selected.set(memory.id, { memory, rendered, reason });
    consumedTokens += tokens;
    return true;
  };

  const renderLevel = selectedLevel === "summary" ? "compact" : selectedLevel;
  if (selectedLevel === "summary") {
    const summary = memories.find((memory) => memory.memory_kind === "campaign_summary")
      ?? memories.find((memory) => memory.memory_kind === "legacy_summary");
    if (summary) addMemory(summary, summary.content, "summary_checkpoint");
  }

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
  const currentScene = latest ? { memoryId: latest.id, ordinal: latest.ordinal, content: latest.content } : null;
  const actualTokens = canonTokens + chronicleEntries.reduce((sum, memory) => sum + memory.estimatedTokens, 0)
    + estimateTokens(currentScene?.content ?? "");
  const expectedForLevel = metrics.compressionEstimates[selectedLevel];

  return {
    campaign: { id: campaign.id, title: campaign.title, activeTurnNumber: campaign.active_turn_number },
    selectedCompression: selectedLevel,
    requestedCompression: options.compression,
    budget: {
      configuredTokens: options.budgetTokens,
      reservedCanonTokens: reservedTokens,
      availableChronicleTokens: availableTokens,
      estimatedSelectedTokens: actualTokens,
      completeHistoryTokens: metrics.estimatedCompleteHistoryTokens,
      expectedTokensForCompression: expectedForLevel,
      truncated: actualTokens > options.budgetTokens || expectedForLevel > availableTokens
    },
    metrics,
    retrieval,
    scopes: {
      worldCanon,
      campaignCanon: { campaignTitle: campaign.title, acceptedTurns: campaign.active_turn_number },
      chronicle: chronicleEntries,
      currentScene
    },
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
     DO UPDATE SET updated_at = chronicle_jobs.updated_at
     RETURNING id`,
    [ownerUserId, campaignId]
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("Could not enqueue the Chronicle reindex job.");
  return id;
}

export async function enqueueEmbeddingReindex(pool: DatabasePool, campaignId: string): Promise<string | null> {
  const ownerUserId = await initialOwnerId(pool);
  await campaignScope(pool, ownerUserId, campaignId);
  const config = await embeddingConfig(pool, ownerUserId, campaignId);
  if (!config?.embedding_enabled || !config.embedding_provider_profile_id || !config.embedding_model) return null;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO chronicle_jobs (owner_user_id, campaign_id, job_type)
     VALUES ($1,$2,'embed_campaign')
     ON CONFLICT (campaign_id, job_type) WHERE status IN ('queued', 'running')
     DO UPDATE SET updated_at = chronicle_jobs.updated_at
     RETURNING id`,
    [ownerUserId, campaignId]
  );
  return result.rows[0]?.id ?? null;
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
  const result = await pool.query<{
    id: string;
    content: string;
    embedding_provider_profile_id: string | null;
    embedding_model: string | null;
    embedding_content_hash: string | null;
  }>(
    `SELECT id, content, embedding_provider_profile_id, embedding_model, embedding_content_hash
       FROM chronicle_memories
      WHERE owner_user_id = $1 AND campaign_id = $2
      ORDER BY ordinal, created_at`,
    [ownerUserId, campaignId]
  );
  const pending = result.rows.filter((memory) => (
    memory.embedding_provider_profile_id !== provider.id
    || memory.embedding_model !== provider.model
    || memory.embedding_content_hash !== contentHash(memory.content)
  ));
  let embedded = 0;
  let dimensions = 0;
  for (let offset = 0; offset < pending.length; offset += config.embedding_batch_size) {
    const batch = pending.slice(offset, offset + config.embedding_batch_size);
    const response = await callEmbeddingProvider(provider, batch.map((memory) => memory.content));
    dimensions = response.embeddings[0]?.length ?? dimensions;
    await withTransaction(pool, async (client) => {
      for (let index = 0; index < batch.length; index += 1) {
        const memory = batch[index];
        const vector = response.embeddings[index];
        if (!memory || !vector) throw new Error("Embedding batch response was incomplete.");
        await client.query(
          `UPDATE chronicle_memories SET embedding = $4::vector, embedding_provider_profile_id = $5,
                  embedding_model = $6, embedding_dimensions = $7, embedding_content_hash = $8, embedding_updated_at = now()
            WHERE id = $1 AND owner_user_id = $2 AND campaign_id = $3 AND content = $9`,
          [memory.id, ownerUserId, campaignId, vectorLiteral(vector), provider.id, provider.model, vector.length, contentHash(memory.content), memory.content]
        );
      }
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
  }>(
    `SELECT id, turn_number, action, narration
       FROM turns WHERE owner_user_id = $1 AND campaign_id = $2 ORDER BY turn_number`,
    [ownerUserId, campaignId]
  );
  await client.query(
    `DELETE FROM chronicle_memories
      WHERE owner_user_id = $1 AND campaign_id = $2 AND memory_kind = 'turn_fiction'`,
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
  }
  return turns.rows.length;
}

export async function runChronicleJob(pool: DatabasePool, workerId: string, leaseSeconds: number, credentialSecret = ""): Promise<boolean> {
  const claimed = await withTransaction(pool, async (client) => {
    const result = await client.query<{ id: string; owner_user_id: string; campaign_id: string; job_type: "reindex_campaign" | "embed_campaign" }>(
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
              lease_expires_at = now() + ($2::text || ' seconds')::interval, updated_at = now()
         FROM candidate
        WHERE j.id = candidate.id
       RETURNING j.id, j.owner_user_id, j.campaign_id, j.job_type`,
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
    const completed = await pool.query<{ id: string }>(
      `UPDATE chronicle_jobs SET status = 'completed', completed_at = now(), updated_at = now(),
              lease_owner = NULL, lease_expires_at = NULL, error_message = NULL
        WHERE id = $1 AND lease_owner = $2`,
      [claimed.id, workerId]
    );
    if (!completed.rowCount) throw new Error("Chronicle job lease was lost before completion could be recorded.");
    await pool.query(
      `INSERT INTO activity_events (owner_user_id, campaign_id, event_type, correlation_id, details)
       VALUES ($1,$2,$3,$4,$5)`,
      [claimed.owner_user_id, claimed.campaign_id,
        claimed.job_type === "reindex_campaign" ? "chronicle_reindexed" : "chronicle_embedded",
        claimed.id, json(details)]
    );
    if (claimed.job_type === "reindex_campaign") await enqueueEmbeddingReindex(pool, claimed.campaign_id);
    if (claimed.job_type === "embed_campaign" && "providerProfileId" in details) {
      const current = await embeddingConfig(pool, claimed.owner_user_id, claimed.campaign_id);
      if (!current?.embedding_enabled) {
        await pool.query(
          `UPDATE chronicle_memories SET embedding = NULL, embedding_provider_profile_id = NULL,
                  embedding_model = NULL, embedding_dimensions = NULL, embedding_content_hash = NULL, embedding_updated_at = NULL
            WHERE owner_user_id = $1 AND campaign_id = $2`,
          [claimed.owner_user_id, claimed.campaign_id]
        );
      } else if (current.embedding_provider_profile_id !== details.providerProfileId || current.embedding_model !== details.model) {
        await enqueueEmbeddingReindex(pool, claimed.campaign_id);
      }
    }
  } catch (error) {
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
