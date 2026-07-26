# Logs and correlation

The runtime emits structured Pino logs. Preserve JSON logs in production and index identifiers needed to trace one request across API and worker work.

The API accepts `X-Correlation-Id` or generates a UUID. Safe error responses include the correlation identifier. Also capture campaign, generation job, image job, accepted turn, provider/model, and retry identifiers where emitted.

Provider transport diagnostics may record endpoint origin, phase, timeout, status class, and latency. They must not record credentials, authorization headers, prompt bodies, private reasoning, raw rejected responses, or unnecessary story content.

When reporting a problem, include the smallest relevant structured log interval and redact private campaign text.

## Turn generation

Use `generationJobId` as the primary trace key for a turn. The worker lifecycle
events are:

- `turn_generation_claimed` — a worker has acquired the job lease.
- `turn_generation_started` — the worker has begun job execution.
- `turn_generation_provider_started` — a provider call has begun.
- `turn_generation_provider_completed` — a provider call returned.
- `turn_generation_provider_failed` — a provider call failed before it returned.
- `turn_generation_stream_progress` — sampled primary-stream progress.
- `turn_generation_stream_persist_failed` — persisting a primary-stream update failed.
- `turn_generation_validation_completed` — output validation finished.
- `turn_generation_scene_coverage_completed` — scene-coverage validation finished.
- `turn_generation_recovery_started` — an invalid or incomplete result is being repaired.
- `turn_generation_recoverable` — the job stopped in a retryable state.
- `turn_generation_requeued` — a retryable or failed job was placed back in the queue.
- `turn_generation_completed` — exactly one accepted turn was committed.
- `turn_generation_failed` — the job ended without a committed turn.

The API also records one SSE lifecycle pair for each connection:

- `turn_generation_stream_connected`
- `turn_generation_stream_closed`

The principal correlation fields are:

```text
generationJobId
campaignId
workerId
jobAttempt
storyOperation
providerProfileId
providerResponseId
correlationId
```

`jobAttempt` identifies a durable worker claim; a requeue is followed by a new
claim with an incremented value. `storyOperation` distinguishes the primary
story call from recovery and scene-coverage work. `providerResponseId` links a
provider result where one is available. `correlationId` is the API request
identifier and is especially useful for matching one SSE connection's open and
close events; it is not a replacement for `generationJobId`.

For provider calls, `streaming: true` identifies the primary browser-preview
call. Recovery provider calls report `streaming: false` and a recovery
`storyOperation`. `turn_generation_stream_progress` is sampled (rather than
emitted for every chunk) and records only `accumulatedChars` and
`narrationChars`, not story text.
