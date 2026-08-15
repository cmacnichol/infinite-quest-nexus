-- Up Migration

CREATE TABLE turn_narration_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  campaign_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  narration text NOT NULL CHECK (length(btrim(narration)) BETWEEN 1 AND 200000),
  previous_effective_narration_hash text NOT NULL
    CHECK (previous_effective_narration_hash ~ '^[0-9a-f]{64}$'),
  reason text CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 2000),
  source text NOT NULL CHECK (source IN ('user_edit','legacy_import','administrative')),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (turn_id, campaign_id, owner_user_id, revision),
  FOREIGN KEY (campaign_id, owner_user_id)
    REFERENCES campaigns(id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id, campaign_id, owner_user_id)
    REFERENCES turns(id, campaign_id, owner_user_id) ON DELETE CASCADE,
  CHECK (created_by_user_id = owner_user_id)
);

CREATE INDEX turn_narration_corrections_effective_idx
  ON turn_narration_corrections(owner_user_id, campaign_id, turn_id, revision DESC);

CREATE VIEW effective_turn_narrations AS
SELECT turn_row.id AS turn_id,
       turn_row.owner_user_id,
       turn_row.campaign_id,
       turn_row.turn_number,
       turn_row.narration AS original_narration,
       COALESCE(correction.narration, turn_row.narration) AS effective_narration,
       COALESCE(correction.revision, 0) AS correction_revision,
       correction.created_at AS corrected_at
  FROM turns turn_row
  LEFT JOIN LATERAL (
    SELECT candidate.narration, candidate.revision, candidate.created_at
      FROM turn_narration_corrections candidate
     WHERE candidate.owner_user_id = turn_row.owner_user_id
       AND candidate.campaign_id = turn_row.campaign_id
       AND candidate.turn_id = turn_row.id
     ORDER BY candidate.revision DESC
     LIMIT 1
  ) correction ON true;

COMMENT ON TABLE turn_narration_corrections IS
  'Append-only accepted-turn narration corrections. The immutable turns.narration ledger remains unchanged.';
COMMENT ON VIEW effective_turn_narrations IS
  'Single authoritative projection for consumers that need the latest accepted narration correction.';

-- Down Migration

DROP VIEW IF EXISTS effective_turn_narrations;
DROP TABLE IF EXISTS turn_narration_corrections;
