ALTER TABLE image_jobs
  DROP CONSTRAINT image_jobs_generation_job_id_fkey,
  ADD CONSTRAINT image_jobs_generation_job_id_fkey
    FOREIGN KEY (generation_job_id) REFERENCES generation_jobs(id) ON DELETE CASCADE;
