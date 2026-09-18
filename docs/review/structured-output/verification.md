# Structured output verification record

Final source candidate: `a09c3204b077392abd068bb2b04c9f6dd35f4016`.
Baseline/main: `2084ae53419388b2e9a3d60fd88cd16547da5acd`, rechecked remotely
on 2026-09-18. Main integration and deployment were not performed.

| Check | Immutable candidate | Result |
| --- | --- | --- |
| Complete unit suite, four workers | `a09c3204` | 4,073 passed; 1 skipped; 322 files; exit 0 |
| Complete isolated PostgreSQL integration suite | `d453ae0e` | 1,273 passed; 7 skipped; 108 files; exit 0 |
| Added reporting SQL regression, real PostgreSQL | `a09c3204` | 1 passed; no skips; exit 0 |
| Complete repository checks and builds | `a09c3204` | Passed; exit 0; existing nonfatal bundle-size warning |
| Settings and paired Story/recovery browser suites | `a09c3204` | 113 passed; 1 skipped; exit 0 |
| Four final-fix focused unit suites | `e9fb1e08` | 115 passed; no skips |
| Offline probe preparation | `e9fb1e08` (unchanged probe at final source) | Exact safe artifact preserved, including schema/body hashes; no HTTP |
| Independent whole-branch reviews and scoped corrections | Through `a09c3204` | Specification and code findings resolved; residual two-field correction independently accepted |

The complete PostgreSQL run preceded the final reporting changes and pure
identity-helper move. Generation/persistence behavior was unchanged afterward;
the identity bytes were independently compared and the new report SQL received
its own fresh PostgreSQL test. These are distinct checkpoints, not a claim that
the complete suite ran at the later SHA.

All immutable Linux checks used the pinned verification image
`sha256:b50802f8ea15e1fa9cc78597ac37efc475e10d9f9b7fd81edd7f64d270895124`, an
archive of the named commit, frozen-lockfile installation and pnpm 12.4.1.
PostgreSQL checks created isolated ephemeral databases without production data
or host ports. This verification image is not a selected deployment image.
The image lacks Corepack; a guarded wrapper invokes its existing pinned pnpm.

## Commands and coverage

```sh
corepack pnpm test:unit --exclude '**/.worktrees/**' --exclude '**/.codex/**' --maxWorkers=4
corepack pnpm test:integration
corepack pnpm exec vitest run --config vitest.integration.config.ts tests/integration/report-turn-validation.integration.test.ts
corepack pnpm check
corepack pnpm build
corepack pnpm exec playwright test tests/e2e/structured-output-settings.e2e.test.ts tests/e2e/generation-review.e2e.test.ts tests/e2e/generation-integrity-diagnostics.e2e.test.ts
git diff --check
```

| Requirement group | Verified evidence |
| --- | --- |
| Capability discovery, cache isolation and trusted operator records | Provider/cache/configuration unit coverage and [phase 01](phase-01.md) |
| Complete schemas and native tracker preservation | Schema fixtures, strict wire validation and [phase 02](phase-02.md) |
| Exact prepared payloads, route identity, no format downgrade | Transport/budget tests and [phase 03](phase-03.md) |
| Durable preflight, reservation, crash/restart, historical readers | Real PostgreSQL response-contract workflows and [phase 04](phase-04.md) |
| Acceptance, scope, explicit recovery and tracker authority | Full generation/review/continuity/isolation integrations; unchanged acceptance checks |
| Settings and safe status across both Story surfaces | Rendered browser coverage and screenshots in [phase 05](phase-05.md) and [final review](final.md) |
| Truthful bounded reporting | First-response denominator tests, future-version rejection, actual PostgreSQL bounded-scalar and typed-diagnostic cases |
| Compatibility probe and rollout | Twelve offline prepared requests, execution guards, [phase 06](phase-06.md), [rollout](rollout.md) |

## Skips, failures and corrections

The unit skip is the existing unsupported-host negative secure-filesystem case:
this Linux environment supports the secure filesystem operations. The seven
integration skips are one opt-in historical-fact benchmark and six opt-in
known-failure baseline probes. The browser skip is the existing Web Awesome
opt-in assertion; that server mode was not selected. No skip is counted as a
pass or as live-provider evidence.

Earlier integration runs caught stale exact-projection/payload expectations and
transaction-unaware checkpoint spies. Scoped test corrections retained exact
sizes, post-commit boundaries, authoritative-state and no-duplicate-call
assertions. The corrected complete PostgreSQL run passed.

The first final unit run found a stale settings count and an API/runtime import
boundary violation. The count now includes the added policy control; the pure
identity helpers moved to contracts without widening the architectural
allowlist. The unchanged elapsed-time test also failed under unrestricted
parallel load at 13,393 ms and 13,505 ms against its 14,500 ms minimum. It passed
alone at 15,018 ms and the complete final suite passed with four workers. No
timing assertion was relaxed.

Final review found version-blind report cohorts and unbounded new private
scalars. Their correction initially converted numeric diagnostics into strings.
An added real-PostgreSQL RED test at `df8309f9` observed zero transport/timeout
diagnostics instead of two. The two-field fix at `a09c3204` preserves bounded
numeric JSON values; the unchanged test then passed, including rejection of
string-version lookalikes. Original findings and the residual correction were
independently reviewed.

One early phase-01 historical RED command/log was not preserved. Current
coverage is verified; that missing chronological evidence is not reconstructed
or claimed as recorded.

No live compatibility request, operator-record installation, production report,
A/B experiment, push, main integration or deployment was performed. Live quality
and failure-rate improvement remain unmeasured.

The final Windows documentation wrapper encountered the known nested pnpm
11.15.1/12.4.1 shim mismatch after its boundary check passed. The data-safety
check was then run directly through Corepack and passed for all 1,760 candidate
files. Local handoff links and staged diff checks passed. The complete code
checks/build result above is from the pinned Linux environment.
