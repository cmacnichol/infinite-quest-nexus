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

## Review a saved candidate

Some complete candidates pause because continuity evidence conflicts or is unavailable, or because a requested scene is not fully covered. The player shows the saved fiction and the available actions. For a final continuity decision, **Keep this turn** accepts only that exact eligible candidate and makes no text-provider request. For a main scene-coverage decision, Keep preserves that exact main fiction as the prefix, then normal final assembly and any later required gate continue. **Continue with retry** authorizes one bounded repair. If that repair fails, the original eligible candidate is shown again with Keep still available. A refresh, reconnect, or worker restart preserves the pending decision.

Keep is unavailable for incomplete output, invalid structure or choices, mechanics leakage, invalid authority or fact references, required event coverage, and replacement-target failures. Those cases require their specific recovery action and never turn an incomplete preview into an accepted turn.

## Operator rollout and rollback

For a rollout, stop intake and old workers, let active jobs finish or resolve their pending reviews with compatible code, then deploy the compatible API, worker, and both player surfaces before resuming intake. Older recoverable jobs with no review checkpoint retain their existing recovery behavior; operators must not fabricate a keepable candidate from a partial preview.

For rollback, stop intake and workers first, resolve pending or queued review jobs with compatible code, and only then return old workers to service. Keep accepted turns and private audit records in place. This change has no destructive down migration; deployment remains an operator action.

## Terminal failure

If the job reaches a failed state:

1. Record the visible correlation or job information from the activity/status display.
2. Confirm that the selected text profile is enabled and its endpoint and model are reachable.
3. Return to Nexus to correct provider configuration when necessary.
4. Use the available latest-generation retry action only after the original job is no longer active.

A failed or incomplete generation cannot mutate accepted turns, campaign state, or Chronicle memory.
