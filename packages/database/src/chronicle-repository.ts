import type {
  CampaignMemoryScope,
  CampaignWorldVersionMemoryScope,
  ChronicleMetricsView,
  ChronicleJobRepository,
  ChronicleJobView,
  ChronicleLeaseScope,
  ChronicleWorkerRetrievalPort,
  ChronicleWorkerStatePort,
  EmbeddingConfigView,
  MemoryApplicationDependencies,
  MemoryConfigurationRepository,
  MemoryGenerationTransactionPort,
  MemoryPublicResult,
  MemoryQueryRepository,
  MemoryTransactionContext
} from "../../application/src/memory/index.js";
import { MEMORY_PUBLIC_FAILURE_MESSAGE } from "../../application/src/memory/index.js";
import { requireCampaignWorldVersionScope } from "../../application/src/memory/helpers.js";
import {
  DEFAULT_EMBEDDING_MODEL,
  type CampaignEmbeddingConfig,
  type CompressionLevel
} from "../../contracts/src/memory.js";
import {
  CHRONICLE_EMBEDDING_PROTOCOL_VERSION,
  buildAcceptedTurnFictionMemory,
  buildCanonicalChronicleFacts,
  buildChronicleEntityCatalog,
  chronicleContentHash,
  embeddingEligibility,
  modelAwareEmbeddingPrefixes,
  providerModelFingerprint,
  sanitizeChronicleFictionString,
  sanitizeChronicleFictionValue,
  sanitizeChronicleMemoryLines
} from "../../domain/src/chronicle-memory-helpers.js";
import { canonicalFactDeduplicationKey } from "../../domain/src/canonical-facts.js";
import {
  expandEntityQuery,
  matchEntityReferences,
  resolveEntityMetadata,
  type EntityReference
} from "../../domain/src/entity-references.js";
import { estimateTokens, stableStringify, truncateAtBoundary } from "../../domain/src/text.js";
import { characterNarrativeContext } from "../../domain/src/world-characters.js";
import { compressTurnMemory } from "../../story-engine/src/chronicle.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";
import { withTransaction } from "./pool.js";
import { enqueuePostgresChronicleChunkIndex } from "./chronicle-chunk-repository.js";

type ChronicleJobRow = Readonly<{
  id: string;
  owner_user_id: string;
  campaign_id: string;
  world_version_id: string;
  job_type: "reindex_campaign" | "embed_campaign";
  status: "queued" | "running" | "completed" | "failed";
  attempts: number;
  work_version: number | string;
  progress: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}>;

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

export type ChronicleTransactionEmbeddingProvider = Readonly<{
  id: string;
  model: string;
  providerType: string;
  configuration?: unknown;
}>;

export type ChronicleTransactionEmbeddingExecution = ChronicleTransactionEmbeddingProvider & Readonly<{
  embed(documents: readonly string[]): Promise<ChronicleTransactionEmbeddingResult>;
}>;

export type ChronicleTransactionEmbeddingResult = Readonly<{
  embeddings: readonly (readonly number[])[];
  responseId: string;
  usage: unknown;
  reportedCost: Readonly<{ amount: string; currency: string }> | null;
}>;

export type ChronicleTransactionEmbeddingPort = Readonly<{
  resolve(
    database: MemoryTransactionContext,
    scope: Readonly<{
      ownerUserId: string;
      campaignId: string;
      selectedProviderProfileId?: string | null;
    }>,
  ): Promise<string | null>;
  load(
    database: MemoryTransactionContext,
    scope: Readonly<{ ownerUserId: string; providerProfileId: string; model: string }>,
  ): Promise<ChronicleTransactionEmbeddingExecution>;
  embed(
    provider: ChronicleTransactionEmbeddingExecution,
    documents: readonly string[],
  ): Promise<ChronicleTransactionEmbeddingResult>;
  fingerprint(
    provider: ChronicleTransactionEmbeddingProvider,
    prefixes: Readonly<{ documentPrefix: string; queryPrefix: string; automatic: boolean }>,
  ): Promise<string>;
  recordHealth(
    database: MemoryTransactionContext,
    scope: Readonly<{ ownerUserId: string; providerProfileId: string; model: string }>,
    healthy: boolean,
    diagnostic?: string,
  ): Promise<void>;
  recordCost(
    database: MemoryTransactionContext,
    provider: ChronicleTransactionEmbeddingProvider,
    scope: Readonly<{
      ownerUserId: string;
      campaignId: string;
      generationJobId?: string;
      chronicleJobId?: string;
      operation: "memory_embedding" | "retrieval_embedding" | "context_preview_embedding";
    }>,
    result: ChronicleTransactionEmbeddingResult,
  ): Promise<string | null>;
  logDiagnostic(error: unknown, context: Readonly<Record<string, unknown>>): void;
}>;

export type ChronicleGenerationTransactionDependencies = Readonly<{
  embeddings: ChronicleTransactionEmbeddingPort;
}>;

export type ChronicleEmbeddingBatchInput = Readonly<{
  provider: ChronicleTransactionEmbeddingProvider;
  providerFingerprint: string;
  protocolVersion: string;
  memories: readonly Readonly<{
    id: string;
    content: string;
    contentHash: string;
  }>[];
  result: ChronicleTransactionEmbeddingResult;
  processed: number;
  total: number;
}>;

export type ChronicleEmbeddingBatchPort = Readonly<{
  commitClaimBatch(scope: ChronicleLeaseScope, input: ChronicleEmbeddingBatchInput): Promise<boolean>;
}>;

export type ChronicleEmbeddingBatchDependencies = Readonly<{
  recordCost: ChronicleTransactionEmbeddingPort["recordCost"];
}>;

function notFound(resource: string): Error & { statusCode: number } {
  return Object.assign(new Error(`${resource} not found.`), { statusCode: 404 });
}

