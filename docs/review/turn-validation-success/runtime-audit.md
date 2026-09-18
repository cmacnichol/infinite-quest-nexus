# Phase 04 runtime audit findings

Audit target: immutable `4de72e16`. Reviewer: independent Terra runtime reviewer. Coordinator adjudicated each finding against source. This is an intermediate audit, not final approval. All fixes require verification at the final integrated commit.

| Finding | Required correction | Current evidence |
|---|---|---|
| Complete JSON with a length finish was categorically excluded from repair | Let the pure planner establish completeness; retain truthful diagnostics | Source changed in `0eaab2a6`; composed coverage pending |
| Story Direction choice validity was checked only after repair authorization | Check mode-specific validity before offering and before applying | Source changed in `0eaab2a6`; composed coverage pending |
| Later semantic/event reviews dropped v2 repair history or required the latest revision to be the original repair receipt | Preserve v2 provenance and resolve the original receipt by persisted identity | Receipt history changes in `0eaab2a6`; composed later-review acceptance pending |
| Repair scope was checked only against its own checkpoint, not the actual job | Independently compare owner, campaign, world version, base identity, provider and protocol at application, load and commit boundaries | Confirmed by coordinator in current source; assigned for correction |
| Repeated repair selected the earliest historical repair receipt | Select the current offer's matching identity and source, preserving earlier receipts | Coordinator reproduced against `0eaab2a6`; implementation underway |

The actual-job scope finding is a failed tamper-rejection invariant. It does not establish an external exploit or an observed cross-campaign write. The required regression must alter the private checkpoint coherently, so internal schema checks still pass, then prove the actual job binding rejects it and authoritative rows remain unchanged.

The coordinator's repeated-repair reproduction returned `true` for applying the current receipt alone and `false` for the same receipt after an older different-plan receipt. This is adapter-level evidence; the composed Retry-to-second-repair workflow remains required.

## Frozen inventory completeness follow-up

The coordinator reproduced two additional adapter-level failures against the extractor copied from `0eaab2a6`: a request missing its Chronicle inventory is accepted as complete, and a request with two different user authority messages silently selects the first. Both synthetic probes returned an inventory instead of rejecting unavailable/ambiguous evidence. The runtime adapter also lacked a comparison between the extracted complete ID set and saved `primaryResult.sentFactIds`; the implementer confirmed that gap. Corrections and durable regressions are assigned with the scope-binding work. This is independent of the retained historical sample, where all 10 extractor comparisons agreed.

## Scope-test evidence correction

During review of the uncommitted scope regression, the coordinator found that its SQL nested the entire orchestration object inside `generationReview`. That malformed shape could make checkpoint parsing fail before the new scope guard ran, so the initial green result did not prove coherent scope rejection. The implementer was asked to persist the orchestration at the correct level, explicitly assert the altered review still passes its schema, and reproduce RED with the scope guard absent before accepting GREEN. This evidence gap must be closed before the scope finding is marked fixed.

The scope-test evidence correction is verified at `fe37fe1a`. The coordinator independently passed the intact 11-case PostgreSQL suite, then removed only the load-time actual-job scope comparison in a disposable archived container. The corrected targeted test failed because load returned a payload instead of null. No workspace source was changed. This closes the false-positive concern for campaign-scope rejection at load; it does not replace the remaining distinct scope/commit tests.

## Independent scoped re-review at fe37fe1a

A fresh Terra reviewer approved the normal-path inventory corrections but found two residual provenance gaps, independently confirmed by the coordinator:

1. The selected repair receipt's `actionReceipt.jobId`, operation and replacement target were not compared to the actual job. Internal schema validity alone could not establish that this job received the recorded authorization. Require exactly one matching receipt, actual job/action/actor binding and schema-valid tamper regressions at load/apply/commit.
2. Jobs without a frozen Story Memory policy did not compare the saved repair provider fingerprint to the current effective provider fingerprint before applying. Comparing the old primary fingerprint only to the old repair fingerprint allowed a changed current provider configuration to be stamped into a repaired draft. Require equality before applied persistence, with a legacy-job regression.

Both remain assigned until scoped RED/GREEN and independent verification establish the correction. This is not a finding of observed production data corruption.

## Follow-up checkpoints and remaining application history

At `833fb40b`, independent coordinator verification passed 79 real PostgreSQL tests and 3,854 unit tests. This covers the `1ecd8959` actual receipt/action/actor and provider fingerprint corrections; the applied-load regression includes an accepted positive control before coherent tampering. Complete length-finished JSON and invalid Story Direction choice cases now have composed coverage. These checkpoint results supersede the earlier pending status for those cases, but final integrated checks remain required.

Expanded composed tests subsequently exposed two further paths: a new malformed primary response produced by explicit Retry lost the opportunity for a supported format repair, and a continuity conflict immediately after application lost the applied v2 provenance. `943d6af8` corrects new-offer selection and reads carried provenance from current orchestration when preparing later gates. Tests are checkpointed in `62f09bdf`; the coordinator independently passed both complete affected PostgreSQL suites at that commit (83/83, no skips). A Retry followed by one repair is distinct from two actual repair applications and must not be reported as the latter.

The independent specification audit at `833fb40b` also identified missing durable application history (A04). A decision receipt establishes consent, while the mutable applied status and draft alone cannot preserve proof of application after later draft replacement. The coordinator accepted this finding. A versioned application ledger in existing private orchestration JSON is being added atomically with the applied draft, with deterministic receipt/source/result bindings and duplicate/conflict checks. It must survive Retry and reclaim without creating provider attempts or cost entries. Completion remains pending its regression tests and independent review.

## Final closure

The application ledger landed in `3868d156`, with distinct-entry history and authorization/state regressions in `5ce73866`. Independent reviews approved the final production diff and subsequent test-only corrections. The completed [acceptance checklist](acceptance-checklist.md) maps every requirement; [final verification](final.md) records actual run identities, source equivalence, passing counts and explicit skip/failure dispositions. Earlier pending statements above describe historical checkpoints and are superseded by this closure. No production deployment or live success-rate claim is implied.
