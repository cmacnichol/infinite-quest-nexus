-- Up Migration

CREATE FUNCTION notify_generation_job_changed_v1() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  notification_version text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.status IS NOT DISTINCT FROM NEW.status
     AND OLD.partial_output IS NOT DISTINCT FROM NEW.partial_output
     AND OLD.attempts IS NOT DISTINCT FROM NEW.attempts
     AND OLD.result_turn_id IS NOT DISTINCT FROM NEW.result_turn_id THEN
    RETURN NEW;
  END IF;

  notification_version := md5(concat_ws(
    E'\x1f',
    NEW.status,
    NEW.attempts::text,
    COALESCE(NEW.result_turn_id::text, ''),
    COALESCE(NEW.partial_output, '')
  ));

  PERFORM pg_notify(
    'infinitequest_generation_changed_v1',
    json_build_object(
      'jobId', NEW.id::text,
      'version', notification_version
    )::text
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER generation_jobs_notify_changed_v1
AFTER INSERT OR UPDATE OF status, partial_output, attempts, result_turn_id
ON generation_jobs
FOR EACH ROW
EXECUTE FUNCTION notify_generation_job_changed_v1();

-- Down Migration

DROP TRIGGER IF EXISTS generation_jobs_notify_changed_v1 ON generation_jobs;
DROP FUNCTION IF EXISTS notify_generation_job_changed_v1();
