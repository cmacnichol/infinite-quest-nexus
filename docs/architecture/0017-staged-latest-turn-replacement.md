# ADR 0017: Stage latest-turn replacements until validated commit

## Status

Accepted

## Context

The Story Player previously retried a turn by committing a campaign rewind and then submitting a separate generation request. A provider or network failure between those operations permanently removed the accepted turn. An ambiguous enqueue response also lost the browser's idempotency key, so a durable job could exist while the next click reported that another generation was active.

## Decision

Latest-turn retries are durable `replace_latest` generation jobs. Enqueue captures the turn identifier, the preceding turn number, and the private authoritative state immediately before the replacement target. It does not mutate accepted campaign state.

The worker builds replacement prompts only from world canon and campaign history through the preceding turn. After output validation, one database transaction verifies that the target is still current, removes target-derived artifacts, inserts the replacement at the same turn number, applies its state, rebuilds Chronicle indexes, and completes the job. Any provider, validation, lease, or commit failure leaves the accepted target turn unchanged.

The API returns active or recoverable jobs from campaign sync status. Browser submissions retain and replay one idempotency key, reconcile ambiguous failures against sync status, and resume the returned durable job rather than enqueueing another.

## Consequences

- Readers always see either the original accepted turn or its validated replacement.
- Replacement prompts cannot retrieve the narration being replaced.
- Recoverable jobs remain exclusive until retried or explicitly discarded.
- Replacement commit performs additional Chronicle cleanup and rebuild work.
- The migration is additive, but Swarm workers must understand `replace_latest` before the retry endpoint is exposed during a rolling deployment.

## Rollout

1. Apply migration `0023_durable_generation_replacement.sql`.
2. Roll all worker replicas to replacement-aware code.
3. Roll API replicas, followed by the web client.
4. Smoke-test idempotent replay, provider transport failure preservation, reload recovery, and successful replacement.

Do not enqueue replacement jobs while pre-0023 worker replicas remain eligible to claim generation work.
