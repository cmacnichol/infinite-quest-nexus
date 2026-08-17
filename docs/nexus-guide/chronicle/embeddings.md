# Configure semantic Chronicle retrieval

1. Create an enabled provider profile with the **Chronicle embeddings** role.
2. Select the campaign and open **Memory and context**.
3. Select **Enable hybrid semantic memory for this campaign**.
4. Choose the **Embedding provider** and **Embedding model**.
5. Optionally set **Document prefix** and **Query prefix**.
6. Set a bounded **Batch size**.
7. Keep **Production retrieval** on **Legacy hybrid** while preparing and shadowing the chunk index.
8. Select **Save & index**. This enqueues the durable `index_memory_chunks_v2` job without changing production retrieval.
9. After the campaign is fully ready and shadow diagnostics are acceptable, explicitly select **Chunked hybrid**. There is no automatic campaign conversion.

Leave prefixes blank to use model-aware defaults when available; override them only when the embedding model documents another instruction format. The text profile may appear as **Text fallback**, but its credentials are not copied into an independent embedding profile.

## Understand health

| Health state | Meaning and response |
| --- | --- |
| `chronicle_available` | Chronicle is available but no semantic configuration exists. Configure embeddings only if semantic retrieval is wanted. |
| `semantic_disabled` | Semantic retrieval is intentionally off. Lexical/entity retrieval remains available. |
| `indexing` | A current chunk job is queued or running. Wait for durable progress to finish. |
| `healthy` | The current configuration has complete compatible coverage and no active fallback. |
| `partially_indexed` | Some current parents lack compatible embedded chunks. Continue or rebuild indexing before production opt-in. |
| `provider_degraded` | Provider health is degraded. Story generation falls open to the complete legacy path when needed. |
| `provider_unavailable` | The independent embedding provider is disabled, missing, or unavailable. Check its profile and worker reachability. |
| `fallback_active` | The latest current production retrieval used a recorded fallback. Inspect the fixed fallback code and provider health. |
| `chunk_protocol_outdated` | Current parents have incomplete or outdated chunk-protocol coverage. Rebuild the derived chunk index. |
| `rebuild_required` | Current configuration and compatible vectors do not form a usable index, or a current job failed. Correct the cause and rebuild. |

Coverage is configuration-specific: provider, model, dimensions, embedding protocol, content hash, provider fingerprint, campaign, and world version must match production retrieval. A displayed 100% is not sufficient if any of those compatibility fields are stale.

## Readiness and fallback

Chunked production requires 100% terminal coverage: every current parent hash has at least one current `chronicle-chunk-v1` chunk in terminal `embedded` or sanitized `skipped` status, every current chunk is terminal, at least one current chunk is embedded, and the latest chunk job is completed or absent. A fully sanitized-skipped index uses the complete legacy path with the existing `chunk_index_not_ready` fallback. Until the gate is met, `chunked_hybrid` falls open to the complete legacy implementation; it never combines a partial chunk index with production results.

Indexing is incremental. A job only re-embeds parents whose current content is not already
terminally chunked, so an accepted turn costs work proportional to what changed rather than a
full campaign re-embed. Long campaigns therefore keep reaching the readiness gate while being
actively played. If an accepted turn arrives during a long initial backfill, the job resumes
from its durable cursor whenever the already-processed parents are unchanged, and restarts only
when one of them was edited.

Embedding requests are batched. Providers that do not declare a batch limit are assumed to accept
16 documents per request; the campaign batch size lowers this, and `embeddingMaxBatchItems: 1`
restores one request per document for providers that require it. A response that does not return
one vector per requested document is always rejected rather than trusted.

A skipped chunk always records one sanitized reason from the closed set `semantic_retrieval_disabled`, `chunk_exceeds_provider_capacity`, or `chunk_embedding_skipped`. Every member counts as terminal for the readiness gate, and provider text, endpoints, and credentials are never stored in the reason. `chunk_exceeds_provider_capacity` marks a chunk that could not fit one provider request; its sibling chunks still index normally.

Disabling or losing the embedding provider does not block story generation. Chronicle uses lexical/entity, relevance, recency, and chronology signals and reports the degradation in health. Re-enable the provider and select **Save & index** to rebuild derived chunks; do not repair them by changing story history.

## Turn-history retrieval audit

Each newly accepted turn can retain a privacy-safe record of the retrieval path
that actually supplied its prompt context. A missing `chronicleRetrieval` value
means the provenance is unknown because the turn is historical, imported, or
contains malformed legacy metadata; do not infer or backfill it from the current
embedding configuration. Reindexing changes only derived memory and never
changes the audit stored with an accepted turn.