function invalid(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function configView(row?: EmbeddingConfigRow): EmbeddingConfigView {
  const model = row?.embedding_model || DEFAULT_EMBEDDING_MODEL;
  const prefixes = modelAwareEmbeddingPrefixes(
    model,
    row?.embedding_document_prefix ?? null,
    row?.embedding_query_prefix ?? null,
  );
  return {
    enabled: row?.embedding_enabled ?? false,
    providerProfileId: row?.embedding_provider_profile_id ?? null,
    model,
    batchSize: row?.embedding_batch_size ?? 16,
    documentPrefix: row?.embedding_document_prefix ?? null,
    queryPrefix: row?.embedding_query_prefix ?? null,
    retrievalImplementation: row?.retrieval_implementation ?? "legacy_hybrid",
    retrievalShadowEnabled: row?.retrieval_shadow_enabled ?? false,
    effectiveDocumentPrefix: prefixes.documentPrefix,
    effectiveQueryPrefix: prefixes.queryPrefix,
    prefixesAutomatic: prefixes.automatic
  };
}

function transactionClient(database: MemoryTransactionContext): DatabaseClient {
  if (!("query" in database) || typeof database.query !== "function") {
    throw new TypeError("Chronicle transaction operations require the caller-owned database client.");
  }
  return database as DatabaseClient;
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

async function loadCampaignProjection(
  client: DatabaseClient,
  scope: CampaignWorldVersionMemoryScope,
): Promise<CampaignProjectionRow> {
  const result = await client.query<CampaignProjectionRow>(
    `SELECT c.id, c.world_version_id, wv.content AS world_content,
            c.character_snapshot, c.character_profile
       FROM campaigns c
       JOIN world_versions wv ON wv.id = c.world_version_id AND wv.owner_user_id = c.owner_user_id
      WHERE c.id = $1 AND c.owner_user_id = $2`,
    [scope.campaignId, scope.ownerUserId]
  );
  return requireCampaignWorldVersionScope(scope, result.rows[0]);
}

type ProjectedFactRow = Readonly<{
  id: string;
  source_turn_id: string;
  source_turn_number: number;
  content: string;
  entities: string[];
  entity_ids: string[];
}>;

async function syncCanonicalFactMemories(
  client: DatabaseClient,
  scope: CampaignWorldVersionMemoryScope,
  sourceTurnIds: ReadonlySet<string>,
): Promise<void> {
  if (!sourceTurnIds.size) return;
  const turnIds = [...sourceTurnIds];
  const active = await client.query<ProjectedFactRow>(
    `SELECT id, source_turn_id, source_turn_number, content, entities, entity_ids
       FROM campaign_canonical_facts
      WHERE owner_user_id = $1 AND campaign_id = $2
        AND source_turn_id = ANY($3::uuid[]) AND valid_until_turn IS NULL
      ORDER BY source_turn_number, source_fact_index`,
    [scope.ownerUserId, scope.campaignId, turnIds]
  );
  await client.query(
    `DELETE FROM chronicle_memories
      WHERE owner_user_id = $1 AND campaign_id = $2 AND turn_id = ANY($3::uuid[])
        AND memory_kind = 'canonical_fact' AND metadata->>'generatedFromAcceptedTurn' = 'true'`,
    [scope.ownerUserId, scope.campaignId, turnIds]
  );
  const grouped = new Map<string, ProjectedFactRow[]>();
  for (const fact of active.rows) {
    const facts = grouped.get(fact.source_turn_id) ?? [];
    facts.push(fact);
    grouped.set(fact.source_turn_id, facts);
  }
  for (const [sourceTurnId, facts] of grouped) {
    const ordinal = facts[0]!.source_turn_number;
    const content = [
      `Canonical facts established or corrected at turn ${ordinal}`,
      ...facts.map((fact) => `- [fact_id: ${fact.id}] ${fact.content}`)
    ].join("\n");
    const entities = [...new Set(facts.flatMap((fact) => fact.entities))].slice(0, 100);
    const entityIds = [...new Set(facts.flatMap((fact) => fact.entity_ids))];
    await client.query(
      `INSERT INTO chronicle_memories (
         owner_user_id, campaign_id, world_version_id, turn_id, memory_kind, ordinal, content,
         token_estimate, importance, entities, entity_ids, metadata
       ) VALUES ($1,$2,$3,$4,'canonical_fact',$5,$6,$7,0.85,$8,$9,$10)`,
      [scope.ownerUserId, scope.campaignId, scope.worldVersionId, sourceTurnId, ordinal, content,
        estimateTokens(content), entities, entityIds,
        json({ sourceTurn: ordinal, generatedFromAcceptedTurn: true, structuredFactIds: facts.map((fact) => fact.id) })]
    );
  }
}

async function projectCanonicalFacts(
  client: DatabaseClient,
  scope: CampaignWorldVersionMemoryScope & Readonly<{
    turnId: string;
    ordinal: number;
    derived: Readonly<{
      canonicalFacts?: readonly string[];
      supersededFacts?: readonly string[];
      canonicalFactUpdates?: readonly Readonly<{ content: string; supersedesFactIds?: readonly string[] }>[];
      entityCatalog: readonly EntityReference[];
    }>;
  }>,
): Promise<void> {
  const projections = buildCanonicalChronicleFacts({
    campaignId: scope.campaignId,
    turnId: scope.turnId,
    entityCatalog: scope.derived.entityCatalog,
    ...(scope.derived.canonicalFacts ? { canonicalFacts: scope.derived.canonicalFacts } : {}),
    ...(scope.derived.canonicalFactUpdates ? { canonicalFactUpdates: scope.derived.canonicalFactUpdates } : {})
  });
  const affectedTurnIds = new Set<string>([scope.turnId]);
  for (const projection of projections) {
    await client.query(
      `INSERT INTO campaign_canonical_facts (
         id, owner_user_id, campaign_id, world_version_id, source_turn_id, source_turn_number,
         source_fact_index, content, normalized_content, entities, entity_ids, valid_from_turn, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$6,$12)
       ON CONFLICT (campaign_id, source_turn_id, source_fact_index) DO UPDATE SET
         content = EXCLUDED.content, normalized_content = EXCLUDED.normalized_content,
         entities = EXCLUDED.entities, entity_ids = EXCLUDED.entity_ids,
         metadata = EXCLUDED.metadata, updated_at = now()`,
      [projection.id, scope.ownerUserId, scope.campaignId, scope.worldVersionId, scope.turnId, scope.ordinal,
        projection.factIndex, projection.content, projection.normalizedContent, projection.entities, projection.entityIds,
        json({ generatedFromAcceptedTurn: true })]
    );
    if (projection.supersedesFactIds.length) {
      const superseded = await client.query<{ id: string; source_turn_id: string }>(
        `UPDATE campaign_canonical_facts
            SET valid_until_turn = $4, superseded_by_fact_id = $5, updated_at = now()
          WHERE owner_user_id = $1 AND campaign_id = $2 AND id = ANY($3::uuid[])
            AND source_turn_number < $4 AND valid_until_turn IS NULL
        RETURNING id, source_turn_id`,
        [scope.ownerUserId, scope.campaignId, projection.supersedesFactIds, scope.ordinal, projection.id]
      );
      superseded.rows.forEach((fact) => affectedTurnIds.add(fact.source_turn_id));
      const matched = new Set(superseded.rows.map((fact) => fact.id));
      const unmatched = projection.supersedesFactIds.filter((id) => !matched.has(id));
      if (unmatched.length) {
        await client.query(
          `UPDATE campaign_canonical_facts
              SET metadata = metadata || $4::jsonb, updated_at = now()
            WHERE id = $1 AND owner_user_id = $2 AND campaign_id = $3`,
          [projection.id, scope.ownerUserId, scope.campaignId, json({ unmatchedSupersedesFactIds: unmatched })]
        );
      }
    }
  }
  const legacySuperseded = sanitizeChronicleMemoryLines(scope.derived.supersededFacts)
    .map((fact) => canonicalFactDeduplicationKey(fact.replace(/^[-•]\s*/, "")));
  if (legacySuperseded.length) {
    const superseded = await client.query<{ source_turn_id: string }>(
      `UPDATE campaign_canonical_facts
          SET valid_until_turn = $4, updated_at = now(), metadata = metadata || $5::jsonb
        WHERE owner_user_id = $1 AND campaign_id = $2
          AND normalized_content = ANY($3::text[])
          AND source_turn_number < $4 AND valid_until_turn IS NULL
      RETURNING source_turn_id`,
      [scope.ownerUserId, scope.campaignId, legacySuperseded, scope.ordinal,
        json({ legacyTextSupersededAtTurn: scope.ordinal })]
    );
    superseded.rows.forEach((fact) => affectedTurnIds.add(fact.source_turn_id));
  }
  await syncCanonicalFactMemories(client, scope, affectedTurnIds);
}

async function storeDerivedMemories(
  client: DatabaseClient,
  scope: Parameters<MemoryGenerationTransactionPort["storeDerivedTurnMemories"]>[1],
): Promise<void> {
  const campaign = await loadCampaignProjection(client, scope);
  const entityCatalog = scope.derived.entityCatalog
    ? scope.derived.entityCatalog as readonly EntityReference[]
    : buildChronicleEntityCatalog({
      worldContent: campaign.world_content,
      characterSnapshot: campaign.character_snapshot,
      characterProfile: campaign.character_profile
    });
  const summary = sanitizeChronicleFictionString(scope.derived.continuitySummary, 20_000);
  const threads = sanitizeChronicleMemoryLines(scope.derived.openThreads);
  await projectCanonicalFacts(client, {
    ...scope,
    derived: { ...scope.derived, entityCatalog }
  });
  if (summary) {
    const entities = resolveEntityMetadata(summary, entityCatalog);
    await client.query(
      `INSERT INTO chronicle_memories (
         owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content,
         token_estimate, importance, entities, entity_ids, metadata
       ) VALUES ($1,$2,$3,'campaign_summary',$4,$5,$6,0.9,$7,$8,$9)
       ON CONFLICT (campaign_id, turn_id, memory_kind) DO UPDATE SET
         world_version_id = EXCLUDED.world_version_id, ordinal = EXCLUDED.ordinal,
         content = EXCLUDED.content, token_estimate = EXCLUDED.token_estimate,
         importance = EXCLUDED.importance, entities = EXCLUDED.entities, entity_ids = EXCLUDED.entity_ids,
         metadata = EXCLUDED.metadata, embedding = NULL, embedding_provider_profile_id = NULL,
         embedding_model = NULL, embedding_dimensions = NULL, embedding_content_hash = NULL,
         embedding_updated_at = NULL, embedding_provider_fingerprint = NULL, updated_at = now()`,
      [scope.ownerUserId, scope.campaignId, scope.worldVersionId, scope.ordinal, summary, estimateTokens(summary),
        entities.entities, entities.entityIds,
        json({ throughTurn: scope.ordinal, generatedFromAcceptedTurn: true })]
    );
    if (scope.ordinal % 8 === 0) {
      await client.query(
        `INSERT INTO summary_checkpoints (owner_user_id, campaign_id, through_turn, summary_kind, content, token_estimate)
         VALUES ($1,$2,$3,'campaign_continuity',$4,$5)`,
        [scope.ownerUserId, scope.campaignId, scope.ordinal, json({ summary }), estimateTokens(summary)]
      );
    }
  }
  if (threads.length) {
    const content = [`Open story threads after turn ${scope.ordinal}`, ...threads.map((thread) => `- ${thread}`)].join("\n");
    const entities = resolveEntityMetadata(content, entityCatalog);
    await client.query(
      `INSERT INTO chronicle_memories (
         owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content,
         token_estimate, importance, entities, entity_ids, metadata
       ) VALUES ($1,$2,$3,'open_thread',$4,$5,$6,0.95,$7,$8,$9)
       ON CONFLICT (campaign_id, turn_id, memory_kind) DO UPDATE SET
         world_version_id = EXCLUDED.world_version_id, ordinal = EXCLUDED.ordinal,
         content = EXCLUDED.content, token_estimate = EXCLUDED.token_estimate,
         importance = EXCLUDED.importance, entities = EXCLUDED.entities, entity_ids = EXCLUDED.entity_ids,
         metadata = EXCLUDED.metadata, embedding = NULL, embedding_provider_profile_id = NULL,
         embedding_model = NULL, embedding_dimensions = NULL, embedding_content_hash = NULL,
         embedding_updated_at = NULL, embedding_provider_fingerprint = NULL, updated_at = now()`,
      [scope.ownerUserId, scope.campaignId, scope.worldVersionId, scope.ordinal, content, estimateTokens(content),
        entities.entities, entities.entityIds,
        json({ throughTurn: scope.ordinal, replacesPriorOpenThreads: true, generatedFromAcceptedTurn: true })]
    );
  } else if (scope.derived.openThreads) {
    await client.query(
      `DELETE FROM chronicle_memories
        WHERE owner_user_id = $1 AND campaign_id = $2
          AND memory_kind = 'open_thread' AND turn_id IS NULL`,
      [scope.ownerUserId, scope.campaignId]
    );
  }
}

async function writeAcceptedFiction(
  client: DatabaseClient,
  scope: Parameters<MemoryGenerationTransactionPort["writeAcceptedTurnFiction"]>[1],
  options: Readonly<{ importance?: number; reindexed?: boolean }> = {},
): Promise<void> {
  const campaign = await loadCampaignProjection(client, scope);
  const memory = buildAcceptedTurnFictionMemory({
    accepted: true,
    action: scope.action,
    narration: scope.narration
  }, scope.ordinal);
  if (!memory) throw new Error("Accepted turn fiction memory was unexpectedly excluded.");
  const entityCatalog = buildChronicleEntityCatalog({
    worldContent: campaign.world_content,
    characterSnapshot: campaign.character_snapshot,
    characterProfile: campaign.character_profile
  });
  const entities = resolveEntityMetadata(memory.content, entityCatalog);
  await client.query(
    `INSERT INTO chronicle_memories (
       owner_user_id, campaign_id, world_version_id, turn_id, memory_kind, ordinal,
       content, token_estimate, importance, entities, entity_ids, metadata
     ) VALUES ($1,$2,$3,$4,'turn_fiction',$5,$6,$7,$8,$9,$10,$11)`,
    [scope.ownerUserId, scope.campaignId, scope.worldVersionId, scope.turnId, scope.ordinal,
      memory.content, memory.tokenEstimate, options.importance ?? Math.min(1, 0.5 + scope.ordinal / 100),
      entities.entities, entities.entityIds,
      json({
        sanitized: memory.sanitized,
        removedMechanicsSegments: memory.removedMechanicsSegments,
        ...(options.reindexed ? { reindexed: true } : { generated: true })
      })]
  );
}

type RebuildTurnRow = Readonly<{
  id: string;
  turn_number: number;
  action: string;
  narration: string;
  state_snapshot_private: Record<string, unknown>;
}>;

type StateCorrection = Readonly<{
  id: string;
  effectiveTurnNumber: number;
  snapshot: Readonly<{
    continuitySummary: string;
    openThreads: readonly string[];
    canonicalFacts: readonly Readonly<{ id: string | null; content: string }>[];
  }>;
}>;

function stateCorrectionSnapshot(snapshot: Record<string, unknown>): StateCorrection["snapshot"] {
  return {
    continuitySummary: typeof snapshot.continuitySummary === "string" ? snapshot.continuitySummary : "",
    openThreads: Array.isArray(snapshot.openThreads)
      ? snapshot.openThreads.filter((value): value is string => typeof value === "string")
      : [],
    canonicalFacts: Array.isArray(snapshot.canonicalFacts)
      ? snapshot.canonicalFacts.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const fact = value as Record<string, unknown>;
        if (typeof fact.content !== "string" || (fact.id !== null && typeof fact.id !== "string")) return [];
        return [{ id: fact.id as string | null, content: fact.content }];
      })
      : []
  };
}

