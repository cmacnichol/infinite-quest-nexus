# Recover Chronicle indexing

Chronicle rebuilds and embedding indexing are durable worker jobs. Story generation can use lexical fallback while vectors are unavailable or incomplete.

For a degraded campaign:

1. Inspect **Memory and context** health and progress.
2. Confirm the embedding profile, model, dimensions, prefixes, capability overrides, and batch size match the intended current configuration.
3. Confirm endpoint reachability from the worker.
4. If a current `index_memory_chunks_v2` job is queued or running, allow its fenced lease and durable cursor to finish rather than starting competing work.
5. Select **Rebuild memory** when derived parent text records are inconsistent.
6. Select **Save & index** after correcting semantic configuration or when health reports `chunk_protocol_outdated`, `rebuild_required`, or persistent partial coverage.
7. Wait for 100% terminal coverage: every current parent has at least one terminal current-protocol chunk, every current chunk is terminal, at least one current chunk is embedded, and the latest chunk job is completed or absent before opting into chunked production. A fully sanitized-skipped index uses the complete legacy path with the existing `chunk_index_not_ready` fallback.

Do not edit accepted turns to repair Chronicle. Accepted narration is authoritative; derived summaries, facts, threads, chunks, and vectors must be rebuilt from effective campaign history. Do not delete legacy embeddings or vectors during recovery. They keep config-only rollback available and require a separate approved cleanup plan.

Semantic, cache, indexing, and telemetry failures fall open to legacy lexical/entity retrieval. If story generation succeeds with a fixed fallback code, repair the derived subsystem independently instead of replaying or rewriting the accepted turn.

## Roll back production selection

If chunked retrieval causes operational trouble, switch every opted-in campaign back to the legacy implementation and disable shadow comparison:

```sql
UPDATE campaign_memory_configs
   SET retrieval_implementation = 'legacy_hybrid',
       retrieval_shadow_enabled = false,
       updated_at = now()
 WHERE retrieval_implementation <> 'legacy_hybrid' OR retrieval_shadow_enabled;
```

This is a configuration-only rollback. It does not change accepted turns, Chronicle parents, legacy vectors, chunk rows, or historical telemetry. After service recovery, an operator may rebuild the derived chunk index and re-enable shadow on selected campaigns before considering another explicit opt-in.
