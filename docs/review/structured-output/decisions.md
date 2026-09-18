# Rulings made during implementation

These decisions are recorded in their original order. The cost column states
what the decision can limit or what would need rework if it proves wrong.

| Decision | Cost or limitation |
| --- | --- |
| Treat the later explicit implementation instruction as authorization to implement the saved plan. | Does not include paid calls, deployment, push, main integration or production mutation. |
| Use Terra for every implementer and reviewer, as requested; coordinator adjudicates findings. | Review depth depends on that requested model and independent verification. |
| Treat each numbered patch, with the index, as the task brief. | Larger briefs require bounded internal slices to avoid partial handoffs. |
| Complete offline/deterministic implementation and prepare a live handoff. | No claim of live effectiveness without the separately authorized experiment. |
| Wire capability/config/cache in patch 01; defer worker dispatch selection to durable patch 04. | Intermediate commits are not independently deployable feature completion. |
| Make API capability status advisory with a registry digest, then check API/worker identity in preflight. | Settings cannot guarantee the state of unknown worker replicas. |
| Append commits after review checkpoints rather than amend reviewed commits. | More commits, with stable review provenance. |
| Split remaining patch-01 loader and wiring corrections across disjoint Terra owners. | Integration rework if their assumptions diverge; combined checks remain required. |
| Interpret zero-attempt preflight as zero provider reservations/dispatches; keep worker claim counters unchanged. | The existing job-attempt field is not a provider-call counter. |
| Let explicit refresh supersede ordinary in-flight discovery; concurrent explicit refreshes share the replacement. | An older caller can receive its own result, but cannot overwrite the newer cache entry. |
| Carry capability boundary-test gaps into mandatory final coverage rather than drop them. | Overall completion waits for that coverage; the carried tests were subsequently added. |
| Keep cross-field semantics in application validation, beyond structural JSON Schema. | Schema-valid output can still fail authority, evidence or semantic checks. |
| Preserve standard code-point JSON Schema limits and existing UTF-16 application limits. | Unusually astral-heavy output may pass schema limits but fail application limits. |
| Keep scene-coverage validation as an exempt assessment; bind full-story scene rewrite to Story schema. | The three-operation schema closure does not cover assessment-shaped responses. |
| Require supported OpenRouter/OpenAI-compatible adapters for new modes; native LM Studio stays Legacy. | Auto/Required on a native unsupported adapter stops at preflight. |
| Add a bounded private invocation ledger without inserting secondary calls into primary validation attempts. | Additional private envelope readers/tests; primary success denominators remain unchanged. |
| Execute high-risk durability work in sequential bounded slices and accept the whole patch only after its gates. | More handoffs, without relaxing the acceptance requirements. |
| Require a completion signal for new-mode SSE: a non-null finish reason or `[DONE]`. | Endpoints closing a stream without either signal remain recoverable failures. |
| Verify integration with a fresh uniquely identified PostgreSQL container and no published ports. | Extra startup and synthetic isolated fixtures rather than production state. |
| Run the independent cache-transaction correction alongside disjoint persistence tests. | Possible integration rework; exact path ownership and immutable verification remain required. |
| Initially accept shared invalidation-helper coverage while carrying direct-delete proof into final coverage. | That direct path needed separate evidence; the held direct-delete test was subsequently added. |
| Interpret profile edits as preserving saved modes, not guaranteeing pending jobs can resume. | Changing back to Legacy can block a pending job's configuration fingerprint. |
| Preserve raw provider context size in historical fingerprints; apply effective caps separately. | Both raw identity and effective budgeting must stay correctly distinguished. |
| Preserve the corrected additive history after one accidental shared-checkpoint amendment. | Mixed checkpoint granularity remains; compared source content was retained and later commit windows serialized. |
| Bound new-mode prepared request evidence to 1,000,000 UTF-16 characters before dispatch. | Very large requests stop early and need reduced context/input; exact evidence is never truncated. |
| Split patch 05 across disjoint server/reporting owners, then UI owners after typed payloads stabilized. | Integration rework remains possible and is covered by combined checks before acceptance. |

The probe preparation additionally distinguishes actual body counts/token
estimates from a conservative spending ceiling. It uses the advertised context
ceiling plus explicit output cap for each of at most 12 calls. This overestimates
likely inference spend; a byte heuristic cannot justify a lower approved limit.
No approval or live compatibility conclusion is inferred from an offline report.

Final review ruling: preserve the existing API/runtime boundary by moving pure capability identity helpers into a shared lower layer without changing their hash bytes. This costs import churn and regression verification; expanding the runtime import allowlist would conceal the boundary regression.

Residual review ruling: correct the reproducible numeric-diagnostic regression
inside the same reporting fix scope, with an additional real-PostgreSQL
RED/GREEN case and independent narrow review. This costs one extra correction
checkpoint; leaving it would make valid failure diagnostics disappear.
