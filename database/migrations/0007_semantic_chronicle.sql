ALTER TABLE provider_profiles DROP CONSTRAINT provider_profiles_provider_role_check;
ALTER TABLE provider_profiles
  ADD CONSTRAINT provider_profiles_provider_role_check
  CHECK (provider_role IN ('text', 'image', 'embedding'));

CREATE TABLE campaign_memory_configs (
  campaign_id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  embedding_enabled boolean NOT NULL DEFAULT false,
  embedding_provider_profile_id uuid,
  embedding_model text NOT NULL DEFAULT '',
  embedding_batch_size integer NOT NULL DEFAULT 16 CHECK (embedding_batch_size BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, owner_user_id),
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (embedding_provider_profile_id, owner_user_id) REFERENCES provider_profiles(id, owner_user_id),
  CHECK (NOT embedding_enabled OR (embedding_provider_profile_id IS NOT NULL AND embedding_model <> ''))
);

ALTER TABLE chronicle_memories
  ADD COLUMN embedding_provider_profile_id uuid,
  ADD COLUMN embedding_model text,
  ADD COLUMN embedding_dimensions integer CHECK (embedding_dimensions > 0),
  ADD COLUMN embedding_content_hash text,
  ADD COLUMN embedding_updated_at timestamptz;

UPDATE chronicle_memories SET embedding = NULL WHERE embedding IS NOT NULL;

ALTER TABLE chronicle_memories
  ADD CONSTRAINT chronicle_memories_embedding_provider_owner_fk
    FOREIGN KEY (embedding_provider_profile_id, owner_user_id) REFERENCES provider_profiles(id, owner_user_id),
  ADD CONSTRAINT chronicle_memories_embedding_metadata_check CHECK (
    (embedding IS NULL AND embedding_provider_profile_id IS NULL AND embedding_model IS NULL
      AND embedding_dimensions IS NULL AND embedding_content_hash IS NULL AND embedding_updated_at IS NULL)
    OR
    (embedding IS NOT NULL AND embedding_provider_profile_id IS NOT NULL AND embedding_model IS NOT NULL
      AND embedding_dimensions IS NOT NULL AND embedding_content_hash IS NOT NULL AND embedding_updated_at IS NOT NULL)
  );

CREATE INDEX chronicle_memories_embedding_scope_idx
  ON chronicle_memories(owner_user_id, campaign_id, embedding_provider_profile_id, embedding_model)
  WHERE embedding IS NOT NULL;

ALTER TABLE chronicle_jobs DROP CONSTRAINT chronicle_jobs_job_type_check;
ALTER TABLE chronicle_jobs
  ADD CONSTRAINT chronicle_jobs_job_type_check CHECK (job_type IN ('reindex_campaign', 'embed_campaign'));
ALTER TABLE chronicle_jobs
  ADD COLUMN progress jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX chronicle_jobs_one_running_campaign_idx
  ON chronicle_jobs(campaign_id)
  WHERE status = 'running';
