CREATE TABLE prompt_template_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  prompt_key text NOT NULL,
  content text NOT NULL CHECK (char_length(btrim(content)) > 0 AND char_length(content) <= 16000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((campaign_id IS NULL) OR owner_user_id IS NOT NULL),
  UNIQUE NULLS NOT DISTINCT (owner_user_id, campaign_id, prompt_key)
);

CREATE INDEX prompt_template_overrides_owner_campaign_idx
  ON prompt_template_overrides(owner_user_id, campaign_id, prompt_key);

ALTER TABLE generation_jobs
  ADD COLUMN prompt_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE illustration_prompt_jobs
  ADD COLUMN prompt_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

INSERT INTO prompt_template_overrides (owner_user_id, campaign_id, prompt_key, content)
SELECT owner_user_id, campaign_id, 'illustration_refinement', refinement_prompt
  FROM campaign_illustration_configs
 WHERE btrim(refinement_prompt) <> ''
ON CONFLICT (owner_user_id, campaign_id, prompt_key) DO NOTHING;

COMMENT ON TABLE prompt_template_overrides IS
  'User-owned application defaults and campaign-specific overrides for application-owned LLM instruction templates.';
COMMENT ON COLUMN generation_jobs.prompt_snapshot IS
  'Effective prompt templates captured at queue time. Retries must use this immutable job snapshot.';
COMMENT ON COLUMN illustration_prompt_jobs.prompt_snapshot IS
  'Effective illustration refinement template captured at queue time.';
