CREATE UNIQUE INDEX IF NOT EXISTS chronicle_jobs_one_active_reindex_idx
  ON chronicle_jobs(campaign_id, job_type)
  WHERE status IN ('queued', 'running');
