# ADR 0012: Provider transport deadlines and diagnostics

## Status

Accepted

## Decision

Each provider profile stores an overall HTTP request deadline in milliseconds. New and migrated profiles default to 300,000 milliseconds (five minutes); the supported UI range is one to sixty minutes.

The Story Engine applies the deadline to text generation, embedding generation, image generation, and model discovery. Each request uses an abort signal for the exact overall wall-clock deadline and an Undici dispatcher whose header, body, and connection ceilings are set to the maximum supported profile deadline. This prevents an implicit transport timeout from preempting the profile deadline while the abort signal still enforces shorter configured values exactly.

Network failures are normalized as either `provider_request_timeout` or `provider_transport_error`. Safe diagnostic fields include provider type, operation, sanitized endpoint path, model, configured timeout, elapsed time, transport code, and low-level cause name/message. Prompts, request bodies, response bodies, and credentials are excluded.

The worker writes a base transport event and a job-correlated event to container standard error. Failed generation jobs also retain safe transport metadata in `recovery_metadata`, allowing the player Activity Log to identify the campaign, generation job, timeout, endpoint, and transport code while confirming that the accepted campaign turn was not changed.

## Consequences

- Slow local models can be given more than five minutes without being canceled by the Node HTTP client.
- Shorter deadlines can be selected independently for remote or auxiliary providers.
- Docker logs contain actionable transport causes even when the browser receives only a safe error message.
- Changing this setting affects subsequent requests only; in-flight requests retain the deadline with which they started.
