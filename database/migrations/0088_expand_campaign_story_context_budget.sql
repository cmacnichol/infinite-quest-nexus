ALTER TABLE campaigns
  DROP CONSTRAINT campaigns_story_context_budget_tokens_check,
  ADD CONSTRAINT campaigns_story_context_budget_tokens_check
    CHECK (story_context_budget_tokens IN (32000, 64000, 128000, 256000, 1000000, 2000000, 4000000));

COMMENT ON COLUMN campaigns.story_context_budget_tokens IS
  'Desired upper Story context target for newly enqueued generation jobs; runtime provider limits still apply.';
