# Infinite Quest Nexus Legacy-Parity Review Charter

## 1. Purpose and Scope

This charter governs the review of the new backend against capabilities historically offered by the isolated root `index.html` client. It covers the current API, application, persistence, runtime worker, active legacy UI, replacement UI consumers, portability paths, and relevant tests. It does not approve the recovered behaviors as the target product specification.

The stakeholder's explicit parity request is classified **Desired**. The repository's earlier decision that the root client needed no parity maintenance is **Documented** (`docs/architecture/0020-retire-legacy-player-runtime.md:17-28`). Any conflict between them is surfaced for decision; the review does not silently choose one.

## 2. Universal Engineering Expectations

The reviewed system should:

1. Preserve authoritative and portable data without silent material loss.
2. Keep owner, campaign, world-version, provider-secret, and private-mechanics boundaries intact.
3. Validate untrusted browser, provider, model, and import data.
4. Fail without accepting partial or invalid story state.
5. Keep retry, cancellation, and concurrency behavior idempotent.
6. Keep accepted-turn, Chronicle, and current-state sources of truth consistent.
7. Produce actionable diagnostics without exposing secrets or private reasoning.
8. Bound network, storage, parsing, prompt, and background work.
9. Support repository-evidenced build, test, deployment, recovery, and rollback workflows.
10. Preserve a legacy capability exactly or provide an explicit, documented, usable replacement.

## 3. Requirement-Alignment Rules

A parity difference is a confirmed requirement violation only when supported by a Desired stakeholder instruction, a current documented requirement, a public contract, a system invariant, or a demonstrated contradiction. A retired convenience is classified as a human decision when the backend offers a plausible substitute and intent is unresolved.

The review distinguishes:

- **Missing backend capability:** no durable operation can perform the historical task.
- **Broken compatibility:** the import/continuation path accepts data but loses or ignores material behavior.
- **Transformed workflow:** a safer backend workflow provides substantially equivalent user value.
- **Frontend-only gap:** backend data exists but neither active UI exposes it as before.
- **Retired behavior:** repository decisions explicitly removed the capability.
- **Unknown:** stakeholder approval is needed to decide equivalence.

## 4. Finding Evidence Requirement

Every finding must include a stable ID, severity, confidence, category, exact location, issue, evidence, evidence classification, concrete failure scenario, blast radius, smallest reasonable correction, validation method, and RepoWise role. RepoWise discovery alone is never proof.

## 5. Severity Definitions

- **Critical:** broad compromise, irrecoverable/widespread loss, catastrophic outage, or similarly severe impact.
- **High:** major required-function failure, serious corruption, authorization bypass, unsafe migration, or significant outage/regression.
- **Medium:** a real but limited/recoverable defect, meaningful compatibility loss, high-risk test gap, or architecture problem likely to cause failure/rework.
- **Low:** narrow correctness, observability, documentation, or maintainability risk with concrete impact.

## 6. Confidence Definitions

- **Confirmed:** directly proven by live source/contract/execution.
- **High:** multiple strong evidence paths with minor unexecuted assumptions.
- **Medium:** plausible and well-supported but dependent on product or runtime confirmation.
- **Low:** useful lead requiring further evidence.

## 7. Parity Acceptance Standard

A legacy capability is considered covered when all applicable conditions hold:

1. Its data is accepted, validated, and durably represented.
2. Continuing an imported campaign uses that data in generation and state workflows.
3. The active legacy UI can complete the workflow against the new backend.
4. The replacement UI has, or has an explicitly approved plan for, the same outcome before cutover.
5. Failure and recovery preserve accepted state.
6. Tests prove migration/round-trip and post-import continuation, not merely schema acceptance.

Exact UI layout and insecure browser-owned credential behavior are not required for parity. The user outcome and authoritative data are.

## 8. Review Coverage Priority

1. Legacy import and post-import continuation.
2. Character/world/campaign identity and private state preservation.
3. Accepted-turn and Chronicle integrity.
4. Generation, recovery, RPG, event-trigger, and illustration workflows.
5. Current-state edit, rewind, branch, and historical inspection.
6. Export, sharing, diagnostics, and memory controls.
7. Both current UIs' consumption of the backend.

## 9. Exclusions and Constraints

- Documentation changes only under `docs/review/`.
- No application/test/configuration/migration/infrastructure edits.
- No dependency installation, commit, push, deployment, database mutation, or destructive operation.
- No dedicated security scan; security was reviewed only where it affected parity/trust boundaries.
- No `superpowers` skill.
- Projectmem calls were required by repository guidance but unavailable in the toolset; this limitation is disclosed.

## 10. Approval Gate

After this review, a human must classify each historical difference as intended parity, approved replacement, obsolete behavior, or deferred work. Only then should the target-state specification and implementation plan be created.

## 11. Dead-Code Audit Addendum — 2026-08-18

This focused addendum evaluates whether code is reachable or consumed; it does not reclassify a compatibility path as obsolete merely because the current browser does not call it.

### Evidence required to call code dead

A deletion-ready finding requires all applicable evidence below:

1. No static import, re-export, local reference, HTML/CSS reference, package entry, build entry, package script, CI command, test import, migration loader, or documented runtime loader reaches it.
2. Dynamic loading conventions have been checked explicitly. Files loaded by HTML, framework configuration discovery, directory enumeration, migration runners, or absolute browser imports are active even when their module in-degree is zero.
3. Public/API compatibility has been considered. An uncalled HTTP route or exported symbol is not dead solely because a repository UI does not consume it.
4. Current source confirms the result. Stale graph/index output is a lead, not evidence.
5. For standalone tooling, a human has confirmed that the operational workflow is obsolete, or the script is explicitly replaced and its documentation updated.

### Finding classes

- **Deletion-ready:** no reference or compatibility role remains; remove in a focused change.
- **Export-only cleanup:** implementation remains active locally, but its `export` surface is unused. This is API-surface narrowing, not dead implementation.
- **Historical artifact:** unreachable by design and retained intentionally; remove only after an archival decision.
- **Orphan tooling:** no repository caller exists, but manual execution may be the intended entry point; human confirmation is required.
- **False positive:** configuration, HTML, dynamic, test-fixture, declaration, or internal reference proves the candidate active.

### Validation standard for cleanup

- Run `tsc` with `--noUnusedLocals --noUnusedParameters` against production and test programs.
- Run `pnpm check`, `pnpm test:unit`, `pnpm build`, and `git diff --check` for every cleanup batch.
- Run focused PostgreSQL integration suites when a removal touches repository, transaction, import, generation, Chronicle, or durable-filesystem files, even if the deleted declaration appears behavior-free.
- Review built manifests and public output when removing browser files or dependencies.
- Keep legacy and replacement UI checks separate so one surface cannot mask a regression in the other.

### Scope exclusions

Generated `dist/` output and installed `node_modules/` content are not cleanup targets. Documentation prose, old review records, and migration history are not code and are excluded unless they directly control loading or document a retained compatibility contract.
