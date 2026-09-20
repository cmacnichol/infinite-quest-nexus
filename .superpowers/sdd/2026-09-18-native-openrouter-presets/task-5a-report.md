# Task 5A Report: Protocol Claim Fences

## Status

**IMPLEMENTED LOCALLY — ready for independent review.**

Task 5A adds migration `0099_worker_text_plan_protocol_fences.sql`, upgrades all Story, authoring, and illustration prompt claim paths to advertise protocol 2 transaction-locally, and adds the authoring enqueue marker before the first claim. The work was exercised only against the dedicated isolated PostgreSQL test database. It was not deployed, native admission remains off in the default production composition, and no live or paid provider call was made.

## Behavior

- Story jobs are classified from preset/model v2 evidence and streaming illustration snapshots. Basis-free model-v2 rows, malformed evidence, and future versions fail closed; genuine historical v1 rows remain claimable.
- Authoring API composition can persist `text_plan_protocol = 2` at enqueue when native admission is enabled. Historical stage and parent claim writes are both suppressed. The queued historical helper's null timestamp still throws before dispatch and rolls back; the expired helper may synthesize a claim object, but the paired rows, load, initialization, heartbeat, and executor remain unchanged.
- Authoring snapshot and protocol evidence is monotonic. Terminal cancellation and cleanup remain allowed and retain the protocol marker. Genuine v1 and plan-only v2 snapshots remain on the historical path.
- Direct and generic illustration prompt claims set the local protocol marker. Native v3 prepared and unavailable snapshots are protected; historical valid v2 rows remain compatible.
- Streaming children must copy the exact valid parent snapshot. Omitted, substituted, malformed-parent, and future-parent writes roll back while the provisional child remains pending for reconciliation.
- The local GUC is transaction-scoped and tests cover commit, rollback, and pooled-connection reuse.
- Operational plan fields remain absent from public projections and portable archives.

## RED evidence

The original historical SQL tests failed before the migration:

- Story: 1 failed, 19 skipped; the preset-v2 job changed to `assessing`, incremented attempts, and received an old-worker lease.
- Authoring: 2 failed, 21 skipped; queued and expired historical claims mutated both parent and stage rows.
- Illustration: 1 failed, 30 skipped; the direct historical CTE claimed a native-v3 prompt job.

Three classifier regressions were then captured before their fixes: unset GUC evaluated to SQL NULL, genuine authoring v1 was classified as protected, and malformed streaming snapshots evaluated to SQL NULL. The focused run failed 3 tests with 73 skipped. After the fixes, the same run passed 3 tests with 73 skipped. The four original claim gates then passed with 72 skipped.

The first complete affected unit run passed 79 tests and failed one strict provenance assertion because the current ledger contract includes `resultHash: null`. The production contract and repository both define that nullable field, so the expectation was aligned without weakening it. The complete affected unit run then passed 80/80.

## GREEN verification

All commands used the repository pnpm shim.

```powershell
& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec vitest run --config .superpowers/sdd/2026-09-18-native-openrouter-presets/vitest.integration.config.ts tests/integration/generation-response-contract.integration.test.ts tests/integration/authoring-stage-execution.integration.test.ts tests/integration/image-pipeline.integration.test.ts
```

Result: **3 files passed; 63 passed, 14 skipped**. The skips are Linux-only cases in these files.

```powershell
& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec vitest run --config .superpowers/sdd/2026-09-18-native-openrouter-presets/vitest.integration.config.ts tests/integration/authoring-job-repository.integration.test.ts
```

Result: **1 file passed; 39/39 passed**.

```powershell
& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec vitest run --config .superpowers/sdd/2026-09-18-native-openrouter-presets/vitest.integration.config.ts tests/integration/story-continuity-review.integration.test.ts -t 'keeps the accepted streamed turn when promoted native illustration children roll back'
```

Result: **1 passed, 74 skipped**. The accepted turn survived the injected promoted-child failure and reconciliation retained the frozen snapshot.

```powershell
& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec vitest run tests/unit/generation-executor-adapter.test.ts tests/unit/system-archive-portability.test.ts tests/unit/migration-order.test.ts
```

Result: **3 files passed; 80/80 passed**.

```powershell
& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec tsc -p tsconfig.json --noEmit
git diff --check
```

Result: **passed**.

## Review and handoff

- The migration is additive and intentionally persistent. A faulty classifier or trigger could block eligible jobs if deployed, which is why verification remained isolated and no deployment occurred.
- `createRuntimeAuthoringApplication` and the worker factory accept the native-admission option, but the default graph remains off. Task 5C must pass one consistent native-admission flag to API enqueue and worker resolution; enabling only the worker could create unmarked API jobs.
- The unavailable illustration snapshot is now version 3 so it is classified consistently with prepared native snapshots.
- Story invocation history was deliberately left mutable because valid execution appends and transitions invocation records. The migration instead makes queued, frozen, route, plan, and streaming illustration evidence immutable.
- Test-helper changes are separate from production behavior: historical SQL is preserved, ambiguous generic-claim projection is qualified, and fixture leases are isolated so later cases select their intended rows.
- Root-owned untracked `docs/review/native-openrouter-presets/` and `scratch/` were not modified or staged.

