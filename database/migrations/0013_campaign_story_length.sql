ALTER TABLE campaigns
  ADD COLUMN story_length_profile text NOT NULL DEFAULT 'standard'
  CHECK (story_length_profile IN ('brief', 'standard', 'long', 'extended'));

UPDATE campaigns
   SET story_length_profile = CASE lower(COALESCE(legacy_settings->>'storyLength', legacy_settings->>'story_length', ''))
     WHEN 'brief' THEN 'brief'
     WHEN 'long' THEN 'long'
     WHEN 'extended' THEN 'extended'
     ELSE 'standard'
   END;

COMMENT ON COLUMN campaigns.story_length_profile IS
  'Authoritative default narration-length profile for each generated campaign turn.';
