-- up migration
CREATE TABLE local_settings_restart_operations (
  id uuid PRIMARY KEY,
  revision bigint NOT NULL REFERENCES instance_settings_revisions(revision),
  expected_active_revision bigint REFERENCES instance_settings_revisions(revision),
  expected_epoch bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('draining','restarting','failed','ready')),
  error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX local_settings_restart_one_pending ON local_settings_restart_operations ((true)) WHERE status IN ('draining','restarting');
