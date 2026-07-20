# ADR 0010: Chronicle uses typed living memory and hard prompt envelopes

Status: accepted

## Context

Turn-sized fiction memories alone do not preserve corrected facts, unresolved threads, current trackers, or the authored World Library graph efficiently. Character-count budgeting also cannot safely reserve room for the system prompt, current action, provider output, and JSON envelope. Embedding jobs can overlap accepted turns, and retrieval models such as Nomic require asymmetric document and query task prefixes.

## Decision

Validated story output now includes a replacement continuity summary, facts established or corrected by the accepted turn, prior facts explicitly superseded by it, and the complete current open-thread set. These values are persisted in the accepted turn state snapshot and projected into rebuildable `campaign_summary`, `canonical_fact`, and `open_thread` Chronicle records. Every eighth accepted living summary is retained as a derived hierarchical checkpoint. Imported scratchpads remain private; a scratchpad enters campaign canon only after it has passed the typed fiction-only output validator.

Prompt construction includes budgeted World Library overview, rules, query-relevant entities and relationships, current trackers, validated continuity scratchpad, current scene, living summary, open threads, recent turns, relevant facts/events, and chronological samples. Candidate loading is bounded. Ranking combines semantic, full-text, entity, recency, and importance signals. The final story prompt is measured conservatively and sheds lowest-priority Chronicle entries until it fits the provider-owned input limit. Browser-supplied context metadata may reduce but never enlarge the configured provider window.

Campaign narration length is an authoritative campaign preference, not a provider limit. Each durable generation job snapshots the selected profile and word range so a queued or retried turn is reproducible even if the campaign default changes. The provider maximum-output setting remains an independent hard ceiling used for context reservation and truncation detection.

Embedding configuration supports optional document and query task prefixes. NULL selects a model-aware default; Nomic models receive `search_document: ` and `search_query: `. Stored vectors carry a fingerprint of endpoint, provider type, model, relevant provider configuration, and effective prefixes. Provider changes clear and rebuild affected vectors. Chronicle jobs carry a monotonically increasing work version so a running job returns to `queued` when accepted memory changes concurrently.

The generation audit records the exact context fingerprint, selected memory IDs and hashes, compression and retrieval mode, conservative prompt estimate, provider input limit, and provider-reported usage.

Cross-turn provider response chains are not written by the Story Engine. LM Studio `previous_response_id` is used only for recovery of the immediately preceding incomplete response, where the chain scope is unambiguous. A future cross-turn cache must budget the retained provider chain and prove compatibility with the exact authoritative context fingerprint before reuse.

## Consequences

- Accepted turns remain the recovery source of truth; every new memory projection can be rebuilt.
- Corrections remove superseded fact text from active retrieval without rewriting accepted turns.
- Long campaigns query bounded candidate pools instead of loading the complete Chronicle into the API process.
- Semantic retrieval remains optional and falls back to deterministic local ranking.
- Prompt estimates are conservative and observable, but provider-reported usage remains the calibration source for model-specific tokenization.
- A new online migration clears existing vectors once because their provider fingerprint and task-prefix provenance are unknown.
