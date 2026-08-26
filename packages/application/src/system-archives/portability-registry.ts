export const SYSTEM_ARCHIVE_PORTABILITY_CLASSES = [
  "portable_authority",
  "portable_normalized",
  "rebuildable",
  "operational",
  "security_authority",
  "deployment_configuration"
] as const;

export type PortabilityClass = typeof SYSTEM_ARCHIVE_PORTABILITY_CLASSES[number];

/** Every table created by the current migrations has one deliberate export treatment. */
export const SYSTEM_ARCHIVE_TABLE_CLASSIFICATIONS = {
  activity_events: "portable_authority",
  api_admission_buckets: "operational",
  api_admission_leases: "operational",
  archive_previews: "operational",
  asset_derivatives: "rebuildable",
  asset_generation_contexts: "portable_normalized",
  asset_library_entries: "portable_normalized",
  asset_metadata_backfill_jobs: "operational",
  asset_metadata_backfill_publications: "operational",
  asset_mutation_idempotency: "operational",
  asset_publication_content_arbitrations: "operational",
  asset_publication_identities: "operational",
  asset_publication_library_initializations: "operational",
  asset_publication_request_contexts: "operational",
  asset_publication_request_derivatives: "operational",
  asset_publication_request_references: "operational",
  asset_publication_request_results: "operational",
  asset_publication_request_sources: "operational",
  asset_publication_requests: "operational",
  asset_references: "portable_authority",
  assets: "portable_authority",
  campaign_canonical_facts: "portable_authority",
  campaign_character_profile_edits: "portable_authority",
  campaign_illustration_configs: "portable_authority",
  campaign_memory_configs: "portable_authority",
  campaign_state: "portable_authority",
  campaign_state_edits: "portable_authority",
  campaign_world_migrations: "portable_authority",
  campaign_world_transfers: "portable_authority",
  campaigns: "portable_authority",
  chronicle_chunk_jobs: "operational",
  chronicle_jobs: "operational",
  chronicle_memories: "portable_authority",
  chronicle_memory_chunks: "rebuildable",
  chronicle_query_embedding_cache: "rebuildable",
  chronicle_retrieval_candidates: "rebuildable",
  chronicle_retrieval_runs: "rebuildable",
  durable_filesystem_candidate_authorities: "operational",
  durable_filesystem_descriptors: "operational",
  durable_filesystem_operations: "operational",
  durable_filesystem_prewrite_nodes: "operational",
  generation_attempts: "operational",
  generation_jobs: "operational",
  illustration_backfill_jobs: "operational",
  illustration_match_candidates: "rebuildable",
  illustration_prompt_jobs: "operational",
  illustration_resolution_jobs: "operational",
  image_job_asset_publications: "operational",
  image_jobs: "operational",
  import_progress_status: "operational",
  imports: "portable_authority",
  model_chains: "operational",
  portable_export_artifacts: "operational",
  portable_import_asset_publications: "operational",
  portable_import_asset_reservation_intents: "operational",
  portable_import_normalized_asset_contexts: "operational",
  portable_import_normalized_asset_publications: "operational",
  portable_import_normalized_asset_references: "operational",
  portable_import_normalized_asset_sources: "operational",
  portable_import_operations: "operational",
  portable_import_work: "operational",
  portable_staged_inputs: "operational",
  private_filesystem_delivery_grants: "security_authority",
  private_finalized_asset_delivery_grants: "security_authority",
  private_legacy_asset_read_capabilities: "security_authority",
  prompt_template_overrides: "portable_authority",
  provider_cost_events: "portable_authority",
  provider_profiles: "portable_normalized",
  summary_checkpoints: "portable_authority",
  system_archive_jobs: "operational",
  system_archive_upload_chunks: "operational",
  system_archive_uploads: "operational",
  turn_illustration_segment_assets: "portable_authority",
  turn_illustration_segments: "portable_authority",
  turn_illustration_sets: "portable_authority",
  turn_input_classifications: "operational",
  turn_narration_corrections: "portable_authority",
  turns: "portable_authority",
  users: "portable_authority",
  world_drafts: "portable_authority",
  world_generation_progress: "operational",
  world_share_links: "security_authority",
  world_versions: "portable_authority",
  worlds: "portable_authority"
} as const satisfies Record<string, PortabilityClass>;

