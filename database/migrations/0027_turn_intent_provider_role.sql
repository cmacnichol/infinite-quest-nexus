ALTER TABLE provider_profiles DROP CONSTRAINT provider_profiles_provider_role_check;
ALTER TABLE provider_profiles
  ADD CONSTRAINT provider_profiles_provider_role_check
  CHECK (provider_role IN ('text', 'image', 'embedding', 'intent'));

COMMENT ON COLUMN provider_profiles.provider_role IS
  'Provider purpose. Intent providers only classify Auto turn input and never generate story narration.';
