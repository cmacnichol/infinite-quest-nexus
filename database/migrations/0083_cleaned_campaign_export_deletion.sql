-- Up Migration

-- Delivery metadata may release its campaign only after filesystem cleanup.
-- Keep the journal/descriptors and all insert/update authority guards intact.
CREATE FUNCTION guard_portable_export_artifact_deletion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.export_kind = 'campaign_zip'
    AND OLD.status = 'cleaned'
    AND EXISTS (
      SELECT 1 FROM durable_filesystem_operations
       WHERE id = OLD.filesystem_operation_id
         AND owner_user_id = OLD.owner_user_id
         AND purpose = 'portable_export'
         AND lifecycle = 'cleaned'
    )
  THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'portable export artifact authority cannot be deleted before campaign export cleanup'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER portable_export_artifacts_authority_trigger ON portable_export_artifacts;
CREATE TRIGGER portable_export_artifacts_authority_trigger
BEFORE INSERT OR UPDATE ON portable_export_artifacts
FOR EACH ROW EXECUTE FUNCTION enforce_portable_export_artifact_authority();

CREATE TRIGGER portable_export_artifacts_deletion_trigger
BEFORE DELETE ON portable_export_artifacts
FOR EACH ROW EXECUTE FUNCTION guard_portable_export_artifact_deletion();

-- Down Migration

DROP TRIGGER portable_export_artifacts_deletion_trigger ON portable_export_artifacts;
DROP FUNCTION guard_portable_export_artifact_deletion();
DROP TRIGGER portable_export_artifacts_authority_trigger ON portable_export_artifacts;
CREATE TRIGGER portable_export_artifacts_authority_trigger
BEFORE INSERT OR UPDATE OR DELETE ON portable_export_artifacts
FOR EACH ROW EXECUTE FUNCTION enforce_portable_export_artifact_authority();
