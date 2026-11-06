-- Cheap invalidation for read-only workspace polling; not portable canon.
ALTER TABLE campaign_cast_state ADD COLUMN workspace_revision bigint NOT NULL DEFAULT 0;
CREATE FUNCTION bump_cast_workspace_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE campaign_cast_state SET workspace_revision=workspace_revision+1
      WHERE campaign_id=OLD.campaign_id AND owner_user_id=OLD.owner_user_id;
    RETURN OLD;
  END IF;
  UPDATE campaign_cast_state SET workspace_revision=workspace_revision+1
    WHERE campaign_id=NEW.campaign_id AND owner_user_id=NEW.owner_user_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cast_workspace_candidates AFTER INSERT OR UPDATE OR DELETE ON campaign_cast_discovery_candidates FOR EACH ROW EXECUTE FUNCTION bump_cast_workspace_revision();
CREATE TRIGGER cast_workspace_jobs AFTER INSERT OR UPDATE OR DELETE ON campaign_cast_discovery_jobs FOR EACH ROW EXECUTE FUNCTION bump_cast_workspace_revision();
CREATE TRIGGER cast_workspace_characters AFTER INSERT OR UPDATE OR DELETE ON campaign_cast_characters FOR EACH ROW EXECUTE FUNCTION bump_cast_workspace_revision();
CREATE TRIGGER cast_workspace_events AFTER INSERT OR UPDATE OR DELETE ON campaign_cast_events FOR EACH ROW EXECUTE FUNCTION bump_cast_workspace_revision();
CREATE TRIGGER cast_workspace_observations AFTER INSERT OR UPDATE OR DELETE ON campaign_cast_observations FOR EACH ROW EXECUTE FUNCTION bump_cast_workspace_revision();
CREATE TRIGGER cast_workspace_turns AFTER INSERT OR UPDATE OR DELETE ON turns FOR EACH ROW EXECUTE FUNCTION bump_cast_workspace_revision();
