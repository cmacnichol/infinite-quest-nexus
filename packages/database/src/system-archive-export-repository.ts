import {
  archiveAssetRecordSchema,
  canonicalArchiveJson,
  sanitizePortableMetadata,
  systemArchiveOperationalOmissionsSchema,
  systemArchiveReportSchema,
  systemRecordEnvelopeSchema,
  type ArchiveAssetBinding,
  type SystemArchiveDomain,
  type SystemRecordEnvelope,
} from "../../contracts/src/index.js";
import { canonicalizeWorldContent } from "../../contracts/src/world-library.js";
import type {
  SystemArchiveExportJobPort,
  SystemArchiveOriginalAssetRecord,
  SystemArchiveSnapshot,
  SystemArchiveSnapshotPort,
} from "../../application/src/system-archives/ports.js";
import type { OwnerScope } from "../../application/src/generation/types.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";

type ExportRepositoryOptions = Readonly<{
  pageSize?: number;
  sourceApplicationVersion: string;
}>;
type EnvelopeRow = Readonly<{ sort_key: string; envelope: unknown }>;

const DEFAULT_PAGE_SIZE = 500;
const SHA_256 = /^[a-f0-9]{64}$/u;

function exportError(message: string): Error & { code: "archive-export-inconsistent" } {
  return Object.assign(new Error(message), { code: "archive-export-inconsistent" as const });
}

function pageSize(value: number | undefined): number {
  const selected = value ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 5_000) {
    throw new TypeError("System Archive export page size must be between 1 and 5000.");
  }
  return selected;
}

function safeInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw exportError(`${field} is not a safe nonnegative integer.`);
  return parsed;
}

function iso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.valueOf())) throw exportError("System Archive source timestamp is invalid.");
  return parsed.toISOString();
}

function imageExtension(mimeType: string): string {
  switch (mimeType) {
    case "image/png": return ".png";
    case "image/jpeg": return ".jpg";
    case "image/webp": return ".webp";
    case "image/gif": return ".gif";
    default: throw exportError("System Archive source asset MIME type is unsupported.");
  }
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw exportError(`${field} is not a logical object.`);
  }
  return value as Record<string, unknown>;
}

function pick(value: unknown, fields: readonly string[], name: string): Record<string, unknown> {
  const source = objectValue(value, name);
  return Object.fromEntries(fields.map((field) => [field, source[field]]));
}

function projectArray(
  value: unknown,
  fields: readonly string[],
  name: string,
): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) throw exportError(`${name} is not a logical array.`);
  return value.map((entry) => pick(entry, fields, name));
}

/** Strip storage-era passthrough fields at the explicit versioned record boundary. */
function projectWorldContent(value: unknown): Record<string, unknown> {
  const content = canonicalizeWorldContent(value);
  const world = pick(content.world, [
    "title", "genre", "tone", "premise", "backgroundStory", "firstAction", "rules",
  ], "System Archive world overview");
  const playableCharacters = content.playableCharacters.map((candidate) => {
    const character = objectValue(candidate, "System Archive playable character");
    const projected: Record<string, unknown> = {
      ...pick(character, ["id", "name", "characterText"], "System Archive playable character"),
      rpgStats: projectArray(character.rpgStats, ["id", "name", "value", "note"], "System Archive character RPG stats"),
      defaultTriggers: projectArray(
        character.defaultTriggers,
        ["id", "name", "value", "rules"],
        "System Archive character default triggers",
      ),
    };
    if (character.profile !== undefined) {
      const profile = objectValue(character.profile, "System Archive character profile");
      projected.profile = {
        identity: pick(profile.identity, ["aliases", "pronouns"], "System Archive character identity"),
        story: pick(profile.story, [
          "role", "background", "personality", "motivations", "goals", "fearsAndConflicts",
          "keyRelationships", "narrativeHooks", "voiceAndMannerisms", "otherGuidance",
        ], "System Archive character story"),
        appearance: pick(profile.appearance, [
          "ancestryOrSpecies", "apparentAge", "genderPresentation", "build", "skinOrComplexion",
          "face", "eyes", "hair", "distinguishingFeatures", "clothing",
          "equipmentAndAccessories", "otherVisualDetails",
        ], "System Archive character appearance"),
        unclassifiedNotes: profile.unclassifiedNotes,
      };
    }
    return projected;
  });
  const defaults = objectValue(content.defaults, "System Archive world defaults");
  return {
    schemaVersion: content.schemaVersion,
    world,
    playableCharacters,
    entities: projectArray(content.entities, ["id", "name", "kind", "description", "tags", "facts"], "System Archive entities")
      .map((entity) => ({
        ...entity,
        facts: projectArray(entity.facts, ["key", "value"], "System Archive entity facts"),
      })),
    relationships: projectArray(
      content.relationships,
      ["id", "fromEntityId", "toEntityId", "kind", "description"],
      "System Archive relationships",
    ),
    rpgStats: projectArray(content.rpgStats, ["id", "name", "value", "note"], "System Archive RPG stats"),
    defaultTriggers: projectArray(
      content.defaultTriggers,
      ["id", "name", "value", "rules"],
      "System Archive default triggers",
    ),
    eventTriggers: projectArray(content.eventTriggers, [
      "id", "label", "timing", "condition", "effect", "addTextAfter", "triggeredCount",
      "lastTriggeredTurn", "lastTriggeredAt",
    ], "System Archive event triggers"),
    assets: projectArray(content.assets, ["assetId", "role"], "System Archive world assets"),
    defaults: {
      selectedCharacterId: typeof defaults.selectedCharacterId === "string"
        ? defaults.selectedCharacterId
        : typeof defaults.defaultPlayableCharacterId === "string" && defaults.defaultPlayableCharacterId.trim()
          ? defaults.defaultPlayableCharacterId
          : null,
      initialLocation: typeof defaults.initialLocation === "string" ? defaults.initialLocation : "",
    },
  };
}

function portableProviderBaseUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function parseEnvelope(domain: SystemArchiveDomain, value: unknown): SystemRecordEnvelope {
  let candidate = value;
  if (domain === "providers" && typeof value === "object" && value !== null) {
    const envelope = value as Record<string, any>;
    candidate = {
      ...envelope,
      record: {
        ...envelope.record,
        baseUrl: portableProviderBaseUrl(envelope.record?.baseUrl),
      },
    };
  }
  if ((domain === "world-versions" || domain === "world-drafts")
    && typeof value === "object" && value !== null) {
    const envelope = value as Record<string, any>;
    candidate = {
      ...envelope,
      record: {
        ...envelope.record,
        content: projectWorldContent(envelope.record?.content),
      },
    };
  }
  return systemRecordEnvelopeSchema.parse(candidate);
}

const DOMAIN_SQL = {
  providers: `
    SELECT '00:' || profile.id::text AS sort_key,
           jsonb_build_object(
             'domain','providers','formatVersion',1,'sourceId',profile.id,
             'record',jsonb_build_object(
               'sourceId',profile.id,
               'kind',profile.provider_role,
               'displayName',profile.name,
               'baseUrl',CASE WHEN profile.base_url ~ '^https?://' THEN profile.base_url ELSE NULL END,
               'selectedModel',NULLIF(profile.default_model,''),
               'contextWindow',profile.context_window_tokens,
               'timeoutMs',profile.request_timeout_ms,
               'retryLimit',CASE WHEN profile.configuration->>'retryLimit' ~ '^[0-9]+$'
                                 THEN (profile.configuration->>'retryLimit')::bigint ELSE NULL END,
               'enabled',false,'health','unknown'
             )
           ) AS envelope
      FROM provider_profiles profile
     WHERE profile.owner_user_id=$1`,
  prompts: `
    SELECT '00:' || COALESCE(prompt.campaign_id::text,'') || ':' || prompt.prompt_key || ':' || prompt.id::text AS sort_key,
           jsonb_build_object(
             'domain','prompts','formatVersion',1,'sourceId',prompt.id,
             'record',jsonb_build_object(
               'sourceId',prompt.id,'campaignId',prompt.campaign_id,'templateKey',prompt.prompt_key,
               'overrideText',prompt.content,'updatedAt',prompt.updated_at
             )
           ) AS envelope
      FROM prompt_template_overrides prompt
     WHERE prompt.owner_user_id=$1`,
  worlds: `
    SELECT '00:' || world.id::text AS sort_key,
           jsonb_build_object(
             'domain','worlds','formatVersion',1,'sourceId',world.id,
             'record',jsonb_build_object(
               'sourceId',world.id,'title',world.title,'status',world.status,
               'forkedFromWorldId',world.forked_from_world_id,
               'forkedFromWorldVersionId',world.forked_from_world_version_id,
               'createdAt',world.created_at,'updatedAt',world.updated_at
             )
           ) AS envelope
      FROM worlds world
     WHERE world.owner_user_id=$1`,
  "world-versions": `
    SELECT '00:' || version.id::text AS sort_key,
           jsonb_build_object(
             'domain','world-versions','formatVersion',1,'sourceId',version.id,
             'record',jsonb_build_object(
               'sourceId',version.id,'worldId',version.world_id,
               'versionNumber',version.version_number,'title',world.title,
               'content',version.content,
               'contentFingerprint',CASE WHEN version.source_hash ~ '^[a-f0-9]{64}$'
                                         THEN version.source_hash ELSE NULL END,
               'releaseNotes',version.release_notes,
               'createdFromRevision',version.created_from_revision,
               'publishedAt',version.published_at
             )
           ) AS envelope
      FROM world_versions version
      JOIN worlds world ON world.id=version.world_id AND world.owner_user_id=version.owner_user_id
     WHERE version.owner_user_id=$1`,
  "world-drafts": `
    SELECT '00:' || draft.world_id::text AS sort_key,
           jsonb_build_object(
             'domain','world-drafts','formatVersion',1,'sourceId',draft.world_id,
             'record',jsonb_build_object(
               'sourceId',draft.world_id,'worldId',draft.world_id,
               'basedOnWorldVersionId',draft.based_on_world_version_id,
               'title',world.title,'revision',draft.revision,'content',draft.content,
               'createdAt',draft.created_at,'updatedAt',draft.updated_at
             )
           ) AS envelope
      FROM world_drafts draft
      JOIN worlds world ON world.id=draft.world_id AND world.owner_user_id=draft.owner_user_id
     WHERE draft.owner_user_id=$1`,
  campaigns: `
    SELECT '00:' || campaign.id::text AS sort_key,
           jsonb_build_object(
             'domain','campaigns','formatVersion',1,'sourceId',campaign.id,
             'record',jsonb_build_object(
               'sourceId',campaign.id,'worldVersionId',campaign.world_version_id,
               'title',campaign.title,'status',campaign.status,
               'activeTurnNumber',campaign.active_turn_number,
               'settings',jsonb_build_object(
                 'turnControlStyle',CASE campaign.turn_control_style
                   WHEN 'flexible_auto' THEN 'Auto'
                   WHEN 'flexible_scene' THEN 'Scene Direction'
                   ELSE 'Action' END
               ),
               'selectedCharacterId',campaign.selected_character_id,
               'characterSnapshot',campaign.character_snapshot,
               'characterProfile',campaign.character_profile,
               'characterProfileRevision',campaign.character_profile_revision,
               'createdAt',campaign.created_at,'updatedAt',campaign.updated_at
             )
           ) AS envelope
      FROM campaigns campaign
     WHERE campaign.owner_user_id=$1`,
  turns: `
    SELECT '00:' || turn_row.id::text AS sort_key,
           jsonb_build_object(
             'domain','turns','formatVersion',1,'sourceId',turn_row.id,
             'record',jsonb_build_object(
               'sourceId',turn_row.id,'campaignId',turn_row.campaign_id,
               'turnNumber',turn_row.turn_number,'action',turn_row.action,
               'narration',turn_row.narration,'choices',turn_row.choices,
               'imagePrompt',turn_row.image_prompt,
               'stateSnapshotPrivate',turn_row.state_snapshot_private,
               'acceptedAt',turn_row.accepted_at
             )
           ) AS envelope
      FROM turns turn_row
     WHERE turn_row.owner_user_id=$1`,
  "turn-corrections": `
    SELECT '00:' || correction.turn_id::text || ':' || lpad(correction.revision::text,10,'0')
           || ':' || correction.id::text AS sort_key,
           jsonb_build_object(
             'domain','turn-corrections','formatVersion',1,'sourceId',correction.id,
             'record',jsonb_build_object(
               'sourceId',correction.id,'turnId',correction.turn_id,
               'revision',correction.revision,'narration',correction.narration,
               'previousEffectiveNarrationHash',correction.previous_effective_narration_hash,
               'reason',correction.reason,'source',correction.source,
               'correctedAt',correction.created_at
             )
           ) AS envelope
      FROM turn_narration_corrections correction
     WHERE correction.owner_user_id=$1`,
  "campaign-state": `
    SELECT '00:' || state.campaign_id::text AS sort_key,
           jsonb_build_object(
             'domain','campaign-state','formatVersion',1,'sourceId',state.campaign_id,
             'record',jsonb_build_object(
               'sourceId',state.campaign_id,'campaignId',state.campaign_id,
               'revision',state.revision,
               'state',jsonb_build_object(
                 'continuitySummary',COALESCE(logical.snapshot->>'continuitySummary',''),
                 'openThreads',CASE WHEN jsonb_typeof(logical.snapshot->'openThreads')='array'
                                    THEN logical.snapshot->'openThreads' ELSE '[]'::jsonb END,
                 'canonicalFacts',CASE
                   WHEN exact_edit.snapshot IS NOT NULL
                     AND jsonb_typeof(exact_edit.snapshot->'canonicalFacts')='array'
                   THEN exact_edit.snapshot->'canonicalFacts'
                   ELSE COALESCE((
                     SELECT jsonb_agg(jsonb_build_object('id',fact.id,'content',fact.content) ORDER BY fact.id)
                       FROM campaign_canonical_facts fact
                      WHERE fact.owner_user_id=state.owner_user_id
                        AND fact.campaign_id=state.campaign_id
                        AND fact.valid_from_turn<=campaign.active_turn_number
                        AND (fact.valid_until_turn IS NULL OR fact.valid_until_turn>campaign.active_turn_number)
                   ),'[]'::jsonb) END,
                 'scratchpad',CASE WHEN exact_edit.snapshot IS NULL THEN state.scratchpad_private
                                    ELSE COALESCE(exact_edit.snapshot->>'scratchpad','') END,
                 'trackers',CASE WHEN exact_edit.snapshot IS NULL THEN state.trackers
                                 ELSE COALESCE(exact_edit.snapshot->'trackers','[]'::jsonb) END,
                 'rpgStats',CASE WHEN exact_edit.snapshot IS NULL THEN state.rpg_stats
                                 ELSE COALESCE(exact_edit.snapshot->'rpgStats','[]'::jsonb) END,
                 'defaultTriggers',state.default_triggers,
                 'eventTriggers',CASE WHEN exact_edit.snapshot IS NULL THEN state.event_triggers
                                      ELSE COALESCE(exact_edit.snapshot->'eventTriggers','[]'::jsonb) END,
                 'pendingEventTriggers',CASE WHEN exact_edit.snapshot IS NULL THEN state.pending_event_triggers
                                             ELSE COALESCE(exact_edit.snapshot->'pendingEventTriggers','[]'::jsonb) END
               ),
               'updatedAt',COALESCE(exact_edit.created_at,accepted_turn.accepted_at,state.updated_at)
             )
           ) AS envelope
      FROM campaign_state state
      JOIN campaigns campaign
        ON campaign.id=state.campaign_id AND campaign.owner_user_id=state.owner_user_id
      LEFT JOIN LATERAL (
        SELECT turn_row.state_snapshot_private AS snapshot,turn_row.accepted_at
          FROM turns turn_row
         WHERE turn_row.owner_user_id=state.owner_user_id
           AND turn_row.campaign_id=state.campaign_id
           AND turn_row.turn_number=campaign.active_turn_number
           AND turn_row.accepted_at IS NOT NULL
         LIMIT 1
      ) accepted_turn ON true
      LEFT JOIN LATERAL (
        SELECT edit.state_snapshot_private AS snapshot,edit.created_at
          FROM campaign_state_edits edit
         WHERE edit.owner_user_id=state.owner_user_id
           AND edit.campaign_id=state.campaign_id
           AND edit.effective_turn_number=campaign.active_turn_number
         ORDER BY edit.revision DESC
         LIMIT 1
      ) exact_edit ON true
      CROSS JOIN LATERAL (
        SELECT COALESCE(
          exact_edit.snapshot,
          CASE WHEN campaign.active_turn_number=0 THEN state.initial_state_snapshot
               ELSE accepted_turn.snapshot END,
          '{}'::jsonb
        ) AS snapshot
      ) logical
     WHERE state.owner_user_id=$1`,
  "campaign-history": `
    SELECT history.sort_key,
           jsonb_build_object(
             'domain','campaign-history','formatVersion',1,'sourceId',history.source_id,
             'record',jsonb_build_object(
               'sourceId',history.source_id,'campaignId',history.campaign_id,
               'eventType',history.event_type,'content',history.content,
               'occurredAt',history.occurred_at
             )
           ) AS envelope
      FROM (
        SELECT '01:' || edit.id::text AS sort_key,edit.id AS source_id,edit.campaign_id,
               'character-profile-edit'::text AS event_type,
               jsonb_build_object(
                 'revision',edit.revision,'previousProfile',edit.previous_profile,
                 'nextProfile',edit.next_profile,'editSource',edit.edit_source
               )::text AS content,
               edit.created_at AS occurred_at
          FROM campaign_character_profile_edits edit WHERE edit.owner_user_id=$1
        UNION ALL
        SELECT '02:' || edit.id::text,edit.id,edit.campaign_id,'campaign-state-edit',
               jsonb_build_object(
                 'effectiveTurnNumber',edit.effective_turn_number,'revision',edit.revision,
                 'stateSnapshot',edit.state_snapshot_private,'changedFields',edit.changed_fields
               )::text,edit.created_at
          FROM campaign_state_edits edit WHERE edit.owner_user_id=$1
        UNION ALL
        SELECT '03:' || migration.id::text,migration.id,migration.campaign_id,'world-migration',
               jsonb_build_object(
                 'fromWorldVersionId',migration.from_world_version_id,
                 'toWorldVersionId',migration.to_world_version_id,'note',migration.note
               )::text,migration.created_at
          FROM campaign_world_migrations migration WHERE migration.owner_user_id=$1
        UNION ALL
        SELECT '04:' || transfer.id::text,transfer.id,
               COALESCE(transfer.target_campaign_id,transfer.source_campaign_id),'world-transfer',
               jsonb_build_object(
                 'sourceCampaignId',transfer.source_campaign_id,'targetCampaignId',transfer.target_campaign_id,
                 'fromWorldVersionId',transfer.from_world_version_id,
                 'toWorldVersionId',transfer.to_world_version_id,
                 'characterStrategy',transfer.character_strategy,'stateStrategy',transfer.state_strategy,
                 'targetDefaultsPolicy',transfer.target_defaults_policy,
                 'sourceFingerprint',transfer.source_fingerprint,'warnings',transfer.warnings,'note',transfer.note
               )::text,transfer.created_at
          FROM campaign_world_transfers transfer
         WHERE transfer.owner_user_id=$1
           AND COALESCE(transfer.target_campaign_id,transfer.source_campaign_id) IS NOT NULL
        UNION ALL
        SELECT '05:' || config.campaign_id::text,
               overlay(overlay(md5('memory-config:' || config.campaign_id::text)
                 placing '5' from 13) placing '8' from 17)::uuid,
               config.campaign_id,'memory-config',
               jsonb_build_object(
                 'embeddingEnabled',config.embedding_enabled,
                 'embeddingProviderProfileId',config.embedding_provider_profile_id,
                 'embeddingModel',config.embedding_model,'embeddingBatchSize',config.embedding_batch_size,
                 'embeddingDocumentPrefix',config.embedding_document_prefix,
                 'embeddingQueryPrefix',config.embedding_query_prefix,
                 'retrievalImplementation',config.retrieval_implementation,
                 'retrievalShadowEnabled',config.retrieval_shadow_enabled,
                 'createdAt',config.created_at,'updatedAt',config.updated_at
               )::text,config.updated_at
          FROM campaign_memory_configs config WHERE config.owner_user_id=$1
        UNION ALL
        SELECT '06:' || config.campaign_id::text,
               overlay(overlay(md5('illustration-config:' || config.campaign_id::text)
                 placing '5' from 13) placing '8' from 17)::uuid,
               config.campaign_id,'illustration-config',
               jsonb_build_object(
                 'enabled',config.enabled,'providerProfileId',config.provider_profile_id,
                 'model',config.model,'size',config.size,'aspectRatio',config.aspect_ratio,
                 'quality',config.quality,'outputFormat',config.output_format,
                 'maxAttempts',config.max_attempts,'segmentWordCount',config.segment_word_count,
                 'imagesPerSegment',config.images_per_segment,'segmentPromptMode',config.segment_prompt_mode,
                 'refinementPrompt',config.refinement_prompt,
                 'sourcePolicy',config.source_policy,'matchingScope',config.matching_scope,
                 'confidenceProfile',config.confidence_profile,
                 'repetitionWindow',config.repetition_window,
                 'createdAt',config.created_at,'updatedAt',config.updated_at
               )::text,config.updated_at
          FROM campaign_illustration_configs config WHERE config.owner_user_id=$1
        UNION ALL
        SELECT '07:' || turn_row.id::text,
               overlay(overlay(md5('accepted-turn-mode:' || turn_row.id::text)
                 placing '5' from 13) placing '8' from 17)::uuid,
               turn_row.campaign_id,'accepted-turn-mode',
               jsonb_build_object(
                 'turnId',turn_row.id,'turnNumber',turn_row.turn_number,
                 'inputMode',turn_row.input_mode,'inputModeSource',turn_row.input_mode_source
               )::text,turn_row.accepted_at
          FROM turns turn_row WHERE turn_row.owner_user_id=$1
        UNION ALL
        SELECT '08:' || illustration_set.id::text,illustration_set.id,illustration_set.campaign_id,'illustration-set',
               jsonb_build_object(
                 'turnId',illustration_set.turn_id,'segmentWordCount',illustration_set.segment_word_count,
                 'imagesPerSegment',illustration_set.images_per_segment,'promptMode',illustration_set.prompt_mode,
                 'status',illustration_set.status,'isActive',illustration_set.is_active,
                 'characterVisualReference',illustration_set.character_visual_reference,
                 'completedAt',illustration_set.completed_at
               )::text,
               illustration_set.created_at
          FROM turn_illustration_sets illustration_set
         WHERE illustration_set.owner_user_id=$1
           AND illustration_set.status IN ('completed','partial','superseded')
        UNION ALL
        SELECT '09:' || segment.id::text,segment.id,segment.campaign_id,'illustration-segment',
               jsonb_build_object(
                 'illustrationSetId',segment.illustration_set_id,'turnId',segment.turn_id,
                 'ordinal',segment.ordinal,'startOffset',segment.start_offset,'endOffset',segment.end_offset,
                 'startWord',segment.start_word,'endWord',segment.end_word,
                 'directPrompt',segment.direct_prompt,'resolvedPrompt',segment.resolved_prompt,
                 'promptSource',segment.prompt_source,'status',segment.status
               )::text,
               segment.created_at
          FROM turn_illustration_segments segment
         WHERE segment.owner_user_id=$1 AND segment.status='completed'
      ) history`,
  "canonical-facts": `
    SELECT '00:' || fact.id::text AS sort_key,
           jsonb_build_object(
             'domain','canonical-facts','formatVersion',1,'sourceId',fact.id,
             'record',jsonb_build_object(
               'sourceId',fact.id,'campaignId',fact.campaign_id,
               'worldVersionId',fact.world_version_id,
               'sourceTurnId',fact.source_turn_id,
               'sourceStateEditId',fact.source_state_edit_id,
               'sourceTurnNumber',fact.source_turn_number,
               'sourceFactIndex',fact.source_fact_index,
               'subject',COALESCE(fact.metadata->>'subject',''),
               'predicate',COALESCE(fact.metadata->>'predicate',''),
               'object',fact.content,'validFromTurn',fact.valid_from_turn,
               'validUntilTurn',fact.valid_until_turn,
               'supersededByFactId',fact.superseded_by_fact_id,
               'createdAt',fact.created_at,'updatedAt',fact.updated_at
             )
           ) AS envelope
      FROM campaign_canonical_facts fact
     WHERE fact.owner_user_id=$1`,
  chronicle: `
    SELECT chronicle.sort_key,
           jsonb_build_object(
             'domain','chronicle','formatVersion',1,'sourceId',chronicle.source_id,
             'record',jsonb_build_object(
               'sourceId',chronicle.source_id,'campaignId',chronicle.campaign_id,
                'kind',chronicle.kind,'content',chronicle.content,
                'occurredAt',chronicle.occurred_at,
                'metadata',jsonb_build_object(
                  'entityNames',chronicle.entity_names,'openThreadIds',chronicle.open_thread_ids
                )
              ) || CASE WHEN chronicle.kind='memory'
                        THEN jsonb_build_object('turnId',chronicle.turn_id,'memoryKind',chronicle.memory_kind)
                        ELSE jsonb_build_object(
                          'throughTurn',chronicle.through_turn,
                          'summaryKind',chronicle.summary_kind
                        ) END
            ) AS envelope
      FROM (
        SELECT '01:' || memory.id::text AS sort_key,memory.id AS source_id,memory.campaign_id,
               'memory'::text AS kind,memory.content,memory.created_at AS occurred_at,
               to_jsonb(memory.entities) AS entity_names,
               CASE WHEN jsonb_typeof(memory.metadata->'openThreadIds')='array'
                    THEN memory.metadata->'openThreadIds' ELSE '[]'::jsonb END AS open_thread_ids,
               memory.turn_id,memory.memory_kind,NULL::integer AS through_turn,
               NULL::text AS summary_kind
          FROM chronicle_memories memory WHERE memory.owner_user_id=$1
        UNION ALL
        SELECT '02:' || checkpoint.id::text,checkpoint.id,checkpoint.campaign_id,
               'summary-checkpoint',CASE
                 WHEN jsonb_typeof(checkpoint.content)='string' THEN checkpoint.content#>>'{}'
                 WHEN jsonb_typeof(checkpoint.content->'summary')='string' THEN checkpoint.content->>'summary'
                 WHEN jsonb_typeof(checkpoint.content->'history')='string' THEN checkpoint.content->>'history'
                 WHEN jsonb_typeof(checkpoint.content->'text')='string' THEN checkpoint.content->>'text'
                 ELSE checkpoint.content::text
               END,
               checkpoint.created_at,
               CASE WHEN jsonb_typeof(checkpoint.content->'entityNames')='array'
                    THEN checkpoint.content->'entityNames' ELSE '[]'::jsonb END,
               CASE WHEN jsonb_typeof(checkpoint.content->'openThreadIds')='array'
                    THEN checkpoint.content->'openThreadIds' ELSE '[]'::jsonb END,
               NULL::uuid,NULL::text,checkpoint.through_turn,checkpoint.summary_kind
          FROM summary_checkpoints checkpoint WHERE checkpoint.owner_user_id=$1
      ) chronicle`,
  illustrations: `
    SELECT '00:' || segment_asset.asset_id::text || ':' || segment_asset.segment_id::text AS sort_key,
           jsonb_build_object(
             'domain','illustrations','formatVersion',1,
             'sourceId',overlay(overlay(md5('illustration:' || segment_asset.segment_id::text || ':' || segment_asset.variant_index::text)
               placing '5' from 13) placing '8' from 17)::uuid,
             'record',jsonb_build_object(
               'sourceId',overlay(overlay(md5('illustration:' || segment_asset.segment_id::text || ':' || segment_asset.variant_index::text)
                 placing '5' from 13) placing '8' from 17)::uuid,
               'campaignId',segment.campaign_id,
               'turnId',segment.turn_id,'assetId',segment_asset.asset_id,
               'fictionPrompt',COALESCE(NULLIF(segment.resolved_prompt,''),segment.direct_prompt),
               'selected',segment_asset.variant_index=0,'createdAt',segment_asset.created_at
             )
           ) AS envelope
      FROM turn_illustration_segment_assets segment_asset
      JOIN turn_illustration_segments segment
        ON segment.id=segment_asset.segment_id AND segment.owner_user_id=segment_asset.owner_user_id
     WHERE segment_asset.owner_user_id=$1`,
  imports: `
    SELECT '00:' || import_row.id::text AS sort_key,
           jsonb_build_object(
             'domain','imports','formatVersion',1,'sourceId',import_row.id,
             'record',jsonb_build_object(
               'sourceId',import_row.id,'sourceType',import_row.source_type,
               'campaignId',import_row.campaign_id,
               'sourceName',import_row.source_name,'sourceHash',import_row.source_hash,
               'completedAt',import_row.completed_at
             )
           ) AS envelope
      FROM imports import_row
     WHERE import_row.owner_user_id=$1`,
  "cost-events": `
    SELECT '00:' || cost.id::text AS sort_key,
           jsonb_build_object(
             'domain','cost-events','formatVersion',1,'sourceId',cost.id,
             'record',jsonb_build_object(
               'sourceId',cost.id,'campaignId',cost.campaign_id,
               'providerKind',CASE cost.category WHEN 'image' THEN 'image'
                                                   WHEN 'memory' THEN 'embedding' ELSE 'text' END,
               'amountMicros',round(cost.amount*1000000)::bigint,
               'occurredAt',cost.occurred_at
             )
           ) AS envelope
      FROM provider_cost_events cost
     WHERE cost.owner_user_id=$1`,
  "activity-events": `
    SELECT '00:' || lpad(to_hex(activity.id),16,'0') AS sort_key,
           jsonb_build_object(
             'domain','activity-events','formatVersion',1,
             'sourceId','00000000-0000-4000-8000-' || right(lpad(to_hex(activity.id),12,'0'),12),
             'record',jsonb_build_object(
               'sourceId','00000000-0000-4000-8000-' || right(lpad(to_hex(activity.id),12,'0'),12),
               'campaignId',activity.campaign_id,'eventType',activity.event_type,
               'summary',COALESCE(activity.details->>'summary',''),
               'occurredAt',activity.created_at
             )
           ) AS envelope
      FROM activity_events activity
     WHERE activity.owner_user_id=$1`,
} as const satisfies Record<SystemArchiveDomain, string>;

