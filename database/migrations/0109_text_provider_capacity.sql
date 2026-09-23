-- Up Migration
CREATE TABLE text_provider_capacity_leases (
  id uuid PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
CREATE INDEX text_provider_capacity_leases_expiry ON text_provider_capacity_leases(expires_at);

-- Down Migration
DROP TABLE text_provider_capacity_leases;
