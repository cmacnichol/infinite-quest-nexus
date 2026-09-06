-- Up Migration

-- Published originals remain immutable authority, but maintenance must be able
-- to add a derived thumbnail without reopening the original publication.
CREATE OR REPLACE FUNCTION enforce_asset_filesystem_identity_lifecycle() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  identity_lifecycle text;
BEGIN
  IF NEW.resource_kind <> 'asset'
    OR NEW.purpose NOT IN ('asset_original','asset_derivative') THEN
    RETURN NEW;
  END IF;
  SELECT lifecycle INTO identity_lifecycle
    FROM asset_publication_identities identity
   WHERE identity.asset_id = NEW.asset_id
     AND identity.owner_user_id = NEW.owner_user_id
   FOR UPDATE;
  IF identity_lifecycle IS NULL
    OR (
      identity_lifecycle NOT IN ('legacy','prepared')
      AND NOT (
        identity_lifecycle = 'published'
        AND NEW.purpose = 'asset_derivative'
      )
    ) THEN
    RAISE EXCEPTION 'asset filesystem operation requires live publication identity'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Down Migration

CREATE OR REPLACE FUNCTION enforce_asset_filesystem_identity_lifecycle() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  identity_lifecycle text;
BEGIN
  IF NEW.resource_kind <> 'asset'
    OR NEW.purpose NOT IN ('asset_original','asset_derivative') THEN
    RETURN NEW;
  END IF;
  SELECT lifecycle INTO identity_lifecycle
    FROM asset_publication_identities identity
   WHERE identity.asset_id = NEW.asset_id
     AND identity.owner_user_id = NEW.owner_user_id
   FOR UPDATE;
  IF identity_lifecycle IS NULL
    OR identity_lifecycle NOT IN ('legacy','prepared') THEN
    RAISE EXCEPTION 'asset filesystem operation requires live publication identity'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
