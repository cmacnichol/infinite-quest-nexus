# Task 14e3e7 implementation report

## Scope

Implemented the additive private asset-maintenance scheduler only. No live
worker/default runtime/API implementation/public barrel/config/manifests or
deployment documentation was changed.

## Delivered

- `packages/application/src/assets/private-asset-maintenance-scheduler.ts`
  provides a capacity-one round-robin scheduler for exactly metadata backfill,
  asset filesystem recovery, and portable expiry recovery. It advances after
  empty or faulted probes, exposes bounded counters and allowlisted diagnostics,
  accepts only worker/lease inputs, and stops new claims while draining its one
  active claim-fenced unit on abort.
- `services/runtime/src/private-asset-maintenance-composition.ts` composes only
  the private e5/e6 compositions on the caller-provided pool. It maps their
  private outcomes to the scheduler’s safe projection and closes only after
  abort/drain.
- `services/runtime/src/private-filesystem-recovery-composition.ts` now exposes
  private `processAssetOne` and `processPortableOne` entry points (limit one),
  while preserving the old private combined `processOne` behavior for existing
  e6 callers.
- `scripts/check-private-asset-maintenance-boundaries.mjs`, wired into the
  repository boundary check, requires the named private scheduler/composition
  and rejects every direct scheduler import outside that composition (including
  API, worker, main/default compositions, and public barrels), live bindings,
  API graph edges, the legacy backfill selector, and additional pool creation.

## Evidence

- Red/green scheduler unit test: missing scheduler module failed, then focused
  scheduler tests passed. Final scheduler/boundary units: 8/8.
- Real PostgreSQL/temp-filesystem e7 matrix: 4/4. In addition to rotation,
  e6 finalization, portable cleanup, and idempotent subsequent ticks, it proves
  each split e6 probe leaves an unexpired claim alone, then a fresh composition
  reclaims it only after expiry and performs one terminal database/physical
  cleanup action.
- Adjacent real e5/e6/e7 matrix: 25/25.
- Adjacent boundary/scheduler unit matrix: 19/19.
- `pnpm check` passed.
- `pnpm build` passed.
- `git diff --check`, untracked-file whitespace checks, and
  `PROJECTMEM_ROOT=/home/devagent/repos/infinite-quest-nexus pjm precheck --level block`
  passed.

## Known constraints

- Live worker scheduling remains intentionally unchanged until e3g. Forced
  process termination is represented solely by durable lease expiry/reclaim;
  the scheduler does not invent cancellation or a second pool/lane.
- This report accompanies the focused e7 implementation commit after
  independent review; live activation remains deferred to e3g.
