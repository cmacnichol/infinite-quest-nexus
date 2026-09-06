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
draft-dependent stage before reuse. Automatic repair consumption is persisted per stage. The main-stage allowance
survives changed drafts and later immediate-extension repair checkpoints,
including compatible older checkpoints. An explicit retry starts a distinct
bounded attempt.

Checkpoint version 2 retains the actual serialized producing request privately,
including streaming and provider-format fallback, and binds effective provider
configuration plus an opaque endpoint identity. Fact visibility is derived only
from that request's protected authority; rejected drafts cannot grant it. Main,
extension, and repair results retain their own producing request. Malformed or
incompatible checkpoints fail safely; an older checkpoint must be discarded and
generation re-enqueued from current authority rather than silently adopted.

Generation and public previews share the hybrid retrieval stage. Generation
receives whole selected parent records before prompt budgeting; public previews
apply their own compression afterward. Candidate loading remains bounded and
prioritizes recent turns before its row limit. The latest protected turn is not
also returned as optional history.

Event coverage requires an explicit result for every due occurrence ID. Missing,
duplicate, or unexpected results fail validation. Immediate events are checked
against both the full narration and the appended passage. Only validated main
narration is immutable during extension repair; a rejected appended passage can
be replaced. Fulfillment counts each distinct occurrence once, including older
pending occurrences, and retains the latest activation source turn.

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

## Follow-up transaction and budget enforcement

Generation captures authority in a short transaction and commits/releases its
campaign and state locks before embedding calls. Optional Chronicle retrieval
then runs without an open transaction, using the captured base turn as its
cutoff. Query-cache writes use a separate short transaction after provider work.
Caller-owned transaction clients receive authority only; the repository does not
commit their transaction or perform optional provider retrieval inside it.

Every canonical operation receives the job's effective context window. Both
optional-history selection and the final serialized-request guard reserve the
same estimated input allowance. Character-based counts are labeled estimated;
the input allowance does not consume the configured output reserve. Recovery
remeasures its final payload after omitting an oversized complete rejected draft.
Checkpoint configuration identity includes the effective window and safety policy.
Whole-main rewrites use replacement output feasibility; extension-only prefix
and suffix constraints apply only to actual extensions.

## Budget-aware history and fact retrieval

Private generation supplies its provider-constrained campaign context allowance
to Chronicle before candidate collection. Generation scales the candidate pools,
per-signal ranks, selected parents, historical-fact pool, and per-turn diversity
allowance in proportion to that budget. The scale is the ceiling of the allowance
divided by 32,000, with a minimum of one and the supported campaign maximum of
1,000,000. The calibrated public-preview policy remains unchanged.

At 32k the generation parent allowance is 16; at 128k it is 64; at 1m it is 512.
These are retrieval allowances, not instructions to fill the prompt or to ignore
relevance. Whole records still pass through the final campaign/provider budget
planner. A larger allowance can therefore include more history and facts when
they are available and fit. Incremental diversity scoring avoids repeatedly
comparing the same vector pairs as these pools grow.

In cutoff-aware chunk retrieval, valid historical facts participate in lexical,
entity, recency, importance, kind, and temporal rank fusion before diversity
selection. They are no longer assigned a rank below every narrative candidate.
Only actual chunk IDs enter vector queries; historical fact candidates use the
scoped canonical projection and do not invent semantic embeddings. A smaller
prompt may prioritize recent history while larger budgets admit more optional
facts. Current authoritative facts remain protected at every budget.

Accepted canonical fact projection combines distinct plain additions with
structured updates. Structured updates keep their previous ordering and fact
identities; distinct plain additions follow them. Normalized duplicate prose is
stored once with the union of its structured supersession references. Explicit
replay uses the same projection from retained accepted snapshots. This code
change does not initiate a rebuild or alter live campaign data.

Supersession validation uses the exact producing request. Its visible-fact
allowlist includes current continuity facts and selected Chronicle entries of
kind `canonical_fact`. In the generation cutoff path those entry IDs are the
scoped canonical fact UUIDs, not grouped memory IDs. Facts omitted by the final
planner, prose containing a UUID, and rejected drafts do not grant authority.
Active-fact and generation-base checks still apply at acceptance.
