ALTER TABLE campaigns
  ADD COLUMN turn_control_style text NOT NULL DEFAULT 'flexible_action'
  CHECK (turn_control_style IN ('action_only', 'flexible_auto', 'flexible_action', 'flexible_scene'));

ALTER TABLE generation_jobs
  ADD COLUMN requested_input_mode text NOT NULL DEFAULT 'action'
    CHECK (requested_input_mode IN ('auto', 'action', 'scene')),
  ADD COLUMN resolved_input_mode text NOT NULL DEFAULT 'action'
    CHECK (resolved_input_mode IN ('action', 'scene')),
  ADD COLUMN input_mode_source text NOT NULL DEFAULT 'explicit'
    CHECK (input_mode_source IN ('explicit', 'auto', 'generated_choice', 'opening_action', 'fallback'));

ALTER TABLE turns
  ADD COLUMN input_mode text NOT NULL DEFAULT 'action'
    CHECK (input_mode IN ('action', 'scene')),
  ADD COLUMN input_mode_source text NOT NULL DEFAULT 'explicit'
    CHECK (input_mode_source IN ('explicit', 'auto', 'generated_choice', 'opening_action', 'fallback'));

CREATE TABLE turn_input_classifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  input_hash text NOT NULL,
  requested_selection text NOT NULL DEFAULT 'auto' CHECK (requested_selection = 'auto'),
  classification text NOT NULL CHECK (classification IN ('action', 'scene', 'mixed', 'uncertain')),
  resolved_mode text NOT NULL CHECK (resolved_mode IN ('action', 'scene')),
  confidence_band text NOT NULL CHECK (confidence_band IN ('clear', 'probable', 'ambiguous')),
  provider_profile_id uuid REFERENCES provider_profiles(id) ON DELETE SET NULL,
  provider_source text NOT NULL CHECK (provider_source IN ('intent_default', 'story_text', 'campaign_fallback')),
  diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  consumed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id)
);

CREATE INDEX turn_input_classifications_scope_idx
  ON turn_input_classifications(owner_user_id, campaign_id, created_at DESC);

ALTER TABLE generation_jobs
  ADD COLUMN turn_input_classification_id uuid REFERENCES turn_input_classifications(id) ON DELETE SET NULL;

COMMENT ON TABLE turn_input_classifications IS
  'Short-lived private audit records for Auto mode. Raw player input is never duplicated here; only a hash is stored.';
