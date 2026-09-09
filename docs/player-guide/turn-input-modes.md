# Turn input modes

There is no Auto input mode, classifier request, or separate campaign mode
setting. The campaign's saved **Turn control style** controls the default and
available choices; the visible controls vary by player interface.

## Action

Choose **Action** when the player character is attempting something. The Story
Engine may assess uncertainty, resolve private mechanics, and narrate the
result. Include dialogue, priorities, and approach, but do not assert that an
uncertain outcome has already happened.

## Story Direction

Choose **Story Direction** when the entered events and details are requested
fiction for the next narration. The Story Engine treats the direction as
fiction to dramatize and then advances to its aftermath. Use it for directed
dialogue, reveals, arrivals, environmental changes, or a decided sequence.
World canon and corrected campaign continuity still constrain the request, so a
direction cannot make incompatible facts true. It guides the narration; it does
not promise every unspecified outcome.

Story Direction skips RPG assessment, event evaluation, and independent
semantic scene-coverage work. It preserves stored RPG data, event triggers,
and pending events without sending them into narration. World canon, campaign
state, corrected continuity, Chronicle retrieval, token budgets, validation,
and mechanics-leak prevention remain active.

The worker requires four distinct next directions and a distinct custom
suggestion. If only choices are invalid, it may perform one bounded
choice-only repair that preserves narration, state, facts, and authority. A
retry or reclaim uses the policy and prompt snapshot saved when the job was
queued.

## Campaign control styles

| Stored style | Player behavior |
| --- | --- |
| **Actions only** (action_only) | Action is fixed. |
| **Action** (flexible_action) | Action is selected initially; the player can explicitly select Story Direction where that interface offers the control. |
| **Story Direction** (flexible_scene) | The player submits Story Direction and new jobs use the story-only workflow. |

The profile default seeds new campaigns only. Changing it never changes an
existing campaign or accepted turn. Changing a campaign between Action and
Story Direction affects newly queued jobs after the save succeeds; it does not
convert an active, recoverable, or accepted job.

Older persisted `flexible_auto` settings normalize to Action. Historical jobs
retain their stored resolved input and policy compatibility data; the active
Auto classification path is retired.

## Context and portability

The editor and API accept up to 12,000 characters. The Story Engine retains the
complete input inside its protected request envelope or returns an explicit
budget error; it does not silently truncate submitted text.

The selected context budget and turn-control policy are captured for every
queued job. Portable accepted-turn provenance retains only the policy version,
play mode, control style, and protocol identity. It excludes runtime prompt
snapshots, provider credentials, chains, and checkpoints.
