-- Durable private route/plan evidence for v2 illustration text refinement.
-- Historical prompt jobs retain NULL and continue through their v1 path.
ALTER TABLE illustration_prompt_jobs
  ADD COLUMN text_execution_snapshot jsonb NULL;
