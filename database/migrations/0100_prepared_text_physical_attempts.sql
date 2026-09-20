-- Private wire-attempt ledger beneath existing logical text invocations.
-- One row represents one concrete model candidate and is never reused for a
-- second dispatch after its status reaches dispatched.
CREATE TABLE prepared_text_physical_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  logical_kind text NOT NULL CHECK (logical_kind IN ('story','authoring','illustration','direct')),
  reservation_key text NOT NULL CHECK (btrim(reservation_key) <> '' AND length(reservation_key) <= 1000),
  logical_reservation jsonb NOT NULL CHECK (jsonb_typeof(logical_reservation) = 'object'),
  plan_hash text NOT NULL CHECK (plan_hash ~ '^[0-9a-f]{64}$'),
  requested_preset_slug text,
  requested_preset_version_id text,
  requested_preset_config_hash text,
  candidate_ordinal integer NOT NULL CHECK (candidate_ordinal BETWEEN 0 AND 31),
  requested_model text NOT NULL CHECK (btrim(requested_model) <> '' AND length(requested_model) <= 500),
  provider_policy jsonb NOT NULL CHECK (jsonb_typeof(provider_policy) = 'object'),
  request_payload_hash text NOT NULL CHECK (request_payload_hash ~ '^[0-9a-f]{64}$'),
  request_body text NOT NULL,
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','dispatched','completed')),
  outcome text CHECK (outcome IN ('succeeded','failed')),
  failure_reason text CHECK (failure_reason IN (
    'rate_limit','provider_unavailable','model_unavailable','authentication','schema_invalid',
    'refusal','cancelled','deadline','ambiguous_transport','invalid_identity','unknown'
  )),
  provider_response_id text,
  returned_model text,
  returned_provider_route text,
  emitted_output boolean NOT NULL DEFAULT false,
  usage jsonb,
  reported_cost jsonb,
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  dispatched_at timestamptz,
  response_started_at timestamptz,
  completed_at timestamptz,
  UNIQUE (logical_kind, reservation_key, candidate_ordinal),
  CHECK ((status = 'reserved' AND dispatched_at IS NULL AND completed_at IS NULL AND outcome IS NULL)
      OR (status = 'dispatched' AND dispatched_at IS NOT NULL AND completed_at IS NULL AND outcome IS NULL)
      OR (status = 'completed' AND dispatched_at IS NOT NULL AND completed_at IS NOT NULL AND outcome IS NOT NULL)),
  CHECK ((outcome IS NULL AND failure_reason IS NULL)
      OR (outcome = 'succeeded' AND failure_reason IS NULL)
      OR (outcome = 'failed' AND failure_reason IS NOT NULL)),
  CHECK ((requested_preset_slug IS NULL AND requested_preset_version_id IS NULL AND requested_preset_config_hash IS NULL)
      OR (requested_preset_slug IS NOT NULL AND requested_preset_version_id IS NOT NULL AND requested_preset_config_hash IS NOT NULL
          AND btrim(requested_preset_slug) <> '' AND length(requested_preset_slug) <= 200
          AND btrim(requested_preset_version_id) <> '' AND length(requested_preset_version_id) <= 500
          AND requested_preset_config_hash ~ '^[0-9a-f]{64}$')),
  CHECK (usage IS NULL OR jsonb_typeof(usage) = 'object'),
  CHECK (reported_cost IS NULL OR jsonb_typeof(reported_cost) = 'object')
);

CREATE INDEX prepared_text_physical_attempts_owner_reserved_idx
  ON prepared_text_physical_attempts(owner_user_id, reserved_at DESC);

COMMENT ON TABLE prepared_text_physical_attempts IS
  'Private durable concrete-route attempts beneath Story, authoring, illustration, or request-scoped logical text reservations.';
