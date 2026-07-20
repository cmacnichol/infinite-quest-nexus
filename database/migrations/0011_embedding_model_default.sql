ALTER TABLE campaign_memory_configs
  ALTER COLUMN embedding_model SET DEFAULT 'text-embedding-nomic-embed-text-v1.5';

UPDATE campaign_memory_configs
   SET embedding_model = 'text-embedding-nomic-embed-text-v1.5', updated_at = now()
 WHERE embedding_model = '';

