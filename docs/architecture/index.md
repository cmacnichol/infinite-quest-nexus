# Architecture decisions

Architecture decision records (ADRs) preserve consequential design decisions and their tradeoffs. Concept pages synthesize current behavior across the complete decision history; later decisions may refine a compatibility detail from an earlier record.

## Persistence, jobs, and migrations

- [ADR 0001: PostgreSQL owns campaigns and Chronicle memory](./0001-postgresql-chronicle.md)
- [ADR 0002: PostgreSQL provides the initial durable worker queue](./0002-postgresql-worker-jobs.md)
- [ADR 0009: Automatic coordinated schema migrations](./0009-automatic-schema-migrations.md)

## Story Engine and Chronicle

- [ADR 0003: The worker owns text generation](./0003-worker-owned-story-engine.md)
- [ADR 0004: Player and Story Engine bridge](./0004-player-story-engine-bridge.md)
- [ADR 0005: Typed private story orchestration](./0005-typed-private-story-orchestration.md)
- [ADR 0006: Campaign-scoped semantic Chronicle](./0006-campaign-scoped-semantic-chronicle.md)
- [ADR 0010: Dynamic Chronicle context](./0010-dynamic-chronicle-context.md)
- [ADR 0011: Provider-reported campaign costs](./0011-provider-reported-campaign-costs.md)
- [ADR 0012: Provider transport deadlines](./0012-provider-transport-deadlines.md)
- [ADR 0017: Staged latest-turn replacement](./0017-staged-latest-turn-replacement.md)
- [ADR 0018: Canonical facts use structured, rebuildable projections](./0018-structured-canonical-fact-projections.md)
- [ADR 0020: Retire the legacy player from the runtime](./0020-retire-legacy-player-runtime.md)

## World Library and characters

- [ADR 0007: World Library versioning](./0007-world-library-versioning.md)
- [ADR 0013: Playable-character rosters and campaign snapshots](./0013-playable-character-rosters.md)
- [ADR 0014: Roster-only world character guidance](./0014-roster-only-world-character-guidance.md)
- [ADR 0015: Deletable unused world versions](./0015-deletable-unused-world-versions.md)
- [ADR 0016: Reviewed character authoring](./0016-reviewed-character-authoring.md)
- [ADR 0019: Cross-world campaign transfer creates an independent copy](./0019-cross-world-campaign-transfer.md)

ADR 0014 supersedes only the backward-compatibility portions of ADR 0013 that allowed legacy top-level character guidance to remain authoritative. It does not supersede structured rosters or campaign character snapshots.

## Illustrations

- [ADR 0008: Independent durable illustration pipeline](./0008-independent-illustration-pipeline.md)

## Reading historical decisions

Some early ADRs refer to the legacy player bridge or to provider work that was implemented later. Preserve that chronology when reading the records. For current deployment and product behavior, use the active guides and concept pages and follow their links back to the relevant decisions.

ADR 0020 supersedes ADR 0004's runtime-routing decision. ADR 0004 remains the historical record of the temporary migration bridge.
