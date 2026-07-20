ALTER TABLE provider_profiles
  ADD COLUMN is_default boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX provider_profiles_one_default_per_role_idx
  ON provider_profiles(owner_user_id, provider_role)
  WHERE is_default = true;

ALTER TABLE campaigns
  ADD COLUMN text_provider_profile_id uuid,
  ADD COLUMN image_provider_profile_id uuid,
  ADD CONSTRAINT campaigns_text_provider_owner_fk
    FOREIGN KEY (text_provider_profile_id, owner_user_id) REFERENCES provider_profiles(id, owner_user_id),
  ADD CONSTRAINT campaigns_image_provider_owner_fk
    FOREIGN KEY (image_provider_profile_id, owner_user_id) REFERENCES provider_profiles(id, owner_user_id);