async function* streamDomain(
  client: DatabaseClient,
  ownerUserId: string,
  domain: SystemArchiveDomain,
  maximumPageSize: number,
  afterId?: string,
): AsyncGenerator<SystemRecordEnvelope> {
  let cursor = "";
  let skipping = afterId !== undefined;
  while (true) {
    const result = await client.query<EnvelopeRow>(
      `SELECT page.sort_key,page.envelope
         FROM (${DOMAIN_SQL[domain]}) page
        WHERE page.sort_key>$2
        ORDER BY page.sort_key
        LIMIT $3`,
      [ownerUserId, cursor, maximumPageSize],
    );
    if (result.rows.length === 0) return;
    for (const row of result.rows) {
      cursor = row.sort_key;
      const envelope = parseEnvelope(domain, row.envelope);
      if (skipping) {
        if (envelope.sourceId === afterId) skipping = false;
        continue;
      }
      yield envelope;
    }
    if (result.rows.length < maximumPageSize) return;
  }
}

type AssetRow = Readonly<{
  id: string;
  content_hash: string;
  mime_type: string;
  byte_length: number | string;
  pixel_width: number | null;
  pixel_height: number | null;
  technical_metadata: unknown;
  created_at: Date | string;
  campaign_id: string | null;
  turn_id: string | null;
  title: string | null;
  caption: string | null;
  notes: string | null;
  tags: string[] | null;
  origin: "generated" | "imported" | "uploaded" | null;
  review_status: "unreviewed" | "eligible" | "restricted" | "blocked" | null;
  reuse_scope: "private" | "campaign" | "world" | "owner_library" | "shared" | null;
  automatic_reuse_enabled: boolean | null;
  content_categories: string[] | null;
  favorite: boolean | null;
  archived_at: Date | string | null;
}>;

