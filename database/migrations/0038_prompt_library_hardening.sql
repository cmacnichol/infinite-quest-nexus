ALTER TABLE prompt_template_overrides
  DROP CONSTRAINT IF EXISTS prompt_template_overrides_campaign_id_fkey;

ALTER TABLE prompt_template_overrides
  DROP CONSTRAINT IF EXISTS prompt_template_overrides_check;

ALTER TABLE prompt_template_overrides
  ADD CONSTRAINT prompt_template_overrides_campaign_owner_fk
  FOREIGN KEY (campaign_id, owner_user_id)
  REFERENCES campaigns(id, owner_user_id)
  ON DELETE CASCADE;

COMMENT ON CONSTRAINT prompt_template_overrides_campaign_owner_fk
  ON prompt_template_overrides IS
  'Campaign prompt overrides must belong to the same owner as their campaign.';
