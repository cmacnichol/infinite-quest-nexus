# Troubleshoot operations

## Application never becomes ready

- Check PostgreSQL health and connection credentials.
- Confirm the `vector` extension is installed.
- Inspect migration logs for pending maintenance work or checksum/order problems.
- Confirm the database is reachable from the container network.

## Worker is healthy but jobs do not complete

- Inspect job status, lease age, attempts, and correlation IDs.
- Confirm worker schema verification completed.
- Test the selected role-specific provider from the worker network.
- Confirm model availability and request deadline.
- Verify shared asset writability for image jobs.

## Streaming story appears to restart

1. Filter logs by `generationJobId`.
2. Order the matching events by timestamp.
3. Confirm that only one `turn_generation_provider_started` event has `streaming: true`.
4. Check whether `turn_generation_recovery_started` follows primary validation.
5. Check whether `turn_generation_requeued` is followed by a new claim with an incremented `jobAttempt`.
6. Compare `turn_generation_stream_connected` and `turn_generation_stream_closed` counts to identify browser or network reconnects.
7. Confirm the sequence terminates in exactly one of `turn_generation_completed`, `turn_generation_recoverable`, or `turn_generation_failed`.

A recovery provider call is expected after invalid output. It reports
`streaming: false` and must not replace the browser preview. A durable retry is
different: it creates another worker attempt for the same job. An SSE reconnect
is different again: it creates another connected/closed pair for the same job
without starting another provider call.

## Embeddings fail

Story generation should continue with lexical fallback. Confirm the embedding profile, model capability, prefixes, and batch size, then reindex.

## Images fail

Accepted story turns remain valid. Confirm independent image credentials, model, output format, shared storage permissions, and retry policy. For Sogni, also check account balance or entitlement, active-workflow and rate limits, persisted remote-job state, request timeout, generation deadline, artifact-host restrictions, and whether the chosen workflow honors the requested sensitive-content filter mode. If discovery is empty, try the exact image model ID manually.

## Saved provider key cannot be decrypted

Confirm the deployment has the same credential-encryption key used when the profile was saved. Changing the key is not a credential-rotation procedure; it makes existing ciphertext unreadable.
