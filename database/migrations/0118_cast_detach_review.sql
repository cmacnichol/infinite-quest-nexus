-- Up Migration
ALTER TABLE campaign_cast_discovery_candidates ALTER COLUMN job_id DROP NOT NULL;
ALTER TABLE campaign_cast_discovery_candidates ADD CONSTRAINT cast_candidate_campaign_owner
  FOREIGN KEY(campaign_id,owner_user_id) REFERENCES campaigns(id,owner_user_id) ON DELETE CASCADE;
CREATE UNIQUE INDEX campaign_cast_detach_review_unique ON campaign_cast_discovery_candidates(campaign_id,local_key) WHERE job_id IS NULL;

-- Down Migration
DROP INDEX campaign_cast_detach_review_unique;
ALTER TABLE campaign_cast_discovery_candidates DROP CONSTRAINT cast_candidate_campaign_owner;
DELETE FROM campaign_cast_discovery_candidates WHERE job_id IS NULL;
ALTER TABLE campaign_cast_discovery_candidates ALTER COLUMN job_id SET NOT NULL;
