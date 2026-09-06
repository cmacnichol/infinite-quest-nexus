import type { CampaignStateCorrectionProjectionScope, CampaignWorldVersionMemoryScope, CorrectionMemoryChanges } from "../../application/src/memory/index.js";
import { campaignRuntimeStateContentSchema } from "../../contracts/src/generation.js";
import { buildChronicleEntityCatalog, chronicleContentHash, sanitizeChronicleFictionString, sanitizeChronicleMemoryLines } from "../../domain/src/chronicle-memory-helpers.js";
import { canonicalFactDeduplicationKey } from "../../domain/src/canonical-facts.js";
import { resolveEntityMetadata, type EntityReference } from "../../domain/src/entity-references.js";
import { estimateTokens } from "../../domain/src/text.js";
import type { DatabaseClient } from "./pool.js";

type FactRow = { id: string; source_turn_id: string | null; source_turn_number: number; content: string; entities: string[]; entity_ids: string[] };
type Projection = { kind: string; turnId: string | null; ordinal: number; content: string; importance: number; entities: string[]; entityIds: string[]; metadata: Record<string, unknown> };
export type StateCorrection = Readonly<{
  id: string;
  effectiveTurnNumber: number;
  snapshot: Readonly<{ continuitySummary: string; openThreads: readonly string[]; canonicalFacts: readonly Readonly<{ id: string | null; content: string }>[] }>;
}>;

/** Caller owns the campaign lock and transaction. No provider work occurs here. */
export async function applyPostgresStateCorrection(client: DatabaseClient, scope: CampaignStateCorrectionProjectionScope): Promise<CorrectionMemoryChanges> {
  const result = await client.query<{
    effective_turn_number: number; state_snapshot_private: unknown; changed_fields: string[];
    world_content: Record<string, unknown>; character_snapshot: Record<string, unknown> | null; character_profile: Record<string, unknown> | null;
  }>(
    `SELECT e.effective_turn_number,e.state_snapshot_private,e.changed_fields,
            wv.content AS world_content,c.character_snapshot,c.character_profile
       FROM campaign_state_edits e JOIN campaigns c ON c.id=e.campaign_id AND c.owner_user_id=e.owner_user_id
       JOIN world_versions wv ON wv.id=c.world_version_id AND wv.owner_user_id=c.owner_user_id
      WHERE e.id=$1 AND e.owner_user_id=$2 AND e.campaign_id=$3 AND c.world_version_id=$4`,
    [scope.stateEditId, scope.ownerUserId, scope.campaignId, scope.worldVersionId]
  );
  const row = result.rows[0];
  if (!row) throw new Error("Campaign state correction not found in the requested scope.");
  if (!row.changed_fields.some((field) => ["continuitySummary", "openThreads", "canonicalFacts"].includes(field))) {
    return { changedMemoryIds: [], removedMemoryIds: [] };
  }
  const snapshot = campaignRuntimeStateContentSchema.parse(row.state_snapshot_private);
  const catalog = buildChronicleEntityCatalog({ worldContent: row.world_content, characterSnapshot: row.character_snapshot, characterProfile: row.character_profile });
  return projectStateCorrection(client, scope, catalog, { id: scope.stateEditId, effectiveTurnNumber: row.effective_turn_number, snapshot }, new Set(row.changed_fields));
}

