# Actions and choices

## Submit a generated choice

Select a choice beneath the current narration. By default, Infinite Quest
submits it immediately using the campaign's saved turn-control style. A choice
from a **Story Direction** campaign remains Story Direction after reload or
when the other player interface is used; it is not silently converted to an
Action.

To review or extend a choice before submitting it:

1. Open the user profile.
2. Clear **Auto-submit story turns when selecting a choice**.
3. Save the profile.

Selecting a choice now copies it into the composer. This preference controls
only automatic choice submission; it does not choose a turn-control style.

## Submit original text

In an **Action** campaign, start with **Action** and use the visible selector,
where offered, to explicitly submit a **Story Direction**. A **Story Direction**
campaign accepts Story Direction only. Enter the next move or direction, then
select **Continue story** or press Enter. Use Shift+Enter for a line break.

- **Action** describes what the character attempts. Existing mechanics may
  assess uncertain outcomes before narration.
- **Story Direction** describes the fiction that should occur next. It uses the
  story-only workflow: the worker preserves authoritative world and campaign
  context, but skips RPG assessment, event evaluation, and scene-coverage
  stages.

Neither input accepts hidden state, system instructions, or private mechanics.
See [Turn input modes](./turn-input-modes.md).

## While generation is busy

The player disables competing turn submission while the durable job is active.
Refresh is safe: it reconnects to the same job instead of creating another.
Settings changes that would alter the campaign's turn-control style are
rejected until unresolved generation is resolved, so an in-flight job keeps its
frozen policy.
