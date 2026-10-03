ALTER TABLE generation_jobs ADD COLUMN activity_revision bigint NOT NULL DEFAULT 0 CHECK (activity_revision >= 0);
ALTER TABLE image_jobs ADD COLUMN activity_revision bigint NOT NULL DEFAULT 0 CHECK (activity_revision >= 0);
ALTER TABLE turn_illustration_segments ADD COLUMN activity_revision bigint NOT NULL DEFAULT 0 CHECK (activity_revision >= 0);

CREATE TABLE campaign_activity_history (
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL,
  captured_since timestamptz NOT NULL,
  retention_floor_sequence bigint NOT NULL DEFAULT 0 CHECK (retention_floor_sequence >= 0),
  last_published_sequence bigint NOT NULL DEFAULT 0 CHECK (last_published_sequence >= retention_floor_sequence),
  PRIMARY KEY (owner_user_id, campaign_id),
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id) ON DELETE CASCADE
);
CREATE TABLE activity_event_outbox (
  event_id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('generation','image','illustration_segment')),
  source_id uuid NOT NULL,
  activity_revision bigint NOT NULL CHECK (activity_revision >= 0),
  ordinal integer NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
  occurred_at timestamptz NOT NULL,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  published_at timestamptz,
  quarantine_code text CHECK (quarantine_code IN ('invalid_snapshot')),
  UNIQUE (source, source_id, activity_revision, ordinal),
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id) ON DELETE CASCADE
);
CREATE INDEX activity_outbox_pending ON activity_event_outbox(occurred_at,event_id) WHERE published_at IS NULL AND quarantine_code IS NULL;
CREATE INDEX activity_outbox_scope ON activity_event_outbox(owner_user_id,campaign_id);
CREATE INDEX activity_outbox_receipt_retention ON activity_event_outbox(published_at,event_id) WHERE published_at IS NOT NULL AND quarantine_code IS NULL;
CREATE TABLE story_activity_events (
  event_id uuid PRIMARY KEY,
  sequence bigserial UNIQUE NOT NULL CHECK (sequence > 0),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  published_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('generation','image','illustration_segment')),
  kind text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info','warning','error','success')),
  job_id uuid,
  generation_job_id uuid,
  segment_id uuid,
  turn_id uuid,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id) ON DELETE CASCADE
);
CREATE INDEX story_activity_scope_sequence ON story_activity_events(owner_user_id,campaign_id,sequence DESC);
CREATE INDEX story_activity_retention ON story_activity_events(published_at,sequence);