function bindingKey(binding: ArchiveAssetBinding): string {
  return canonicalArchiveJson(binding);
}

async function assetBindings(
  client: DatabaseClient,
  ownerUserId: string,
  rows: readonly AssetRow[],
): Promise<ReadonlyMap<string, readonly ArchiveAssetBinding[]>> {
  const assetIds = rows.map((row) => row.id);
  const bindings = new Map<string, Map<string, ArchiveAssetBinding>>(
    assetIds.map((id) => [id, new Map()]),
  );
  const add = (assetId: string, binding: ArchiveAssetBinding) => {
    const target = bindings.get(assetId);
    if (target) target.set(bindingKey(binding), binding);
  };
  for (const row of rows) {
    if (row.campaign_id && row.turn_id) {
      add(row.id, { role: "turn_illustration", campaignId: row.campaign_id, turnId: row.turn_id });
    } else if (row.campaign_id) {
      add(row.id, { role: "campaign_asset", campaignId: row.campaign_id });
    }
  }
  const covers = await client.query<{ asset_id: string; world_id: string }>(
    `SELECT cover_asset_id AS asset_id,id AS world_id
       FROM worlds
      WHERE owner_user_id=$1 AND cover_asset_id=ANY($2::uuid[])`,
    [ownerUserId, assetIds],
  );
  for (const row of covers.rows) add(row.asset_id, { role: "world_cover", worldId: row.world_id });

  const versionAssets = await client.query<{
    asset_id: string;
    world_id: string;
    world_version_id: string;
  }>(
    `SELECT item->>'assetId' AS asset_id,version.world_id,
            version.id AS world_version_id
       FROM world_versions version
       CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(version.content->'assets')='array'
              THEN version.content->'assets' ELSE '[]'::jsonb END
       ) item
      WHERE version.owner_user_id=$1
        AND item->>'assetId'=ANY($2::text[])
        AND item->>'role' IN ('world_cover','world_version_asset')`,
    [ownerUserId, assetIds],
  );
  for (const row of versionAssets.rows) {
    add(row.asset_id, {
      role: "world_version_asset",
      worldId: row.world_id,
      worldVersionId: row.world_version_id,
    });
  }

  const references = await client.query<{
    asset_id: string;
    campaign_id: string;
    turn_id: string | null;
    asset_role: string;
  }>(
    `SELECT asset_id,campaign_id,turn_id,asset_role
       FROM asset_references
      WHERE owner_user_id=$1 AND asset_id=ANY($2::uuid[])`,
    [ownerUserId, assetIds],
  );
  for (const row of references.rows) {
    if (row.asset_role === "turn_illustration" && row.turn_id) {
      add(row.asset_id, { role: "turn_illustration", campaignId: row.campaign_id, turnId: row.turn_id });
    } else if (row.asset_role === "import_attachment") {
      add(row.asset_id, { role: "imported_attachment", campaignId: row.campaign_id, turnId: row.turn_id });
    } else {
      add(row.asset_id, { role: "campaign_asset", campaignId: row.campaign_id });
    }
  }

  const variants = await client.query<{
    asset_id: string;
    campaign_id: string;
    turn_id: string;
    segment_id: string;
    variant_index: number;
  }>(
    `SELECT segment_asset.asset_id,segment.campaign_id,segment.turn_id,
            segment_asset.segment_id,segment_asset.variant_index
       FROM turn_illustration_segment_assets segment_asset
       JOIN turn_illustration_segments segment
         ON segment.id=segment_asset.segment_id AND segment.owner_user_id=segment_asset.owner_user_id
      WHERE segment_asset.owner_user_id=$1 AND segment_asset.asset_id=ANY($2::uuid[])`,
    [ownerUserId, assetIds],
  );
  for (const row of variants.rows) {
    add(row.asset_id, {
      role: "illustration_segment_variant",
      campaignId: row.campaign_id,
      turnId: row.turn_id,
      segmentId: row.segment_id,
      variantIndex: row.variant_index,
    });
  }

  const contexts = await client.query<{
    id: string;
    asset_id: string;
    campaign_id: string | null;
    world_id: string | null;
    world_version_id: string | null;
    turn_id: string | null;
  }>(
    `SELECT id,asset_id,campaign_id,world_id,world_version_id,turn_id
       FROM asset_generation_contexts
      WHERE owner_user_id=$1 AND asset_id=ANY($2::uuid[])`,
    [ownerUserId, assetIds],
  );
  for (const row of contexts.rows) {
    add(row.asset_id, {
      role: "generation_context",
      campaignId: row.campaign_id,
      worldId: row.world_id,
      worldVersionId: row.world_version_id,
      turnId: row.turn_id,
      sourceContextId: row.id,
    });
  }
  return new Map([...bindings].map(([assetId, values]) => [
    assetId,
    [...values.values()].sort((left, right) => bindingKey(left).localeCompare(bindingKey(right))),
  ]));
}

