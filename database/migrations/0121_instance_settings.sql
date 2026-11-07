-- Up Migration
CREATE TABLE settings_operator_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_user_id uuid NOT NULL REFERENCES users(id),
  token_digest text NOT NULL UNIQUE CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  csrf_digest text NOT NULL CHECK (csrf_digest ~ '^[a-f0-9]{64}$'), key_fingerprint text NOT NULL CHECK (key_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes')
);
CREATE INDEX settings_operator_sessions_expiry ON settings_operator_sessions(expires_at);
CREATE TABLE settings_unlock_attempts (
  bucket text PRIMARY KEY, window_start timestamptz NOT NULL, attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 1001)
);
CREATE TABLE instance_settings_revisions (
  revision bigint PRIMARY KEY CHECK (revision > 0), previous_revision bigint REFERENCES instance_settings_revisions(revision),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'), schema_version integer NOT NULL CHECK (schema_version=1),
  actor_user_id uuid NOT NULL REFERENCES users(id), operator_session_id uuid,
  cli_reference text CHECK (length(cli_reference) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('seed','proposal','rollback')), policy_digest text NOT NULL CHECK (policy_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((operator_session_id IS NULL) <> (cli_reference IS NULL)),
  CHECK ((revision=1 AND previous_revision IS NULL AND kind='seed') OR (revision>1 AND previous_revision=revision-1 AND kind<>'seed'))
);
CREATE TABLE instance_settings_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), installation_id uuid,
  active_revision bigint REFERENCES instance_settings_revisions(revision), requested_revision bigint REFERENCES instance_settings_revisions(revision),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version=1), mode text NOT NULL DEFAULT 'environment' CHECK (mode IN ('environment','database')),
  activation_epoch bigint NOT NULL DEFAULT 0 CHECK (activation_epoch>=0), seed_digest text CHECK (seed_digest ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((mode='environment' AND active_revision IS NULL) OR (mode='database' AND active_revision IS NOT NULL)),
  CHECK ((requested_revision IS NULL AND installation_id IS NULL AND seed_digest IS NULL) OR (requested_revision IS NOT NULL AND installation_id IS NOT NULL AND seed_digest IS NOT NULL))
);
INSERT INTO instance_settings_state DEFAULT VALUES;
CREATE TABLE instance_settings_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, kind text NOT NULL CHECK (kind IN ('seed','proposal','rollback','activation','cancellation')),
  revision bigint NOT NULL REFERENCES instance_settings_revisions(revision), actor_user_id uuid NOT NULL REFERENCES users(id),
  operator_session_id uuid, cli_reference text CHECK (length(cli_reference) BETWEEN 1 AND 200),
  maintenance_reference text CHECK (length(maintenance_reference) BETWEEN 1 AND 200),
  reason_code text NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), CHECK ((operator_session_id IS NULL) <> (cli_reference IS NULL))
);
CREATE TABLE instance_settings_runtime_reports (
  process_id uuid PRIMARY KEY, role text NOT NULL CHECK (role IN ('api','worker','all')), build_version text NOT NULL,
  protocol_version integer NOT NULL CHECK (protocol_version>0), active_revision bigint REFERENCES instance_settings_revisions(revision),
  policy_digest text NOT NULL CHECK (policy_digest ~ '^[a-f0-9]{64}$'), activation_epoch bigint NOT NULL CHECK (activation_epoch>=0),
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(), effective_configuration_digest text NOT NULL CHECK (effective_configuration_digest ~ '^[a-f0-9]{64}$'),
  readiness_state text NOT NULL CHECK (readiness_state IN ('ready','blocked','stopping'))
);
CREATE FUNCTION protect_instance_settings_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable_instance_settings_evidence'; END;
$$;
CREATE TRIGGER instance_settings_revisions_immutable BEFORE UPDATE OR DELETE ON instance_settings_revisions FOR EACH ROW EXECUTE FUNCTION protect_instance_settings_evidence();
CREATE TRIGGER instance_settings_events_immutable BEFORE UPDATE OR DELETE ON instance_settings_events FOR EACH ROW EXECUTE FUNCTION protect_instance_settings_evidence();
-- Down Migration
-- Installation evidence is retained on application rollback.
