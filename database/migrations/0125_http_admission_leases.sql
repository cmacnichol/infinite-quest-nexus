-- up migration
-- Coherent with offline exact-lease recovery and explicit activation guards.
-- Normal/non-HTTP lease expiry and the old INSERT/ON CONFLICT contract remain.
ALTER TABLE api_admission_leases ADD COLUMN request_running boolean NOT NULL DEFAULT false;
CREATE TABLE api_admission_recoveries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lease_id uuid NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  operation text NOT NULL CHECK(operation IN ('provider','import')),
  request_id text NOT NULL CHECK(length(request_id) BETWEEN 1 AND 200),
  maintenance_reference text NOT NULL CHECK(length(maintenance_reference) BETWEEN 3 AND 200),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  recovered_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER api_admission_recoveries_immutable BEFORE UPDATE OR DELETE ON api_admission_recoveries
FOR EACH ROW EXECUTE FUNCTION protect_instance_settings_evidence();
