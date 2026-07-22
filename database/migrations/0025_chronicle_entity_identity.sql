ALTER TABLE chronicle_memories
  ADD COLUMN entity_ids text[] NOT NULL DEFAULT ARRAY[]::text[];

CREATE INDEX chronicle_memories_entity_ids_idx
  ON chronicle_memories USING gin(entity_ids);

ALTER TABLE campaign_canonical_facts
  ADD COLUMN entity_ids text[] NOT NULL DEFAULT ARRAY[]::text[];

CREATE INDEX campaign_canonical_facts_entity_ids_idx
  ON campaign_canonical_facts USING gin(entity_ids);

INSERT INTO chronicle_jobs (owner_user_id, campaign_id, job_type, status)
SELECT owner_user_id, id, 'reindex_campaign', 'queued'
  FROM campaigns
ON CONFLICT (campaign_id, job_type) WHERE status IN ('queued', 'running')
DO UPDATE SET work_version = chronicle_jobs.work_version + 1, updated_at = now();

COMMENT ON COLUMN chronicle_memories.entity_ids IS
  'Derived stable entity references resolved only from the campaign pinned world version and character snapshot.';