async function* originalAssets(
  client: DatabaseClient,
  ownerUserId: string,
  maximumPageSize: number,
): AsyncGenerator<SystemArchiveOriginalAssetRecord> {
  let cursor = "00000000-0000-0000-0000-000000000000";
  while (true) {
    const result = await client.query<AssetRow>(
      `SELECT asset.id,asset.content_hash,asset.mime_type,asset.byte_length,
              asset.pixel_width,asset.pixel_height,asset.technical_metadata,
              asset.created_at,asset.campaign_id,asset.turn_id,
              library.title,library.caption,library.notes,library.tags,library.origin,
              library.review_status,library.reuse_scope,library.automatic_reuse_enabled,
              library.content_categories,library.favorite,library.archived_at
         FROM assets asset
         LEFT JOIN asset_library_entries library
           ON library.asset_id=asset.id AND library.owner_user_id=asset.owner_user_id
        WHERE asset.owner_user_id=$1 AND asset.id>$2::uuid
        ORDER BY asset.id
        LIMIT $3`,
      [ownerUserId, cursor, maximumPageSize],
    );
    if (result.rows.length === 0) return;
    const bindings = await assetBindings(client, ownerUserId, result.rows);
    for (const row of result.rows) {
      cursor = row.id;
      if (!SHA_256.test(row.content_hash)) throw exportError("System Archive source asset hash is invalid.");
      const byteLength = safeInteger(row.byte_length, "System Archive source asset byte length");
      const pixelWidth = safeInteger(row.pixel_width, "System Archive source asset width");
      const pixelHeight = safeInteger(row.pixel_height, "System Archive source asset height");
      if (pixelWidth < 1 || pixelHeight < 1) throw exportError("System Archive source asset dimensions are missing.");
      const mimeType = row.mime_type as "image/png" | "image/jpeg" | "image/webp" | "image/gif";
      const archivePath = `assets/sha256/${row.content_hash.slice(0, 2)}/${row.content_hash}${imageExtension(mimeType)}`;
      const assetBindings = bindings.get(row.id) ?? [];
      const reuseScope = assetBindings.length === 0 ? "owner_library" : (row.reuse_scope ?? "private");
      const record = archiveAssetRecordSchema.parse({
        sourceAssetId: row.id,
        contentHash: row.content_hash,
        archivePath,
        mimeType,
        byteLength,
        pixelWidth,
        pixelHeight,
        technicalMetadata: sanitizePortableMetadata(row.technical_metadata),
        library: {
          title: row.title ?? "",
          caption: row.caption ?? "",
          notes: row.notes ?? "",
          tags: row.tags ?? [],
          origin: row.origin ?? "imported",
          reviewStatus: row.review_status ?? "unreviewed",
          reuseScope,
          automaticReuseEnabled: row.automatic_reuse_enabled ?? false,
          contentCategories: row.content_categories ?? [],
          favorite: row.favorite ?? false,
          archivedAt: row.archived_at === null ? null : iso(row.archived_at),
        },
        createdAt: iso(row.created_at),
        bindings: assetBindings,
      });
      yield Object.freeze({
        sourceAssetId: row.id,
        archivePath,
        expectedSha256: row.content_hash,
        expectedBytes: byteLength,
        expectedMimeType: record.mimeType,
        expectedPixelWidth: pixelWidth,
        expectedPixelHeight: pixelHeight,
        record,
      });
    }
    if (result.rows.length < maximumPageSize) return;
  }
}