export const SYSTEM_ARCHIVE_SOURCE_COLUMN_CLASSES = [
  "portable_exact",
  "portable_sanitized",
  "portable_normalized",
  "owner_remapped",
  "destination_retained",
  "secret_excluded",
  "derived_rebuild",
  "operational_excluded",
  "storage_rebound"
] as const;

export type SourceColumnPortabilityClass = typeof SYSTEM_ARCHIVE_SOURCE_COLUMN_CLASSES[number];

function sourceColumns(
  groups: Partial<Record<SourceColumnPortabilityClass, readonly string[]>>
): Readonly<Record<string, SourceColumnPortabilityClass>> {
  const entries = Object.entries(groups).flatMap(([classification, columns]) =>
    (columns ?? []).map((column) => [column, classification] as const));
  return Object.freeze(Object.fromEntries(entries)) as Readonly<Record<string, SourceColumnPortabilityClass>>;
}

/**
 * Column-level authority ledger for every table read by System Archive v2.
 * The companion database integration test compares these keys with the live
 * migration schema, so adding a column requires an explicit portability ruling.
 */
export const SYSTEM_ARCHIVE_SOURCE_COLUMN_CLASSIFICATIONS = Object.freeze({
  activity_events: sourceColumns({
    portable_exact: ["id", "campaign_id", "event_type", "correlation_id", "created_at"],
    portable_sanitized: ["details"],
    owner_remapped: ["owner_user_id"]
  }),
  asset_generation_contexts: sourceColumns({
    portable_exact: [
      "id", "asset_id", "world_id", "world_version_id", "campaign_id", "turn_id",
      "target_type", "variant_index", "fiction_prompt", "negative_prompt",
      "provider_profile_id", "provider_type", "model", "parent_asset_ids",
      "metadata_schema_version", "created_at"
    ],
    portable_sanitized: [
      "entities", "characters", "locations", "factions", "scene_attributes",
      "generation_parameters"
    ],
    owner_remapped: ["owner_user_id", "created_by_user_id"],
    operational_excluded: ["image_job_id"]
  }),
  asset_library_entries: sourceColumns({
    portable_exact: [
      "asset_id", "title", "caption", "notes", "tags", "origin", "reuse_scope",
      "automatic_reuse_enabled", "review_status", "content_categories", "favorite",
      "archived_at", "metadata_revision", "created_at", "updated_at"
    ],
    owner_remapped: ["owner_user_id", "created_by_user_id"]
  }),
  asset_references: sourceColumns({
    portable_exact: ["id", "asset_id", "campaign_id", "turn_id", "asset_role", "created_at"],
    owner_remapped: ["owner_user_id"]
  }),
  assets: sourceColumns({
    portable_exact: [
      "id", "content_hash", "mime_type", "byte_length", "created_at", "pixel_width", "pixel_height"
    ],
    portable_sanitized: ["technical_metadata"],
    portable_normalized: ["campaign_id", "turn_id"],
    owner_remapped: ["owner_user_id"],
    secret_excluded: ["source_url"],
    storage_rebound: ["storage_driver", "storage_path"],
    operational_excluded: ["filesystem_operation_id", "filesystem_operation_purpose"]
  }),
  campaign_canonical_facts: sourceColumns({
    portable_exact: [
      "id", "campaign_id", "world_version_id", "source_turn_id", "source_turn_number",
      "source_fact_index", "content", "normalized_content", "entities", "valid_from_turn",
      "valid_until_turn", "superseded_by_fact_id", "created_at", "updated_at", "entity_ids",
      "source_state_edit_id"
    ],
    portable_sanitized: ["metadata"],
    owner_remapped: ["owner_user_id"]
  }),
  campaign_character_profile_edits: sourceColumns({
    portable_exact: ["id", "campaign_id", "revision", "previous_profile", "next_profile", "edit_source", "created_at"],
    owner_remapped: ["owner_user_id"]
  }),
  campaign_illustration_configs: sourceColumns({
    portable_exact: [
      "campaign_id", "enabled", "provider_profile_id", "model", "size", "aspect_ratio",
      "quality", "output_format", "max_attempts", "created_at", "updated_at", "source_policy",
      "matching_scope", "confidence_profile", "repetition_window", "segment_word_count",
      "images_per_segment", "segment_prompt_mode", "refinement_prompt"
    ],
    owner_remapped: ["owner_user_id"]
  }),
  campaign_memory_configs: sourceColumns({
    portable_exact: [
      "campaign_id", "embedding_enabled", "embedding_provider_profile_id", "embedding_model",
      "embedding_batch_size", "created_at", "updated_at", "embedding_document_prefix",
      "embedding_query_prefix", "retrieval_implementation", "retrieval_shadow_enabled"
    ],
    owner_remapped: ["owner_user_id"]
  }),
  campaign_state: sourceColumns({
    portable_exact: [
      "campaign_id", "scratchpad_private", "trackers", "default_triggers", "event_triggers",
      "pending_event_triggers", "rpg_stats", "updated_at", "scratchpad_safe_for_prompt", "revision"
    ],
    portable_sanitized: ["import_provenance", "initial_state_snapshot"],
    owner_remapped: ["owner_user_id"]
  }),
  campaign_state_edits: sourceColumns({
    portable_exact: [
      "id", "campaign_id", "effective_turn_number", "revision", "state_snapshot_private",
      "changed_fields", "created_at"
    ],
    owner_remapped: ["owner_user_id"]
  }),
  campaign_world_migrations: sourceColumns({
    portable_exact: ["id", "campaign_id", "from_world_version_id", "to_world_version_id", "note", "created_at"],
    owner_remapped: ["owner_user_id"]
  }),
  campaign_world_transfers: sourceColumns({
    portable_exact: [
      "id", "idempotency_key", "source_campaign_id", "target_campaign_id", "from_world_version_id",
      "to_world_version_id", "character_strategy", "state_strategy", "target_defaults_policy",
      "source_fingerprint", "warnings", "note", "created_at"
    ],
    owner_remapped: ["owner_user_id"]
  }),
  campaigns: sourceColumns({
    portable_exact: [
      "id", "world_version_id", "title", "status", "active_turn_number", "created_at", "updated_at",
      "text_provider_profile_id", "image_provider_profile_id", "story_length_profile", "selected_character_id",
      "character_snapshot", "turn_control_style", "character_profile", "character_profile_revision"
    ],
    portable_sanitized: ["legacy_settings"],
    owner_remapped: ["owner_user_id"]
  }),
  chronicle_memories: sourceColumns({
    portable_exact: [
      "id", "campaign_id", "world_version_id", "turn_id", "memory_kind", "ordinal", "content",
      "token_estimate", "importance", "entities", "created_at", "updated_at", "entity_ids", "content_hash"
    ],
    portable_sanitized: ["metadata"],
    owner_remapped: ["owner_user_id"],
    derived_rebuild: [
      "embedding", "search_document", "embedding_provider_profile_id", "embedding_model",
      "embedding_dimensions", "embedding_content_hash", "embedding_updated_at", "embedding_provider_fingerprint"
    ]
  }),
  imports: sourceColumns({
    portable_exact: [
      "id", "source_type", "source_name", "source_hash", "status", "world_id", "world_version_id",
      "campaign_id", "error_message", "created_at", "completed_at"
    ],
    portable_sanitized: ["stats"],
    owner_remapped: ["owner_user_id"]
  }),
  prompt_template_overrides: sourceColumns({
    portable_exact: ["id", "campaign_id", "prompt_key", "content", "updated_at", "created_at"],
    owner_remapped: ["owner_user_id"]
  }),
  provider_cost_events: sourceColumns({
    portable_exact: [
      "id", "campaign_id", "turn_id", "provider_profile_id", "local_call_id", "provider_type",
      "provider_response_id", "category", "operation", "requested_model", "resolved_model", "amount",
      "currency", "occurred_at", "created_at"
    ],
    portable_sanitized: ["usage_metadata"],
    owner_remapped: ["owner_user_id"],
    operational_excluded: ["generation_job_id", "image_job_id", "chronicle_job_id"]
  }),
  provider_profiles: sourceColumns({
    portable_exact: [
      "id", "name", "provider_type", "provider_role", "default_model", "context_window_tokens",
      "max_output_tokens", "temperature", "created_at", "updated_at", "is_default", "request_timeout_ms"
    ],
    portable_sanitized: ["base_url", "configuration"],
    portable_normalized: ["enabled"],
    owner_remapped: ["owner_user_id"],
    secret_excluded: [
      "encrypted_api_key", "credential_nonce", "credential_auth_tag", "credential_key_version"
    ],
    operational_excluded: [
      "health_status", "consecutive_failures", "last_health_check_at", "last_health_error"
    ]
  }),
  summary_checkpoints: sourceColumns({
    portable_exact: ["id", "campaign_id", "through_turn", "summary_kind", "content", "token_estimate", "created_at"],
    owner_remapped: ["owner_user_id"]
  }),
  turn_illustration_segment_assets: sourceColumns({
    portable_exact: ["segment_id", "asset_id", "variant_index", "created_at"],
    owner_remapped: ["owner_user_id"],
    operational_excluded: ["image_job_id"]
  }),
  turn_illustration_segments: sourceColumns({
    portable_exact: [
      "id", "illustration_set_id", "campaign_id", "turn_id", "ordinal", "start_offset", "end_offset",
      "start_word", "end_word", "source_text", "source_text_hash", "direct_prompt", "resolved_prompt",
      "prompt_source", "status", "created_at", "updated_at"
    ],
    owner_remapped: ["owner_user_id"],
    operational_excluded: ["generation_job_id"]
  }),
  turn_illustration_sets: sourceColumns({
    portable_exact: [
      "id", "campaign_id", "turn_id", "source_text_hash", "segment_word_count", "images_per_segment",
      "prompt_mode", "status", "is_active", "created_at", "completed_at", "character_visual_reference"
    ],
    owner_remapped: ["owner_user_id"],
    operational_excluded: ["generation_job_id"]
  }),
  turn_narration_corrections: sourceColumns({
    portable_exact: [
      "id", "campaign_id", "turn_id", "revision", "narration", "previous_effective_narration_hash",
      "reason", "source", "created_at"
    ],
    owner_remapped: ["owner_user_id", "created_by_user_id"]
  }),
  turns: sourceColumns({
    portable_exact: [
      "id", "campaign_id", "turn_number", "source_turn_id", "action", "narration", "choices",
      "custom_action_suggestion", "image_prompt", "image_url", "mechanics_private", "state_snapshot_private",
      "accepted_at", "created_at", "input_mode", "input_mode_source"
    ],
    portable_sanitized: ["model_metadata", "import_metadata"],
    owner_remapped: ["owner_user_id"]
  }),
  users: sourceColumns({
    portable_exact: ["display_name", "status", "created_at", "updated_at"],
    portable_sanitized: ["settings"],
    owner_remapped: ["id"],
    destination_retained: ["system_key"]
  }),
  world_drafts: sourceColumns({
    portable_exact: ["world_id", "based_on_world_version_id", "revision", "created_at", "updated_at"],
    portable_normalized: ["content"],
    owner_remapped: ["owner_user_id"]
  }),
  world_versions: sourceColumns({
    portable_exact: [
      "id", "world_id", "version_number", "source_hash", "published_at", "created_at",
      "release_notes", "created_from_revision"
    ],
    portable_normalized: ["content"],
    owner_remapped: ["owner_user_id"]
  }),
  worlds: sourceColumns({
    portable_exact: [
      "id", "title", "status", "created_at", "updated_at", "forked_from_world_id",
      "forked_from_world_version_id", "next_version_number", "cover_asset_id"
    ],
    owner_remapped: ["owner_user_id"]
  })
});
