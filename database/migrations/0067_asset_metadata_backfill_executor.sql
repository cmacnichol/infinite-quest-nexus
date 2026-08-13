-- Up Migration
-- Private Task 14e3e5 state: an existing original remains authoritative while
-- a claimed executor attaches one deterministic thumbnail and reconciles its
-- post-commit filesystem finalization without re-decoding on restart.

CREATE TABLE asset_metadata_backfill_publications (
  owner_user_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  work_version integer NOT NULL CHECK (work_version > 0),
  expected_content_hash text NOT NULL CHECK (expected_content_hash ~ '^[0-9a-f]{64}$'),
  thumbnail_content_hash text NOT NULL CHECK (thumbnail_content_hash ~ '^[0-9a-f]{64}$'),
  filesystem_operation_id uuid NOT NULL UNIQUE REFERENCES durable_filesystem_operations(id),
  lifecycle text NOT NULL CHECK (lifecycle IN ('attached', 'published')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  PRIMARY KEY (owner_user_id, asset_id),
  FOREIGN KEY (asset_id, owner_user_id)
    REFERENCES assets(id, owner_user_id) ON DELETE CASCADE,
  CONSTRAINT asset_metadata_backfill_publication_published_check CHECK (
    (lifecycle = 'published' AND published_at IS NOT NULL)
    OR (lifecycle = 'attached' AND published_at IS NULL)
  )
);

CREATE INDEX asset_metadata_backfill_publication_pending_idx
  ON asset_metadata_backfill_publications(owner_user_id, asset_id)
  WHERE lifecycle = 'attached';

-- Down Migration
DROP TABLE IF EXISTS asset_metadata_backfill_publications;
