ALTER TABLE archive_previews
  DROP CONSTRAINT archive_previews_status_check;

ALTER TABLE archive_previews
  ADD CONSTRAINT archive_previews_status_check
  CHECK (status IN ('previewed', 'superseded', 'consumed', 'expired', 'failed'));
