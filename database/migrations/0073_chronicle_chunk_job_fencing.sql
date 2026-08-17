ALTER TABLE chronicle_chunk_jobs
  ADD COLUMN lease_token uuid,
  ADD COLUMN work_signature text;

-- Pre-token claims cannot retain authority. Requeue them as fresh work so only
-- a post-upgrade claimant with a unique lease token can continue.
UPDATE chronicle_chunk_jobs
   SET status = 'queued',
       work_version = work_version + 1,
       lease_owner = NULL,
       lease_expires_at = NULL,
       progress = '{}'::jsonb,
       error_message = NULL,
       completed_at = NULL,
       updated_at = clock_timestamp()
 WHERE status = 'running';

UPDATE chronicle_chunk_jobs jobs
   SET work_signature = encode(digest(
         campaigns.world_version_id::text || E'\x1f' || COALESCE((
           SELECT string_agg(
             memories.ordinal::text || ':' || memories.id::text || ':' || memories.content_hash,
             E'\x1e' ORDER BY memories.ordinal,memories.id
           )
             FROM chronicle_memories memories
            WHERE memories.owner_user_id = jobs.owner_user_id
              AND memories.campaign_id = jobs.campaign_id
              AND memories.world_version_id = campaigns.world_version_id
         ), ''),
         'sha256'
       ), 'hex')
  FROM campaigns
 WHERE campaigns.id = jobs.campaign_id
   AND campaigns.owner_user_id = jobs.owner_user_id;

ALTER TABLE chronicle_chunk_jobs
  ALTER COLUMN work_signature SET DEFAULT repeat('0', 64),
  ALTER COLUMN work_signature SET NOT NULL,
  ADD CONSTRAINT chronicle_chunk_jobs_work_signature_check
    CHECK (work_signature ~ '^[0-9a-f]{64}$');

ALTER TABLE chronicle_chunk_jobs
  DROP CONSTRAINT chronicle_chunk_jobs_lease_check,
  ADD CONSTRAINT chronicle_chunk_jobs_lease_check CHECK (
    (status = 'running'
      AND lease_owner IS NOT NULL
      AND btrim(lease_owner) <> ''
      AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL)
    OR
    (status <> 'running'
      AND lease_owner IS NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL)
  );

COMMENT ON COLUMN chronicle_chunk_jobs.work_signature IS
  'SHA-256 of the current world-version and ordered Chronicle parent ids/content hashes; unchanged enqueue is a no-op.';
COMMENT ON COLUMN chronicle_chunk_jobs.lease_token IS
  'Opaque per-claim authority regenerated on every claim, including same-worker expired-lease reclamation.';
