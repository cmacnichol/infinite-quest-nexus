# Choose Chronicle retrieval and compression modes

## Production retrieval

| Implementation | Behavior |
| --- | --- |
| Legacy hybrid | Default. Uses the established memory-level lexical, entity, semantic, recency, and chronology path. |
| Chunked hybrid | Explicit opt-in. Uses current deterministic chunks, the generated weighted reciprocal-rank-fusion profile, and deterministic diversity limits. It falls back to the complete legacy path unless the chunk index meets the readiness gate. |

Enabling **Shadow comparison** calculates lexical, legacy-hybrid, and proposed chunked results for diagnostics while legacy or chunked production selection continues independently. Shadow comparison never changes production selection. Use it only on selected campaigns after compatible code and the derived chunk schema have been deployed.

Chunked retrieval is eligible at 100% terminal coverage: every current parent has a terminal current-protocol chunk, every current chunk is terminal, and the latest chunk job is completed or absent. A sanitized-skipped index omits semantic scoring but can still fuse lexical, entity, recency, and chronology signals. Available ranks are combined by weighted reciprocal-rank fusion, followed by deterministic duplicate and diversity controls. There is no reranking stage or separate reranker provider.

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
