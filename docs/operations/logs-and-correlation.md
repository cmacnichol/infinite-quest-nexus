# Logs and correlation

The runtime emits structured Pino logs. Preserve JSON logs in production and index identifiers needed to trace one request across API and worker work.

The API accepts `X-Correlation-Id` or generates a UUID. Safe error responses include the correlation identifier. Also capture campaign, generation job, image job, accepted turn, provider/model, and retry identifiers where emitted.

Provider transport diagnostics may record endpoint origin, phase, timeout, status class, and latency. They must not record credentials, authorization headers, prompt bodies, private reasoning, raw rejected responses, or unnecessary story content.

When reporting a problem, include the smallest relevant structured log interval and redact private campaign text.
