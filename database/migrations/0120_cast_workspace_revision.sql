-- Up Migration
-- Cheap invalidation for read-only workspace polling; not portable canon.
-- Statement-level triggers bump each affected campaign once per statement, and
-- discovery-job housekeeping (leases, heartbeats, checkpoints) is not a change.
ALTER TABLE campaign_cast_state ADD COLUMN workspace_revision bigint NOT NULL DEFAULT 0;

CREATE FUNCTION bump_cast_workspace_revision_statement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE campaign_cast_state s SET workspace_revision=s.workspace_revision+1
    FROM (SELECT DISTINCT campaign_id,owner_user_id FROM changed_rows) c
    WHERE s.campaign_id=c.campaign_id AND s.owner_user_id=c.owner_user_id;
  RETURN NULL;
END;
$$;

CREATE FUNCTION bump_cast_workspace_revision_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE campaign_cast_state SET workspace_revision=workspace_revision+1
    WHERE campaign_id=NEW.campaign_id AND owner_user_id=NEW.owner_user_id;
  RETURN NULL;
END;
$$;

DO $$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['campaign_cast_discovery_candidates','campaign_cast_characters','campaign_cast_events',
    'campaign_cast_observations','campaign_cast_discovery_jobs','turns'] LOOP
    EXECUTE format('CREATE TRIGGER cast_workspace_insert AFTER INSERT ON %I REFERENCING NEW TABLE AS changed_rows
      FOR EACH STATEMENT EXECUTE FUNCTION bump_cast_workspace_revision_statement()', target);
    EXECUTE format('CREATE TRIGGER cast_workspace_delete AFTER DELETE ON %I REFERENCING OLD TABLE AS changed_rows
      FOR EACH STATEMENT EXECUTE FUNCTION bump_cast_workspace_revision_statement()', target);
  END LOOP;
  FOREACH target IN ARRAY ARRAY['campaign_cast_discovery_candidates','campaign_cast_characters','campaign_cast_events',
    'campaign_cast_observations'] LOOP
    EXECUTE format('CREATE TRIGGER cast_workspace_update AFTER UPDATE ON %I REFERENCING NEW TABLE AS changed_rows
      FOR EACH STATEMENT EXECUTE FUNCTION bump_cast_workspace_revision_statement()', target);
  END LOOP;
END;
$$;

-- Only visible job transitions count; lease and checkpoint writes are frequent.
CREATE TRIGGER cast_workspace_update AFTER UPDATE ON campaign_cast_discovery_jobs FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.diagnostic_code IS DISTINCT FROM NEW.diagnostic_code)
  EXECUTE FUNCTION bump_cast_workspace_revision_row();
-- Turn rows change for unrelated reasons (illustrations, costs); only narration matters here.
CREATE TRIGGER cast_workspace_update AFTER UPDATE ON turns FOR EACH ROW
  WHEN (OLD.narration IS DISTINCT FROM NEW.narration)
  EXECUTE FUNCTION bump_cast_workspace_revision_row();

-- Down Migration
DO $$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['campaign_cast_discovery_candidates','campaign_cast_characters','campaign_cast_events',
    'campaign_cast_observations','campaign_cast_discovery_jobs','turns'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS cast_workspace_insert ON %I', target);
    EXECUTE format('DROP TRIGGER IF EXISTS cast_workspace_delete ON %I', target);
    EXECUTE format('DROP TRIGGER IF EXISTS cast_workspace_update ON %I', target);
  END LOOP;
END;
$$;
DROP FUNCTION bump_cast_workspace_revision_row();
DROP FUNCTION bump_cast_workspace_revision_statement();
ALTER TABLE campaign_cast_state DROP COLUMN workspace_revision;
