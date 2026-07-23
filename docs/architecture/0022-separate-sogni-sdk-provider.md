# 0022: Keep Sogni REST and SDK image providers separate

## Status

Accepted.

## Decision

Infinite Quest Nexus exposes two independent Sogni image-provider types:

- `sogni` uses durable Creative Workflow REST endpoints, caller-controlled idempotency, and Sogni's mandatory content policy. It does not expose an NSFW-filter override.
- `sogni_sdk` uses `@sogni-ai/sogni-client` Projects for model-aware controls, live progress, queue position, ETA, and the explicit `disableNSFWFilter` option.

Both providers persist the remote generation identifier before releasing the Nexus image-job lease. Once that identifier exists, workers reconcile or cancel the existing provider job and never resubmit it. SDK projects tracked by the submitting process provide live progress. After a worker or replica change, Nexus polls `GET /v1/projects/{id}`; the SDK's processing-time 404 is treated as pending until the durable deadline, after which its terminal record and artifact are recovered.

## Consequences

The SDK generates its project UUID internally and does not accept Nexus's idempotency key. A process failure after Sogni accepts the project but before `projects.create()` returns leaves a narrow untracked-charge or duplicate-retry window. This limitation is accepted for general availability and is covered by explicit submit-boundary telemetry and an opt-in paid durability qualification test. Creative Workflow REST remains the stronger option when caller-controlled idempotency is required.

SDK profiles default content filtering to enabled. Operators may disable it for fiction that would otherwise trigger false positives. Temporary preview and artifact URLs are never retained in provider metadata or authoritative story state; completed media is downloaded into Nexus asset storage.