async function excludedOperationalWork(
  client: DatabaseClient,
  ownerUserId: string,
): Promise<Readonly<Record<string, number>>> {
  const result = await client.query<Readonly<Record<string, number | string>>>(
    `SELECT
       (SELECT count(*)::int FROM generation_jobs
         WHERE owner_user_id=$1 AND status IN (
           'queued','replacement_queued','assessing','generating','validating','committing','recoverable'
         )) AS generation,
       ((SELECT count(*) FROM image_jobs
          WHERE owner_user_id=$1 AND status IN ('queued','generating','provider_pending','downloading','recoverable'))
        +(SELECT count(*) FROM illustration_prompt_jobs
          WHERE owner_user_id=$1 AND status IN ('queued','refining','recoverable'))
        +(SELECT count(*) FROM illustration_resolution_jobs
          WHERE owner_user_id=$1 AND status IN ('queued','matching','generation_queued','recoverable'))
        +(SELECT count(*) FROM illustration_backfill_jobs
          WHERE owner_user_id=$1 AND status IN ('queued','running')))::int AS illustration,
       ((SELECT count(*) FROM chronicle_jobs
          WHERE owner_user_id=$1 AND status IN ('queued','running'))
        +(SELECT count(*) FROM chronicle_chunk_jobs
          WHERE owner_user_id=$1 AND status IN ('queued','running')))::int AS chronicle,
       (SELECT count(*)::int FROM imports
         WHERE owner_user_id=$1 AND status='processing') AS imports,
       (SELECT count(*)::int FROM system_archive_jobs
         WHERE owner_user_id=$1 AND status NOT IN ('published','completed','cancelled','rolled_back','failed','expired')) AS system_archive`,
    [ownerUserId],
  );
  const row = result.rows[0] ?? {};
  return Object.freeze(Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key.replaceAll("_", "-"),
    safeInteger(value, `System Archive excluded ${key} count`),
  ])));
}

