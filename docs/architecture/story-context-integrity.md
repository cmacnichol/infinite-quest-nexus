# Story context integrity

## Decision

Story generation uses one private, authoritative context path. Accepted turns
and explicit current-state corrections are the source of truth; Chronicle
summaries, embeddings, and retrieval results are derived aids and must never
replace the source when they are missing or stale. The private authority load
is scoped by owner, campaign, and world version and includes the immutable
world rules, complete replacement continuity, the latest accepted turn, the
applicable correction (including an intentional empty value), and authorized
canonical facts. Public context previews remain sanitized and cannot request
private authority data.

The planner applies two ceilings to the exact serialized request:

```text
W = the supported provider window, limited by a valid requested window
O = configured output reserve for this provider operation
S = safety allowance
I = W - O - S

serialized context <= snapshotted campaign context budget
serialized provider request <= I
```

With a compatible tokenizer, the planner counts serialized message framing and
keeps 256 tokens of transport headroom. Without one, it uses the conservative
estimator with a 20% input allowance plus 1,024 tokens for uncertain template
and message overhead. These are safety margins, not a guarantee for an unknown
model tokenizer. Provider-reported overflow remains recoverable and informs
future calibration; it does not authorize clipping protected state or lowering
the configured output reserve.

Protected records are complete. The planner adds optional recent turns and
historical facts as complete records only when they fit, records omissions, and
renders selected records in chronology. A protected-context shortfall returns a
safe recovery diagnostic. Before transport it also checks that the complete
replacement shape can fit within the configured output reserve. That feasibility
check prevents a known impossible request; it does not promise that a model will
produce a complete answer.

All story-generation operations use the same serialized-payload guard: initial
generation, schema/mechanics recovery, scene validation and rewrite, RPG
assessment, before/after trigger evaluation, event extension, and event
coverage repair. Operations that need less history deliberately omit it before
planning. Transport sends the measured canonical bytes without a later splice,
field cap, or rebuild.

The current protocol requires complete replacement fields. Empty continuity
summary and empty thread list are valid values. The shared thread limit is 500;
501 entries fail validation rather than being silently trimmed. New-protocol
output does not use historical defaulting or text supersession. Historical
imports and records retain their named compatibility readers. The legacy
provider serializer, response-chain handling, lexical fallback, retrieval
comparison, and import/history readers remain for their separate workflows and
are not an alternate new-generation path.

Recovery requests are self-contained. They may include a complete, explicitly
untrusted rejected draft, but never a prefix presented as an outcome. They do
not send `previous_response_id`; response IDs remain diagnostics only. Prompt
overrides preserve editable creative text while the protocol's required wire
shape and authority requirements remain non-overridable. An incompatible
override must be acknowledged against the current protocol and otherwise gives
an actionable compatibility notice; the service never rewrites the override.

## Durable execution

The worker records a versioned private checkpoint after it validates the main
draft. The checkpoint binds owner, campaign, world version, base identity,
protocol, provider/model, normalized action, request payload hash, draft hash,
producing attempt, and the sent canonical-fact allowlist. A compatible retry or
lease reclaim resumes that exact draft. A new draft invalidates every
draft-dependent stage before reuse. Automatic repair consumption is persisted
per stage and draft; an explicit retry starts a distinct bounded attempt.

Immediate events require a complete final `StoryTurnOutput`, including the
original validated narration and a nonempty extension. Event occurrence
accounting distinguishes due immediate events from deferred events: only due
immediate fiction is required for the current final object, while deferred
events stay pending. Extension or coverage failure is recoverable and does not
accept a turn or increment trigger state. The final-object hash and producing
attempt are checked before the guarded, exactly-once commit. Illustration work
remains an independent child job.

Public polling, SSE, and recovery projections expose only allowlisted codes,
operation/action keys, safe scope names, and nonnegative counts. They never
include prompt text, provider endpoints, rejected narration, scratchpad, or
private checkpoint data. Typical actions are to adjust campaign context or
output/state, acknowledge or update an override, repair imported rules, or
discard and enqueue a protocol-incompatible job. Old jobs are classified
recoverable instead of being reinterpreted under the new protocol.

## Alternatives and limits

Changing continuity to model-generated patches was rejected because it adds
deletion/conflict semantics and migrations without repairing source authority.
Increasing every context budget or selecting a larger model was rejected because
it only postpones overflow and does not make partial replacement safe.

This design proves the contents sent, validated, checkpointed, and committed by
the application. It cannot prove narrative quality or a provider's advertised
capacity. Run copied-campaign canaries against the actual provider, inspect
usage and latency, and retain the old reader where needed for rollback.

## Existing-campaign repair

This change prevents future loss; it does not establish that prior continuity
is complete. For a reported loss, prepare a separate source-linked proposal
listing the current value, proposed value, source turn or snapshot revision,
and any ambiguity. Later explicit corrections take precedence over older
generated snapshots. Apply only an approved, revision-checked state edit through
the existing API, then rebuild derived memory. A fact absent from every retained
authoritative source is unrecoverable; do not ask a model to reconstruct it.
