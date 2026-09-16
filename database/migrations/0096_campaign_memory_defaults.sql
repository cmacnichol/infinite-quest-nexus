INSERT INTO campaign_story_memory_enrollments(campaign_id,owner_user_id,capability,review_mode)
SELECT id,owner_user_id,'r3','enforce'
  FROM campaigns
ON CONFLICT (campaign_id) DO UPDATE
  SET capability='r3',review_mode='enforce',updated_at=now();

CREATE FUNCTION seed_campaign_story_memory_default()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO campaign_story_memory_enrollments(campaign_id,owner_user_id,capability,review_mode)
  VALUES(NEW.id,NEW.owner_user_id,'r3','enforce')
  ON CONFLICT (campaign_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER campaign_story_memory_default_enrollment
AFTER INSERT ON campaigns
FOR EACH ROW EXECUTE FUNCTION seed_campaign_story_memory_default();
