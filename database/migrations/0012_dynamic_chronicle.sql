ALTER TABLE campaign_memory_configs
  ADD COLUMN embedding_document_prefix text,
  ADD COLUMN embedding_query_prefix text;

ALTER TABLE campaign_state
  ADD COLUMN scratchpad_safe_for_prompt boolean NOT NULL DEFAULT false;

ALTER TABLE chronicle_jobs
  ADD COLUMN work_version bigint NOT NULL DEFAULT 1 CHECK (work_version > 0);

ALTER TABLE chronicle_memories
  DROP CONSTRAINT chronicle_memories_embedding_metadata_check;

ALTER TABLE chronicle_memories
  ADD COLUMN embedding_provider_fingerprint text;

UPDATE chronicle_memories
   SET embedding = NULL,
       embedding_provider_profile_id = NULL,
       embedding_model = NULL,
       embedding_dimensions = NULL,
       embedding_content_hash = NULL,
       embedding_updated_at = NULL,
       embedding_provider_fingerprint = NULL
 WHERE embedding IS NOT NULL;

INSERT INTO chronicle_jobs (owner_user_id, campaign_id, job_type, status)
SELECT owner_user_id, campaign_id, 'embed_campaign', 'queued'
  FROM campaign_memory_configs
 WHERE embedding_enabled
ON CONFLICT (campaign_id, job_type) WHERE status IN ('queued', 'running')
DO UPDATE SET work_version = chronicle_jobs.work_version + 1,
              updated_at = now();

ALTER TABLE chronicle_memories
  ADD CONSTRAINT chronicle_memories_embedding_metadata_check CHECK (
    (embedding IS NULL AND embedding_provider_profile_id IS NULL AND embedding_model IS NULL
      AND embedding_dimensions IS NULL AND embedding_content_hash IS NULL AND embedding_updated_at IS NULL
      AND embedding_provider_fingerprint IS NULL)
    OR
    (embedding IS NOT NULL AND embedding_provider_profile_id IS NOT NULL AND embedding_model IS NOT NULL
      AND embedding_dimensions IS NOT NULL AND embedding_content_hash IS NOT NULL AND embedding_updated_at IS NOT NULL
      AND embedding_provider_fingerprint IS NOT NULL)
  );

COMMENT ON COLUMN campaign_memory_configs.embedding_document_prefix IS
  'Optional explicit task prefix. NULL selects the model-aware default.';
COMMENT ON COLUMN campaign_memory_configs.embedding_query_prefix IS
  'Optional explicit task prefix. NULL selects the model-aware default.';
COMMENT ON COLUMN chronicle_jobs.work_version IS
  'Incremented whenever more Chronicle work arrives so a running job cannot lose concurrent updates.';
COMMENT ON COLUMN chronicle_memories.embedding_provider_fingerprint IS
  'Hash of provider endpoint, type, model, task prefixes, and relevant configuration used to create the vector.';
COMMENT ON COLUMN campaign_state.scratchpad_safe_for_prompt IS
  'True only after the scratchpad passed the typed fiction-only story-output validator.';
