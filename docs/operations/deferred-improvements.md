# Deferred improvements

This document records reviewed improvements that are intentionally not part of the current implementation. Items here require a fresh implementation review before development begins because adjacent schemas and workflows may have changed.

## Update an existing campaign from an Infinite Worlds story TXT export

**Status:** Deferred. Do not implement as part of the current import workflow.

### Goal

Allow a newer Infinite Worlds story TXT export to update an existing Infinite Quest Nexus campaign. After previewing the file, the user selects the exact source turns to import. A selected source turn that already exists at the same campaign turn number replaces the active content of that turn; a selected missing turn is inserted. The operation must not create another world or campaign.

### Current limitation

The Infinite Worlds parser retains source turn numbers, but conversion to the legacy story contract renumbers turns sequentially. The request contract has no target campaign or turn selection, preview reports aggregate counts only, and import delegates to the create-or-reconnect legacy campaign importer. Consequently, a newer TXT export cannot safely update part of an existing campaign.

### Proposed user workflow

1. Select the matching published World Library version and choose **Update existing campaign**.
2. Select a campaign restricted to that world version.
3. Load or paste the newer Infinite Worlds story TXT export.
4. Preview every parsed source turn with its source number, action/narration excerpt, and disposition: **New**, **Will overwrite**, or **Unchanged**.
5. Select turns individually, select all, or enter an inclusive source-turn range.
6. Confirm a summary of inserted and overwritten turns before committing the update.

Creating a new campaign remains a separate import mode. Updating must never silently delete later, unselected turns. A future **Replace from this turn onward** mode may truncate later history, but it requires its own explicit destructive confirmation and is outside this improvement.

### API and validation contract

The import request should identify the target campaign, transmit an exact array of selected source turn numbers, and include an optimistic concurrency value captured during preview. The server must not trust a range expanded only by the browser.

```ts
{
  targetCampaignId: string;
  sourceTurnNumbers: number[];
  expectedCampaignUpdatedAt: string;
}
```

Preview should return per-turn metadata and the expected disposition. Import must reject stale previews, duplicate source turn numbers, missing narration, ownership violations, world-version mismatches, non-contiguous insertions that would leave a ledger gap, and campaigns with active generation, illustration, or Chronicle work.

Source turn numbers are authoritative for update matching. Existing rows are located by `(campaign_id, turn_number)`. Preserve the database turn ID when replacing active content so dependent references remain stable.

### Persistence and recovery rules

Accepted turns are normally append-only. To make this explicit import correction recoverable, save the previous row in a new turn-revision history record before updating it. Record the source hash, import ID, source turn number, replacement timestamp, and previous authoritative fields. The update and all associated invalidation must occur in one locked database transaction.

For selected turns:

- Insert missing turns and replace existing turn content while preserving existing turn IDs.
- Sanitize narration, choices, and image prompts through the same fiction-only import boundary.
- Preserve all unselected turns.
- Do not reset structured campaign state from the imported TXT because that format does not contain complete Nexus state snapshots.
- Set the campaign active turn to the highest remaining accepted turn, not merely the highest selected source turn.

After any replacement, rebuild campaign fiction memories, remove stale derived continuity summaries/canonical facts/open threads, enqueue semantic embedding reindexing, and invalidate all model response chains for the campaign. Semantic-memory health should report a rebuilding state until the derived indexes are current.

Existing illustrations must be detached from overwritten active content without deleting their stored assets. Optional illustration generation targets the highest selected imported turn, not implicitly the campaign's latest turn.

Provider cost events remain append-only and continue contributing to campaign totals. A charge associated with replaced content must move to the archived turn revision or lose its active-turn association so the imported replacement does not display the cost of generating its former content. Import itself creates no provider cost event unless optional enrichment or illustration work actually makes a provider call.

### Audit result

Record a campaign import event containing the source name and hash, selected source turn numbers, inserted/overwritten/unchanged counts, target campaign revision, Chronicle rebuild job ID, and whether optional enrichment or illustration work was requested. Re-importing the same source and selection should be idempotent.

