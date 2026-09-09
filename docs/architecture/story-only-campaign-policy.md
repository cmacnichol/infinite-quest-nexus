# Story-only campaign policy

## Current decision

Story-only play is the `flexible_scene` campaign turn-control style, labelled
**Story Direction** in the current settings and player controls. It is a
campaign setting, not an Auto input mode or a new provider role. The stored
policy snapshots the style when a generation job is queued, so retries and
lease reclaim execute the same policy even if the campaign is later changed.

`flexible_action` starts with Action and may offer an explicit Story Direction
control in the player interface. `action_only` accepts Action only.
`flexible_scene` accepts Story Direction only. Historical `flexible_auto`
values normalize to `flexible_action`; the retired classifier is not consulted.

## Generation boundary

For a job queued while its campaign setting is Story Direction, the policy is
version 1 with play mode `story_only` and protocol `story-only-v1`. An explicit
Story Direction turn in a flexible Action campaign remains on the legacy scene
path. The story-only snapshot captures the exact required system supplement,
the exact choice-repair text, and their hashes before dispatch. A worker uses
this durable snapshot rather than deriving policy from the campaign's current
setting.

The story-only path preserves the authoritative world version, campaign state,
corrected continuity, Chronicle retrieval, context budget, output validation,
and mechanics-leak checks. It skips RPG assessment, event evaluation, and
independent semantic scene coverage. Stored RPG data, event triggers, and
pending events remain durable but do not enter fiction narration.

The submitted direction is required fiction only within authoritative world
facts and corrected continuity. Unspecified outcomes remain plausible fiction.
The response must contain four distinct immediate directions and a distinct
custom suggestion. If narration is valid but only choices are invalid, the
worker may perform one choice-only repair without replacing narration, state,
or canonical authority.

## Compatibility and portability

Migration `0094_story_generation_policy.sql` adds nullable generation-policy
columns to jobs and accepted turns. New work gets a policy snapshot; existing
historical rows remain null and are read through their legacy path. The
migration also normalizes persisted campaign and user `flexible_auto` defaults
to `flexible_action` without rewriting historical jobs.

Campaign Archive root manifest version 2 requires campaign payload version 4.
That payload records generation-policy version 1 and redacted accepted-turn
provenance only: policy version, play mode, turn-control style, and protocol
identity. Runtime generation-policy prompt snapshots, provider credentials,
response chains, and checkpoints do not leave the source runtime through that
provenance. Authored Prompt Library templates have their own System Archive
portability contract. System Archive root manifest version 2 and system
payload/record version 3 are separate contracts.

## Operations

Roll out the additive migration only after intake is stopped and queued or
recoverable jobs are resolved. Stop old workers and record zero old worker
processes and zero old leases before a compatible worker processes new policy
snapshots. Deploy compatible API, worker, and player builds together, then run
copied-campaign canaries and inspect the provider operation list, commit, and
next-turn behavior before resuming intake. The general rolling-worker overlap
procedure does not apply to this migration because old workers cannot be fenced
by a new policy snapshot.

For rollback, stop intake, resolve new-policy jobs, and stop compatible workers
before an old binary can claim work. Retain the additive schema and accepted
history; do not run a down migration, delete policy rows, or reset campaigns to
make an old binary start.

## Historical record

[ADR 0021](./0021-turn-input-intent-classification.md) records the former
Auto-classifier design. It is superseded for active turn handling but retained
to explain historical rows and older exports.