function correctionFactId(campaignId: string, stateEditId: string, factIndex: number): string {
  const hash = chronicleContentHash(`${campaignId}:${stateEditId}:${factIndex}`);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

async function projectStateCorrection(
  client: DatabaseClient,
  scope: CampaignWorldVersionMemoryScope,
  campaign: CampaignProjectionRow,
  edit: StateCorrection,
): Promise<void> {
  const entityCatalog = buildChronicleEntityCatalog({
    worldContent: campaign.world_content,
    characterSnapshot: campaign.character_snapshot,
    characterProfile: campaign.character_profile
  });
  const canonicalFacts = edit.snapshot.canonicalFacts.flatMap((fact) => {
    const content = sanitizeChronicleFictionString(fact.content, 20_000);
    return content ? [{ ...fact, content }] : [];
  });
  const active = await client.query<{
    id: string;
    source_turn_number: number;
    content: string;
  }>(
    `SELECT id, source_turn_number, content
       FROM campaign_canonical_facts
      WHERE owner_user_id = $1 AND campaign_id = $2
        AND valid_from_turn <= $3
        AND (valid_until_turn IS NULL OR valid_until_turn > $3)
      ORDER BY source_turn_number, source_fact_index`,
    [scope.ownerUserId, scope.campaignId, edit.effectiveTurnNumber]
  );
  const activeById = new Map(active.rows.map((fact) => [fact.id, fact]));
  const desiredIds = new Set(canonicalFacts.flatMap((fact) => fact.id ? [fact.id] : []));
  for (const fact of active.rows) {
    if (desiredIds.has(fact.id)) continue;
    if (fact.source_turn_number < edit.effectiveTurnNumber) {
      await client.query(
        `UPDATE campaign_canonical_facts
            SET valid_until_turn = $4, updated_at = now()
          WHERE id = $1 AND owner_user_id = $2 AND campaign_id = $3`,
        [fact.id, scope.ownerUserId, scope.campaignId, edit.effectiveTurnNumber]
      );
    } else {
      await client.query(
        "DELETE FROM campaign_canonical_facts WHERE id = $1 AND owner_user_id = $2 AND campaign_id = $3",
        [fact.id, scope.ownerUserId, scope.campaignId]
      );
    }
  }
  for (const [index, desired] of canonicalFacts.entries()) {
    const id = desired.id ?? correctionFactId(scope.campaignId, edit.id, index);
    const existing = activeById.get(id);
    const entityMetadata = resolveEntityMetadata(desired.content, entityCatalog);
    if (existing?.source_turn_number === edit.effectiveTurnNumber) {
      await client.query(
        `UPDATE campaign_canonical_facts
            SET source_turn_id = NULL, source_state_edit_id = $4, source_fact_index = $5,
                content = $6, normalized_content = $7, entities = $8, entity_ids = $9,
                metadata = $10, updated_at = now()
          WHERE id = $1 AND owner_user_id = $2 AND campaign_id = $3`,
        [id, scope.ownerUserId, scope.campaignId, edit.id, index, desired.content,
          canonicalFactDeduplicationKey(desired.content), entityMetadata.entities, entityMetadata.entityIds,
          json({ stateEditId: edit.id, manualCorrection: true })]
      );
      continue;
    }
    if (existing) continue;
    await client.query(
      `INSERT INTO campaign_canonical_facts (
         id, owner_user_id, campaign_id, world_version_id, source_state_edit_id, source_turn_number,
         source_fact_index, content, normalized_content, entities, entity_ids, valid_from_turn, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$6,$12)`,
      [id, scope.ownerUserId, scope.campaignId, scope.worldVersionId, edit.id, edit.effectiveTurnNumber, index,
        desired.content, canonicalFactDeduplicationKey(desired.content), entityMetadata.entities, entityMetadata.entityIds,
        json({ stateEditId: edit.id, manualCorrection: true })]
    );
  }

  await client.query(
    `DELETE FROM chronicle_memories
      WHERE owner_user_id = $1 AND campaign_id = $2
        AND memory_kind IN ('campaign_summary', 'canonical_fact', 'open_thread')`,
    [scope.ownerUserId, scope.campaignId]
  );
  const projected = await client.query<{
    id: string;
    source_turn_id: string | null;
    source_turn_number: number;
    content: string;
    entities: string[];
    entity_ids: string[];
  }>(
    `SELECT id, source_turn_id, source_turn_number, content, entities, entity_ids
       FROM campaign_canonical_facts
      WHERE owner_user_id = $1 AND campaign_id = $2 AND valid_until_turn IS NULL
      ORDER BY source_turn_number, source_fact_index`,
    [scope.ownerUserId, scope.campaignId]
  );
  const grouped = new Map<string | null, typeof projected.rows>();
  for (const fact of projected.rows) {
    const facts = grouped.get(fact.source_turn_id) ?? [];
    facts.push(fact);
    grouped.set(fact.source_turn_id, facts);
  }
  for (const [sourceTurnId, facts] of grouped) {
    const ordinal = facts[0]!.source_turn_number;
    const content = [
      `Canonical facts established or corrected at turn ${ordinal}`,
      ...facts.map((fact) => `- [fact_id: ${fact.id}] ${fact.content}`)
    ].join("\n");
    const entities = [...new Set(facts.flatMap((fact) => fact.entities))].slice(0, 100);
    const entityIds = [...new Set(facts.flatMap((fact) => fact.entity_ids))];
    await client.query(
      `INSERT INTO chronicle_memories (
         owner_user_id, campaign_id, world_version_id, turn_id, memory_kind, ordinal, content,
         token_estimate, importance, entities, entity_ids, metadata
       ) VALUES ($1,$2,$3,$4,'canonical_fact',$5,$6,$7,0.85,$8,$9,$10)`,
      [scope.ownerUserId, scope.campaignId, scope.worldVersionId, sourceTurnId, ordinal,
        content, estimateTokens(content), entities, entityIds,
        json({ stateEditId: edit.id, manualCorrection: true, structuredFactIds: facts.map((fact) => fact.id) })]
    );
  }
  const summary = sanitizeChronicleFictionString(edit.snapshot.continuitySummary, 20_000);
  if (summary) {
    const entityMetadata = resolveEntityMetadata(summary, entityCatalog);
    await client.query(
      `INSERT INTO chronicle_memories (
         owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content,
         token_estimate, importance, entities, entity_ids, metadata
       ) VALUES ($1,$2,$3,'campaign_summary',$4,$5,$6,0.9,$7,$8,$9)`,
      [scope.ownerUserId, scope.campaignId, scope.worldVersionId, edit.effectiveTurnNumber, summary,
        estimateTokens(summary), entityMetadata.entities, entityMetadata.entityIds,
        json({ stateEditId: edit.id, manualCorrection: true })]
    );
  }
  const threads = sanitizeChronicleMemoryLines(edit.snapshot.openThreads);
  if (threads.length) {
    const content = [
      `Open story threads after turn ${edit.effectiveTurnNumber}`,
      ...threads.map((thread) => `- ${thread}`)
    ].join("\n");
    const entityMetadata = resolveEntityMetadata(content, entityCatalog);
    await client.query(
      `INSERT INTO chronicle_memories (
         owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content,
         token_estimate, importance, entities, entity_ids, metadata
       ) VALUES ($1,$2,$3,'open_thread',$4,$5,$6,0.95,$7,$8,$9)`,
      [scope.ownerUserId, scope.campaignId, scope.worldVersionId, edit.effectiveTurnNumber, content,
        estimateTokens(content), entityMetadata.entities, entityMetadata.entityIds,
        json({ stateEditId: edit.id, manualCorrection: true })]
    );
  }
}

function derivedFromStateSnapshot(
  snapshot: Record<string, unknown>,
  entityCatalog: readonly EntityReference[],
): Parameters<MemoryGenerationTransactionPort["storeDerivedTurnMemories"]>[1]["derived"] {
  const openThreads = Array.isArray(snapshot.openThreads)
    ? snapshot.openThreads.filter((value): value is string => typeof value === "string")
    : undefined;
  return {
    continuitySummary: typeof snapshot.continuitySummary === "string" ? snapshot.continuitySummary : "",
    canonicalFacts: Array.isArray(snapshot.canonicalFacts)
      ? snapshot.canonicalFacts.filter((value): value is string => typeof value === "string")
      : [],
    supersededFacts: Array.isArray(snapshot.supersededFacts)
      ? snapshot.supersededFacts.filter((value): value is string => typeof value === "string")
      : [],
    canonicalFactUpdates: Array.isArray(snapshot.canonicalFactUpdates)
      ? snapshot.canonicalFactUpdates.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const update = value as Record<string, unknown>;
        if (typeof update.content !== "string") return [];
        return [{
          content: update.content,
          supersedesFactIds: Array.isArray(update.supersedesFactIds)
            ? update.supersedesFactIds.filter((id): id is string => typeof id === "string")
            : []
        }];
      })
      : [],
    entityCatalog,
    ...(openThreads ? { openThreads } : {})
  };
}

