ALTER TABLE authoring_job_stages
  ADD COLUMN source_review_generation integer;

ALTER TABLE authoring_job_stages
  ADD CONSTRAINT authoring_job_stages_source_review_generation_check
  CHECK (source_review_generation IS NULL OR source_review_generation >= 0);

CREATE INDEX authoring_job_stages_source_review_generation_idx
  ON authoring_job_stages (job_id, source_review_generation)
  WHERE source_review_generation IS NOT NULL;
