# Actions and choices

## Submit a generated choice

Select one of the choices beneath the current narration. By default, Infinite Quest submits the choice immediately as the next action.

To review or extend a choice before submitting it:

1. Open the user profile.
2. Clear **Auto-submit story turns when selecting a choice**.
3. Save the profile.

Selecting a choice now copies it into the free-action editor.

Generated choices always submit as **Action**. If a flexible campaign was set to Auto or Scene direction, copying a choice selects Action before submission so the Story Engine can resolve the proposed attempt.

## Submit an original action

1. In a flexible campaign, select **Auto**, **Action**, or **Scene direction**.
2. Enter the turn text in the editor.
3. Select the mode-specific submit button or press Enter.

Use Shift+Enter for a line break. Action describes fictional intent; Scene direction supplies required current-turn events. Neither mode accepts hidden state, system instructions, or private mechanics. See [Turn input modes](./turn-input-modes.md).

## While generation is busy

The player disables competing turn submission while the durable job is active. Progress may show private mechanics stages, but only sanitized fictional consequences are sent into narration.

Do not refresh merely to speed up generation. Refresh is safe, but it reconnects to the same job rather than starting another one.
