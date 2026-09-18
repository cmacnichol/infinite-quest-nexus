# Turn validation rollout handoff

Status: preparation only. Implementation and final verification are still in progress. No deployment, image publication, production job changes, or live-provider canary has been performed or authorized by this document.

## Release identity and compatibility

- Final release commit and image digest: pending final integrated verification. Do not deploy an intermediate checkpoint merely because its focused tests pass.
- Repository base: `2ce5508872ba0588c0c0ea51769bb828194b3f46`.
- New-job fact-wire prompt identity: `story-v16-fact-wire-distinction`. Existing jobs retain their frozen prompt content and identities, including historical v15 jobs.
- New public/private review version: v2 for fact-format repair; historical v1 Keep and Retry meanings remain unchanged. Unknown future versions are inert refresh-required markers.
- Repaired drafts retain original response/request evidence, the explicit repair receipt and transformation provenance. Compatible workers must understand those fields through later reviews and recovery.
- No database migration, Dockerfile or deployment manifest has changed through `0a0ab8f6`; recheck the final release diff. Existing database schema requirements still apply.
- Reporting now recognizes `NEXUS_BUILD_COMMIT`, then legacy `GIT_SHA`/`BUILD_SHA`, with safe-label validation.

## Before an authorized rollout

1. Finish every requirement in the [acceptance checklist](acceptance-checklist.md) at one immutable integrated SHA. Attach final unit, PostgreSQL, type/build, browser and independent review evidence.
2. Follow the [deployment runbook](../../runbooks/deployment.md), including the normal authoritative PostgreSQL backup and restoration rehearsal. Record the exact current and candidate image digests without exporting credentials.
3. Inventory queued, running and recoverable generation jobs by frozen protocol and review/checkpoint version. Preserve original attempts and pending decisions. Stop new intake and drain active work as required by the actual deployment topology; deliberate cancellation or discard requires its own authorization.
4. Deploy compatible API, runtime/worker and Story clients together. Do not allow an older worker pool to claim new v2 work without independently proven compatibility. Keep the documented ten-minute worker shutdown grace period.
5. A live canary requires separate approval of disposable campaign copies, actual provider/model, frozen parameters, maximum calls/tokens, priced cost cap and stop conditions. No live budget is assumed here. Context and strict-output experiments (phases 05–06) remain outside the current implementation scope.

## Measurement after separate canary authorization

Use fixed UTC windows and show the numerator, denominator and missing observations for each result. Separate first-pass structural validity from deterministic repair eligibility, user-authorized repair, semantic review and final acceptance. Track primary calls per accepted turn, optional provider failures, cancellations/discards and latency separately.

The release plan proposes a 20-job smoke sample followed by at least 50 eligible primary responses for a directional comparison. Its 90% first-pass structural-validity and 95% supported-case parser targets are evaluation targets, not promises. The historical replay demonstrates four retained invalid primary responses are structurally repairable, including two first responses; it does not establish a live recovery percentage. See [historical replay](historical-replay.md).

Stop a canary on unauthorized writes, duplicate turns, cross-campaign access, hidden primary rewrites, lost supersession information or misleading repair consent. Preserve evidence when a stop condition occurs.

## Rollback boundary

Pending v1 and v2 reviews, authorized repairs, applied repairs awaiting semantic review and committed jobs require separate compatibility checks before release. Do not start older workers against v2 jobs merely by changing an image tag. Keep a v2-capable worker available, or stop worker dispatch until compatible code is restored. No repair-off switch or per-job hold command is assumed to exist.

Existing jobs keep frozen prompt/provider settings and receipts. Rollback must not relabel them, erase transformations, reinterpret Retry as repair consent, or restore a whole database over newly accepted turns. Database restoration is a separate recovery operation with its own authorization and reconciliation of accepted work.

Live success-rate improvement remains unmeasured. Final implementation verification is still required before this handoff becomes release-ready.