/** Also used during chronological maintenance replay, where every field is projected. */
export async function projectStateCorrection(
  client: DatabaseClient, scope: CampaignWorldVersionMemoryScope, catalog: readonly EntityReference[], edit: StateCorrection,
  changedFields: ReadonlySet<string> = new Set(["continuitySummary", "openThreads", "canonicalFacts"]),
): Promise<CorrectionMemoryChanges> {
  const changedMemoryIds: string[] = [];
  const removedMemoryIds: string[] = [];
  const scopeValues = [scope.ownerUserId, scope.campaignId, scope.worldVersionId];
  const desired: Projection[] = [];
  const kinds: string[] = [];
  if (changedFields.has("canonicalFacts")) {
    kinds.push("canonical_fact");
    const active = await client.query<FactRow>(
      `SELECT id,source_turn_id,source_turn_number,content,entities,entity_ids FROM campaign_canonical_facts
        WHERE owner_user_id=$1 AND campaign_id=$2 AND world_version_id=$3
          AND valid_from_turn <= $4 AND (valid_until_turn IS NULL OR valid_until_turn > $4)
        ORDER BY source_turn_number,source_fact_index`, [...scopeValues, edit.effectiveTurnNumber]
    );
    const byId = new Map(active.rows.map((fact) => [fact.id, fact]));
    const facts = edit.snapshot.canonicalFacts.flatMap((fact, index) => {
      const content = sanitizeChronicleFictionString(fact.content, 20_000);
      const hash = chronicleContentHash(`${scope.campaignId}:${edit.id}:${index}`);
      const id = fact.id ?? `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      return content ? [{ id, content, index }] : [];
    });
    const retained = new Set(facts.map((fact) => fact.id));
    for (const fact of active.rows) {
      if (retained.has(fact.id)) continue;
      if (fact.source_turn_number < edit.effectiveTurnNumber) {
        await client.query(`UPDATE campaign_canonical_facts SET valid_until_turn=$5,updated_at=now()
          WHERE owner_user_id=$1 AND campaign_id=$2 AND world_version_id=$3 AND id=$4`, [...scopeValues, fact.id, edit.effectiveTurnNumber]);
      } else {
        await client.query("DELETE FROM campaign_canonical_facts WHERE owner_user_id=$1 AND campaign_id=$2 AND world_version_id=$3 AND id=$4", [...scopeValues, fact.id]);
      }
    }
    for (const fact of facts) {
      const existing = byId.get(fact.id);
      if (existing?.content === fact.content) continue;
      const entities = resolveEntityMetadata(fact.content, catalog);
      // IDs for replacements of older facts are reconciled before the edit is persisted.
      if (existing) {
        if (existing.source_turn_number !== edit.effectiveTurnNumber) throw new Error("An older canonical fact cannot be rewritten.");
        await client.query(`UPDATE campaign_canonical_facts SET source_turn_id=NULL,source_state_edit_id=$5,source_fact_index=$6,
            content=$7,normalized_content=$8,entities=$9,entity_ids=$10,metadata=$11,updated_at=now()
          WHERE owner_user_id=$1 AND campaign_id=$2 AND world_version_id=$3 AND id=$4`,
        [...scopeValues, fact.id, edit.id, fact.index, fact.content, canonicalFactDeduplicationKey(fact.content), entities.entities, entities.entityIds, JSON.stringify({ stateEditId: edit.id, manualCorrection: true })]);
      } else {
        await client.query(`INSERT INTO campaign_canonical_facts (owner_user_id,campaign_id,world_version_id,id,source_state_edit_id,
          source_turn_number,source_fact_index,content,normalized_content,entities,entity_ids,valid_from_turn,metadata)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$6,$12)`,
        [...scopeValues, fact.id, edit.id, edit.effectiveTurnNumber, fact.index, fact.content, canonicalFactDeduplicationKey(fact.content), entities.entities, entities.entityIds, JSON.stringify({ stateEditId: edit.id, manualCorrection: true })]);
      }
    }
    const projected = await client.query<FactRow>(`SELECT id,source_turn_id,source_turn_number,content,entities,entity_ids FROM campaign_canonical_facts
      WHERE owner_user_id=$1 AND campaign_id=$2 AND world_version_id=$3 AND valid_until_turn IS NULL ORDER BY source_turn_number,source_fact_index`, scopeValues);
    const groups = new Map<string | null, FactRow[]>();
    for (const fact of projected.rows) {
      const group = groups.get(fact.source_turn_id) ?? [];
      group.push(fact);
      groups.set(fact.source_turn_id, group);
    }
    for (const [turnId, group] of groups) {
      const ordinal = group[0]!.source_turn_number;
      desired.push({ kind: "canonical_fact", turnId, ordinal, importance: 0.85,
        content: [`Canonical facts established or corrected at turn ${ordinal}`, ...group.map((fact) => `- [fact_id: ${fact.id}] ${fact.content}`)].join("\n"),
        entities: [...new Set(group.flatMap((fact) => fact.entities))].slice(0, 100), entityIds: [...new Set(group.flatMap((fact) => fact.entity_ids))],
        metadata: { stateEditId: edit.id, manualCorrection: true, structuredFactIds: group.map((fact) => fact.id) } });
    }
  }
  if (changedFields.has("continuitySummary")) {
    kinds.push("campaign_summary");
    const content = sanitizeChronicleFictionString(edit.snapshot.continuitySummary, 20_000);
    if (content) desired.push({ kind: "campaign_summary", turnId: null, ordinal: edit.effectiveTurnNumber, content, importance: 0.9,
      ...resolveEntityMetadata(content, catalog), metadata: { stateEditId: edit.id, manualCorrection: true } });
  }
  if (changedFields.has("openThreads")) {
    kinds.push("open_thread");
    const threads = sanitizeChronicleMemoryLines(edit.snapshot.openThreads);
    if (threads.length) {
      const content = [`Open story threads after turn ${edit.effectiveTurnNumber}`, ...threads.map((thread) => `- ${thread}`)].join("\n");
      desired.push({ kind: "open_thread", turnId: null, ordinal: edit.effectiveTurnNumber, content, importance: 0.95,
        ...resolveEntityMetadata(content, catalog), metadata: { stateEditId: edit.id, manualCorrection: true } });
    }
  }
  const existing = await client.query<{ id: string; memory_kind: string; turn_id: string | null; content: string; managed: boolean }>(
    `SELECT id,memory_kind,turn_id,content,
            (metadata->>'generatedFromAcceptedTurn' = 'true' OR metadata->>'manualCorrection' = 'true') AS managed
       FROM chronicle_memories
      WHERE owner_user_id=$1 AND campaign_id=$2 AND world_version_id=$3 AND memory_kind=ANY($4::text[])
        AND (memory_kind='canonical_fact' OR turn_id IS NULL)
      ORDER BY created_at,id`, [...scopeValues, kinds]);
  const consumed = new Set<string>();
  for (const projection of desired) {
    const parent = existing.rows.find((row) => !consumed.has(row.id) && row.memory_kind === projection.kind && row.turn_id === projection.turnId);
    if (parent) consumed.add(parent.id);
    if (parent?.content === projection.content) continue;
    const values = [...scopeValues, projection.content, estimateTokens(projection.content), projection.entities, projection.entityIds,
      JSON.stringify(projection.metadata), projection.ordinal, projection.importance];
    if (parent) {
      // Retire stale chunks in this transaction; lexical retrieval must not see their old text.
      await client.query("DELETE FROM chronicle_memory_chunks WHERE owner_user_id=$1 AND campaign_id=$2 AND world_version_id=$3 AND parent_memory_id=$4", [...scopeValues, parent.id]);
      await client.query(`UPDATE chronicle_memories SET content=$4,token_estimate=$5,entities=$6,entity_ids=$7,metadata=$8,ordinal=$9,importance=$10,
        embedding=NULL,embedding_provider_profile_id=NULL,embedding_model=NULL,embedding_dimensions=NULL,
        embedding_content_hash=NULL,embedding_updated_at=NULL,embedding_provider_fingerprint=NULL,updated_at=now()
        WHERE owner_user_id=$1 AND campaign_id=$2 AND world_version_id=$3 AND id=$11`, [...values, parent.id]);
      changedMemoryIds.push(parent.id);
    } else {
      const inserted = await client.query<{ id: string }>(`INSERT INTO chronicle_memories (owner_user_id,campaign_id,world_version_id,content,token_estimate,
        entities,entity_ids,metadata,ordinal,importance,memory_kind,turn_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [...values, projection.kind, projection.turnId]);
      changedMemoryIds.push(inserted.rows[0]!.id);
    }
  }
  for (const parent of existing.rows) {
    if (consumed.has(parent.id)) continue;
    if (parent.memory_kind === "canonical_fact" && !parent.managed) continue;
    await client.query("DELETE FROM chronicle_memories WHERE owner_user_id=$1 AND campaign_id=$2 AND world_version_id=$3 AND id=$4", [...scopeValues, parent.id]);
    removedMemoryIds.push(parent.id);
  }
  return { changedMemoryIds, removedMemoryIds };
}
