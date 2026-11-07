-- Up Migration
-- Recovery establishes local quiescence. The provider outcome remains unknown.
CREATE TABLE cancelled_dispatch_recoveries (
  attempt_id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL,
  parent_job_id uuid NOT NULL,
  logical_kind text NOT NULL CHECK (logical_kind IN ('story','cast_discovery')),
  attempt_sha256 bytea NOT NULL CHECK (octet_length(attempt_sha256) = 32),
  maintenance_reference text NOT NULL CHECK (length(maintenance_reference) BETWEEN 3 AND 200),
  recorded_by text NOT NULL DEFAULT current_user,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER cancelled_dispatch_recoveries_immutable BEFORE UPDATE OR DELETE
ON cancelled_dispatch_recoveries FOR EACH ROW EXECUTE FUNCTION protect_instance_settings_evidence();

-- Both the maintenance transaction and activation use UTC for the row digest.
CREATE VIEW cancelled_dispatch_evidence AS
SELECT a.id AS attempt_id, a.owner_user_id, a.logical_kind,
       coalesce(g.id,c.id) AS parent_job_id,
       sha256(convert_to(to_jsonb(a)::text,'UTF8')) AS attempt_sha256
FROM prepared_text_physical_attempts a
LEFT JOIN generation_jobs g ON a.logical_kind='story' AND g.owner_user_id=a.owner_user_id
  AND g.id::text=a.logical_reservation->>'generationJobId' AND g.status='cancelled'
LEFT JOIN campaign_cast_discovery_jobs c ON a.logical_kind='cast_discovery' AND c.owner_user_id=a.owner_user_id
  AND c.id::text=a.logical_reservation->>'jobId' AND c.status='cancelled'
WHERE a.status='dispatched' AND a.outcome IS NULL AND (g.id IS NOT NULL OR c.id IS NOT NULL);
