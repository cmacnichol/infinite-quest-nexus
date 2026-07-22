# Chronicle memory

Chronicle is a campaign-scoped derived memory system built from accepted fiction. Its purpose is to select relevant continuity without treating a provider context window as permanent storage.

Chronicle combines:

- Recent accepted turns
- Bounded chronological coverage
- Living campaign summary
- Canonical facts with stable derived IDs, turn validity, and explicit supersession
- Current open threads
- Entity and keyword matches
- Optional semantic similarity

The accepted-turn ledger remains the recovery source of truth. Structured fact projections, summaries, and vectors can be rebuilt without rewriting accepted narration. New fact corrections reference an exact visible fact ID; normalized text matching is retained only for legacy snapshots.

Semantic retrieval is optional. When its independent embedding provider is disabled or unavailable, Chronicle falls back to lexical/entity, relevance, recency, and chronology signals. That degradation must not block story generation.

Mechanics, rolls, private scratchpads, diagnostics, rejected output, credentials, and raw provider responses never become Chronicle memories.

Related decisions: [ADR 0001](../architecture/0001-postgresql-chronicle.md), [ADR 0006](../architecture/0006-campaign-scoped-semantic-chronicle.md), [ADR 0010](../architecture/0010-dynamic-chronicle-context.md), and [ADR 0018](../architecture/0018-structured-canonical-fact-projections.md).
