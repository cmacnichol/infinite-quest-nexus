-- Up Migration
ALTER TABLE instance_settings_revisions ADD COLUMN local_single_user boolean NOT NULL DEFAULT false;
ALTER TABLE instance_settings_events ADD COLUMN local_single_user boolean NOT NULL DEFAULT false;
ALTER TABLE instance_settings_revisions DROP CONSTRAINT instance_settings_revisions_check;
ALTER TABLE instance_settings_events DROP CONSTRAINT instance_settings_events_check;
ALTER TABLE instance_settings_revisions ADD CONSTRAINT instance_settings_revisions_actor_check CHECK (num_nonnulls(operator_session_id, cli_reference) + local_single_user::int = 1);
ALTER TABLE instance_settings_events ADD CONSTRAINT instance_settings_events_actor_check CHECK (num_nonnulls(operator_session_id, cli_reference) + local_single_user::int = 1);
-- Down Migration
-- Installation evidence is retained on application rollback.