### Required tests

- Preview reports correct new, overwrite, and unchanged dispositions.
- Mixed insert/overwrite selection changes only selected turns and creates no world or campaign.
- Exact repeat import is idempotent.
- Source turn numbers survive parsing and conversion.
- A stale campaign revision returns a conflict without partial mutation.
- Cross-owner and cross-world-version targets are rejected.
- Ledger gaps, duplicate source numbers, and malformed selected turns are rejected transactionally.
- Active generation, illustration, or Chronicle work prevents the update.
- Unselected and later turns remain unchanged.
- Chronicle memories are rebuilt without stale fiction, derived continuity is invalidated, embeddings are queued, and response chains are invalidated.
- Previous content remains recoverable through turn revisions.
- Existing provider charges remain in campaign totals but are not shown as the replacement turn's generation cost.
- Existing illustration assets are retained but detached from overwritten content.
- Imported story content continues to pass mechanics-leakage sanitization.

## Stream provisional story narration during generation

**Status:** Deferred. Do not implement as part of the current provider or Story Engine workflow.

### Goal

For provider/model combinations that support streaming, show the user a provisional story narration as it is generated. Streaming improves perceived responsiveness but must not weaken the durable generation workflow: no streamed draft becomes an accepted turn, campaign state, Chronicle memory, image prompt, or actionable choice until the complete response passes validation and commits transactionally.

The UI must clearly label streamed content as a draft and replace it with the authoritative database turn after commit. Unsupported providers and models continue through the existing non-streaming workflow without losing functionality.

### Current limitation

All provider adapters currently buffer complete responses. LM Studio explicitly sends `stream: false`; OpenRouter, Manifest, and generic OpenAI-compatible profiles use a normal `/chat/completions` JSON response. The worker waits for the complete response before parsing, validation, cost recording, and commit. The player polls durable job status and fetches narration only after the accepted result exists.

The current `generation_jobs.partial_output` field is failure/recovery evidence, not a live transport. Rewriting a growing raw response into that field would create database write amplification, expose unvalidated structured output, and provide no ordered reconnect contract.

### Provider capability policy

Streaming and stream cancellation are separate capabilities.

| Provider type | Default streaming state | Required behavior |
| --- | --- | --- |
| LM Studio native `/api/v1/chat` | Supported when its named SSE API is available | Consume named progress and `message.delta` events; use `chat.end` as the authoritative aggregate result. |
| OpenRouter | Supported by the routing API | Consume normalized chat-completion deltas, ignore SSE comments, handle mid-stream error objects, and collect final usage. Upstream cancellation may remain unavailable for some routed providers. |
| Manifest | Unknown | Keep streaming disabled until a probe succeeds or an operator explicitly enables it. |
| Generic OpenAI-compatible | Unknown | Detect a compliant SSE response at request time, allow an operator override, and retain non-streaming fallback. |

Extend discovered model/provider capability data with explicit states instead of a boolean:

```ts
streaming: "supported" | "unsupported" | "unknown";
streamingSource: "provider_contract" | "discovery" | "probe" | "manual";
streamCancellation: "supported" | "unsupported" | "unknown";
```

Persist observed capability per owned provider profile and model, including when it was checked and the last bounded error. A future provider-screen preference should offer **Auto**, **Enabled**, and **Disabled**. Auto uses known provider contracts or a prior successful observation; an unknown endpoint must not be assumed compatible merely because it exposes an OpenAI-shaped non-streaming API.

Model discovery often does not advertise streaming. Do not make a paid probe automatically while loading model inventory. A real request may establish support when it returns a valid SSE content type and terminal event; a pre-token rejection may establish that the selected endpoint/model does not support the requested mode.

### Streaming provider interface

Add a provider-neutral streaming call that aggregates the complete response while reporting safe transport events:

```ts
callTextProviderStream(profile, request, {
  signal,
  onMessageDelta,
  onProviderProgress
}): Promise<ProviderResult>
```

The returned `ProviderResult` remains the input to the existing schema validator, mechanics-leakage validator, cost recorder, attempt record, and commit transaction. The streaming implementation must handle:

