-- up migration
-- Local transfer authority is installation configuration, never portable content.
ALTER TABLE system_archive_uploads ADD COLUMN policy_snapshot jsonb;
ALTER TABLE system_archive_jobs ADD COLUMN policy_snapshot jsonb;
ALTER TABLE portable_import_operations ADD COLUMN policy_snapshot jsonb;
ALTER TABLE portable_export_artifacts ADD COLUMN policy_snapshot jsonb;
-- Existing expirations are intentionally untouched. NULL denotes the code-owned
-- historical baseline, never a new process's environment configuration.

CREATE FUNCTION protect_archive_policy_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.policy_snapshot IS DISTINCT FROM NEW.policy_snapshot THEN
    RAISE EXCEPTION 'archive_policy_snapshot_immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER system_upload_policy_immutable BEFORE UPDATE ON system_archive_uploads
FOR EACH ROW EXECUTE FUNCTION protect_archive_policy_snapshot();
CREATE TRIGGER system_job_policy_immutable BEFORE UPDATE ON system_archive_jobs
FOR EACH ROW EXECUTE FUNCTION protect_archive_policy_snapshot();
CREATE TRIGGER portable_import_policy_immutable BEFORE UPDATE ON portable_import_operations
FOR EACH ROW EXECUTE FUNCTION protect_archive_policy_snapshot();
CREATE TRIGGER portable_export_policy_immutable BEFORE UPDATE ON portable_export_artifacts
FOR EACH ROW EXECUTE FUNCTION protect_archive_policy_snapshot();