/** PostgreSQL adapter: one repeatable-read, read-only transaction per owner snapshot. */
export function createPostgresSystemArchiveExportRepository(
  pool: DatabasePool,
  options: ExportRepositoryOptions,
): SystemArchiveSnapshotPort {
  if (!options.sourceApplicationVersion.trim()) {
    throw exportError("System Archive source application version is required.");
  }
  const maximumPageSize = pageSize(options.pageSize);
  return {
    async withOwnerSnapshot(owner: OwnerScope, consume) {
      if (!owner.ownerUserId.trim()) throw exportError("System Archive owner scope is required.");
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const ownerResult = await client.query<{ id: string; display_name: string }>(
          "SELECT id,display_name FROM users WHERE id=$1 AND status='active'",
          [owner.ownerUserId],
        );
        const ownerRow = ownerResult.rows[0];
        if (!ownerRow) throw Object.assign(new Error("System Archive owner was not found."), { statusCode: 404 });
        const migrationResult = await client.query<{ name: string }>(
          "SELECT name FROM schema_migrations ORDER BY run_on DESC,name DESC LIMIT 1",
        );
        const sourceMigration = migrationResult.rows[0]?.name;
        if (!sourceMigration) throw exportError("System Archive source migration watermark is unavailable.");
        const snapshot: SystemArchiveSnapshot = Object.freeze({
          async readOwner() {
            return Object.freeze({
              sourceId: ownerRow.id,
              sourceInstallationId: ownerRow.id,
              displayName: ownerRow.display_name,
            });
          },
          async readCompatibility() {
            return Object.freeze({
              sourceApplication: options.sourceApplicationVersion,
              sourceMigration,
            });
          },
          streamDomain(domain: SystemArchiveDomain, afterId?: string) {
            return streamDomain(client, owner.ownerUserId, domain, maximumPageSize, afterId);
          },
          listOriginalAssets() {
            return originalAssets(client, owner.ownerUserId, maximumPageSize);
          },
          summarizeExcludedOperationalWork() {
            return excludedOperationalWork(client, owner.ownerUserId);
          },
        });
        const value = await consume(snapshot);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

function jobUpdateError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

/** Durable Task 2 lifecycle adapter used by the System Archive worker composition. */
export function createPostgresSystemArchiveExportJobPort(pool: DatabasePool): SystemArchiveExportJobPort {
  return {
    async setPhase(job, phase, progress) {
      const result = await pool.query(
        `UPDATE system_archive_jobs
            SET status=$4,progress=$5::jsonb,updated_at=clock_timestamp()
          WHERE id=$1 AND owner_user_id=$2 AND kind='export'
            AND lease_owner=$3 AND lease_expires_at>clock_timestamp()
            AND status<>'cancelling'`,
        [job.id, job.ownerUserId, job.leaseOwner, phase, canonicalArchiveJson(progress)],
      );
      if (result.rowCount !== 1) {
        const cancelling = await pool.query<{ cancellation_owned: boolean }>(
          `SELECT status='cancelling'
                  AND lease_owner=$3
                  AND lease_expires_at>clock_timestamp() AS cancellation_owned
             FROM system_archive_jobs
            WHERE id=$1 AND owner_user_id=$2 AND kind='export'`,
          [job.id, job.ownerUserId, job.leaseOwner],
        );
        if (cancelling.rows[0]?.cancellation_owned) return;
        throw jobUpdateError("System Archive export lease or phase was lost.", 409);
      }
    },

    async cancellationRequested(job) {
      const result = await pool.query<{ status: string }>(
        `SELECT status FROM system_archive_jobs
          WHERE id=$1 AND owner_user_id=$2 AND kind='export'`,
        [job.id, job.ownerUserId],
      );
      const row = result.rows[0];
      if (!row) throw jobUpdateError("System Archive export job was not found.", 404);
      return row.status === "cancelling";
    },

    async markPublished(job, artifact, report) {
      if (!artifact.artifactId) throw exportError("Published System Archive artifact lacks durable authority.");
      const recordsByDomain = { ...report.domainCounts };
      const operationalOmissions = systemArchiveOperationalOmissionsSchema.parse(report.excludedOperationalWork);
      const omittedOperationalRows = Object.values(operationalOmissions)
        .reduce((total, count) => total + count, 0);
      const durableReport = systemArchiveReportSchema.parse({
        completedAt: report.completedAt,
        archiveFingerprint: report.contentFingerprint,
        recordsByDomain,
        assetCount: report.originalAssets,
        assetBytes: report.originalBytes,
        omittedOperationalRows,
        operationalOmissions,
        warnings: [],
        errors: [],
      });
      const result = await pool.query(
        `UPDATE system_archive_jobs
            SET status='published',export_artifact_id=$4,report=$5::jsonb,
                progress='{}'::jsonb,lease_owner=NULL,lease_expires_at=NULL,
                updated_at=clock_timestamp()
          WHERE id=$1 AND owner_user_id=$2 AND kind='export' AND lease_owner=$3
            AND status IN ('verifying','cancelling')`,
        [job.id, job.ownerUserId, job.leaseOwner, artifact.artifactId, canonicalArchiveJson(durableReport)],
      );
      if (result.rowCount !== 1) throw jobUpdateError("System Archive export could not publish its durable job.", 409);
    },

    async markCancelled(job) {
      const result = await pool.query(
        `UPDATE system_archive_jobs
            SET status='cancelled',progress='{}'::jsonb,
                lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
          WHERE id=$1 AND owner_user_id=$2 AND kind='export'
            AND status='cancelling'`,
        [job.id, job.ownerUserId],
      );
      if (result.rowCount !== 1) throw jobUpdateError("System Archive export cancellation was not current.", 409);
    },

    async markFailed(job, errorCode) {
      await pool.query(
        `UPDATE system_archive_jobs
            SET status='failed',progress=jsonb_build_object('errorCode',$4::text),
                lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
          WHERE id=$1 AND owner_user_id=$2 AND kind='export'
            AND (lease_owner=$3 OR status='cancelling')
            AND status IN ('capturing','writing','verifying','cancelling')`,
        [job.id, job.ownerUserId, job.leaseOwner, errorCode],
      );
    },
  };
}
