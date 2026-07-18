ALTER TABLE worlds
  ADD COLUMN forked_from_world_id uuid,
  ADD COLUMN forked_from_world_version_id uuid;

ALTER TABLE world_versions
  ADD COLUMN release_notes text NOT NULL DEFAULT '',
  ADD COLUMN created_from_revision integer;

CREATE TABLE world_drafts (
  world_id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  based_on_world_version_id uuid,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  content jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id, owner_user_id),
  FOREIGN KEY (world_id, owner_user_id) REFERENCES worlds(id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (based_on_world_version_id, owner_user_id) REFERENCES world_versions(id, owner_user_id)
);

CREATE INDEX world_drafts_owner_updated_idx
  ON world_drafts(owner_user_id, updated_at DESC);

ALTER TABLE worlds
  ADD CONSTRAINT worlds_forked_world_owner_fk
  FOREIGN KEY (forked_from_world_id, owner_user_id) REFERENCES worlds(id, owner_user_id);

ALTER TABLE worlds
  ADD CONSTRAINT worlds_forked_version_owner_fk
  FOREIGN KEY (forked_from_world_version_id, owner_user_id) REFERENCES world_versions(id, owner_user_id);

CREATE TABLE campaign_world_migrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  campaign_id uuid NOT NULL,
  from_world_version_id uuid NOT NULL,
  to_world_version_id uuid NOT NULL,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (from_world_version_id, owner_user_id) REFERENCES world_versions(id, owner_user_id),
  FOREIGN KEY (to_world_version_id, owner_user_id) REFERENCES world_versions(id, owner_user_id),
  CHECK (from_world_version_id <> to_world_version_id)
);

CREATE INDEX campaign_world_migrations_scope_idx
  ON campaign_world_migrations(owner_user_id, campaign_id, created_at DESC);

INSERT INTO world_drafts (world_id, owner_user_id, based_on_world_version_id, revision, content)
SELECT w.id, w.owner_user_id, latest.id, 1, latest.content
  FROM worlds w
  JOIN LATERAL (
    SELECT id, content
      FROM world_versions
     WHERE world_id = w.id AND owner_user_id = w.owner_user_id
     ORDER BY version_number DESC
     LIMIT 1
  ) latest ON true
ON CONFLICT (world_id) DO NOTHING;
