ALTER TABLE provider_profiles
  ADD COLUMN request_timeout_ms integer NOT NULL DEFAULT 300000
  CHECK (request_timeout_ms BETWEEN 60000 AND 3600000);

COMMENT ON COLUMN provider_profiles.request_timeout_ms IS
  'Overall provider HTTP request deadline in milliseconds. Defaults to five minutes.';