- SSE frames and UTF-8 characters split across arbitrary network chunks.
- Multi-line `data:` fields, comments/keepalives, terminal events, and normal JSON error responses before streaming starts.
- OpenRouter/OpenAI-compatible `choices[0].delta.content`, `[DONE]`, final usage, response/model identifiers, finish reasons, and top-level mid-stream errors.
- LM Studio named events, including model/prompt progress, `message.delta`, `error`, and the final aggregated `chat.end` result.
- A successful normal JSON response from an endpoint that ignores streaming.
- Network aborts, worker shutdown, lease loss, output limits, and incomplete terminal metadata.
- Complete aggregation of output for the existing parser even when the browser never connects to the Nexus event stream.

Never forward or persist reasoning deltas, tool traces, private RPG assessment, trigger evaluation, parser diagnostics, or provider credentials. Provider progress may be normalized to non-sensitive stage/progress events.

### Safe incremental narration extraction

The story provider returns one structured JSON object, so raw provider deltas contain incomplete JSON and may include private or non-display fields. Do not forward raw deltas to the browser.

Implement a streaming JSON tokenizer that locates and decodes only the top-level `narration` string. It must handle field reordering, escaped quotes and backslashes, Unicode escapes, and incomplete escape sequences. Buffer at least a complete sentence or paragraph, retain enough overlap to detect prohibited phrases crossing chunk boundaries, and apply the same fiction/mechanics display validation used by the final story validator before emitting text.

Only validated narration segments may be shown provisionally. Do not stream:

- Choices or custom action suggestions before the turn is accepted.
- Scratchpad or continuity-summary content.
- Canonical/superseded facts or open-thread fields.
- Tracker updates or image prompts.
- Reasoning content or raw JSON syntax.
- Private mechanics, rolls, trigger decisions, or recovery diagnostics.

If incremental extraction cannot prove that content belongs to the narration field, buffer it until the full response is available. Streaming may therefore start later for models that reorder fields; correctness takes priority over first-token display.

### Durable cross-replica event delivery

The worker owns the provider connection, while any API replica may own the browser connection. Do not directly proxy the provider socket through an API process and do not add process-local correctness state.

Add a rebuildable, short-retention table such as:

```text
generation_stream_events
  id / sequence
  generation_job_id
  event_type
  payload
  created_at
```

Events must be ownership-scoped through the generation job. Use an ordered sequence with a uniqueness constraint so retried worker leases cannot publish conflicting events. Batch validated deltas by time or size rather than inserting every provider token. The table is an operational delivery log, not authoritative story history, and should be pruned after a bounded retention period.

Expose an owned endpoint such as:

```text
GET /api/v1/generation-jobs/:jobId/events
Content-Type: text/event-stream
```

Recommended browser-facing events:

- `stage`
- `narration_delta`
- `draft_reset`
- `validating`
- `committed`
- `recoverable`
- `failed`
- `heartbeat`

Support `Last-Event-ID` so refreshes, transient network failures, and API-replica changes can replay missed events. The database event table remains the source of truth. PostgreSQL `LISTEN/NOTIFY` may be added as a wake-up optimization, but missed notifications must never lose events or require a sticky API session. Avoid holding one ordinary pooled database connection per browser stream when that could exhaust the API pool.

The SSE response must disable proxy buffering, send periodic heartbeats, prevent caching, and stop promptly when the client disconnects. Disconnecting the browser only closes its subscription; it does not cancel the durable generation job.

### UI workflow

After enqueueing the durable generation job, the browser opens the job event stream while retaining the current status-polling code as fallback. During `generating`, render a provisional turn card labeled **Draft — generating** with a non-interactive narration region and cursor/progress treatment.

Do not show clickable choices until the accepted result is fetched from the database. When the worker enters validation or commit, keep the draft visible but indicate that it is being checked. On `committed`, fetch the normal generation result and replace the complete provisional card. If an after-response event appends fiction, add it only after that extension passes its own validation.

