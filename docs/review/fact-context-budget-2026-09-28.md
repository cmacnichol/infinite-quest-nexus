# Fact context budget verification

The repair removes the cumulative 512-fact capture/query ceiling, the 1 MB
aggregate source gate, and the 2,000-fact saved-state schema limit. It retains
per-record validation, scoped source verification and correction frontiers.
V5 prompt planning sends the largest newest sequence of complete facts that
fits campaign context and the independent writer/reviewer request limits.
Older facts remain stored. Current correction facts are no longer duplicated
inside mandatory context; current facts without source IDs are also budgeted
without inventing IDs. Legacy context protocol branches remain unchanged.

The former 15% fact allocation and 64-measurement cutoff are removed. Binary
search preserves oldest-first omission with logarithmic exact measurements.
If the newest individual fact cannot fit, the selected fact sequence is empty.

## Verification

- RED: 910-fact contract capture and PostgreSQL source tests failed at former
  count/size gates; the roomy planner sent only 240 of 910 facts.
- RED: asymmetric writer/reviewer limits incorrectly omitted a fitting fact;
  exact budget checks now pass that case.
- RED: exhaustive partial-fit probing required 216 measurements. The new
  suffix selection uses 10 for 512 facts, approximately one second locally.
- `corepack pnpm test:unit`: 365 files passed, 4,697 tests passed, 44 skipped.
  Skips are existing platform-dependent secure-filesystem/POSIX cases on Windows.
- PostgreSQL: 21 tests passed across `history-protected-facts`,
  `history-coverage-context`, and `generation-budget-growth`. Tests cover
  capture-to-serialized-request behavior, complete fact identity, source
  isolation, nonmutation, budget growth and pre-dispatch overflow rejection.
- `corepack pnpm check`, `corepack pnpm build`, and `git diff --check`: passed.
- Independent final review found no actionable P1/P2 findings.

PostgreSQL ran in a disposable pgvector container on loopback port 55439,
separate from production. A temporary Vitest configuration retained the normal
integration configuration and per-file database isolation while bypassing only
global Docker provisioning, using the explicit disposable database URL. The
temporary configuration was removed after verification.

Initial sandboxed Vite builds failed resolving Windows parent directories;
build and the full unit suite passed outside that restriction with the workspace
package-manager path. An intermediate performance integration failed before
the binary-search fix; the final complete three-file run passed.

No UI behavior was edited, so no browser screenshots were required. No live
provider generation, deployment, campaign mutation, or retry was performed.
The full repository integration suite was not run; the three affected suites
above establish the reported PostgreSQL evidence.
