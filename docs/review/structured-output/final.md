# Structured output implementation review

Structured output can reduce malformed JSON, missing fields and wrong field
shapes for a verified model/provider/schema combination. It complements the
validation work merged into main; it does not replace application validation,
semantic review, mechanics isolation or explicit recovery decisions. No live
reduction in generation failures has been measured by this implementation task.

## When capability metadata is queried

The application preserves OpenRouter's bounded `supported_parameters`
advertisement during model inventory discovery. The settings Refresh endpoint
requests fresh discovery. New-job preflight uses the server's 24-hour,
owner/profile/endpoint/model/configuration-scoped cache and discovers on a miss
or expiry before taking the durable dispatch path. Concurrent matching loads
share one request. Failed discovery becomes unknown. Resume of an already frozen
contract does not rediscover or change its selected response format.

Advertising `response_format` or `structured_outputs` is insufficient to permit
strict schema mode. Eligibility also needs a current operator-reviewed record
for the exact schema, model, endpoint, routing configuration, adapter and
streaming mode. Browser settings cannot create that record. Missing policy stays
Legacy without inserting a value into historical configuration fingerprints.
Auto selects a verified schema or JSON-object mode before dispatch. Required
stops before dispatch when its required operations cannot be verified.

## What changed

- Complete provider wire schemas cover Story, choice repair and continuity
  review. Strict payloads use `response_format.type=json_schema`, a named schema,
  `strict=true`, and OpenRouter route restrictions with `require_parameters=true`.
- A versioned job selection and private invocation ledger preserve exact request
  bytes/hash, operation, format, schema and observed response identity through
  failure, review and restart. New modes do not retry without response format
  after a format rejection. Reserved/dispatched/completed states do not grant an
  automatic replacement call.
- Settings expose Legacy, Auto and Required with advisory verified/advertised/
  unsupported/unknown coverage. Both Story interfaces display safe saved-job
  format and preflight guidance without changing Keep, Retry or local repair
  authority.
- Read-only reporting retains the first initial application-validation
  denominator, separates repairs, acceptance and preflight failure, and keeps
  missing observations unknown. Observed per-call transport classification,
  latency and cost are not available in the current durable scalar data.

The Story wire schema intentionally retains arbitrary native tracker objects.
An endpoint requiring every nested object to be closed cannot qualify for that
schema. Choices/review can have different eligibility from Story; Required
needs all operations in the saved job closure. Raw nested tracker updates remain
in a private new-mode evidence sidecar while normalized campaign trackers and
historical snapshot meanings stay unchanged.

## Delivery and evidence

The work is isolated on `codex/structured-output`; the main checkout is unchanged.
Remote main was rechecked as `2084ae53419388b2e9a3d60fd88cd16547da5acd` on
2026-09-18. No push, main integration, deployment or production mutation has
occurred. The phase handoffs record checkpoint evidence:

- [Capabilities](phase-01.md)
- [Schemas](phase-02.md)
- [Transport](phase-03.md)
- [Durability](phase-04.md)
- [Controls and reporting](phase-05.md)
- [Probe and release verification](phase-06.md)

All six patches are implemented and deterministic verification is complete.
The [verification record](verification.md) records exact tested commits, commands,
passed/skipped counts, corrections and independent review. Final source is
`a09c3204b077392abd068bb2b04c9f6dd35f4016`; later handoff changes are documentation only.

## Live qualification and limitations

No route has been qualified by a live probe here, including the user-selected
DeepSeek V3.2 Exp behind `@preset/nexus-nsfw`. A concrete single-route probe cannot
establish compatibility for that mutable preset. The proposed route, priced
batch, matched-cohort experiment and rollback boundaries are in the
[rollout handoff](rollout.md). Baseline reporting and live A/B measurement remain
unperformed and require their described operational access/authorization.

Standard JSON Schema string limits count Unicode code points while the existing
application validator uses UTF-16 units. Some schema-valid astral-heavy output
can therefore still fail application size validation. Cross-field evidence and
supersession semantics remain application checks. New modes also enforce a
1,000,000 UTF-16-character prepared-body ceiling before dispatch so exact failure
evidence remains durably recordable; oversized requests require less context or
shorter input. These are documented compatibility boundaries, not silent output
normalization or acceptance guarantees.

Rendered evidence: [Settings Required](../assets/structured-output/settings-desktop-required.png),
[Settings coverage](../assets/structured-output/settings-desktop-verified.png),
[legacy Story](../assets/structured-output/story-legacy-response-format-desktop.png),
and [replacement Story](../assets/structured-output/story-web-next-response-format-desktop.png).
Mobile captures are retained beside these files. These use synthetic fixtures.

## Final verification

At the final source commit, 4,073 unit tests passed (one skip), all repository
checks and builds passed, and 113 browser tests passed (one skip). The complete
isolated PostgreSQL suite passed 1,273 tests (seven skips) at the preceding
workflow candidate; the added reporting SQL regression passed separately at
final source. No failed check remains unresolved. The verification record
explains the separate checkpoints and every skip.

Fresh Terra specification/code reviews found and resolved the final reporting
and architecture issues. The last diagnostic correction has real PostgreSQL
RED/GREEN evidence and an independent scoped review. All implementation rulings
and their costs are retained in the [decision log](decisions.md).

One early phase-01 historical RED command/log was not preserved. Current
regression coverage is verified; missing chronological evidence is not claimed.