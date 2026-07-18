# ADR 0005: RPG and event orchestration is typed, private, and retry-stable

Status: accepted

## Context

The first player bridge could not use Nexus mode when RPG stats or event triggers were active. Running those workflows in the browser would require additional direct-provider calls, make replica-safe recovery impossible, and risk placing raw rolls, targets, trigger diagnostics, or referee responses into the narration request.

A recoverable story generation also must not silently produce a new random result. The fictional outcome seen after retry must be the outcome resolved for the original idempotent job.

## Decision

One durable generation job owns three distinct private phases before commit:

1. Assess the action against the campaign's typed RPG stats and persist one cryptographically random percentile resolution.
2. Evaluate typed before-response triggers and combine them with deferred events from the previous accepted turn.
3. Generate and validate narration using only sanitized fictional consequences, then privately evaluate after-response triggers and optionally generate a validated fiction-only extension.

The worker stores typed phase results in `generation_jobs.orchestration_private` before advancing. A lease recovery or manual retry reuses that object, including the original random value. Raw or malformed private phase output is never inserted into turns or Chronicle. Malformed RPG assessment falls back to deterministic local stat matching before one private random resolution; malformed trigger evaluation activates nothing and records only a private diagnostic.

The browser synchronizes RPG stats, event-trigger definitions, suppression state, and deferred events through a user-scoped API guarded by the expected accepted-turn number. The browser does not submit fictional guidance and does not perform provider-side referee or trigger calls in Nexus mode.

The worker maps activated trigger IDs back to authoritative database definitions. Trigger effects and selected RPG outcomes pass through mechanics sanitization before entering the story prompt. The story protocol is bumped to `story-v3-schema-guidance`, invalidating older optional response chains. The v3 contract explicitly types tracker updates and includes bounded schema diagnostics in private repair requests so compatible models can correct field-shape errors without exposing diagnostics to narration or Chronicle.

Only after narration and any optional extension pass schema and mechanics validation does one transaction insert the turn, private mechanics disclosure, state snapshot, trigger counters, deferred triggers, and fiction-only Chronicle memory.

## Consequences

- RPG and event-trigger campaigns remain in the durable Nexus workflow.
- Output-limit recovery, worker restart, and manual retry cannot reroll an existing job.
- The player can still inspect the accepted roll, while story text, prompts, memory, embeddings, and image prompts remain mechanics-free.
- Before/after trigger decisions and reasons remain private and cannot introduce model-invented trigger effects.
- Immediate after-response extensions can fail independently; the accepted main scene remains valid and the event is deferred rather than lost.
- Private orchestration adds provider calls and latency when configured features require them, but those calls are explicit, typed, and auditable.
