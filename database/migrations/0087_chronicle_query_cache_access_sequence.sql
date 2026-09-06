CREATE SEQUENCE chronicle_query_embedding_cache_access_sequence;

ALTER TABLE chronicle_query_embedding_cache
  ADD COLUMN last_accessed_sequence bigint;

ALTER TABLE chronicle_query_embedding_cache
  ALTER COLUMN last_accessed_sequence
  SET DEFAULT nextval('chronicle_query_embedding_cache_access_sequence');

UPDATE chronicle_query_embedding_cache
  SET last_accessed_sequence=nextval('chronicle_query_embedding_cache_access_sequence');

ALTER TABLE chronicle_query_embedding_cache
  ALTER COLUMN last_accessed_sequence SET NOT NULL;

DROP INDEX chronicle_query_embedding_cache_lru_idx;

CREATE INDEX chronicle_query_embedding_cache_lru_idx
  ON chronicle_query_embedding_cache(owner_user_id,campaign_id,last_accessed_sequence DESC,last_accessed_at DESC,created_at DESC,id DESC);

COMMENT ON COLUMN chronicle_query_embedding_cache.last_accessed_sequence IS
  'Monotonic cache-local access order used to break timestamp ties during LRU eviction.';
