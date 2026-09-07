# Durable AI authoring operations

## Rollout

1. Back up the authoritative database and apply the additive migrations with compatible API and worker builds deployed together.
2. Keep `AI_AUTHORING_JOBS_ENABLED=false` in Compose or in both Swarm API and worker services. Confirm `/api/v1/meta` reports the capability as unavailable and existing clients retain synchronous preview behavior.
3. In a disposable environment, verify the worker’s bounded authoring cleanup lane and a normal generation lane. Do not infer this proof from a configuration render.
4. Set `AI_AUTHORING_JOBS_ENABLED=true` for the combined Compose runtime, or for both compatible Swarm API and worker services. Recreate or update the services; runtime environment settings are read at process start.
5. Confirm the capability before enabling durable-proposal client flows. Keep the gate false if workers are not yet compatible.

## Retention and recovery

Proposals expire seven days after their last execution or user mutation. Reads, lists, and worker heartbeats do not extend that deadline. Cleanup processes at most 100 jobs per tick, locks work with PostgreSQL `SKIP LOCKED`, fences a running stage before clearing payloads, and leaves saved world content unchanged. Applied jobs retain an idempotency receipt for 30 days; after that deadline the receipt is unavailable and cleanup clears it.

Provider calls are not exactly once: lease loss can repeat a request. Durable checkpoints and revision-checked apply prevent stale output from becoming authoritative. Synchronous previews that were in flight before this rollout cannot be recovered as durable jobs.

## Rollback

Set `AI_AUTHORING_JOBS_ENABLED=false` on the API and worker, then return clients to synchronous flows after the capability is false. Do not down-migrate, delete authoring tables, or purge proposals as part of rollback. Compatible workers continue ordinary retention cleanup while the gate is false; checkpoints remain resumable only until their existing inactivity deadline. Returning to an older binary that lacks cleanup can defer physical deletion, but it does not extend an expired proposal’s authority. Re-enable a compatible worker and the gate to resume unexpired proposals.

System Archive deliberately excludes authoring inputs, stage output, reviews, and receipts. Use the normal PostgreSQL recovery procedure for installation recovery; a portable System Archive does not preserve operational authoring work.