## Independent review round 1 fixes

The first independent review identified four fail-closed gaps. This follow-up keeps the native-admission default off and changes only the protocol fences, accepted-child ancestry plumbing, and their regression coverage.

- Historical Story v1, authoring v2, and illustration v2 exemptions now validate their authoritative top-level and nested shapes. The Story checks cover queued policy identity, frozen contract selection structure, invocation lifecycle, request audit, timestamps, and completed response provenance. Authoring validates its exact v1/v2 fields and every frozen plan. Illustration validates the complete v2 prepared or unavailable union.
- Streaming illustration v3 validation now requires the complete exact prepared or unavailable shape, including the v2 route, plan, frozen response-contract, request-configuration, owner, provider, and prompt invariants. Runtime insertion uses the same authoritative readers before any child row is written.
- Accepted children receive the committing generation job identity directly. Rebuilds derive the unique completed generation parent from the accepted turn. Set, segment, and prompt rows persist that identity, and omission or substitution of a native parent snapshot rolls back before insert. Historical parents without snapshots remain compatible.
- The unchanged old generic illustration claim CTE is now exercised against both prepared and unavailable v3 rows without a GUC. Both remain queued with unchanged attempts, owner, and lease.

### Review-round RED evidence

- The shallow historical Story/authoring counterexamples initially produced **2 failures and 1 pass, with 75 skipped**: malformed Story v1 evidence was claimed and malformed authoring v2 was classified as historical.
- The malformed streaming-v3 counterexample initially produced **1 failure, with 31 skipped** because the validator accepted nested stubs and omitted required identity/configuration fields.
- The malformed historical illustration-v2 counterexample initially produced **1 failure, with 32 skipped** because the historical classifier accepted incomplete nested shapes.
- The accepted-parent ancestry test initially failed because `generationJobId` was ignored and four illustration segments were inserted. Omitted and substituted native snapshots therefore bypassed the intended copy guard.
- The old generic CTE regression was GREEN when first added. The existing table trigger already blocked both native v3 states, so no production change was made to manufacture a RED result.

### Review-round GREEN verification

The final dedicated PostgreSQL run after all nested-validator changes was:

```powershell
& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec vitest run --config '.superpowers/sdd/2026-09-18-native-openrouter-presets/vitest.integration.config.ts' tests/integration/generation-response-contract.integration.test.ts tests/integration/authoring-stage-execution.integration.test.ts tests/integration/image-pipeline.integration.test.ts
```

Result: **3 files passed; 67 passed, 14 Linux-only skipped**.

The generation repository identity and savepoint file passed **35/35**. The authoring repository compatibility file passed **39/39** in the preceding combined run. Its initial combined companion failures were test-helper plumbing only: four Keep fixtures replaced the whole private-state document and thereby deleted immutable queued-policy evidence. Merging checkpoint fields into the existing document preserved the evidence; the generation file then passed 35/35.

The final changed-scope unit and static checks were:

```powershell
& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec vitest run tests/unit/generation-executor-adapter.test.ts tests/unit/system-archive-portability.test.ts tests/unit/migration-order.test.ts
& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec tsc --noEmit
git diff --check
```

Result: **3 unit files passed; 80/80 passed; TypeScript no-emit passed; diff check passed**.

No production database or deployment was touched. No live or paid provider call was made. Task 8 must still enforce the operational all-workers-upgraded gate before deployment.

## Independent review round 2 fixes

The second review confirmed the ancestry and old-generic-claim fixes, then found that several complete historical snapshots could still pass SQL shape checks after their semantic hashes or authority bindings were changed. This follow-up keeps the native-admission default off and strengthens only the database protocol classifiers and copy boundary.

- PostgreSQL now serializes the supported JSON contract values with the same recursive canonical rules as the TypeScript hash helpers: array order is preserved, object keys use C/ASCII ordering, strings use JSON escaping, scalars retain their JSON representation, and SHA-256 is computed over UTF-8. A valid nested fixture containing arrays, objects, null, a decimal, and non-ASCII prompt text has matching JavaScript and SQL hashes.
- Historical Story v1 evidence now recomputes contract schema hashes and the frozen selection hash. A fully shaped snapshot with only `selectionHash` changed is protected from downlevel claims.
- Historical authoring v2 evidence now recomputes route, prompt, and plan hashes. Illustration v2 and streaming v3 additionally require the frozen plan to be the exact plan derived from its route basis and trusted operation prompt.
- Frozen response contracts now recompute their selection and schema hashes and bind the queued policy to the frozen authority and verification evidence. Changing the queued provider profile and recomputing `selectionHash` still fails when the authority remains unchanged.
- The exact streaming parent-to-child database copy path is covered with a fully shaped, correctly rehashed but authority-inconsistent parent. The child insert fails and the transaction rolls back without adding a prompt row.

### Review-round 2 RED evidence

