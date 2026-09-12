# Recover a generation

Story generation is a durable server job. Closing or refreshing the player does not make the browser authoritative and does not automatically discard the job.

## Refresh or reconnect

Reload the campaign, select it from the dashboard again, or choose **Story** while it is active. The player reconnects to the pending generation and resumes progress.

## Recoverable provider output

When a provider stops at an output limit or returns incomplete structured
output, the worker preserves a recoverable job. For Story Direction, a valid
narration with invalid or duplicate choices can use the bounded automatic repair
allowance. If the response still needs choice repair after that allowance is
used, it becomes pending and waits for you to select the explicit retry action.
That retry makes one choices-only request; a lease reclaim does not make an
extra provider request. Private assessment and random resolution remain stable
for Action recovery.

Continue to watch the current job rather than submitting the action again.
The pending turn retains its frozen Action or Story Direction policy, including
the saved prompt identity. Recovery, retry, reclaim, and replacement do not
reclassify or convert it.

## Terminal failure

If the job reaches a failed state:

1. Record the visible correlation or job information from the activity/status display.
2. Confirm that the selected text profile is enabled and its endpoint and model are reachable.
3. Return to Nexus to correct provider configuration when necessary.
4. Use the available latest-generation retry action only after the original job is no longer active.

A failed or incomplete generation cannot mutate accepted turns, campaign state, or Chronicle memory.
