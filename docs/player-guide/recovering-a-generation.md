# Recover a generation

Story generation is a durable server job. Closing or refreshing the player does not make the browser authoritative and does not automatically discard the job.

## Refresh or reconnect

Reload the campaign or select **Load story** again. The player reconnects to the pending generation and resumes progress.

## Recoverable provider output

When a provider stops at an output limit or returns incomplete structured output, the worker can retry through its persisted recovery path. Private assessment and random resolution remain stable across that recovery.

The player performs one supported automatic retry for a recoverable generation. Continue to watch the current job rather than submitting the action again.

## Terminal failure

If the job reaches a failed state:

1. Record the visible correlation or job information from the activity/status display.
2. Confirm that the selected text profile is enabled and its endpoint and model are reachable.
3. Return to Nexus to correct provider configuration when necessary.
4. Use the available latest-generation retry action only after the original job is no longer active.

A failed or incomplete generation cannot mutate accepted turns, campaign state, or Chronicle memory.
