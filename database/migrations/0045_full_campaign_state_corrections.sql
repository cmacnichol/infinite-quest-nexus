ALTER TABLE campaign_state_edits
  ADD CONSTRAINT campaign_state_edits_owner_identity
  UNIQUE (id, campaign_id, owner_user_id);

ALTER TABLE generation_jobs
  ADD COLUMN state_edit_id uuid,
  ADD COLUMN state_edit_revision integer CHECK (state_edit_revision IS NULL OR state_edit_revision > 0),
  ADD COLUMN state_edit_snapshot_private jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT generation_jobs_state_edit_owner_fk
    FOREIGN KEY (state_edit_id, campaign_id, owner_user_id)
    REFERENCES campaign_state_edits(id, campaign_id, owner_user_id);

ALTER TABLE campaign_canonical_facts
  ALTER COLUMN source_turn_id DROP NOT NULL,
  ADD COLUMN source_state_edit_id uuid,
  ADD CONSTRAINT campaign_canonical_facts_source_edit_owner_fk
    FOREIGN KEY (source_state_edit_id, campaign_id, owner_user_id)
    REFERENCES campaign_state_edits(id, campaign_id, owner_user_id) ON DELETE CASCADE,
  ADD CONSTRAINT campaign_canonical_facts_exactly_one_source
    CHECK (num_nonnulls(source_turn_id, source_state_edit_id) = 1);

CREATE UNIQUE INDEX campaign_canonical_facts_edit_source_idx
  ON campaign_canonical_facts(campaign_id, source_state_edit_id, source_fact_index)
  WHERE source_state_edit_id IS NOT NULL;

COMMENT ON COLUMN generation_jobs.state_edit_snapshot_private IS
  'Complete manual state correction captured for durable latest-turn replacement. Never return it to clients or prompts.';
COMMENT ON COLUMN campaign_canonical_facts.source_state_edit_id IS
  'Append-only manual state edit that projected this canonical fact; exactly one source is required.';
