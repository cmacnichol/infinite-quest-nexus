-- Preserve existing campaign choices and frozen jobs; default new campaigns off.
CREATE OR REPLACE FUNCTION seed_campaign_story_memory_default()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO campaign_story_memory_enrollments(campaign_id,owner_user_id,capability,review_mode)
  VALUES(NEW.id,NEW.owner_user_id,'r3','off')
  ON CONFLICT (campaign_id) DO NOTHING;
  RETURN NEW;
END;
$$;