On `draft_reset`, remove the provisional narration before showing a recovery stream. On terminal failure, remove or visually discard the provisional card and state clearly that the accepted campaign turn is unchanged. A page reload should reconnect to the same durable job using the saved pending-generation record and replay available events before returning to live delivery.

### Acceptance, recovery, and fallback rules

Streaming changes presentation only. Preserve the existing authoritative workflow:

```text
queued -> assessing -> generating/streaming -> validating -> committing -> completed
                                             \-> recoverable or failed
```

- Only the complete aggregated response is eligible for final story parsing and acceptance.
- Stream events never update `turns`, `campaign_state`, Chronicle memory, embeddings, or illustration jobs.
- A normal JSON response to a streaming request is processed as a normal non-streaming result.
- A clear unsupported-streaming error before any output may trigger one recorded non-streaming fallback under the same job policy.
- Do not silently issue a second paid request after partial output. Treat a mid-stream failure as a recorded failed/recovery attempt, clear the displayed draft, and use the established recovery workflow.
- Stream recovery output as a new draft only after emitting `draft_reset`.
- If SSE delivery to the browser is unavailable, the provider stream may still be aggregated by the worker while the browser uses existing job polling.
- A streaming failure must not mark the provider generally unhealthy when a non-streaming fallback succeeds; record streaming capability health separately.

### Cancellation

Closing the browser event stream must never cancel generation. A future explicit **Cancel generation** action requires a durable cancellation request, worker-side `AbortController`, and a terminal job state that prevents commit even if the upstream provider continues producing output.

Cancellation must disclose capability accurately. For an upstream provider that supports abort propagation, abort the provider request and record any reported usage/cost. When upstream cancellation is unsupported, stop displaying and refuse to commit the eventual output, but warn that provider computation and billing may continue. Do not infer cancellation support from ordinary streaming support.

### Cost and attempt accounting

Accumulate response ID, resolved model, finish reason, usage, and reported cost from the final stream event. Record costs using the same append-only provider-cost ledger as non-streaming calls. Failed or rejected streamed attempts may still incur a provider charge and must remain campaign-attributed even though no turn is accepted.

If terminal usage is absent after a stream error, retain the known response/generation ID and bounded error metadata so a provider-specific reconciliation mechanism can be added later. Never fabricate zero cost or usage. Recovery and any non-streaming fallback are separate provider attempts and must be auditable as such.

### Required tests

- OpenRouter-style SSE comments, split frames, multi-line data, content deltas, final usage, `[DONE]`, and mid-stream error objects.
- LM Studio named model/prompt progress, reasoning suppression, message deltas, errors, and aggregated `chat.end` processing.
- Fragmented UTF-8, escaped quotes/backslashes, Unicode escapes, reordered JSON fields, and malformed/incomplete JSON.
- Mechanics/private phrases divided across provider chunks never reach the browser.
- Only the narration field produces provisional display events.
- Provider reasoning, scratchpad, trackers, facts, threads, choices, image prompts, and raw JSON never appear in stream events.
- Normal JSON fallback when an endpoint ignores streaming.
- Unsupported streaming before output records capability and safely falls back according to policy.
- Mid-stream failure records an attempt, emits `draft_reset`, and leaves the accepted campaign unchanged unless recovery later commits.
- Final streamed and non-streamed `ProviderResult` metadata have contract parity, including cost and usage.
- Worker lease expiry/reclaim cannot duplicate, reorder, or cross-publish events.
- API and worker running on separate replicas deliver an ordered stream without sticky sessions.
- Ownership isolation prevents reading another user's or campaign's generation events.
- `Last-Event-ID` replay works after browser refresh, network interruption, and API-replica restart.
- Browser SSE failure transparently falls back to durable status polling.
- Choices remain disabled until the database-backed accepted result is loaded.
- Terminal failure removes/discards provisional content and states that the accepted turn is unchanged.
- Stream-event retention cleanup never removes authoritative turns, attempts, costs, or Chronicle records.
- Explicit cancellation prevents commit and accurately reports whether upstream processing may continue.
