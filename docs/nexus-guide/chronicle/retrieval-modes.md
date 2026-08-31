# Choose Chronicle retrieval and compression modes

## Production retrieval

| Implementation | Behavior |
| --- | --- |
| Legacy hybrid | Uses the established memory-level lexical, entity, semantic, recency, and chronology path. Chronological coverage is a deterministic evenly-spaced sample of at most 32 memories, so a long campaign does not fill the prompt with every past turn and crowd out relevance-selected entries. |
| Chunked hybrid | Default for new campaigns created from a world. Uses current deterministic chunks, the generated weighted reciprocal-rank-fusion profile, and deterministic diversity limits. It falls back to the complete legacy path unless the chunk index meets the readiness gate. |

Enabling **Shadow comparison** calculates lexical, legacy-hybrid, and proposed chunked results for diagnostics while legacy or chunked production selection continues independently. Shadow comparison never changes production selection. It is enabled by default for new campaigns created from a world; existing campaign settings are unchanged.

Campaign creation automatically queues chunk indexing alongside legacy embedding work when an eligible embedding provider is available. Indexing runs asynchronously, and a new campaign with no accepted memories continues to use the safe fallback until its index is ready. Without a provider, the retrieval defaults are still saved, but Semantic Retrieval remains off and indexing is deferred. Configure an embedding provider and use **Save & index** to enable it later.

Chunked retrieval is eligible at 100% terminal coverage: every current parent has a terminal current-protocol chunk, every current chunk is terminal, at least one current chunk is embedded, and the latest chunk job is completed or absent. A fully sanitized-skipped index uses the complete legacy path with the existing `chunk_index_not_ready` fallback. Available ranks are combined by weighted reciprocal-rank fusion only after the readiness gate, followed by deterministic duplicate and diversity controls. There is no reranking stage or separate reranker provider.

## Turn retrieval audit

Newly accepted turns record the observed production retrieval path in their
local `chronicleRetrieval` audit. This is provenance for the accepted prompt
context, not a reconstruction from current campaign settings or optional shadow
comparison telemetry.

| Stored/API state | Meaning |
| --- | --- |
| `chronicleRetrieval: null` | Unknown historical/imported provenance; do not infer. |
| `effectiveMode: semantic_hybrid`, `resolutionSource: dedicated_embedding` | Dedicated embedding provider contributed semantic ranking. |
| `effectiveMode: semantic_hybrid`, `resolutionSource: text_fallback` | Text-role provider was explicitly used through the embedding interface. |
| configured chunked + effective legacy | Complete legacy fallback supplied the accepted prompt context. |
| `effectiveMode: lexical_only` | No semantic rank contributed; inspect sanitized `fallbackCode`. |
| cache-only | Semantic rank used cached query vectors; no live embedding call occurred. |

Missing or malformed stored values remain `null`; do not infer or backfill them.
The audit records only actual production retrieval. Shadow comparisons and other
operational telemetry remain retention-bound diagnostics and never rewrite turn
history.

## Compression

| Mode | Behavior |
| --- | --- |
| Automatic | Uses the least compressed selection that fits the effective budget |
| Full history | Preserves complete selected action and narration memories |
| Balanced | Preserves complete actions with bounded older narration |
| Compact | Uses action and outcome excerpts |
| Summary + recent | Uses the newest summary checkpoint plus recent and relevant turns |

The Story Engine reserves room for prompt overhead and provider output before selecting memory. When the available context is tight, it sheds lower-priority derived material instead of dropping authoritative current-scene requirements.

Semantic relevance, lexical/entity matches, recency, chronology, and open-thread relevance can all influence selection. Retrieval chooses candidates; compression then fits selected authoritative and derived context into the effective prompt budget. Inspect a context preview when continuity seems too compressed.
