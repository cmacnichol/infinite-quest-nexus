# Structured output phase 06 handoff

The compatibility probe defaults to offline preparation. Its safe example is
[probe-dry-run.json](probe-dry-run.json); no credentials, user content or full
request bodies appear there. Running the CLI without `--execute` does not load
runtime configuration, access the database or make HTTP requests. The
[operator runbook](../../runbooks/structured-output.md) documents execution.

## Prepared qualification matrix

| Operation | Nonstreaming | Streaming | Current worker uses |
| --- | --- | --- | --- |
| Story (`story-native-v1`) | Unverified | Unverified | Both |
| Choices (`choices-v1`) | Unverified | Unverified | Nonstreaming |
| Continuity review (`continuity-review-v1`) | Unverified | Unverified | Nonstreaming |

These six tuples each have two synthetic scenarios, for twelve requests. The
proposed target is `deepseek/deepseek-v3.2-exp` through `novita/fp8`. This does not
qualify `@preset/nexus-nsfw` or establish that the preset selects that route.
Every tuple is still unverified: no live calls or operator records were created
or installed. Consequently there are no live verification-record hashes to
report; the offline artifact contains exact schema and prepared-payload hashes.

Story preserves arbitrary native nested tracker objects. A route requiring all
nested objects to be closed is unsupported for that Story schema, regardless
of its advertised structured-output support. Choice/review eligibility is
independent. Auto may select different modes per operation; Required needs the
complete operation closure before dispatch. LM Studio native has no verified
new-mode adapter; Legacy remains available.

The largest prepared body is 3,088 bytes and the application input estimate is
1,030 tokens. That estimate is not a billing bound. The separate conservative
163,840-input-token ceiling plus 2,048 output tokens per call prices the twelve
requests at at most $0.540918 inference cost using the recorded public price.
Execution requires refreshed price evidence, matching profile identity, an
explicit route and authorization reference, accepted cost and all limits. It
reserves a private report outside the repository before loading credentials.
No spending approval is inferred from the model-selection answers.

Returned model/route identity, strict wire validation, production parsing and
tracker equality must all pass. Any incomplete output, refusal, timeout,
identity mismatch or invalid schema aborts the batch without proposed records
or an automatic retry. A provider display name alone cannot establish a full
route variant. Successful proposed records still need operator review and
installation; browser discovery never grants trust.

## Verification checkpoints

The probe implementation and two review corrections end at `607eac06`.
The focused CLI suite passed 19 tests, including real offline entrypoint
isolation, distinct failure paths and independently reached input/cost guards.
Final narrow review accepted the cap-guard corrections. Whole-branch reviews
and complete deterministic verification are now recorded in
[verification.md](verification.md), through final source `a09c3204`.

The full integration run exposed three historical test assumptions. Exact API
projection and payload-size expectations now include the bounded response-format
projection. The checkpoint tests now observe the real repository method after
its transaction commits, rather than a pool-query spy bypassed by transactional
writes. Their original reclaim, authority and no-duplicate-call assertions
remain. The corrected generation integration file passed 50/50 tests against a
fresh isolated PostgreSQL database at `96ac3c68`.

No live provider effectiveness, production baseline, A/B experiment, deployment
or release image is claimed. The [rollout handoff](rollout.md) provides the
matched-cohort experiment, operational stop conditions and rollback inventory.
The [decision log](decisions.md) records implementation rulings and their costs.
