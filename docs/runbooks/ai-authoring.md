# Durable AI authoring operations

## Rollout

1. Back up the authoritative database and apply the additive migrations with compatible API and worker builds deployed together.
2. Keep `AI_AUTHORING_JOBS_ENABLED=false` in Compose or in both Swarm API and worker services. Confirm `/api/v1/authoring/capabilities` reports `enabled: false` and existing clients retain synchronous preview behavior.
3. In a disposable environment, verify the worker’s bounded authoring cleanup lane and a normal generation lane. Do not infer this proof from a configuration render.
4. Set `AI_AUTHORING_JOBS_ENABLED=true` for the combined Compose runtime, or for both compatible Swarm API and worker services. Recreate or update the services; runtime environment settings are read at process start.
5. Confirm the capability before enabling durable-proposal client flows. Keep the gate false if workers are not yet compatible.

## Story-source capability and rollback

`AI_STORY_SOURCE_AUTHORING_ENABLED` is a separate startup setting for story and chapter intake. Its default is `true`; set it to `false` on both compatible API and worker services to pause source execution while `AI_AUTHORING_JOBS_ENABLED=true` continues Patch 2 world-concept and character proposals. Confirm `/api/v1/authoring/capabilities` omits `story_source` from `supportedKinds` before hiding new-source controls.

The pause is enforced server-side for generic and named source submissions, source retry, and source synthesis. It pauses before claim, so an already leased source stage may finish its generation-fenced checkpoint; queued and expired-lease source stages are not claimed or marked retry-exhausted. Owned source proposals remain readable and may be fact-reviewed, explicitly applied, cancelled, discarded, or cleaned up without a provider call. Keep the client resume/review controls available for those provider-free operations and show that execution is paused when retry or synthesis is attempted.

Do not roll back to a writer that cannot preserve schema-6 `sourceMaterial`. Reverting the source UI is safe after the capability is false. A code rollback must retain schema-6 reads and writes, all Patch 2 jobs, and the authoring cleanup lane. Do not down-migrate authoring tables or strip accepted source appendices from drafts, versions, exports, campaigns, or System Archives.

## Retention and recovery

Proposals expire seven days after their last execution or user mutation. Reads, lists, and worker heartbeats do not extend that deadline. Cleanup processes at most 100 jobs per tick, locks work with PostgreSQL `SKIP LOCKED`, fences a running stage before clearing payloads, and leaves saved world content unchanged. Applied jobs retain an idempotency receipt for 30 days; after that deadline the receipt is unavailable and cleanup clears it.

Provider calls are not exactly once: lease loss can repeat a request. Durable checkpoints and revision-checked apply prevent stale output from becoming authoritative. Synchronous previews that were in flight before this rollout cannot be recovered as durable jobs.

## Rollback

Set `AI_AUTHORING_JOBS_ENABLED=false` on the API and worker, then return clients to synchronous flows after the capability is false. Do not down-migrate, delete authoring tables, or purge proposals as part of rollback. Compatible workers continue ordinary retention cleanup while the gate is false; checkpoints remain resumable only until their existing inactivity deadline. Returning to an older binary that lacks cleanup can defer physical deletion, but it does not extend an expired proposal’s authority. Re-enable a compatible worker and the gate to resume unexpired proposals.

System Archive deliberately excludes authoring inputs, stage output, reviews, and receipts. Use the normal PostgreSQL recovery procedure for installation recovery; a portable System Archive does not preserve operational authoring work.

For story-source proposals, discard, successful apply, and expiry cleanup also clear the operational source plan and fact review. The accepted appendix saved in a draft or version is authoritative portable content and is not deleted by job cleanup.
