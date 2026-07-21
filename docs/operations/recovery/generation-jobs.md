# Recover generation jobs

Generation jobs are durable and idempotent. The API enqueues them; workers claim them with row locks and leases.

When a browser disconnects, reload the same campaign and let the player reconnect. Do not enqueue a duplicate action while the original job is active.

For an apparently stuck job:

1. Record job and correlation identifiers.
2. Inspect status, current stage, lease owner/expiry, and attempts.
3. Confirm a worker is healthy and schema-current.
4. Confirm the selected text endpoint/model is reachable from the worker.
5. Allow an expired lease to become claimable according to runtime policy.
6. Use the supported retry endpoint/UI only for a recoverable or failed job.

Private mechanics and random outcomes are persisted for retry stability. Incomplete output never mutates the accepted ledger.
