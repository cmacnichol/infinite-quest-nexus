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

Campaign story context settings support 32k through 4m tokens; these are upper
targets, subject to the provider request limit. The separate public memory
context-preview query remains capped at 1m. See
[Story Memory rollout](../runbooks/story-memory-rollout.md#budget-terminology).

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

Protected records are complete. The legacy planner adds optional recent turns and
historical facts as complete records only when they fit, records omissions, and
renders selected records in chronology. A protected-context shortfall returns a
safe recovery diagnostic. Before transport it also checks that the complete
replacement shape can fit within the configured output reserve. That feasibility
check prevents a known impossible request; it does not promise that a model will
produce a complete answer.

The versioned Story Memory policy may permit verified narrative excerpts after
its capability is explicitly enabled. A selected canonical fact remains complete;
an excerpt cannot grant a canonical fact ID or supersession authority. Protected
current state is never excerpted. Bounded world references and historical facts
are selected evidence, not a claim that all world/history records were supplied.

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

### Continuity-context protocol and rollout

`current-continuity-v3` has a typed private context envelope. It binds the
owner, campaign, pinned world version, versioned generation base identity,
complete protected authority, selected evidence, and a hash of the complete
evidence manifest. It does not make all historical records mandatory prompt
content: selected reference records and recent/retrieved evidence are bounded
and every omission has a fixed reason. Current protected state remains whole;
an overflow is recoverable rather than a reason to truncate or substitute a
summary.

Story Memory capability remains installation-owned. Migration 0096 enrolls all
existing campaigns at Max (R3/enforce), and new campaign rows receive Max through
a database trigger, including branches and imports. Campaign settings can select
Off, Standard, Enhanced or Max; an explicit Off selection stays disabled.
Operator configuration can restrict available levels. The enqueue transaction freezes the
resolved policy, its canonical hash, protocol identities, and effective provider
configuration fingerprint. Later enrollment, prompt, or provider changes apply
only to new jobs. A worker that cannot read the frozen policy reports a
discard-and-reenqueue recovery requirement; it never silently downgrades a job.

Historical jobs with no Story Memory policy and old base identities use their
named legacy readers. A v3 base identity requires every declared dependency,
including the effective character revision/fingerprint; no reader fills missing
fields from mutable campaign data. The v3 review envelope is optional and
operational. A review pass means only that no evidence-supported contradiction
was found in the supplied manifest, not that all campaign history was checked.

### Private contract seams

`packages/application/src/memory/generation-context.ts` owns the canonical
authority, candidate and base-identity types used by application ports and the
database/runtime adapters. The baseline authority retains complete current
continuity, rules, world canon, selected character ID, latest accepted action and
narration, and the existing internal mechanics fields. Those internal fields do
not grant permission to send mechanics to fiction providers. Character capture
extends the same authority with `characterAuthority`; it is required by the v3
snapshot and absent from unchanged legacy captures.

`legacyGenerationBaseIdentitySchema` and `readLegacyGenerationBaseIdentity`
preserve the old dependency set. `generationBaseIdentityV3Schema` adds the
explicit `generation-base-v3` discriminator and mandatory character profile
revision/fingerprint while retaining every old dependency. Capturing and checking
these new dependencies is a separate executor/source integration step. Merely
parsing a snapshot never manufactures a missing profile fence.

Evidence uses `fiction-safe-json-v1`: callers first supply a scoped, fiction-safe
JSON document; object keys are sorted by code-unit order, array order is retained,
and string fields retain their exact UTF-16 text. The source hash covers the
complete canonical document. `sourcePath` resolves only own JSON properties.
`sourceLength` bounds spans within the resolved field representation; disjoint
ordered spans join with an explicit `\n[…]\n` separator. Empty strings and empty
arrays remain distinct values. `readStoryEvidenceFromSource` rebinds persisted
metadata/content to the captured source instead of trusting a self-reported hash.

Evidence IDs include source kind, ID, revision, turn, content hash, pointer, role,
normalization version, form and spans. Ranking and entry order do not change
individual IDs. Manifest hashes exclude their own hash, canonicalize object keys,
and retain array order so a changed selection order changes the request-bound
manifest hash. Required-review IDs are a unique subset of supplied entries.
Review references use the contracts package's single source/candidate union;
omission findings identify an output field without fabricating a quotation.

`createStoryContinuityCheckpointV3Schema(payloadSchema)` creates the explicit
`{ version: 3, metadata, checkpoint }` envelope. Metadata fixes context v3 and
output v2 and binds policy/manifest hashes; review state is optional. It is not a
schema for the full executor payload. The caller must supply that payload's
complete validator and retain its existing provenance/commit checks.
`readStoryContinuityCheckpoint` names the v2 path `legacy_v2`, validates either
payload without defaults, and rejects unsupported or malformed envelopes with
`discard_and_reenqueue`. This contract does not turn an old checkpoint into new
authority or enable reviewer dispatch. Existing execution continues to use its
v2 checkpoint until the later executor integration supplies the compatible schema.

The actual historical query variants are `action`, `entity_expanded`, `scene`
and `open_thread` with `query` and `entityIds`. The named legacy reader retains
that shape and `legacy_sum`. New variants use `story-memory-query-v1`, stable
family/variant IDs, action segment positions and optional temporal hints, with
the `query_family_max_v1` contract. Cache/diagnostic serialization preserves the
entire versioned identity. The current planner and rank adapter remain explicitly
typed as legacy until the balanced planner is implemented.

Executable serialized examples, including intentional empty corrections, complete
executor payloads and negative records, live in
`tests/fixtures/story-continuity-contracts.v1.json` and are exercised by
`tests/unit/story-continuity-serialized-fixtures.test.ts`.

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

### Exact derived source spans

New chunk jobs certify contiguous UTF-16 spans against the complete fiction-safe
`story-fiction-source-v1` representation. That normalization applies NFKC and LF,
removes mechanics with the shared sanitizer, and retains turn intent/narration
labels. Every certified chunk records its normalized source hash and offsets in
`chronicle_memory_chunks.metadata.sourceEvidence`; capability splitting preserves
those offsets. The batch writer reconstructs and verifies the span before saving.
Existing chunks without this metadata remain retrievable, but their historical
computed offsets do not constitute evidence certification.

Chunk rows and their certification metadata remain `rebuildable` in the portability
registry. Accepted turns are unchanged. Turn-memory rebuilds read the saved input
mode and label scene input `Story Direction (intent)`; old `Player action` memories
remain readable. Parent normalization metadata describes a derived representation,
not new story authority. Work and processed-prefix signatures include the source
normalization version. A campaign-scoped queued chunk job can resume an unchanged
prefix or rebuild uncertified parents; deployment performs no synchronous global
reindex. Only verified spans may later support excerpt evidence.