The focused pre-fix run used the three affected PostgreSQL integration files and the four new semantic-tamper cases. It failed **4 tests with 81 skipped**:

- an old Story claim mutated a fully shaped v1 selection whose only invalid field was `selectionHash`;
- a fully shaped authoring v2 plan with a changed `planHash` was classified as historical;
- a fully shaped illustration v2 plan with a changed `planHash` was classified as historical; and
- SQL accepted a fully shaped streaming v3 snapshot after its queued provider profile and selection hash were changed, while the authoritative TypeScript reader rejected the authority mismatch.

The first full affected run after the production fix passed 55 tests and skipped 14, then 16 later Story cases failed because the new protected queued fixture remained claimable by subsequent test helpers. This was fixture isolation rather than a production defect. The regression now terminally cleans up its protected row, and the unchanged later claim cases select their intended fixtures.

### Review-round 2 GREEN verification

The focused semantic run passed **4/4**, with **81 skipped**. It includes a correctly recomputed illustration `planHash` whose plan disagrees with the frozen route basis and operation prompt, and a correctly recomputed response-contract `selectionHash` whose queued policy disagrees with frozen authority. Both are rejected.

The final dedicated PostgreSQL run was:

```powershell
& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec vitest run --config '.superpowers/sdd/2026-09-18-native-openrouter-presets/vitest.integration.config.ts' tests/integration/generation-response-contract.integration.test.ts tests/integration/authoring-stage-execution.integration.test.ts tests/integration/image-pipeline.integration.test.ts
```

Result: **3 files passed; 71 passed, 14 Linux-only skipped**.

```powershell
& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec vitest run tests/unit/migration-order.test.ts
& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec tsc -p tsconfig.json --noEmit
git diff --check
```

Result: **migration-order 1/1 passed; TypeScript no-emit passed; diff check passed**.

The SQL canonicalizer is intentionally limited to the JSON value forms used by these authoritative schemas; it is not introduced as a general replacement for application serialization. Compatibility and parity were verified with actual valid historical fixtures, including nested data and non-ASCII text. No production database or deployment was touched, no live or paid provider call was made, and native admission remains off.

## Independent review round 3 fix

The second re-review confirmed the earlier semantic, ancestry, and old-worker claim findings as addressed, then identified a compatibility regression inside the SQL canonicalizer itself. PostgreSQL JSONB expands scientific numbers and C collation sorts UTF-8 bytes, while the application hashes JavaScript `Number` text and sorts object keys by UTF-16 code units.

The migration now uses two bounded canonical helpers:

- finite JSON numbers are converted through PostgreSQL's shortest round-trip `float8out` with function-local `extra_float_digits = 3`, then normalized to JavaScript's fixed/scientific thresholds and exponent syntax; and
- object keys receive a fixed-width UTF-16 code-unit sort key, including surrogate-pair expansion for supplementary characters, before canonical values are concatenated.

This preserves the existing hash and semantic guards without restricting valid route parameters or permissive v1 schema bodies.

### Review-round 3 RED evidence

On the unchanged round-2 migration, the focused three-file run produced **3 failures, 1 pass, and 82 skipped**:

- JavaScript expected `1e-7` and `1e+21`, while SQL emitted `0.0000001` and `1000000000000000000000`;
- JavaScript sorted the `😀` schema key before `U+E000`, while C collation produced the reverse order; and
- the trigger rejected an otherwise valid exact streaming child copy whose route contained those numeric values.

The existing changed-plan tamper case in the same run remained GREEN.

### Review-round 3 GREEN verification

The same focused run passed **4/4**, with **82 skipped**. It verifies literal JavaScript/SQL canonical text and SHA-256 parity, a valid v1 schema containing `1e-7`, `1e21`, `😀`, and `U+E000`, old-worker claim eligibility for that historical selection, a valid historical authoring plan with the numeric edge values, and a committed-boundary exact streaming child insert followed by rollback. A separate focused check also passed with the session deliberately set to `extra_float_digits = -15`, preserving `0.30000000000000004` through the function-local deterministic setting. The invalid plan and authority cases remain rejected by the full matrix.

The final dedicated PostgreSQL run was:

```powershell
& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec vitest run --config '.superpowers/sdd/2026-09-18-native-openrouter-presets/vitest.integration.config.ts' tests/integration/generation-response-contract.integration.test.ts tests/integration/authoring-stage-execution.integration.test.ts tests/integration/image-pipeline.integration.test.ts
```

Result: **3 files passed; 72 passed, 14 Linux-only skipped**.

```powershell
& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec vitest run tests/unit/migration-order.test.ts
& '.superpowers/sdd/2026-09-18-native-openrouter-presets/bin/pnpm.cmd' exec tsc -p tsconfig.json --noEmit
git diff --check
```

Result: **migration-order 1/1 passed; TypeScript no-emit passed; diff check passed**.

No unsupported valid fixture was found. Non-finite JavaScript values are excluded by the route schemas and cannot be persisted as JSON numbers. No production database or deployment was touched, no live or paid provider call was made, no branch was pushed, and native admission remains off.
