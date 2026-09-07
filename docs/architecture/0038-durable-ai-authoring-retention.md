# ADR 0038: Durable AI authoring proposals have bounded operational retention

## Status

Accepted

## Context

Durable AI authoring jobs retain untrusted prompts, provider checkpoints, review proposals, and an idempotent applied receipt. They are useful only while a user can resume or replay the associated request. They are not world authority and must not enter System Archives.

## Decision

Inactive proposals expire after seven days. An applied job retains only its owner-scoped apply receipt and request hash for thirty days. Reads, list requests, and lease heartbeats do not extend either deadline. A bounded cleanup tick selects no more than 100 expired jobs with `FOR UPDATE SKIP LOCKED`, locks each job before its stages, revokes execution fencing, and then clears proposal payloads. Cleanup never changes a saved draft or published world.

`AI_AUTHORING_JOBS_ENABLED` defaults to false. It controls new admission and provider execution. Compatible workers continue ordinary bounded cleanup while it is false, so disabling the feature does not pause retention. The authoring tables remain operational and are excluded from System Archives.

## Consequences

- Operators can roll out and roll back through a capability gate without a down migration or immediate purge.
- A lost worker lease may cause an external provider request to be repeated; fencing prevents stale output from becoming current.
- Synchronous previews created before rollout have no durable checkpoint to recover.
