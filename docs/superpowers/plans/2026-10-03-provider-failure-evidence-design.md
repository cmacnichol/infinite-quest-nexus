# Provider failure evidence and safe retry guidance design

Date: 2026-10-03
Status: Implementation authorized by the subsequent user request and completed; Tasks 1–5 reviewed and Task 6 selected verification passed. Final branch review and operator rollout remain separate. Platform skips and resolved final review minors are recorded in the [verification report](../../review/provider-failure-diagnostics-verification.md).
Planning baseline: `30a884a1` (Error Diagnostic). Implementation rebased onto `origin/main` `66a0deeb`; preserve the original diagnosis dates below.

## Problem and evidence

The deployed baseline preserves `provider_rate_limited` and displays its fixed message. It does not retain enough upstream evidence to distinguish OpenRouter platform throttling from provider capacity. Three post-deployment requests failed before successful response start, with zero output, in 0.871, 1.188, and 1.050 seconds. An identical request payload subsequently succeeded about 16 seconds after one failure. Failed request metadata lookups returned 404. Successful requests used DeepSeek V3.2 through DeepInfra; this does not establish which provider rejected failed requests.

The HTTP adapter parses the upstream error body, but prepared-contract errors retain only response identity and format diagnostics. HTTP status and Retry-After survive transiently on error objects; the physical-attempt completion loses them. `classifyPresetRouteFailure` infers response start from a response ID, and the database attempt reader makes a similar inference from identity fields. An ID attached to a rejected HTTP request is not proof of successful response start.

These observations justify better evidence and correcting that classification. They do not establish account exhaustion, DeepInfra-specific throttling, or safe automatic replay of every failed request.

## Scope and delivery boundary

Implement durable, bounded upstream failure evidence; publish a safe projection in the current Story surface; show provider-specified retry timing; correct successful-response-start tracking. Preserve the already shipped reason messages.

Do not automatically resend requests, rotate keys, alter remote presets, expand provider fallback, change narration prompts, or backfill historical jobs. Existing explicit Retry continues to create work through the established workflow. Retry timing is advisory, not a promise of capacity and not a new authorization gate.

Automatic retry is a separate follow-up after diagnostic evidence is available. The current uniqueness key `(logical_kind, reservation_key, candidate_ordinal)` represents one wire dispatch. Reusing that row, inventing a candidate, or minting an untracked logical invocation to retry would violate audit/idempotency semantics. Also preserve the decision in [Story preset JSON Schema dispatch](2026-09-23-story-preset-schema.md): new Story presets send one `@preset/<slug>` request and leave provider/model fallback to OpenRouter.

## Evidence contract

Add `ProviderFailureEvidenceV1` in `packages/contracts/src/provider-failure.ts`, validated by a strict schema:

| Field | Contract |
| --- | --- |
| version | Literal 1 |
| source | `http_error`, `sse_error`, or `transport_error` |
| observedAt | UTC ISO datetime sampled when the failure is observed |
| httpStatus | Integer 100..599 or null; SSE preserves actual HTTP 200 |
| upstreamStatus | Integer 100..599 or null from numeric error code |
| reason | Existing route failure vocabulary, including `unknown` |
| limitSource | `openrouter_platform`, `upstream_provider`, `upstream_provider_shared_pool`, `openrouter_in_flight_budget`, `openrouter_key_limit`, `openrouter_credits`, or `unknown` |
| upstreamCode | Known normalized symbol from a finite allowlist, or null |
| providerName | A corroborated provider identity or null |
| retryAfterMs | Nonnegative safe integer <= 86400000, or null |
| retryAt | UTC ISO datetime derived from observedAt + retryAfterMs, or null |
| rateLimit | Null or object with nullable nonnegative safe-integer `limit`, `remaining`, and nullable UTC ISO `resetAt` |
| successfulResponseStarted | Boolean; successful HTTP headers/accepted streaming evidence, never an error ID alone |
| emittedOutput | Boolean, monotonically true after output |
| metadataStatus | `recognized`, `absent`, `unrecognized`, `malformed`, or `oversized` |

Keep existing response ID, requested model, actual returned model/provider, timestamps, usage and cost fields in the physical-attempt record; do not duplicate raw provider objects into this evidence.

The upstream-code allowlist initially contains `rate_limit_exceeded`, `provider_overloaded`, `provider_unavailable`, `in_flight_budget_exhausted`, `weight_exceeds_budget`, `insufficient_credits`, `invalid_api_key`, and `permission_denied`. Unknown strings are not persisted. Numeric error status is preserved separately. Provider name is accepted only if it matches a resolved/inventory identity already available to the invocation; otherwise leave it null. Do not invent a provider identity from the most recent successful request.

Read exact recognized values from `error.code`, `error.type`, and `error.metadata` fields `error_type`, `reason`, `limit_source`, `provider_code`, `provider_error_code`, `provider_name`, and `is_byok`. BYOK is only supporting evidence for source classification, not a public account detail. Recognize platform headers and explicit source metadata; never infer upstream ownership from HTTP 429 alone. Unknown vendor forms stay unknown. Do not persist `error.message`, `metadata.raw`, `remedy_hint`, headers wholesale, URLs, credentials, prompts, or raw response bodies. Add new vocabulary only with provider documentation and sanitized fixtures.

