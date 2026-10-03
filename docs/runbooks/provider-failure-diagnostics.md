# Provider failure diagnostics

Capture describes the observed rejection; it does not diagnose account exhaustion from HTTP 429 alone. Inspect the failed generation and its physical attempts without submitting another generation. Old rows with null evidence remain unknown. Never backfill a source from a later successful request.

## Read-only investigation

Use the server-resolved owner UUID and exact generation job UUID. In a read-only SQL session, bind `:owner_user_id` and `:generation_job_id` to those IDs:

```sql
BEGIN READ ONLY;
SELECT j.id AS generation_job_id, j.campaign_id, j.status, j.attempts,
       j.result_turn_id, a.id AS physical_attempt_id, a.candidate_ordinal,
       a.provider_response_id, a.reserved_at, a.dispatched_at,
       a.response_started_at, a.completed_at, a.outcome, a.failure_reason,
       a.emitted_output,
       a.failure_diagnostic->>'source' AS failure_source,
       a.failure_diagnostic->>'observedAt' AS observed_at,
       a.failure_diagnostic->>'httpStatus' AS http_status,
       a.failure_diagnostic->>'upstreamStatus' AS upstream_status,
       a.failure_diagnostic->>'limitSource' AS limit_source,
       a.failure_diagnostic->>'upstreamCode' AS upstream_code,
       a.failure_diagnostic->>'retryAfterMs' AS retry_after_ms,
       a.failure_diagnostic->>'retryAt' AS retry_at,
       a.failure_diagnostic->>'metadataStatus' AS metadata_status
FROM generation_jobs j
JOIN prepared_text_physical_attempts a
  ON a.owner_user_id=j.owner_user_id AND a.logical_kind='story'
 AND a.logical_reservation->>'generationJobId'=j.id::text
WHERE j.owner_user_id=:'owner_user_id'::uuid
  AND j.id=:'generation_job_id'::uuid
ORDER BY a.reserved_at,a.id;
ROLLBACK;
```

The query excludes raw request bodies, prompts, provider responses, credentials and private reasoning. Do not replace its named columns with `SELECT *` or export `orchestration_private`. Preserve the owner/job predicates when correlating logs.

`recognized` means recognized metadata was retained, not that every field is known. `absent`, `unrecognized`, `malformed` and `oversized` describe capture availability. A null column predates capture or has no supported evidence. `unknown` source cannot identify OpenRouter versus an upstream provider. Corroborated inventory identity is optional; the most recent successful provider is not evidence for a rejected request. OpenRouter header-only attribution is accepted only for a verified OpenRouter endpoint. Numeric reset-header units are undocumented and remain null.

Keep the physical attempt ID, provider response ID and observed timestamp together. An OpenRouter generation ID can identify a rejected HTTP request even when metadata lookup returns 404; it never proves successful response start. Correlate existing IDs with the provider dashboard or existing request metadata, without pressing Retry or issuing a paid probe. Confirmed platform/upstream source requires recognized explicit evidence. A streaming error retains HTTP 200 separately from its upstream error status.

## Player recovery

GET, SSE and campaign reload expose a bounded projection: statuses, source/reason, limiter source and retry timing. Provider identity, counters and upstream codes remain operator evidence. The fixed reason precedes optional context warnings. Suggested retry time is advisory; an elapsed wait does not mean the provider is healthy. No clock, status read or reload sends a request.

Explicit Retry creates a new logical attempt. For a failed primary with validated, matching durable non-2xx HTTP rejection, no response start and no output, it re-arms the saved request without changing the old physical row. Owner, job, invocation, request hash/body and claim-attempt proofs must match. Ambiguous, stale, malformed, SSE or post-output evidence keeps the interrupted-output fence. Current Story presets still send one `@preset/<slug>` candidate per authorized logical invocation. Automatic retries require a separate policy design.

## Rollout and rollback

1. Take and verify the normal database backup.
2. Apply the additive nullable `failure_diagnostic` migration through the normal migration role.
3. Roll out compatible API and workers, then the frontend.
4. Only when authorized, inspect a naturally occurring failure or use a copied campaign for a canary. Do not generate merely to identify a past limiter.
5. Inspect safe evidence and confirm no accepted turn/state/Chronicle mutation on rejection.

Rollback binaries may ignore the nullable column. Retain the column, captured attempts and costs; do not drop evidence or rewrite old jobs. This implementation does not deploy automatically. See [deployment](deployment.md), [transport diagnostics](../architecture/0012-provider-transport-deadlines.md), and [verification](../review/provider-failure-diagnostics-verification.md).
