ALTER TABLE authoring_jobs DROP CONSTRAINT authoring_jobs_kind_check;
ALTER TABLE authoring_jobs ADD CONSTRAINT authoring_jobs_kind_check
  CHECK (kind IN ('world_concept', 'character', 'story_source'));

ALTER TABLE authoring_jobs
  ADD COLUMN source_plan jsonb,
  ADD COLUMN source_review jsonb;

ALTER TABLE authoring_jobs
  ADD CONSTRAINT authoring_jobs_source_plan_check
  CHECK (source_plan IS NULL OR jsonb_typeof(source_plan) = 'object'),
  ADD CONSTRAINT authoring_jobs_source_review_check
  CHECK (source_review IS NULL OR jsonb_typeof(source_review) = 'object');