Parse Retry-After seconds and HTTP-date. Reject negative, nonfinite, overflow, or >24h values instead of shortening them. Retain zero as valid. Parse X-RateLimit-Reset only with documented units; OpenRouter's documentation supplies no numeric reset units, so those forms remain null and are pinned as unsupported in fixtures. Do not guess units from digit count. Cap the serialized evidence at 4096 UTF-8 bytes; on overflow retain minimal known status/source/reason and mark oversized.

## Storage and propagation

Add nullable `failure_diagnostic jsonb` to `prepared_text_physical_attempts` in the next migration (0114 at this baseline). Validate object/version/4096-byte size in PostgreSQL and validate the full schema in application code. No backfill or uniqueness/index changes. Store the failure and evidence atomically under the same owner/claim guards. Failure-evidence validation must fall back to a minimal known-safe record rather than masking the original error or leaving an otherwise completable attempt unrecorded.

Carry evidence through ProviderHttpError, PreparedResponseContractError and PreparedRouteTerminalError with explicit fields. Extract before throwing/wrapping. Capture minimal status/header evidence even when body parsing fails. SSE evidence preserves successful response start and output state; no SSE failure can enable a new fallback merely because it contains 429.

Add optional `providerFailure` to the private generation failure diagnostic and its safe public projection. Keep the existing public generic error envelope and existing `code`/`message` fields. Public evidence contains only status, finite source/reason, retryAt, and retryAfterMs; detailed provider identity, rate counters, and upstream codes remain operator diagnostics. Old readers may omit the new optional field; malformed/unknown evidence must not invalidate the whole job or SSE snapshot.

Expose the same projected evidence through GET status, SSE, and campaign reload. Extend snapshot copying and equality so changed evidence is not silently deduplicated. Keep context-omission warnings separate and visually subordinate to the failure reason.

## Successful response and fallback semantics

Track successfulResponseStarted explicitly at the provider boundary and preserve it through errors. Read `response_started_at IS NOT NULL` in every repository record path. Preserve `provider_response_id` even for non-2xx responses, without setting response_started_at. For legacy/third-party errors lacking explicit evidence, use conservative classification: unknown start must never create a newly eligible retry.

A definitive HTTP 429 with no successful response start and no output is a pre-output failure even if it has an ID. Historical concrete candidate lists may use their existing eligible next-candidate policy. A single remote preset still terminates without local provider fallback. This change introduces no same-candidate retry, no new provider calls for current Story preset failures, and no changes to lease/deadline/cancellation fences.

## Player and operator behavior

Keep the current fixed rate-limit message. Add fixed text identifying the confirmed source when known: 'OpenRouter reported a platform limit.' or 'An upstream provider reported a rate limit.' Unknown source: 'The provider did not identify which limit was reached.'

When retryAt is available, show 'Provider suggested retry time: <localized date/time>.' After that time, say 'The suggested wait has elapsed; you can retry.' Do not claim the provider is healthy. Preserve existing Retry/Discard eligibility; no background request, automatic retry, or clock-based state mutation. New optional details also apply to the latest failure received live and after reload.

Emit bounded structured operator fields on the existing job-correlated failure log: physical attempt ID, response ID, source, statuses, reason, limitSource, recognized upstreamCode, retryAfterMs, successfulResponseStarted, emittedOutput, metadataStatus. Query the database when more detail is needed; never emit a raw error body.

Composed verification exposed a preexisting explicit Retry interruption gate after definitive HTTP rejection. The subsequent implementation ruling permits re-arming the saved primary reservation only within explicit Retry, using completed current invocation/physical evidence and matching owner/job/body/hash/claim proofs, non-2xx HTTP, no successful start and no output. A new logical identity creates a new immutable physical row. Ambiguous/SSE/post-output/stale evidence retains the existing gate. This correction adds no automatic dispatch policy. Presentation receives injected time parsing/formatting from the browser to preserve the pure client-core boundary.

## Rollout and success criteria

Use an additive migration; old attempts remain readable with null evidence. Deploy API/worker support before relying on the new frontend fields. No prompt, provider settings, or route plan changes are required. Rollback code may ignore the column; retain it and its evidence. Do not drop data to roll back a UI change.

Success: deterministic HTTP and SSE tests prove capture; PostgreSQL proves durable atomic evidence and isolation; API/browser tests prove consistent safe messages live and after reload; rejected requests cannot mutate accepted turns, campaign state, or Chronicle memory. A subsequent naturally occurring production failure should identify the limiter when metadata exists, or explicitly report absent/unrecognized metadata. Unit fixtures cannot establish the real upstream cause.

References: [provider model](../../concepts/provider-model.md), [transport deadlines](../../architecture/0012-provider-transport-deadlines.md), [deployment](../../runbooks/deployment.md), [testing](../../workflows/testing.md), [OpenRouter limits](https://openrouter.ai/docs/api_reference/limits).
