ALTER TABLE generation_jobs
  ADD COLUMN generation_base_identity jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN generation_jobs.generation_base_identity IS
  'Immutable authoritative campaign base identity captured at enqueue. Used to fence retries, checkpoints, and commit.';
