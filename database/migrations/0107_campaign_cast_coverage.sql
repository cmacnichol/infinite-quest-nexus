-- Up Migration
ALTER TABLE campaign_cast_state ADD COLUMN coverage_start_turn integer CHECK (coverage_start_turn > 0);
UPDATE campaign_cast_state s SET coverage_start_turn=enrollment.first_turn
FROM (SELECT j.campaign_id,min(j.turn_number) AS first_turn FROM campaign_cast_discovery_jobs j
  JOIN campaigns c ON c.id=j.campaign_id AND c.owner_user_id=j.owner_user_id
  WHERE j.status<>'cancelled' AND j.turn_number<=c.active_turn_number GROUP BY j.campaign_id) enrollment
WHERE s.campaign_id=enrollment.campaign_id;

-- Down Migration
ALTER TABLE campaign_cast_state DROP COLUMN coverage_start_turn;
