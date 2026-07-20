ALTER TABLE chronicle_jobs
  ADD CONSTRAINT chronicle_jobs_id_owner_unique UNIQUE (id, owner_user_id);

CREATE TABLE provider_cost_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  campaign_id uuid NOT NULL,
  turn_id uuid REFERENCES turns(id) ON DELETE SET NULL,
  provider_profile_id uuid,
  generation_job_id uuid,
  image_job_id uuid,
  chronicle_job_id uuid,
  local_call_id uuid NOT NULL DEFAULT gen_random_uuid(),
  provider_type text NOT NULL,
  provider_response_id text,
  category text NOT NULL CHECK (category IN ('story', 'image', 'memory')),
  operation text NOT NULL,
  requested_model text NOT NULL DEFAULT '',
  resolved_model text NOT NULL DEFAULT '',
  amount numeric(24,12) NOT NULL CHECK (amount >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  usage_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, local_call_id),
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (provider_profile_id, owner_user_id) REFERENCES provider_profiles(id, owner_user_id) ON DELETE SET NULL (provider_profile_id),
  FOREIGN KEY (generation_job_id, owner_user_id) REFERENCES generation_jobs(id, owner_user_id) ON DELETE SET NULL (generation_job_id),
  FOREIGN KEY (image_job_id, owner_user_id) REFERENCES image_jobs(id, owner_user_id) ON DELETE SET NULL (image_job_id),
  FOREIGN KEY (chronicle_job_id, owner_user_id) REFERENCES chronicle_jobs(id, owner_user_id) ON DELETE SET NULL (chronicle_job_id)
);

CREATE UNIQUE INDEX provider_cost_events_provider_response_idx
  ON provider_cost_events(owner_user_id, provider_type, provider_response_id)
  WHERE provider_response_id IS NOT NULL AND provider_response_id <> '';

CREATE INDEX provider_cost_events_campaign_idx
  ON provider_cost_events(owner_user_id, campaign_id, currency, occurred_at DESC);

CREATE INDEX provider_cost_events_turn_idx
  ON provider_cost_events(owner_user_id, turn_id, currency)
  WHERE turn_id IS NOT NULL;

CREATE INDEX provider_cost_events_generation_job_idx
  ON provider_cost_events(generation_job_id)
  WHERE generation_job_id IS NOT NULL;

COMMENT ON TABLE provider_cost_events IS
  'Append-only provider-reported campaign charges. Missing provider cost data never creates a row.';