async function rebuildMemories(
  client: DatabaseClient,
  scope: CampaignWorldVersionMemoryScope,
): Promise<number> {
  const campaign = await loadCampaignProjection(client, scope);
  const entityCatalog = buildChronicleEntityCatalog({
    worldContent: campaign.world_content,
    characterSnapshot: campaign.character_snapshot,
    characterProfile: campaign.character_profile
  });
  const turns = await client.query<RebuildTurnRow>(
    `SELECT turn_row.id, turn_row.turn_number, turn_row.action,
            effective.effective_narration AS narration, turn_row.state_snapshot_private
       FROM turns turn_row
       JOIN effective_turn_narrations effective
         ON effective.turn_id = turn_row.id
        AND effective.campaign_id = turn_row.campaign_id
        AND effective.owner_user_id = turn_row.owner_user_id
      WHERE turn_row.owner_user_id = $1 AND turn_row.campaign_id = $2
      ORDER BY turn_row.turn_number`,
    [scope.ownerUserId, scope.campaignId]
  );
  await client.query(
    "DELETE FROM campaign_canonical_facts WHERE owner_user_id = $1 AND campaign_id = $2",
    [scope.ownerUserId, scope.campaignId]
  );
  await client.query(
    `DELETE FROM chronicle_memories
      WHERE owner_user_id = $1 AND campaign_id = $2 AND memory_kind = 'turn_fiction'`,
    [scope.ownerUserId, scope.campaignId]
  );
  await client.query(
    `DELETE FROM summary_checkpoints
      WHERE owner_user_id = $1 AND campaign_id = $2 AND summary_kind = 'campaign_continuity'`,
    [scope.ownerUserId, scope.campaignId]
  );
  await client.query(
    `DELETE FROM chronicle_memories
      WHERE owner_user_id = $1 AND campaign_id = $2
        AND memory_kind IN ('campaign_summary','canonical_fact','open_thread')`,
    [scope.ownerUserId, scope.campaignId]
  );
  for (const turn of turns.rows) {
    await writeAcceptedFiction(client, {
      ...scope,
      turnId: turn.id,
      ordinal: turn.turn_number,
      action: turn.action,
      narration: turn.narration
    }, {
      importance: Math.min(1, 0.45 + turn.turn_number / Math.max(20, turns.rows.length * 2)),
      reindexed: true
    });
    await storeDerivedMemories(client, {
      ...scope,
      turnId: turn.id,
      ordinal: turn.turn_number,
      derived: derivedFromStateSnapshot(turn.state_snapshot_private, entityCatalog)
    });
  }
  const edits = await client.query<{
    id: string;
    effective_turn_number: number;
    state_snapshot_private: Record<string, unknown>;
  }>(
    `SELECT id, effective_turn_number, state_snapshot_private
       FROM campaign_state_edits
      WHERE owner_user_id = $1 AND campaign_id = $2
      ORDER BY effective_turn_number, revision`,
    [scope.ownerUserId, scope.campaignId]
  );
  for (const edit of edits.rows) {
    await projectStateCorrection(client, scope, campaign, {
      id: edit.id,
      effectiveTurnNumber: edit.effective_turn_number,
      snapshot: stateCorrectionSnapshot(edit.state_snapshot_private)
    });
  }
  return turns.rows.length;
}

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

