-- Offline psql maintenance. Pass manifest (reviewed JSON array) and reference via -v.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL lock_timeout='5s';
LOCK TABLE api_admission_leases, campaign_cast_discovery_jobs, cancelled_dispatch_recoveries,
  generation_jobs, instance_settings_runtime_reports, prepared_text_physical_attempts,
  text_provider_capacity_leases IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE reviewed_dispatches (
  attempt_id uuid PRIMARY KEY, parent_job uuid NOT NULL, kind text NOT NULL,
  parent_status text NOT NULL CHECK (parent_status='cancelled'),
  row_fingerprint text NOT NULL CHECK (row_fingerprint ~ '^[0-9a-f]{32}$')
) ON COMMIT DROP;
INSERT INTO reviewed_dispatches
SELECT attempt_id,parent_job,kind,parent_status,row_fingerprint
FROM jsonb_to_recordset(:'manifest'::jsonb) AS m(
  attempt_id uuid,parent_job uuid,kind text,parent_status text,row_fingerprint text);
DO $$
BEGIN
  IF EXISTS (SELECT FROM instance_settings_runtime_reports WHERE heartbeat_at>now()-interval '30 seconds')
    OR EXISTS (SELECT FROM api_admission_leases WHERE request_running OR expires_at>now())
    OR EXISTS (SELECT FROM text_provider_capacity_leases WHERE expires_at>now()) THEN
    RAISE EXCEPTION 'Stop all runtimes and drain active work before recovery';
  END IF;
  IF NOT EXISTS (SELECT FROM reviewed_dispatches) OR EXISTS (
    SELECT FROM reviewed_dispatches m WHERE NOT EXISTS (
      SELECT FROM cancelled_dispatch_evidence e JOIN prepared_text_physical_attempts a ON a.id=e.attempt_id
      WHERE e.attempt_id=m.attempt_id AND e.parent_job_id=m.parent_job AND e.logical_kind=m.kind
        AND md5(to_jsonb(a)::text)=m.row_fingerprint)
  ) THEN RAISE EXCEPTION 'Manifest does not match cancelled dispatch evidence'; END IF;
END $$;
INSERT INTO cancelled_dispatch_recoveries(attempt_id,owner_user_id,parent_job_id,logical_kind,attempt_sha256,maintenance_reference)
SELECT e.attempt_id,e.owner_user_id,e.parent_job_id,e.logical_kind,e.attempt_sha256,:'reference'
FROM cancelled_dispatch_evidence e JOIN reviewed_dispatches m USING(attempt_id);
COMMIT;
