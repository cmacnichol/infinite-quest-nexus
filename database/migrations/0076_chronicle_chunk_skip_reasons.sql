-- Derived-only tightening: chunk skip reasons become a closed sanitized set so retrieval
-- readiness can treat every member as terminal without depending on writer convention.
-- Existing rows only ever carry the generic bucket, so no value is rewritten.

ALTER TABLE chronicle_memory_chunks
  DROP CONSTRAINT IF EXISTS chronicle_memory_chunks_embedding_skip_reason_check;

ALTER TABLE chronicle_memory_chunks
  ADD CONSTRAINT chronicle_memory_chunks_embedding_skip_reason_check CHECK (
    embedding_skip_reason IS NULL
    OR embedding_skip_reason IN (
      'semantic_retrieval_disabled',
      'chunk_exceeds_provider_capacity',
      'chunk_embedding_skipped'
    )
  );

COMMENT ON COLUMN chronicle_memory_chunks.embedding_skip_reason IS
  'Closed sanitized reason set; provider text, endpoints, and credentials are never representable here.';
