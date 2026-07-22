# Campaigns and turns

A campaign is a mutable story instance created from one immutable world version. It owns its selected character snapshot, current state, accepted-turn ledger, jobs, Chronicle, and assets.

An accepted turn is append-only canonical history:

```text
player action + validated narration + accepted state transition
```

Only validated worker output can append a turn and advance campaign state. Rejected or incomplete generations remain operational attempts and do not become story history.

Rewind and branch are explicit ledger-boundary operations. A branch creates a separate campaign scope. A rewind changes the current accepted boundary without pretending that provider costs or operational attempts never occurred.

Campaign migrations retain accepted turns and invalidate incompatible provider continuation state. The next request bootstraps from PostgreSQL rather than relying on a model conversation chain.

Same-world version migration updates an existing campaign in place. A cross-world transfer instead creates an independent campaign copy, preserves the source, rebuilds derived Chronicle data under the target world version, and uses target-world canon only for future generation.

Related decisions: [ADR 0003](../architecture/0003-worker-owned-story-engine.md), [ADR 0007](../architecture/0007-world-library-versioning.md), [ADR 0013](../architecture/0013-playable-character-rosters.md), and [ADR 0019](../architecture/0019-cross-world-campaign-transfer.md).
