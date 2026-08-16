CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE chronicle_memories
  ADD COLUMN content_hash text GENERATED ALWAYS AS (encode(digest(content, 'sha256'), 'hex')) STORED,
  ADD CONSTRAINT chronicle_memories_chunk_parent_scope_unique
    UNIQUE (id, owner_user_id, campaign_id, world_version_id);

ALTER TABLE campaign_memory_configs
  ADD COLUMN retrieval_implementation text NOT NULL DEFAULT 'legacy_hybrid'
    CHECK (retrieval_implementation IN ('legacy_hybrid', 'chunked_hybrid')),
  ADD COLUMN retrieval_shadow_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE chronicle_memory_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  world_version_id uuid NOT NULL,
  parent_memory_id uuid NOT NULL,
  parent_content_hash text NOT NULL CHECK (parent_content_hash ~ '^[0-9a-f]{64}$'),
  chunking_protocol_version text NOT NULL CHECK (length(btrim(chunking_protocol_version)) BETWEEN 1 AND 200),
  chunk_ordinal integer NOT NULL CHECK (chunk_ordinal >= 0),
  chunk_kind text NOT NULL CHECK (chunk_kind IN (
    'turn_action', 'turn_narration', 'legacy_summary', 'campaign_summary', 'canonical_fact', 'open_thread'
  )),
  content text NOT NULL,
  content_hash text GENERATED ALWAYS AS (encode(digest(content, 'sha256'), 'hex')) STORED,
  source_start_offset integer NOT NULL DEFAULT 0 CHECK (source_start_offset >= 0),
  source_end_offset integer NOT NULL DEFAULT 0 CHECK (source_end_offset >= source_start_offset),
  token_estimate integer NOT NULL CHECK (token_estimate >= 0),
  entities text[] NOT NULL DEFAULT ARRAY[]::text[],
  entity_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding vector,
  embedding_status text NOT NULL DEFAULT 'pending' CHECK (embedding_status IN ('pending', 'embedded', 'skipped')),
  embedding_skip_reason text CHECK (embedding_skip_reason IS NULL OR length(btrim(embedding_skip_reason)) BETWEEN 1 AND 512),
  embedding_provider_profile_id uuid,
  embedding_model text,
  embedding_dimensions integer CHECK (embedding_dimensions > 0),
  embedding_protocol_version text,
  embedding_provider_fingerprint text,
  embedding_content_hash text,
  embedding_updated_at timestamptz,
  search_document tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chronicle_memory_chunks_parent_version_ordinal_key
    UNIQUE (parent_memory_id, parent_content_hash, chunking_protocol_version, chunk_ordinal),
  FOREIGN KEY (parent_memory_id, owner_user_id, campaign_id, world_version_id)
    REFERENCES chronicle_memories (id, owner_user_id, campaign_id, world_version_id) ON DELETE CASCADE,
  FOREIGN KEY (campaign_id, owner_user_id)
    REFERENCES campaigns (id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (world_version_id, owner_user_id)
    REFERENCES world_versions (id, owner_user_id),
  FOREIGN KEY (embedding_provider_profile_id, owner_user_id)
    REFERENCES provider_profiles (id, owner_user_id),
  CONSTRAINT chronicle_memory_chunks_embedding_metadata_check CHECK (
    (embedding_status = 'pending'
      AND embedding IS NULL
      AND embedding_skip_reason IS NULL
      AND embedding_provider_profile_id IS NULL
      AND embedding_model IS NULL
      AND embedding_dimensions IS NULL
      AND embedding_protocol_version IS NULL
      AND embedding_provider_fingerprint IS NULL
      AND embedding_content_hash IS NULL
      AND embedding_updated_at IS NULL)
    OR
    (embedding_status = 'embedded'
      AND embedding IS NOT NULL
      AND embedding_skip_reason IS NULL
      AND embedding_provider_profile_id IS NOT NULL
      AND embedding_model IS NOT NULL
      AND embedding_dimensions IS NOT NULL
      AND embedding_protocol_version IS NOT NULL
      AND embedding_provider_fingerprint IS NOT NULL
      AND embedding_content_hash = content_hash
      AND embedding_updated_at IS NOT NULL)
    OR
    (embedding_status = 'skipped'
      AND embedding IS NULL
      AND embedding_skip_reason IS NOT NULL
      AND embedding_provider_profile_id IS NULL
      AND embedding_model IS NULL
      AND embedding_dimensions IS NULL
      AND embedding_protocol_version IS NULL
      AND embedding_provider_fingerprint IS NULL
      AND embedding_content_hash IS NULL
      AND embedding_updated_at IS NULL)
  )
);

CREATE INDEX chronicle_memory_chunks_scope_idx
  ON chronicle_memory_chunks(owner_user_id, campaign_id, world_version_id, parent_memory_id, chunk_ordinal);
CREATE INDEX chronicle_memory_chunks_search_idx
  ON chronicle_memory_chunks USING gin(search_document);
CREATE INDEX chronicle_memory_chunks_entity_ids_idx
  ON chronicle_memory_chunks USING gin(entity_ids);
CREATE INDEX chronicle_memory_chunks_embedded_scope_idx
  ON chronicle_memory_chunks(owner_user_id, campaign_id, world_version_id, embedding_provider_profile_id, embedding_model)
  WHERE embedding_status = 'embedded';

CREATE TABLE chronicle_chunk_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  job_type text NOT NULL DEFAULT 'index_memory_chunks_v2'
    CHECK (job_type = 'index_memory_chunks_v2'),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  work_version bigint NOT NULL DEFAULT 1 CHECK (work_version > 0),
  lease_owner text,
  lease_expires_at timestamptz,
  progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (campaign_id, owner_user_id)
    REFERENCES campaigns (id, owner_user_id) ON DELETE CASCADE,
  CONSTRAINT chronicle_chunk_jobs_lease_check CHECK (
    (status = 'running'
      AND lease_owner IS NOT NULL
      AND btrim(lease_owner) <> ''
      AND lease_expires_at IS NOT NULL)
    OR
    (status <> 'running' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT chronicle_chunk_jobs_completed_check CHECK (
    (status = 'completed' AND completed_at IS NOT NULL)
    OR (status <> 'completed' AND completed_at IS NULL)
  )
);

CREATE UNIQUE INDEX chronicle_chunk_jobs_one_active_campaign_idx
  ON chronicle_chunk_jobs(campaign_id)
  WHERE status IN ('queued', 'running');
CREATE INDEX chronicle_chunk_jobs_claim_idx
  ON chronicle_chunk_jobs(status, created_at)
  WHERE status = 'queued';
CREATE INDEX chronicle_chunk_jobs_running_lease_idx
  ON chronicle_chunk_jobs(status, lease_expires_at, created_at)
  WHERE status = 'running';

INSERT INTO chronicle_chunk_jobs (owner_user_id, campaign_id)
SELECT owner_user_id, campaign_id
  FROM campaign_memory_configs
 WHERE embedding_enabled
ON CONFLICT (campaign_id) WHERE status IN ('queued', 'running')
DO UPDATE SET work_version = chronicle_chunk_jobs.work_version + 1,
              updated_at = now();
