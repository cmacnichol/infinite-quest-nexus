-- Up Migration
ALTER TABLE campaign_cast_events ADD COLUMN attachment jsonb;

-- Down Migration
ALTER TABLE campaign_cast_events DROP COLUMN attachment;
