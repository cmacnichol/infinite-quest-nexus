DELETE FROM summary_checkpoints older
 USING summary_checkpoints newer
 WHERE older.campaign_id = newer.campaign_id
   AND older.summary_kind = newer.summary_kind
   AND older.through_turn = newer.through_turn
   AND (older.created_at, older.id) < (newer.created_at, newer.id);

CREATE UNIQUE INDEX summary_checkpoints_campaign_kind_turn_idx
  ON summary_checkpoints(campaign_id, summary_kind, through_turn);

COMMENT ON INDEX summary_checkpoints_campaign_kind_turn_idx IS
  'Makes versioned derived checkpoint rewrites idempotent during Chronicle rebuilds.';
