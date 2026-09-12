# Durable AI authoring operations

## Rollout

1. Back up the authoritative database and apply the additive migrations with compatible API and worker builds deployed together.
2. Keep `AI_AUTHORING_JOBS_ENABLED=false` in Compose or in both Swarm API and worker services. Confirm `/api/v1/authoring/capabilities` reports `enabled: false` and existing clients retain synchronous preview behavior.
3. In a disposable environment, verify the worker’s bounded authoring cleanup lane and a normal generation lane. Do not infer this proof from a configuration render.
4. Set `AI_AUTHORING_JOBS_ENABLED=true` for the combined Compose runtime, or for both compatible Swarm API and worker services. Recreate or update the services; runtime environment settings are read at process start.
5. Confirm the capability before enabling durable-proposal client flows. Keep the gate false if workers are not yet compatible.

## Story-source capability and rollback

`AI_STORY_SOURCE_AUTHORING_ENABLED` is a separate startup setting for story and chapter intake. Its default is `true`; set it to `false` on both compatible API and worker services to pause source execution while `AI_AUTHORING_JOBS_ENABLED=true` continues Patch 2 world-concept and character proposals. Confirm `/api/v1/authoring/capabilities` omits `story_source` from `supportedKinds` before hiding new-source controls.

The pause is enforced server-side for generic and named source submissions, source retry, and source synthesis. It pauses before claim, so an already leased source stage may finish its generation-fenced checkpoint; queued and expired-lease source stages are not claimed or marked retry-exhausted. Owned source proposals remain readable and may be fact-reviewed, explicitly applied, cancelled, discarded, or cleaned up without a provider call. Keep the client resume/review controls available for those provider-free operations and show that execution is paused when retry or synthesis is attempted.

Do not roll back to a writer that cannot preserve schema-6 `sourceMaterial`. Reverting the source UI is safe after the capability is false. A code rollback must retain schema-6 reads and writes, all Patch 2 jobs, and the authoring cleanup lane. Do not down-migrate authoring tables or strip accepted source appendices from drafts, versions, exports, campaigns, or System Archives.

## Retention and recovery

Proposals expire seven days after their last execution or user mutation. Reads, lists, and worker heartbeats do not extend that deadline. Cleanup processes at most 100 jobs per tick, locks work with PostgreSQL `SKIP LOCKED`, fences a running stage before clearing payloads, and leaves saved world content unchanged. Applied jobs retain an idempotency receipt for 30 days; after that deadline the receipt is unavailable and cleanup clears it.

Provider calls are not exactly once: lease loss can repeat a request. Durable checkpoints and revision-checked apply prevent stale output from becoming authoritative. Synchronous previews that were in flight before this rollout cannot be recovered as durable jobs.

## Rollback

Set `AI_AUTHORING_JOBS_ENABLED=false` on the API and worker, then return clients to synchronous flows after the capability is false. Do not down-migrate, delete authoring tables, or purge proposals as part of rollback. Compatible workers continue ordinary retention cleanup while the gate is false; checkpoints remain resumable only until their existing inactivity deadline. Returning to an older binary that lacks cleanup can defer physical deletion, but it does not extend an expired proposal’s authority. Re-enable a compatible worker and the gate to resume unexpired proposals.

System Archive deliberately excludes authoring inputs, stage output, reviews, and receipts. Use the normal PostgreSQL recovery procedure for installation recovery; a portable System Archive does not preserve operational authoring work.

For story-source proposals, discard, successful apply, and expiry cleanup also clear the operational source plan and fact review. The accepted appendix saved in a draft or version is authoritative portable content and is not deleted by job cleanup.

## Source authoring diagnostics

Story-source extraction and synthesis emit `authoring_provider_started`,
`authoring_provider_headers`, `authoring_provider_completed`, and
`authoring_provider_failed`. Correlate by `authoringJobId`, `stageId`,
`stageGeneration`, and `requestAttempt`; `repair` distinguishes repair calls.
The start event records the pinned provider/model, actual streaming mode,
request bytes, context/output limits, and timeout. Completion records token usage,
finish reason, truncation status, and a provider response ID when available.
Headers events preserve a safe OpenRouter generation ID even if reading the body
later fails. Failure events report whether headers arrived and the transport code,
so waiting for headers can be distinguished from failure after headers.

`authoring_transport_retry`, `authoring_repair_started`, and
`authoring_validation_completed` explain the work between provider calls. Failed
validation records bounded, sanitized issue paths and reasons. These diagnostics
do not log source text, prompts, rejected output, credentials, or raw provider
errors. Validation success is not a durable-checkpoint receipt; use the job API
for authoritative stage status. No streaming, retry, or validation policy changes
are required to enable these logs; deploy the updated runtime normally.

For exact-quote failures, `authoring_citation_mismatch` adds fact/citation indexes,
trusted paragraph IDs, code-point lengths, and a `matchCategory`:
`wrong_paragraph`, `formatting_difference`, `cross_paragraph`, `changed_text`,
`outside_chunk`, or `coordinate_mismatch`. Formatting diagnostics identify
`whitespace`, `unicode` (NFC), `quotation_marks` (curly versus straight), or
`combined` normalization. Comparisons remain in memory and search only through
the selected source boundary. `changed_text` means no tested match was found;
it does not establish that the model invented the quote. These diagnostic
comparisons never accept a previously rejected citation or change the prompt.

Source extraction protocol `source-extraction-v6-evidence-ids` supplies content-based
IDs alongside exact paragraph excerpts. The provider selects evidence IDs; the
server resolves them against the current validated chunk and attaches the exact
source text, paragraph, and Unicode coordinates. Unknown IDs and mixed ID/quote
objects are rejected. Existing quote/coordinate responses remain strictly validated
for compatibility; they are never fuzzy-matched or reassigned. Evidence selection
proves a source location, not that the fact is semantically supported: human review
remains required. The runtime budgets the same evidence table used for execution.

After deployment, create a new source proposal. Older extraction snapshots retain
their protocol and fail with `source_evidence_invalid` before provider execution.
Saved citations and world data need no migration. If temporary text logging is still
needed, update its job ID to the new proposal; evidence-ID failures contain no
provider quote for that logger to capture.

### Temporary citation text capture

To diagnose an exact-quote mismatch, set `AI_AUTHORING_CITATION_DEBUG_JOB_ID`
to the affected proposal UUID in the local `.env`, then rebuild/recreate the
Compose application and retry that proposal. For Swarm, pass the same environment
variable to the worker service. Empty or unset disables text capture; other jobs
keep metadata-only diagnostics.

For that job only, `authoring_citation_mismatch` includes `sourceDebug` with
`rejectedQuote`, `citedParagraphText`, and `providedSpanText`. These are literal
texts, including Unicode and whitespace, JSON-escaped by the structured logger.
Both initial and repair failures are captured. The source paragraph stays within
the selected boundary; the span is the excerpt sent to the provider. Validation
and retry behavior are unchanged. This opt-in is an exception to the metadata-only
logging described above: captured logs contain private story and provider text.
Clear the variable and recreate the service to stop capture; existing logs retain
captured text under the installation's log retention policy. Remove this temporary
hook, Compose variable, and documentation once troubleshooting is complete.

### Reviewing facts with multiple values

Source predicates are free-form descriptions, not declared single-value fields.
Two accepted facts may share a subject and predicate while having different values
(for example, two skills or two facilities at a location). Saving preserves both;
reviewers can reject or leave uncertain any claim they consider contradictory.
The server still rejects unknown or stale fact IDs, invalid identity representatives,
duplicate identity membership, and incomplete character grouping. No database or
prompt-protocol migration is required for this review-save correction.
