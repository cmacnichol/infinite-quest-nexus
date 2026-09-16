CREATE TABLE campaign_story_memory_enrollments (
  campaign_id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL,
  capability text NOT NULL CHECK (capability IN ('r1','r2','r3')),
  review_mode text NOT NULL CHECK (review_mode IN ('off','observe','enforce')),
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id) ON DELETE CASCADE,
  CHECK (
    (capability IN ('r1','r2') AND review_mode = 'off')
    OR (capability = 'r3' AND review_mode IN ('off','observe','enforce'))
  )
);

CREATE INDEX campaign_story_memory_enrollments_owner_campaign_idx
  ON campaign_story_memory_enrollments(owner_user_id, campaign_id);
