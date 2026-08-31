# Chronicle memory

Chronicle is a campaign-scoped derived memory system built from accepted fiction. Its purpose is to select relevant continuity without treating a provider context window as permanent storage.

Chronicle combines:

- Recent accepted turns
- Bounded chronological coverage
- Living campaign summary
- Canonical facts with stable derived IDs, turn validity, and explicit supersession
- Current open threads
- Scoped entity identities, aliases, and keyword matches
- Optional semantic similarity

The accepted-turn ledger and append-only user correction ledger remain the recovery sources of truth. Structured fact projections, summaries, entity identities, and vectors can be rebuilt without rewriting accepted narration. New fact corrections reference an exact visible fact ID; normalized text matching is retained only for legacy snapshots.

Ordinary current-state saves project only changed summary/thread documents and affected fact groups, preserving unrelated embeddings and chunks. Private scratchpad changes create no Chronicle work. Index eligibility/signature scans may still read the campaign; this is not a constant-time guarantee. A changed grouped fact document is embedded as a group, not one vector per edited word or fact.

Reserve full rebuilds for maintenance/recovery. Replay turn-zero corrections first, then each accepted turn followed by corrections effective at that turn in revision order. Applying all old corrections after the latest turn can resurrect superseded facts and must not be used. Deploy matching API, worker, and both UIs together; an application rollback must retain the current-only guard and correction-aware prompt reader.

Stable entity IDs are derived only from the campaign's pinned world version, selected-character snapshot, and campaign character profile. Authored world aliases, snapshot aliases, and schema-v5 profile aliases may identify the same scoped entity. Ambiguous aliases are not resolved.

Chronicle uses exact scoped-ID overlap to supplement lexical and semantic candidate selection. Owner, campaign, and historical turn cutoffs remain mandatory. Internal IDs are retrieval metadata only: prompt scopes contain human-readable fiction and names, never `entity_ids`.

**Semantic Retrieval** is an optional derived index. `legacy_hybrid` is the production default. An operator may enable safe shadow comparison for selected campaigns and later opt a ready campaign into `chunked_hybrid`; neither migrations nor calibration change campaign selection. Shadow work records only safe comparison metadata and never changes the context selected for production.

Chunked retrieval divides current Chronicle parents into deterministic `chronicle-chunk-v1` records and indexes them through the fixed `index_memory_chunks_v2` job. Production may use the chunked implementation only after 100% terminal coverage: every current parent hash has at least one current-protocol chunk in terminal `embedded` or sanitized `skipped` status, every current chunk is terminal, at least one current chunk is embedded, and the latest job is completed or absent. A fully sanitized-skipped index uses the complete legacy path with the existing `chunk_index_not_ready` fallback. Until that gate is met, Chronicle does not mix partially trusted chunk results into production.

Chunked results combine semantic, lexical, entity, recency, and chronology ranks through the generated weighted reciprocal-rank-fusion profile. A deterministic diversity penalty limits repeated parents and turns. There is no reranking stage and no reranker provider request.

When the independent embedding provider is disabled, incomplete, degraded, or unavailable, Chronicle falls back visibly to lexical/entity, relevance, recency, and chronology signals. That degradation must not block story generation. Query embeddings are an independently owned derived cache retained for 7 days and capped at 256 entries per campaign. Safe retrieval telemetry is retained for 30 days and capped at 5,000 runs per campaign.

Mechanics, rolls, private scratchpads, diagnostics, rejected output, credentials, and raw provider responses never become Chronicle memories.

Related decisions: [ADR 0001](../architecture/0001-postgresql-chronicle.md), [ADR 0006](../architecture/0006-campaign-scoped-semantic-chronicle.md), [ADR 0010](../architecture/0010-dynamic-chronicle-context.md), [ADR 0018](../architecture/0018-structured-canonical-fact-projections.md), [ADR 0024](../architecture/0024-scoped-chronicle-entity-identity.md), and [ADR 0028](../architecture/0028-chunked-chronicle-retrieval.md).