type ContextMetrics = Readonly<{
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

async function loadContextMetrics(
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

async function applyContextSemanticRelevance(
  client: DatabaseClient,
  scope: Parameters<MemoryGenerationTransactionPort["buildContextPreview"]>[1],
  query: string,
  memories: ContextMemoryRow[],
  queryEntityIds: string[],
  dependencies: ChronicleGenerationTransactionDependencies,
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
  const configResult = await client.query<EmbeddingConfigRow>(
    `SELECT embedding_enabled, embedding_provider_profile_id, embedding_model, embedding_batch_size,
            embedding_document_prefix, embedding_query_prefix, retrieval_implementation,
            retrieval_shadow_enabled
       FROM campaign_memory_configs WHERE campaign_id = $1 AND owner_user_id = $2`,
    [scope.campaignId, scope.ownerUserId]
  );
  const config = configResult.rows[0];
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

async function buildContext(
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
  const retrieval = {
    ...await applyContextSemanticRelevance(
    client,
    scope,
    expandedQuery,
    memories,
    queryEntityIds,
    dependencies
    ),
    scopeEligibleCandidates
  };
  const metrics = await loadContextMetrics(client, scope);
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

export function createPostgresChronicleGenerationTransactionPort(
  dependencies: ChronicleGenerationTransactionDependencies,
): MemoryGenerationTransactionPort {
  return {
    async autoEnableCampaignEmbedding(database, scope) {
      const client = transactionClient(database);
      await requireCampaign(client, scope);
      const providerProfileId = await dependencies.embeddings.resolve(client, {
        ownerUserId: scope.ownerUserId,
        campaignId: scope.campaignId,
        selectedProviderProfileId: null
      });
      if (!providerProfileId) return loadConfig(client, scope);
      const provider = await client.query<{ default_model: string }>(
        `SELECT default_model FROM provider_profiles
          WHERE id = $1 AND owner_user_id = $2 AND enabled = true
            AND provider_role IN ('embedding','text')`,
        [providerProfileId, scope.ownerUserId]
      );
      const model = provider.rows[0]?.default_model?.trim() || DEFAULT_EMBEDDING_MODEL;
      const saved = await client.query<EmbeddingConfigRow>(
        `INSERT INTO campaign_memory_configs (
           campaign_id, owner_user_id, embedding_enabled, embedding_provider_profile_id, embedding_model,
           embedding_batch_size, embedding_document_prefix, embedding_query_prefix
         ) VALUES ($1,$2,true,$3,$4,16,null,null)
         ON CONFLICT (campaign_id) DO UPDATE SET
           embedding_enabled = EXCLUDED.embedding_enabled,
           embedding_provider_profile_id = EXCLUDED.embedding_provider_profile_id,
           embedding_model = EXCLUDED.embedding_model,
           embedding_batch_size = EXCLUDED.embedding_batch_size,
           embedding_document_prefix = EXCLUDED.embedding_document_prefix,
           embedding_query_prefix = EXCLUDED.embedding_query_prefix,
           updated_at = now()
         RETURNING embedding_enabled, embedding_provider_profile_id, embedding_model, embedding_batch_size,
                   embedding_document_prefix, embedding_query_prefix, retrieval_implementation,
                   retrieval_shadow_enabled`,
        [scope.campaignId, scope.ownerUserId, providerProfileId, model]
      );
      await client.query(
        `INSERT INTO chronicle_jobs (owner_user_id, campaign_id, job_type)
         VALUES ($1,$2,'embed_campaign')
         ON CONFLICT (campaign_id, job_type) WHERE status IN ('queued', 'running')
         DO UPDATE SET work_version = chronicle_jobs.work_version + 1, updated_at = now()`,
        [scope.ownerUserId, scope.campaignId]
      );
      return configView(saved.rows[0]);
    },
    async enqueueEmbeddingReindex(database, scope) {
      const client = transactionClient(database);
      const config = await loadConfig(client, scope);
      if (!config.enabled) return null;
      const providerProfileId = await dependencies.embeddings.resolve(client, {
        ownerUserId: scope.ownerUserId,
        campaignId: scope.campaignId,
        selectedProviderProfileId: config.providerProfileId ?? null
      });
      if (!embeddingEligibility({
        enabled: config.enabled,
        providerProfileId,
        model: config.model ?? null
      }).eligible) return null;
      const result = await client.query<{ id: string }>(
        `INSERT INTO chronicle_jobs (owner_user_id, campaign_id, job_type)
         VALUES ($1,$2,'embed_campaign')
         ON CONFLICT (campaign_id, job_type) WHERE status IN ('queued', 'running')
         DO UPDATE SET work_version = chronicle_jobs.work_version + 1, updated_at = now()
         RETURNING id`,
        [scope.ownerUserId, scope.campaignId]
      );
      return result.rows[0]?.id ?? null;
    },
    async enqueueChunkIndex(database, scope) {
      return enqueuePostgresChronicleChunkIndex(transactionClient(database), scope);
    },
    async writeAcceptedTurnFiction(database, scope) {
      const client = transactionClient(database);
      await writeAcceptedFiction(client, scope);
      await enqueuePostgresChronicleChunkIndex(client, scope);
    },
    async storeDerivedTurnMemories(database, scope) {
      await storeDerivedMemories(transactionClient(database), scope);
    },
    async rebuildCampaignMemories(database, scope) {
      const client = transactionClient(database);
      const rebuilt = await rebuildMemories(client, scope);
      await enqueuePostgresChronicleChunkIndex(client, scope);
      return rebuilt;
    },
    async buildContextPreview(database, scope) {
      return buildContext(transactionClient(database), scope, dependencies);
    }
  } as MemoryGenerationTransactionPort;
}

async function requireCampaign(
  pool: DatabasePool | DatabaseClient,
  scope: CampaignWorldVersionMemoryScope | CampaignMemoryScope,
): Promise<string> {
  const result = await pool.query<{ world_version_id: string }>(
    "SELECT world_version_id FROM campaigns WHERE id = $1 AND owner_user_id = $2",
    [scope.campaignId, scope.ownerUserId]
  );
  const worldVersionId = result.rows[0]?.world_version_id;
  if (!worldVersionId || ("worldVersionId" in scope && worldVersionId !== scope.worldVersionId)) {
    throw notFound("Campaign");
  }
  return worldVersionId;
}

async function loadConfig(pool: DatabasePool | DatabaseClient, scope: CampaignMemoryScope): Promise<EmbeddingConfigView> {
  await requireCampaign(pool, scope);
  const result = await pool.query<EmbeddingConfigRow>(
    `SELECT embedding_enabled, embedding_provider_profile_id, embedding_model, embedding_batch_size,
            embedding_document_prefix, embedding_query_prefix, retrieval_implementation,
            retrieval_shadow_enabled
       FROM campaign_memory_configs WHERE campaign_id = $1 AND owner_user_id = $2`,
    [scope.campaignId, scope.ownerUserId]
  );
  return configView(result.rows[0]);
}

type EnabledProviderCandidate = Readonly<{
  id: string;
  is_default: boolean;
}>;

function preferredProviderId(candidates: readonly EnabledProviderCandidate[]): string | null {
  if (candidates.length === 1 || candidates[0]?.is_default) return candidates[0]?.id ?? null;
  return null;
}

async function resolvePermittedEmbeddingProviderId(
  database: DatabasePool | DatabaseClient,
  scope: CampaignMemoryScope,
  selectedProviderProfileId: string | null,
): Promise<string | null> {
  const dedicated = await database.query<EnabledProviderCandidate>(
    `SELECT id, is_default FROM provider_profiles
      WHERE owner_user_id = $1 AND provider_role = 'embedding' AND enabled = true
      ORDER BY is_default DESC, name, id`,
    [scope.ownerUserId]
  );
  if (selectedProviderProfileId) {
    const selected = await database.query<{ provider_role: string }>(
      `SELECT provider_role FROM provider_profiles
        WHERE id = $1 AND owner_user_id = $2 AND enabled = true`,
      [selectedProviderProfileId, scope.ownerUserId]
    );
    const role = selected.rows[0]?.provider_role;
    if (role !== "embedding" && role !== "text") {
      throw invalid("Select an enabled embedding provider. Text fallback is available only when no embedding provider is enabled.");
    }
    if (role === "text" && dedicated.rows.length) {
      throw invalid("Select an enabled embedding provider. Text fallback is available only when no embedding provider is enabled.");
    }
    return selectedProviderProfileId;
  }
  if (dedicated.rows.length) return preferredProviderId(dedicated.rows);

  const campaign = await database.query<{ text_provider_profile_id: string | null }>(
    `SELECT text_provider_profile_id FROM campaigns
      WHERE id = $1 AND owner_user_id = $2`,
    [scope.campaignId, scope.ownerUserId]
  );
  const campaignTextProviderId = campaign.rows[0]?.text_provider_profile_id;
  if (campaignTextProviderId) {
    const selectedText = await database.query<{ id: string }>(
      `SELECT id FROM provider_profiles
        WHERE id = $1 AND owner_user_id = $2 AND provider_role = 'text' AND enabled = true`,
      [campaignTextProviderId, scope.ownerUserId]
    );
    if (selectedText.rows[0]) return selectedText.rows[0].id;
  }
  const text = await database.query<EnabledProviderCandidate>(
    `SELECT id, is_default FROM provider_profiles
      WHERE owner_user_id = $1 AND provider_role = 'text' AND enabled = true
      ORDER BY is_default DESC, name, id`,
    [scope.ownerUserId]
  );
  return preferredProviderId(text.rows);
}

export function createPostgresChronicleConfigurationRepository(pool: DatabasePool): MemoryConfigurationRepository {
  return {
    getEmbeddingConfig: (scope) => loadConfig(pool, scope),
    async setEmbeddingConfig(scope, input: CampaignEmbeddingConfig) {
      return withTransaction(pool, async (client) => {
        const worldVersionId = await requireCampaign(client, scope);
        const previous = await loadConfig(client, scope);
        const providerProfileId = await resolvePermittedEmbeddingProviderId(
          client,
          scope,
          input.providerProfileId
        );
        if (input.enabled && !providerProfileId) {
          throw invalid("Add a text or embedding provider before enabling semantic memory.");
        }
        const result = await client.query<EmbeddingConfigRow>(
          `INSERT INTO campaign_memory_configs (
             campaign_id, owner_user_id, embedding_enabled, embedding_provider_profile_id, embedding_model,
             embedding_batch_size, embedding_document_prefix, embedding_query_prefix,
             retrieval_implementation, retrieval_shadow_enabled
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (campaign_id) DO UPDATE SET
             embedding_enabled = EXCLUDED.embedding_enabled,
             embedding_provider_profile_id = EXCLUDED.embedding_provider_profile_id,
             embedding_model = EXCLUDED.embedding_model,
             embedding_batch_size = EXCLUDED.embedding_batch_size,
             embedding_document_prefix = EXCLUDED.embedding_document_prefix,
             embedding_query_prefix = EXCLUDED.embedding_query_prefix,
             retrieval_implementation = EXCLUDED.retrieval_implementation,
             retrieval_shadow_enabled = EXCLUDED.retrieval_shadow_enabled,
             updated_at = now()
           RETURNING embedding_enabled, embedding_provider_profile_id, embedding_model, embedding_batch_size,
                     embedding_document_prefix, embedding_query_prefix, retrieval_implementation,
                     retrieval_shadow_enabled`,
          [scope.campaignId, scope.ownerUserId, input.enabled, providerProfileId, input.model,
            input.batchSize, input.documentPrefix ?? null, input.queryPrefix ?? null,
            input.retrievalImplementation ?? "legacy_hybrid", input.retrievalShadowEnabled ?? false]
        );
        const saved = configView(result.rows[0]);
        const capabilityChanged = previous.providerProfileId !== saved.providerProfileId
          || previous.model !== saved.model
          || previous.documentPrefix !== saved.documentPrefix
          || previous.queryPrefix !== saved.queryPrefix;
        if (capabilityChanged) {
          await client.query(
            `UPDATE chronicle_memory_chunks SET embedding=NULL,embedding_status='pending',
               embedding_skip_reason=NULL,embedding_provider_profile_id=NULL,embedding_model=NULL,
               embedding_dimensions=NULL,embedding_protocol_version=NULL,
               embedding_provider_fingerprint=NULL,embedding_content_hash=NULL,
               embedding_updated_at=NULL,updated_at=clock_timestamp()
             WHERE owner_user_id=$1 AND campaign_id=$2`,
            [scope.ownerUserId, scope.campaignId]
          );
        }
        await enqueuePostgresChronicleChunkIndex(client, { ...scope, worldVersionId });
        return saved;
      });
    }
  };
}

function publicJob(row: ChronicleJobRow): ChronicleJobView {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    jobType: row.job_type,
    status: row.status,
    attempts: row.attempts,
    progress: row.progress,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: iso(row.completed_at),
    ...(row.status === "failed" ? { failure: { code: "memory_unavailable", message: "Chronicle memory is unavailable." } } : {})
  };
}

export function createPostgresChronicleJobRepository(pool: DatabasePool): ChronicleJobRepository {
  const enqueue = async (
    scope: CampaignWorldVersionMemoryScope,
    jobType: "reindex_campaign" | "embed_campaign",
  ) => {
    await requireCampaign(pool, scope);
    const result = await pool.query<{ id: string }>(
      `INSERT INTO chronicle_jobs (owner_user_id, campaign_id, job_type, status)
       VALUES ($1,$2,$3,'queued')
       ON CONFLICT (campaign_id, job_type) WHERE status IN ('queued', 'running')
       DO UPDATE SET work_version = chronicle_jobs.work_version + 1, updated_at = now()
       RETURNING id`,
      [scope.ownerUserId, scope.campaignId, jobType]
    );
    return { jobId: result.rows[0]!.id, status: "queued" as const };
  };

  return {
    enqueueChronicleReindex: (scope) => enqueue(scope, "reindex_campaign"),
    async enqueueEmbeddingReindex(scope) {
      const config = await loadConfig(pool, scope);
      if (!config.enabled || !config.model) return null;
      const providerProfileId = await resolvePermittedEmbeddingProviderId(
        pool,
        scope,
        config.providerProfileId ?? null
      );
      if (!providerProfileId) return null;
      if (providerProfileId !== config.providerProfileId) {
        await pool.query(
          `UPDATE campaign_memory_configs
              SET embedding_provider_profile_id = $3, updated_at = now()
            WHERE campaign_id = $1 AND owner_user_id = $2`,
          [scope.campaignId, scope.ownerUserId, providerProfileId]
        );
      }
      return enqueue(scope, "embed_campaign");
    },
    async getJob(scope) {
      const result = await pool.query<ChronicleJobRow>(
        `SELECT j.id, j.owner_user_id, j.campaign_id, c.world_version_id, j.job_type, j.status, j.attempts,
                j.work_version, j.progress, j.created_at, j.updated_at, j.completed_at
           FROM chronicle_jobs j JOIN campaigns c ON c.id = j.campaign_id AND c.owner_user_id = j.owner_user_id
          WHERE j.id = $1 AND j.owner_user_id = $2`,
        [scope.jobId, scope.ownerUserId]
      );
      const row = result.rows[0];
      if (!row) throw notFound("Chronicle job");
      return publicJob(row);
    }
  };
}

type MetricsEmbeddingConfigRow = EmbeddingConfigRow & Readonly<{ updated_at: Date }>;
type MetricsProviderRow = Readonly<{
  id: string;
  name: string;
  enabled: boolean;
  health_status: "unknown" | "healthy" | "degraded" | "unavailable";
}>;
type MetricsJobRow = Readonly<{
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  progress: ChronicleMetricsView["semanticHealth"]["progress"];
  completed_at: Date | null;
}>;

async function semanticHealth(
  pool: DatabasePool,
  scope: CampaignWorldVersionMemoryScope,
  metrics: Omit<ChronicleMetricsView, "semanticHealth">,
): Promise<ChronicleMetricsView["semanticHealth"]> {
  const configResult = await pool.query<MetricsEmbeddingConfigRow>(
    `SELECT embedding_enabled, embedding_provider_profile_id, embedding_model, embedding_batch_size,
            embedding_document_prefix, embedding_query_prefix, retrieval_implementation,
            retrieval_shadow_enabled, updated_at
       FROM campaign_memory_configs
      WHERE campaign_id = $1 AND owner_user_id = $2`,
    [scope.campaignId, scope.ownerUserId]
  );
  const config = configResult.rows[0];
  const disabled: ChronicleMetricsView["semanticHealth"] = {
    status: "disabled",
    message: "Semantic memory is disabled. Chronicle is using lexical, entity, chronology, and recency retrieval.",
    enabled: false,
    providerProfileId: null,
    providerName: "",
    providerHealth: "unknown",
    model: config?.embedding_model ?? "",
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

  const [providerResult, embeddedResult, jobResult] = await Promise.all([
    config.embedding_provider_profile_id
      ? pool.query<MetricsProviderRow>(
        `SELECT id, name, enabled, health_status
           FROM provider_profiles
          WHERE id = $1 AND owner_user_id = $2 AND provider_role IN ('embedding','text')`,
        [config.embedding_provider_profile_id, scope.ownerUserId]
      )
      : Promise.resolve({ rows: [] as MetricsProviderRow[] }),
    config.embedding_provider_profile_id
      ? pool.query<Readonly<{ content: string; embedding_content_hash: string | null }>>(
        `SELECT content, embedding_content_hash
           FROM chronicle_memories
          WHERE owner_user_id = $1 AND campaign_id = $2 AND world_version_id = $3
            AND embedding IS NOT NULL AND embedding_provider_profile_id = $4 AND embedding_model = $5
            AND embedding_provider_fingerprint IS NOT NULL`,
        [scope.ownerUserId, scope.campaignId, scope.worldVersionId,
          config.embedding_provider_profile_id, config.embedding_model]
      )
      : Promise.resolve({ rows: [] as Readonly<{ content: string; embedding_content_hash: string | null }>[] }),
    pool.query<MetricsJobRow>(
      `SELECT id, status, progress, completed_at
         FROM chronicle_jobs
        WHERE owner_user_id = $1 AND campaign_id = $2 AND job_type = 'embed_campaign'
        ORDER BY created_at DESC, updated_at DESC, id DESC LIMIT 1`,
      [scope.ownerUserId, scope.campaignId]
    )
  ]);
  const provider = providerResult.rows[0];
  const indexedMemories = embeddedResult.rows.filter((row) => (
    row.embedding_content_hash === chronicleContentHash(row.content)
  )).length;
  const coveragePercent = metrics.memoryCount
    ? Math.min(100, Math.round(indexedMemories / metrics.memoryCount * 100))
    : 100;
  const job = jobResult.rows[0];
  const base = {
    enabled: true,
    providerProfileId: config.embedding_provider_profile_id,
    providerName: provider?.name ?? "",
    providerHealth: provider?.health_status ?? ("unavailable" as const),
    model: config.embedding_model,
    indexedMemories,
    totalMemories: metrics.memoryCount,
    coveragePercent,
    jobId: job?.id ?? null,
    jobStatus: job?.status ?? null,
    progress: job?.progress ?? {},
    errorMessage: "",
    lastCompletedAt: iso(job?.completed_at ?? null)
  };
  if (job?.status === "queued" || job?.status === "running") {
    const completed = Number(job.progress?.embedded ?? 0);
    const total = Number(job.progress?.total ?? metrics.memoryCount);
    return {
      ...base,
      status: "indexing",
      message: job.status === "queued"
        ? "Semantic indexing is queued and waiting for a Chronicle worker."
        : `Semantic indexing is running${total ? `: ${completed} of ${total} memories processed` : ""}.`
    };
  }
  if (job?.status === "failed") {
    return { ...base, status: "failed", message: MEMORY_PUBLIC_FAILURE_MESSAGE, errorMessage: MEMORY_PUBLIC_FAILURE_MESSAGE };
  }
  if (!provider || !provider.enabled || provider.health_status === "unavailable") {
    return {
      ...base,
      status: "unavailable",
      message: "The configured embedding provider is disabled or unavailable. Lexical Chronicle retrieval remains active."
    };
  }
  const configIsFresh = Boolean(job?.completed_at && job.completed_at.getTime() >= config.updated_at.getTime());
  if (!configIsFresh || coveragePercent < 100 || provider.health_status === "degraded") {
    const reason = !configIsFresh
      ? "The current semantic configuration has not completed indexing."
      : provider.health_status === "degraded"
        ? "The embedding provider is reporting degraded health."
        : `${indexedMemories} of ${metrics.memoryCount} Chronicle memories are indexed.`;
    return {
      ...base,
      status: "degraded",
      message: `${reason} Lexical retrieval remains available while semantic coverage recovers.`
    };
  }
  return {
    ...base,
    status: "healthy",
    message: metrics.memoryCount
      ? `All ${metrics.memoryCount} Chronicle memories are indexed with ${config.embedding_model}.`
      : `Semantic memory is ready with ${config.embedding_model}; memories will be indexed as turns are accepted.`
  };
}

export function createPostgresChronicleQueryRepository(
  pool: DatabasePool,
  transactionDependencies: ChronicleGenerationTransactionDependencies,
): MemoryQueryRepository {
  return {
    async getMetrics(scope): Promise<MemoryPublicResult<ChronicleMetricsView>> {
      await requireCampaign(pool, scope);
      const metrics = await loadContextMetrics(pool, {
        ...scope,
        request: {
          query: "",
          recentTurns: 1,
          compression: "summary",
          budgetTokens: 1
        }
      });
      return { ...metrics, semanticHealth: await semanticHealth(pool, scope, metrics) };
    },
    async previewContext(scope, request) {
      return withTransaction(pool, (client) => buildContext(client, { ...scope, request }, transactionDependencies));
    }
  };
}

function claimed(row: ChronicleJobRow, workerId: string, leaseSeconds: number): ChronicleLeaseScope {
  return {
    jobId: row.id,
    ownerUserId: row.owner_user_id,
    campaignId: row.campaign_id,
    worldVersionId: row.world_version_id,
    jobType: row.job_type,
    workVersion: Number(row.work_version),
    workerId,
    leaseSeconds
  };
}

export function createPostgresChronicleWorkerStatePort(pool: DatabasePool): ChronicleWorkerStatePort {
  return {
    async claimNext(request) {
      return withTransaction(pool, async (client) => {
        const result = await client.query<ChronicleJobRow>(
          `WITH candidate AS (
             SELECT j.id
               FROM chronicle_jobs j
               JOIN campaigns claim_campaign
                 ON claim_campaign.id = j.campaign_id
                AND claim_campaign.owner_user_id = j.owner_user_id
              WHERE (j.status = 'queued' OR (j.status = 'running' AND j.lease_expires_at < now()))
                AND NOT EXISTS (
                  SELECT 1 FROM chronicle_jobs active
                   WHERE active.campaign_id = j.campaign_id AND active.status = 'running'
                     AND active.lease_expires_at >= now() AND active.id <> j.id
                )
              ORDER BY j.created_at, j.id
              FOR UPDATE OF j, claim_campaign SKIP LOCKED
              LIMIT 1
           )
           UPDATE chronicle_jobs j
              SET status = 'running', attempts = attempts + 1, lease_owner = $1,
                  lease_expires_at = now() + ($2::text || ' seconds')::interval,
                  progress = '{}'::jsonb, updated_at = now()
             FROM candidate c
            WHERE j.id = c.id
           RETURNING j.id, j.owner_user_id, j.campaign_id,
                     (SELECT campaign.world_version_id FROM campaigns campaign
                       WHERE campaign.id = j.campaign_id AND campaign.owner_user_id = j.owner_user_id) AS world_version_id,
                     j.job_type, j.status,
                     j.attempts, j.work_version, j.progress, j.created_at, j.updated_at, j.completed_at`,
          [request.workerId, request.leaseSeconds]
        );
        const row = result.rows[0];
        return row ? claimed(row, request.workerId, request.leaseSeconds) : null;
      });
    },
    async loadClaimedJob(scope) {
      const result = await pool.query<ChronicleJobRow>(
        `SELECT j.id, j.owner_user_id, j.campaign_id, c.world_version_id, j.job_type, j.status, j.attempts,
                j.work_version, j.progress, j.created_at, j.updated_at, j.completed_at
           FROM chronicle_jobs j JOIN campaigns c ON c.id = j.campaign_id AND c.owner_user_id = j.owner_user_id
          WHERE j.id = $1 AND j.owner_user_id = $2 AND j.campaign_id = $3 AND c.world_version_id = $4
            AND j.lease_owner = $5 AND j.status = 'running' AND j.work_version = $6
            AND j.lease_expires_at >= now()`,
        [scope.jobId, scope.ownerUserId, scope.campaignId, scope.worldVersionId, scope.workerId, scope.workVersion]
      );
      const row = result.rows[0];
      return row ? claimed(row, scope.workerId, scope.leaseSeconds) : null;
    },
    async heartbeatClaim(scope) {
      const result = await pool.query(
        `UPDATE chronicle_jobs SET lease_expires_at = now() + ($7::text || ' seconds')::interval, updated_at = now()
          WHERE id = $1 AND owner_user_id = $2 AND campaign_id = $3 AND lease_owner = $4
            AND status = 'running' AND work_version = $5
            AND lease_expires_at >= now()
            AND EXISTS (SELECT 1 FROM campaigns WHERE id = $3 AND owner_user_id = $2 AND world_version_id = $6)`,
        [scope.jobId, scope.ownerUserId, scope.campaignId, scope.workerId, scope.workVersion, scope.worldVersionId, scope.leaseSeconds]
      );
      return result.rowCount === 1;
    },
    async completeClaim(scope, completion) {
      const result = await pool.query<{ status: "queued" | "completed" }>(
        `UPDATE chronicle_jobs SET
             status = CASE WHEN work_version > $5 THEN 'queued' ELSE 'completed' END,
             completed_at = CASE WHEN work_version > $5 THEN NULL ELSE now() END,
             progress = $6::jsonb, updated_at = now(), lease_owner = NULL, lease_expires_at = NULL, error_message = NULL
          WHERE id = $1 AND owner_user_id = $2 AND campaign_id = $3 AND lease_owner = $4
            AND status = 'running' AND work_version >= $5
            AND lease_expires_at >= now()
            AND EXISTS (SELECT 1 FROM campaigns WHERE id = $3 AND owner_user_id = $2 AND world_version_id = $7)
          RETURNING status`,
        [scope.jobId, scope.ownerUserId, scope.campaignId, scope.workerId, scope.workVersion,
          JSON.stringify(completion.progress), scope.worldVersionId]
      );
      return result.rowCount === 1;
    },
    async failClaim(scope, failure) {
      const result = await pool.query(
        `UPDATE chronicle_jobs SET status = 'failed', error_message = $6, updated_at = now(),
             lease_owner = NULL, lease_expires_at = NULL
          WHERE id = $1 AND owner_user_id = $2 AND campaign_id = $3 AND lease_owner = $4
            AND status = 'running' AND work_version = $5
            AND lease_expires_at >= now()
            AND EXISTS (SELECT 1 FROM campaigns WHERE id = $3 AND owner_user_id = $2 AND world_version_id = $7)`,
        [scope.jobId, scope.ownerUserId, scope.campaignId, scope.workerId, scope.workVersion,
          failure.diagnosticCode.slice(0, 128), scope.worldVersionId]
      );
      return result.rowCount === 1;
    },
    async requeueClaim(scope, retry) {
      const result = await pool.query(
        `UPDATE chronicle_jobs SET status = 'queued', completed_at = NULL, lease_owner = NULL, lease_expires_at = NULL,
             progress = progress || jsonb_build_object('retryReason', $6::text), updated_at = now()
          WHERE id = $1 AND owner_user_id = $2 AND campaign_id = $3 AND lease_owner = $4
            AND status = 'running' AND work_version = $5
            AND lease_expires_at >= now()
            AND EXISTS (SELECT 1 FROM campaigns WHERE id = $3 AND owner_user_id = $2 AND world_version_id = $7)`,
        [scope.jobId, scope.ownerUserId, scope.campaignId, scope.workerId, scope.workVersion, retry.reason, scope.worldVersionId]
      );
      return result.rowCount === 1;
    }
  };
}

type ChronicleEmbeddingBatchJobRow = Readonly<{
  progress: Record<string, unknown>;
}>;

type ChronicleEmbeddingBatchMemoryRow = Readonly<{
  id: string;
  content: string;
}>;

type ChronicleEmbeddingConfigurationRow = Readonly<{
  embedding_provider_profile_id: string;
  embedding_model: string;
  embedding_document_prefix: string | null;
  embedding_query_prefix: string | null;
}>;

function requiredProgressString(
  progress: Record<string, unknown>,
  key: string,
  expected: string,
): void {
  const existing = progress[key];
  if (existing !== undefined && existing !== expected) {
    throw invalid(`Chronicle embedding ${key} changed during the claimed job.`);
  }
}

export function createPostgresChronicleEmbeddingBatchPort(
  pool: DatabasePool,
  dependencies: ChronicleEmbeddingBatchDependencies,
): ChronicleEmbeddingBatchPort {
  return {
    async commitClaimBatch(scope, input) {
      if (scope.jobType !== "embed_campaign") throw invalid("Only embedding jobs may commit Chronicle vectors.");
      if (input.protocolVersion !== CHRONICLE_EMBEDDING_PROTOCOL_VERSION) {
        throw invalid("Chronicle embedding protocol version is incompatible.");
      }
      if (!input.providerFingerprint.trim()) throw invalid("Chronicle embedding provider fingerprint is required.");
      if (!Number.isSafeInteger(input.processed)
        || !Number.isSafeInteger(input.total)
        || input.processed < 1
        || input.total < input.processed
        || input.memories.length < 1
        || input.memories.length > 128
        || input.result.embeddings.length !== input.memories.length) {
        throw invalid("Chronicle embedding batch progress is invalid.");
      }
      const dimensions = input.result.embeddings[0]?.length ?? 0;
      if (!dimensions || input.result.embeddings.some((vector) => (
        vector.length !== dimensions || vector.some((coordinate) => !Number.isFinite(coordinate))
      ))) {
        throw invalid("Chronicle embedding batch dimensions are invalid.");
      }

      return withTransaction(pool, async (client) => {
        const active = await client.query<ChronicleEmbeddingBatchJobRow>(
          `SELECT j.progress
             FROM chronicle_jobs j
             JOIN campaigns c ON c.id = j.campaign_id AND c.owner_user_id = j.owner_user_id
            WHERE j.id = $1 AND j.owner_user_id = $2 AND j.campaign_id = $3
              AND c.world_version_id = $4 AND j.lease_owner = $5
              AND j.status = 'running' AND j.work_version = $6
              AND j.lease_expires_at >= clock_timestamp()
            FOR UPDATE OF j`,
          [scope.jobId, scope.ownerUserId, scope.campaignId, scope.worldVersionId,
            scope.workerId, scope.workVersion]
        );
        const job = active.rows[0];
        if (!job) return false;

        const configuration = await client.query<ChronicleEmbeddingConfigurationRow>(
          `SELECT memory_config.embedding_provider_profile_id, memory_config.embedding_model,
                  memory_config.embedding_document_prefix, memory_config.embedding_query_prefix
             FROM campaign_memory_configs memory_config
            WHERE memory_config.campaign_id = $1 AND memory_config.owner_user_id = $2
              AND memory_config.embedding_enabled = true
            FOR SHARE OF memory_config`,
          [scope.campaignId, scope.ownerUserId]
        );
        const selected = configuration.rows[0];
        if (!selected) throw invalid("Chronicle embedding configuration is unavailable for this campaign.");
        if (input.provider.id !== selected.embedding_provider_profile_id
          || input.provider.model !== selected.embedding_model) {
          throw invalid("Chronicle embedding provider or model changed during the claimed job.");
        }
        const prefixes = modelAwareEmbeddingPrefixes(
          selected.embedding_model,
          selected.embedding_document_prefix,
          selected.embedding_query_prefix
        );
        const inputFingerprint = providerModelFingerprint({
          ...input.provider,
          baseUrl: input.provider.id,
          protocolVersion: CHRONICLE_EMBEDDING_PROTOCOL_VERSION
        }, prefixes);
        if (input.providerFingerprint !== inputFingerprint) {
          throw invalid("Chronicle embedding provider fingerprint changed during the claimed job.");
        }

        requiredProgressString(job.progress, "embeddingProviderProfileId", input.provider.id);
        requiredProgressString(job.progress, "embeddingModel", input.provider.model);
        requiredProgressString(job.progress, "embeddingProviderFingerprint", inputFingerprint);
        requiredProgressString(job.progress, "embeddingProtocolVersion", input.protocolVersion);
        const previousDimensions = job.progress.embeddingDimensions;
        if (previousDimensions !== undefined && previousDimensions !== dimensions) {
          throw invalid("Chronicle embedding dimensions changed during the claimed job.");
        }
        const previousProcessed = job.progress.embedded === undefined ? 0 : job.progress.embedded;
        if (!Number.isSafeInteger(previousProcessed)
          || previousProcessed !== input.processed - input.memories.length) {
          throw invalid("Chronicle embedding batch progress is stale.");
        }
        const previousTotal = job.progress.total;
        if (previousTotal !== undefined && previousTotal !== input.total) {
          throw invalid("Chronicle embedding batch total changed during the claimed job.");
        }

        const ids = input.memories.map((memory) => memory.id);
        if (new Set(ids).size !== ids.length) throw invalid("Chronicle embedding batch contains duplicate memories.");
        const stored = await client.query<ChronicleEmbeddingBatchMemoryRow>(
          `SELECT id, content FROM chronicle_memories
            WHERE owner_user_id = $1 AND campaign_id = $2 AND world_version_id = $3
              AND id = ANY($4::uuid[])
            ORDER BY id
            FOR UPDATE`,
          [scope.ownerUserId, scope.campaignId, scope.worldVersionId, ids]
        );
        const storedById = new Map(stored.rows.map((memory) => [memory.id, memory]));
        for (const memory of input.memories) {
          const current = storedById.get(memory.id);
          if (!current
            || current.content !== memory.content
            || chronicleContentHash(current.content) !== memory.contentHash) {
            throw invalid("Chronicle embedding memory content changed before batch commit.");
          }
        }

        const vectors = input.result.embeddings.map(vectorLiteral);
        const hashes = input.memories.map((memory) => memory.contentHash);
        const contents = input.memories.map((memory) => memory.content);
        const updated = await client.query(
          `UPDATE chronicle_memories AS memory
              SET embedding = batch.embedding::vector,
                  embedding_provider_profile_id = $2,
                  embedding_model = $3,
                  embedding_dimensions = $4,
                  embedding_content_hash = batch.content_hash,
                  embedding_updated_at = clock_timestamp(),
                  embedding_provider_fingerprint = $5,
                  updated_at = clock_timestamp()
             FROM (SELECT unnest($1::uuid[]) AS id,
                          unnest($6::text[]) AS embedding,
                          unnest($7::text[]) AS content_hash,
                          unnest($8::text[]) AS content) AS batch
            WHERE memory.id = batch.id
              AND memory.owner_user_id = $9
              AND memory.campaign_id = $10
              AND memory.world_version_id = $11
              AND memory.content = batch.content`,
          [ids, input.provider.id, input.provider.model, dimensions, inputFingerprint,
            vectors, hashes, contents, scope.ownerUserId, scope.campaignId, scope.worldVersionId]
        );
        if (updated.rowCount !== input.memories.length) {
          throw invalid("Chronicle embedding batch did not update its complete claimed scope.");
        }

        await dependencies.recordCost(client, input.provider, {
          ownerUserId: scope.ownerUserId,
          campaignId: scope.campaignId,
          chronicleJobId: scope.jobId,
          operation: "memory_embedding"
        }, input.result);
        const progress = {
          embedded: input.processed,
          total: input.total,
          embeddingDimensions: dimensions,
          embeddingProviderProfileId: input.provider.id,
          embeddingModel: input.provider.model,
          embeddingProviderFingerprint: inputFingerprint,
          embeddingProtocolVersion: input.protocolVersion
        };
        const heartbeat = await client.query(
          `UPDATE chronicle_jobs
              SET progress = $7::jsonb,
                  lease_expires_at = clock_timestamp() + ($8::text || ' seconds')::interval,
                  updated_at = clock_timestamp()
            WHERE id = $1 AND owner_user_id = $2 AND campaign_id = $3
              AND lease_owner = $4 AND status = 'running' AND work_version = $5
              AND lease_expires_at >= clock_timestamp()
              AND EXISTS (
                SELECT 1 FROM campaigns
                 WHERE id = $3 AND owner_user_id = $2 AND world_version_id = $6
              )`,
          [scope.jobId, scope.ownerUserId, scope.campaignId, scope.workerId, scope.workVersion,
            scope.worldVersionId, JSON.stringify(progress), scope.leaseSeconds]
        );
        if (heartbeat.rowCount !== 1) {
          throw new Error("Chronicle embedding lease was lost before the batch could be committed.");
        }
        return true;
      });
    }
  };
}

type ChronicleMemoryRow = Readonly<{
  id: string;
  ordinal: number;
  content: string;
  token_estimate: number;
  memory_kind: string;
}>;

function parseCursor(cursor: string | null | undefined): { ordinal: number; id: string } | null {
  if (!cursor) return null;
  const [ordinalText, id] = cursor.split(":", 2);
  const ordinal = Number(ordinalText);
  if (!Number.isSafeInteger(ordinal)
    || !id
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw invalid("Invalid Chronicle memory cursor.");
  }
  return { ordinal, id };
}

export function createPostgresChronicleWorkerRetrievalPort(pool: DatabasePool): ChronicleWorkerRetrievalPort {
  return {
    async loadForClaim(scope, request) {
      if (!Number.isInteger(request.batchLimit) || request.batchLimit < 1 || request.batchLimit > 128) {
        throw invalid("Chronicle retrieval batchLimit must be between 1 and 128.");
      }
      const active = await createPostgresChronicleWorkerStatePort(pool).loadClaimedJob(scope);
      if (!active) throw notFound("Chronicle job lease");
      const cursor = parseCursor(request.cursor);
      const result = await pool.query<ChronicleMemoryRow>(
        `SELECT id, ordinal, content, token_estimate, memory_kind
           FROM chronicle_memories
          WHERE owner_user_id = $1 AND campaign_id = $2 AND world_version_id = $3
            AND ($4::integer IS NULL OR ordinal > $4 OR (ordinal = $4 AND id > $5::uuid))
          ORDER BY ordinal, id
          LIMIT $6`,
        [scope.ownerUserId, scope.campaignId, scope.worldVersionId, cursor?.ordinal ?? null, cursor?.id ?? null, request.batchLimit + 1]
      );
      const rows = result.rows.slice(0, request.batchLimit);
      const tail = rows.at(-1);
      const total = await pool.query<{ total: string }>(
        `SELECT count(*)::text AS total
           FROM chronicle_memories
          WHERE owner_user_id = $1 AND campaign_id = $2 AND world_version_id = $3`,
        [scope.ownerUserId, scope.campaignId, scope.worldVersionId]
      );
      return {
        config: await loadConfig(pool, scope),
        memories: rows.map((row) => ({
          id: row.id, ordinal: row.ordinal, content: row.content, tokenEstimate: row.token_estimate, kind: row.memory_kind
        })),
        totalMemories: Number(total.rows[0]?.total ?? 0),
        batchLimit: request.batchLimit,
        nextCursor: tail && result.rows.length > request.batchLimit ? `${tail.ordinal}:${tail.id}` : null
      };
    }
  };
}

export function createPostgresChronicleWorkerAdapters(pool: DatabasePool): Readonly<{
  state: ChronicleWorkerStatePort;
  retrieval: ChronicleWorkerRetrievalPort;
}> {
  return {
    state: createPostgresChronicleWorkerStatePort(pool),
    retrieval: createPostgresChronicleWorkerRetrievalPort(pool)
  };
}

export function createPostgresChronicleRepositories(
  pool: DatabasePool,
  transactionDependencies: ChronicleGenerationTransactionDependencies,
): MemoryApplicationDependencies {
  return {
    configuration: createPostgresChronicleConfigurationRepository(pool),
    queries: createPostgresChronicleQueryRepository(pool, transactionDependencies),
    jobs: createPostgresChronicleJobRepository(pool),
    transaction: createPostgresChronicleGenerationTransactionPort(transactionDependencies)
  };
}
