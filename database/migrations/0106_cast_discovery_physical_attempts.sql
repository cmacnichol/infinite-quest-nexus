-- Up Migration
ALTER TABLE prepared_text_physical_attempts DROP CONSTRAINT prepared_text_physical_attempts_logical_kind_check;
ALTER TABLE prepared_text_physical_attempts ADD CONSTRAINT prepared_text_physical_attempts_logical_kind_check
  CHECK (logical_kind IN ('story','authoring','illustration','direct','cast_discovery'));

-- Down Migration
-- Refuse rollback while discovery accounting exists; do not delete financial evidence.
ALTER TABLE prepared_text_physical_attempts DROP CONSTRAINT prepared_text_physical_attempts_logical_kind_check;
ALTER TABLE prepared_text_physical_attempts ADD CONSTRAINT prepared_text_physical_attempts_logical_kind_check
  CHECK (logical_kind IN ('story','authoring','illustration','direct'));
