CREATE TABLE chronicle_retrieval_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  world_version_id uuid NOT NULL,
  query_hash text NOT NULL CHECK (query_hash ~ '^[0-9a-f]{64}$'),
  production_implementation text NOT NULL
    CHECK (production_implementation IN ('legacy_hybrid', 'chunked_hybrid')),
  shadow_enabled boolean NOT NULL,
  retrieval_version text NOT NULL CHECK (retrieval_version ~ '^[a-z0-9][a-z0-9_.:-]{0,199}$'),
  embedding_protocol_version text NOT NULL
    CHECK (embedding_protocol_version ~ '^[a-z0-9][a-z0-9_.:-]{0,199}$'),
  chunk_protocol_version text NOT NULL
    CHECK (chunk_protocol_version ~ '^[a-z0-9][a-z0-9_.:-]{0,199}$'),
  provider_fingerprint text CHECK (
    provider_fingerprint IS NULL OR (
      length(provider_fingerprint) BETWEEN 1 AND 512
      AND provider_fingerprint ~ '^[A-Za-z0-9_.:-]+$'
    )
  ),
  query_token_estimate integer NOT NULL CHECK (query_token_estimate >= 0),
  cost_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  lexical_latency_ms integer CHECK (lexical_latency_ms >= 0),
  lexical_fallback_code text CHECK (
    lexical_fallback_code IS NULL OR lexical_fallback_code ~ '^[a-z0-9][a-z0-9_.:-]{0,199}$'
  ),
  legacy_hybrid_latency_ms integer CHECK (legacy_hybrid_latency_ms >= 0),
  legacy_hybrid_fallback_code text CHECK (
    legacy_hybrid_fallback_code IS NULL OR legacy_hybrid_fallback_code ~ '^[a-z0-9][a-z0-9_.:-]{0,199}$'
  ),
  chunked_hybrid_latency_ms integer CHECK (chunked_hybrid_latency_ms >= 0),
  chunked_hybrid_fallback_code text CHECK (
    chunked_hybrid_fallback_code IS NULL OR chunked_hybrid_fallback_code ~ '^[a-z0-9][a-z0-9_.:-]{0,199}$'
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT chronicle_retrieval_runs_scope_unique
    UNIQUE (id, owner_user_id, campaign_id, world_version_id),
  FOREIGN KEY (campaign_id, owner_user_id)
    REFERENCES campaigns (id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (world_version_id, owner_user_id)
    REFERENCES world_versions (id, owner_user_id)
);

CREATE INDEX chronicle_retrieval_runs_retention_idx
  ON chronicle_retrieval_runs(campaign_id, created_at DESC, id DESC);

CREATE TABLE chronicle_retrieval_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  world_version_id uuid NOT NULL,
  implementation text NOT NULL
    CHECK (implementation IN ('lexical', 'legacy_hybrid', 'chunked_hybrid')),
  candidate_id text NOT NULL CHECK (candidate_id ~ '^[A-Za-z0-9_.:-]{1,200}$'),
  parent_memory_id uuid NOT NULL,
  rank integer NOT NULL CHECK (rank BETWEEN 1 AND 10000),
  reason text NOT NULL CHECK (reason ~ '^[a-z0-9][a-z0-9_.:-]{0,199}$'),
  token_estimate integer NOT NULL CHECK (token_estimate >= 0),
  selected boolean NOT NULL,
  production_selection boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (run_id, owner_user_id, campaign_id, world_version_id)
    REFERENCES chronicle_retrieval_runs (id, owner_user_id, campaign_id, world_version_id) ON DELETE CASCADE,
  FOREIGN KEY (campaign_id, owner_user_id)
    REFERENCES campaigns (id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (parent_memory_id, owner_user_id, campaign_id, world_version_id)
    REFERENCES chronicle_memories (id, owner_user_id, campaign_id, world_version_id) ON DELETE CASCADE,
  CONSTRAINT chronicle_retrieval_candidates_run_candidate_unique
    UNIQUE (run_id, implementation, candidate_id)
);

CREATE INDEX chronicle_retrieval_candidates_scope_idx
  ON chronicle_retrieval_candidates(campaign_id, run_id, implementation, rank);

COMMENT ON TABLE chronicle_retrieval_runs IS
  'Safe Chronicle comparison metadata only; raw query, action, narration, prompts, responses, endpoints, and credentials are forbidden.';
COMMENT ON TABLE chronicle_retrieval_candidates IS
  'Safe Chronicle candidate IDs, ranks, reason codes, token estimates, and selection flags only.';
