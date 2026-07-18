# ADR 0002: PostgreSQL provides the initial durable worker queue

Status: accepted

## Context

Local Compose must remain a two-container steady state, while Swarm must support multiple API and worker replicas. Generation and memory jobs must survive restarts and must not execute concurrently against the same queue row.

## Decision

Use PostgreSQL queue tables claimed with `FOR UPDATE SKIP LOCKED`. Workers apply leases with an owner and expiration time, permitting recovery after a crashed worker. Canonical commits use transactions and uniqueness constraints independently of queue delivery.

Chronicle reindex and Story Engine generation jobs use these conventions. Story jobs add request idempotency, one-active-job-per-campaign enforcement, leased attempt records, explicit recoverable failure, and a transactional accepted-turn plus Chronicle commit. Image jobs will adopt the same conventions while remaining independent children of accepted story turns.

## Consequences

- No Redis container is required for the initial architecture.
- Multiple worker replicas can claim different jobs safely.
- PostgreSQL connection and queue latency must be monitored.
- LISTEN/NOTIFY may later reduce polling latency, but it will remain an optimization rather than a durability mechanism.
