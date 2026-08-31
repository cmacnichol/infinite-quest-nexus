ALTER TABLE campaign_canonical_facts
  DROP CONSTRAINT campaign_canonical_facts_source_turn_number_check,
  DROP CONSTRAINT campaign_canonical_facts_valid_from_turn_check,
  ADD CONSTRAINT campaign_canonical_facts_source_turn_number_check
    CHECK (
      source_turn_number > 0
      OR (source_turn_number = 0 AND source_state_edit_id IS NOT NULL)
    ),
  ADD CONSTRAINT campaign_canonical_facts_valid_from_turn_check
    CHECK (
      valid_from_turn > 0
      OR (valid_from_turn = 0 AND source_state_edit_id IS NOT NULL)
    );

COMMENT ON COLUMN campaign_canonical_facts.source_turn_number IS
  'Accepted-turn facts begin after turn zero. Manual state-correction facts may begin at editable turn zero.';
COMMENT ON COLUMN campaign_canonical_facts.valid_from_turn IS
  'Inclusive active-turn boundary. Turn zero is valid only for a manual state-correction fact.';
