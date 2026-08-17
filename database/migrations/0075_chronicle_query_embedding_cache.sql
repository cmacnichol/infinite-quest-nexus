CREATE TABLE chronicle_query_embedding_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  normalized_query_hash text NOT NULL CHECK (normalized_query_hash ~ '^[0-9a-f]{64}$'),
  provider_profile_id uuid NOT NULL,
  embedding_model_hash text NOT NULL CHECK (embedding_model_hash ~ '^[0-9a-f]{64}$'),
  provider_fingerprint_hash text NOT NULL CHECK (provider_fingerprint_hash ~ '^[0-9a-f]{64}$'),
  query_prefix_hash text NOT NULL CHECK (query_prefix_hash ~ '^[0-9a-f]{64}$'),
  embedding_protocol_version text NOT NULL
    CHECK (embedding_protocol_version ~ '^[a-z0-9][a-z0-9_.:-]{0,199}$'),
  embedding vector NOT NULL,
  embedding_dimensions integer NOT NULL CHECK (embedding_dimensions BETWEEN 1 AND 16000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_accessed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '7 days'),
  hit_count bigint NOT NULL DEFAULT 0 CHECK (hit_count >= 0),
  CONSTRAINT chronicle_query_embedding_cache_scope_unique UNIQUE (
    owner_user_id,
    campaign_id,
    normalized_query_hash,
    provider_profile_id,
    embedding_model_hash,
    provider_fingerprint_hash,
    query_prefix_hash,
    embedding_protocol_version
  ),
  CONSTRAINT chronicle_query_embedding_cache_dimensions_match
    CHECK (vector_dims(embedding) = embedding_dimensions),
  FOREIGN KEY (campaign_id, owner_user_id)
    REFERENCES campaigns (id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (provider_profile_id, owner_user_id)
    REFERENCES provider_profiles (id, owner_user_id) ON DELETE CASCADE
);

CREATE INDEX chronicle_query_embedding_cache_lru_idx
  ON chronicle_query_embedding_cache(owner_user_id, campaign_id, last_accessed_at DESC, created_at DESC, id DESC);

CREATE INDEX chronicle_query_embedding_cache_expiry_idx
  ON chronicle_query_embedding_cache(expires_at);

COMMENT ON TABLE chronicle_query_embedding_cache IS
  'Scoped derived query vectors only; raw queries, expanded queries, prefixes, model names, provider fingerprints, prompts, responses, endpoints, and credentials are forbidden.';
COMMENT ON COLUMN chronicle_query_embedding_cache.normalized_query_hash IS
  'SHA-256 of the normalized expanded query; never the query text.';
COMMENT ON COLUMN chronicle_query_embedding_cache.embedding_model_hash IS
  'SHA-256 of the embedding model identity; never the raw model name.';
COMMENT ON COLUMN chronicle_query_embedding_cache.provider_fingerprint_hash IS
  'SHA-256 of the safe provider fingerprint; never provider configuration or credentials.';
COMMENT ON COLUMN chronicle_query_embedding_cache.query_prefix_hash IS
  'SHA-256 of the effective query prefix; never the prefix text.';
