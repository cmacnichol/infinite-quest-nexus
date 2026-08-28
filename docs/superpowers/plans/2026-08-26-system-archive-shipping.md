# System Archive Shipping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the verified System Archive security gaps, establish production-ready release evidence, and update the operator guidance without enabling the capability.

**Architecture:** Enforce archive confidentiality at the contracts layer so export sanitization and v2 import validation share the same guarantees. Keep System Archive default-off while the API, worker, database, and both clients are verified in a Linux/PostgreSQL release gate. Operator documentation must describe the verified current contract and a staged enablement procedure.

**Tech Stack:** TypeScript, Zod, PostgreSQL, Vitest, Playwright/Chromium, Docker, VitePress.

**Spec:** `docs/superpowers/specs/2026-07-26-portable-campaign-and-system-archives-design.md`

## Global Constraints

- Preserve World JSON, Campaign Archive, legacy/external import, and readable export behavior.
- System Archive must remain behind `SYSTEM_ARCHIVE_ENABLED=false`; this plan does not enable, commit, push, or publish it.
- Archives must never retain credentials, access capabilities, raw provider state, temporary provider URLs, authorization headers, or provider response identifiers.
- Use strict TDD: every production behavior change needs a focused RED then GREEN regression test.
- PostgreSQL/Docker checks are only passing when their complete command exits zero; skipped database tests are not evidence.
- Preserve unrelated worktree changes.

---

### Task 1: Close System Archive confidentiality bypasses

**Files:**
- Modify: `packages/contracts/src/archives.ts`
- Modify: `packages/contracts/src/system-archives.ts`
- Modify: `packages/database/src/system-archive-export-repository.ts`
- Modify: `packages/database/src/system-archive-import-repository.ts` only if schema-normalized import requires it
- Test: the nearest archive-contract and System Archive export/import regression suites.

- [ ] Add failing tests that reject punctuation-delimited secret keys (`api.key`, `private.key`, `auth.header`, `bearer.grant`), reject percent-encoded `/signed/` and `/temp/` path segments, and show `providerResponseId` is absent from an exported v2 cost event and rejected on import.
- [ ] Run the focused tests and record expected RED failures at the shared schema/sanitization boundary.
- [ ] Implement the narrowest shared normalization and sanitization changes that reject all equivalent malicious representations while retaining safe metadata and ordinary public image URLs.
- [ ] Run the focused tests to GREEN, then run direct export/import regression coverage.

### Task 2: Independently review the security boundary

**Files:**
- Review only the Task 1 candidate diff and its direct callers.

- [ ] Have an independent reviewer reconstruct the confidentiality invariant across export, v2 schema validation, nested JSON, query keys, and URL path normalization.
- [ ] Resolve every confirmed Critical or Important bypass/regression with a focused test and re-review the fix.

### Task 3: Produce final release-matrix evidence

**Files:**
- Test: System Archive unit, migration, resumable, integration, and Linux E2E suites.

- [ ] Run the focused contract/export/import suites affected by Task 1.
- [ ] Run the isolated PostgreSQL migration, resumable, and core System Archive suites without combining files that mutate the shared test database.
- [ ] Run the compiled Linux/PostgreSQL/private-root/Chromium E2E gate and the repository build.
- [ ] Run `git diff --check` and retain only evidence-backed results.

### Task 4: Correct System Archive operator documentation

**Files:**
- Modify: `docs/nexus-guide/operations/system-data-transfer.md`
- Modify: `docs/installation/environment-configuration.md` only when its release-gate guidance needs a matching correction.

- [ ] Replace obsolete statements that claim Linux/private-root qualification remains incomplete with the verified release evidence.
- [ ] State the supported format versions accurately, retain the distinction from Disaster-Recovery Backups, and describe the security exclusions.
- [ ] Document the explicit staged rollout: validation deployment, shared roots/API-worker configuration, source-to-empty-destination drill, monitoring, rollback by disabling the flag, and post-import verification.

### Task 5: Capture deployment-readiness proof without enablement

**Files:**
- Review: `compose.yaml`, `deploy/swarm/stack.yaml`, `docs/runbooks/deployment.md`, and System Archive environment documentation.

- [ ] Verify that the reviewed manifests can provide identical `SYSTEM_ARCHIVE_ENABLED`, archive root, asset root, and PostgreSQL authority to each participating API/worker role.
- [ ] Add or correct only documentation/configuration evidence required to make the reviewed override and rollback procedure executable; do not turn on the flag in a checked-in deployment.
- [ ] Validate the Compose/Swarm configuration syntax and run the applicable deployment smoke test if the environment can do so.
