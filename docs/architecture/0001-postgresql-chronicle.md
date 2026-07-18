# ADR 0001: PostgreSQL owns campaigns and Chronicle memory

Status: accepted

## Context

The legacy browser client stores the complete story in localStorage and relies on provider response chains for short-term continuity. Browser limits, model changes, response-chain loss, and context limits can therefore make the model lose authoritative history.

## Decision

PostgreSQL is the authoritative store for the initial user, worlds, immutable world versions, campaigns, accepted turns, and campaign state. Accepted turns are the recovery ledger. Summaries, full-text documents, entities, and embeddings are Chronicle indexes that can be rebuilt.

The initial local memory implementation uses PostgreSQL generated `tsvector` documents for relevance, combined with recency, chronology, and configurable compression. pgvector is installed from the first migration so local embeddings can be added without changing the ownership or memory boundaries.

Private mechanics and state snapshots are stored separately from narration. Chronicle indexes only sanitized action and narration. Context construction does not select roll records, scratchpads, rejected model output, parser diagnostics, or credentials.

## Consequences

- Switching models or provider instances will reconstruct context from database state.
- Large histories remain measurable and usable at multiple compression levels.
- Worker and API replicas can operate without process-local memory.
- The database must be backed up and restored as authoritative data.
- Chronicle indexes can be deleted and rebuilt from accepted turns.
