ALTER TABLE authoring_jobs
  ADD COLUMN reviewed_stage_ids jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(reviewed_stage_ids) = 'array');
