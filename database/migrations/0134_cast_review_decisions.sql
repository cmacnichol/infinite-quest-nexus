-- Up Migration
ALTER TABLE campaign_cast_discovery_candidates
  ADD CONSTRAINT cast_candidate_id_scope_unique UNIQUE (id, campaign_id, owner_user_id);

CREATE TABLE campaign_cast_review_sequences (
  campaign_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  PRIMARY KEY (campaign_id, owner_user_id),
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id) ON DELETE CASCADE
);

CREATE TABLE campaign_cast_review_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  narration_revision integer NOT NULL CHECK (narration_revision >= 0),
  timeline_revision integer NOT NULL CHECK (timeline_revision >= 0),
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  source jsonb NOT NULL CHECK (jsonb_typeof(source) = 'object'),
  target_kind text NOT NULL CHECK (target_kind IN ('identity', 'detail')),
  observation_index integer CHECK (observation_index BETWEEN 0 AND 19),
  target_payload jsonb NOT NULL CHECK (jsonb_typeof(target_payload) = 'object'),
  target_fingerprint text NOT NULL CHECK (target_fingerprint ~ '^[a-f0-9]{64}$'),
  action text NOT NULL CHECK (action IN ('dismiss', 'restore')),
  restores_decision_id uuid,
  revision bigint NOT NULL CHECK (revision > 0),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  result_receipt jsonb NOT NULL CHECK (jsonb_typeof(result_receipt) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((target_kind = 'detail') = (observation_index IS NOT NULL)),
  CHECK ((action = 'restore') = (restores_decision_id IS NOT NULL)),
  UNIQUE (id, campaign_id, owner_user_id),
  UNIQUE (campaign_id, owner_user_id, revision),
  UNIQUE (campaign_id, owner_user_id, idempotency_key),
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id),
  FOREIGN KEY (candidate_id, campaign_id, owner_user_id) REFERENCES campaign_cast_discovery_candidates(id, campaign_id, owner_user_id),
  FOREIGN KEY (turn_id, campaign_id, owner_user_id) REFERENCES turns(id, campaign_id, owner_user_id),
  FOREIGN KEY (restores_decision_id, campaign_id, owner_user_id) REFERENCES campaign_cast_review_decisions(id, campaign_id, owner_user_id)
);
CREATE INDEX cast_review_decisions_fingerprint ON campaign_cast_review_decisions (owner_user_id, campaign_id, target_fingerprint, revision);
CREATE INDEX cast_review_decisions_restore ON campaign_cast_review_decisions (owner_user_id, campaign_id, restores_decision_id) WHERE restores_decision_id IS NOT NULL;
CREATE FUNCTION reject_cast_review_decision_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'cast review decisions are append-only' USING ERRCODE = '55000';
END $$;
CREATE TRIGGER cast_review_decision_immutable BEFORE UPDATE OR DELETE ON campaign_cast_review_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_cast_review_decision_mutation();

-- Down Migration
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM campaign_cast_review_decisions) THEN
    RAISE EXCEPTION 'Cannot remove retained cast review decisions';
  END IF;
END $$;
DROP TRIGGER cast_review_decision_immutable ON campaign_cast_review_decisions;
DROP FUNCTION reject_cast_review_decision_mutation();
DROP TABLE campaign_cast_review_decisions;
DROP TABLE campaign_cast_review_sequences;
ALTER TABLE campaign_cast_discovery_candidates DROP CONSTRAINT cast_candidate_id_scope_unique;
