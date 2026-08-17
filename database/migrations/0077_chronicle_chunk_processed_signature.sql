-- Derived-only. A chunk job previously discarded all durable progress whenever the campaign's
-- parent set changed, and every accepted turn changes it (a new turn memory plus the updated
-- living-summary and open-thread singletons). A long initial backfill could therefore be
-- restarted from zero by an unrelated tail change and never reach a terminal state on an
-- actively played campaign.
--
-- processed_signature records the signature of the parents at or before the durable cursor.
-- When only untouched-prefix work remains valid, the enqueue keeps the cursor and resumes;
-- when a already-processed parent changed, the cursor is cleared and the job restarts.

ALTER TABLE chronicle_chunk_jobs
  ADD COLUMN processed_signature text;

ALTER TABLE chronicle_chunk_jobs
  ADD CONSTRAINT chronicle_chunk_jobs_processed_signature_check
    CHECK (processed_signature IS NULL OR processed_signature ~ '^[0-9a-f]{64}$');

-- Existing jobs have no recorded prefix, so their next enqueue conservatively restarts them.
COMMENT ON COLUMN chronicle_chunk_jobs.processed_signature IS
  'SHA-256 of the ordered parent ids/content hashes at or before the durable cursor; NULL forces a restart.';
