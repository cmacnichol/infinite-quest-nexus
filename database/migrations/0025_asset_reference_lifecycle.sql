-- Assets are owner-scoped content-addressed blobs. Campaign and turn columns are
-- retained as nullable creation provenance; asset_references owns live usage.
ALTER TABLE assets
  DROP CONSTRAINT IF EXISTS assets_turn_owner_fk,
  DROP CONSTRAINT IF EXISTS assets_campaign_owner_fk,
  ADD CONSTRAINT assets_campaign_owner_fk
  FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id)
  ON DELETE SET NULL (campaign_id),
  ADD CONSTRAINT assets_turn_owner_fk
  FOREIGN KEY (turn_id, campaign_id, owner_user_id) REFERENCES turns(id, campaign_id, owner_user_id)
  ON DELETE SET NULL (turn_id);

-- Clear both legacy provenance columns before campaign cascades remove turns.
-- Otherwise the campaign FK can null campaign_id first, causing the composite
-- turn FK to stop matching while leaving a dangling informational turn UUID.
CREATE FUNCTION clear_deleted_campaign_asset_provenance() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE assets
     SET campaign_id = NULL, turn_id = NULL
   WHERE owner_user_id = OLD.owner_user_id AND campaign_id = OLD.id;
  RETURN OLD;
END;
$$;

CREATE TRIGGER clear_deleted_campaign_asset_provenance_trigger
BEFORE DELETE ON campaigns
FOR EACH ROW EXECUTE FUNCTION clear_deleted_campaign_asset_provenance();
