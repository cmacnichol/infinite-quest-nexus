# ADR 0006: Semantic Chronicle is optional, derived, and campaign-scoped

Status: accepted

## Context

Full-text, entity, recency, and chronological retrieval preserve exact references but do not reliably recover conceptually related events when the current action uses different words. LM Studio supports embedding models through the OpenAI-compatible `POST /v1/embeddings` endpoint. Embeddings can improve recall, but an embedding endpoint is not authoritative storage and may be offline, changed, or configured with a model that produces a different vector dimension.

Semantic retrieval must never weaken user, campaign, or world-version isolation. It also must not allow stale vectors, private mechanics, or rejected generation output into a story prompt.

## Decision

Each campaign can opt into one independently owned provider profile with the `embedding` role, one model identifier, and a configurable batch size. This provider does not inherit the text or image endpoint's URL or credentials.

Chronicle embeds only already-sanitized memory records. Every stored vector carries its provider profile, requested model, dimension, SHA-256 content hash, and update time. The accepted-turn ledger remains authoritative; vectors can be deleted and rebuilt at any time.

PostgreSQL-backed jobs claim embedding work with `FOR UPDATE SKIP LOCKED`, campaign-level running-job exclusion, leases, heartbeats, content-aware upserts, and idempotent active-job deduplication. A model or provider switch makes old vectors ineligible immediately and queues a replacement build even when the change occurs during an older job.

At retrieval time the application embeds the current fiction-only action, calculates exact pgvector cosine similarity only against rows matching the request owner, campaign, provider, model, dimension, and current content hash, and combines that score with normalized PostgreSQL full-text relevance. Recent and chronological coverage continue to participate independently.

If configuration is absent, indexing is incomplete, dimensions differ, credentials cannot be decrypted, or the endpoint fails, retrieval returns a visible `lexical_fallback` mode and continues without semantic scores. Story generation does not fail because semantic retrieval is unavailable.

The initial implementation uses exact cosine scans within one campaign rather than an approximate global vector index. This preserves strict scope and supports different embedding dimensions across campaigns. An ANN index can be added later for a measured workload by standardizing dimensions or partitioning embeddings by model/dimension.

## Consequences

- Local embedding models can provide semantic long-term recall without giving the LLM authority over memory.
- Text generation, embedding generation, and future illustration generation remain independent provider concerns.
- Vectors never contain roll records, private scratchpads, diagnostics, or rejected narration because the embedding worker reads Chronicle memory only.
- Endpoint outages reduce retrieval quality but do not block a turn or mutate campaign state.
- Switching models requires a rebuild, but stale vectors are excluded before that rebuild completes.
- Exact campaign-scoped scans favor correctness and flexibility over maximum vector-search throughput in the initial release.
