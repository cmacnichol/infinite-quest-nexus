# Self-Provisioning PostgreSQL Test Database Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every PostgreSQL integration-test run provision and use a project-owned local pgvector database when one is absent.

**Architecture:** A Node provisioner owns the deterministic localhost endpoint, ignored generated credentials, Docker Compose lifecycle, and root-database recreation. Vitest runs the provisioner before integration modules load, then the existing isolated-database setup creates per-suite databases from `TEST_DATABASE_URL`.

**Tech Stack:** Node.js 22.13+, Docker Engine/Compose, PostgreSQL 18 with pgvector, `pg`, Vitest 4, PowerShell.

## Global Constraints

- Never commit a database password or generated connection URL.
- Bind test PostgreSQL only to `127.0.0.1:55432`.
- Use a dedicated `infinitequest-integration-postgres` container and `infinitequest-test_infinitequest-integration-postgres-data` volume; never touch the application Compose stack, `postgres-test`, or their volumes.
- The provisioner must create `.env.test.local` when missing and recreate the root test database when it was deleted.
- Integration commands must fail with an actionable error when Docker Engine is unavailable; skipped database suites are not success.
- Use two-space indentation and test each behavior before its implementation.

---

### Task 1: Provisioner and dedicated Compose service

**Files:**
- Create: `scripts/ensure-test-database.mjs`
- Create: `compose.test.yaml`
- Create: `.env.test.example`
- Create: `tests/unit/ensure-test-database.test.ts`

**Interfaces:**
- Produces: `ensureTestDatabase({ execute, rootConnectionFactory, projectRoot })` and `loadTestDatabaseConfig(projectRoot)`.
- Produces: `.env.test.local` with `POSTGRES_PASSWORD` and `TEST_DATABASE_URL`.

- [ ] **Step 1: Write failing provisioner tests**

Assert that a missing local environment file receives a generated password, that the composed URL is `postgresql://infinitequest_test:<password>@127.0.0.1:55432/infinitequest_test`, that Compose is invoked with `compose.test.yaml`, and that a missing root database receives `CREATE DATABASE infinitequest_test`.

- [ ] **Step 2: Run RED**

Run `node_modules/.bin/vitest.cmd run tests/unit/ensure-test-database.test.ts`.

Expected: FAIL because the provisioner module does not exist.

- [ ] **Step 3: Implement the minimal provisioner and Compose files**

Create the pgvector PostgreSQL 18 service, ignored local configuration generation, `docker.exe compose --env-file .env.test.local -p infinitequest-test -f compose.test.yaml up -d postgres`, readiness polling, and root-database creation through `pg`.

- [ ] **Step 4: Run GREEN and commit**

Run `node_modules/.bin/vitest.cmd run tests/unit/ensure-test-database.test.ts` and `pnpm check`, then commit the provisioner and its tests.

### Task 2: Automatic Vitest integration provisioning

**Files:**
- Create: `tests/integration/ensure-test-database.setup.ts`
- Modify: `vitest.integration.config.ts`
- Modify: `package.json`
- Modify: `tests/integration/setup-isolated-database.ts`
- Test: `tests/unit/ensure-test-database.test.ts`

**Interfaces:**
- Consumes: `ensureTestDatabase` from Task 1.
- Produces: `TEST_DATABASE_URL` before database integration files load.

- [ ] **Step 1: Add a failing setup-order assertion**

Assert that the setup module calls the provisioner and publishes its URL before `setup-isolated-database.ts` reads the environment.

- [ ] **Step 2: Run RED**

Run `node_modules/.bin/vitest.cmd run tests/unit/ensure-test-database.test.ts`.

Expected: FAIL because no integration setup module runs the provisioner.

- [ ] **Step 3: Implement global setup and mandatory script**

Use Vitest `globalSetup` to await provisioning before test import, make `pnpm test:integration` invoke it, and replace the skip-on-missing configuration with an error because provisioning is now mandatory.

- [ ] **Step 4: Run GREEN and real smoke test**

Run `pnpm test:integration -- tests/integration/migrations.integration.test.ts`; verify Docker starts the dedicated container, the database exists, and the focused suite executes rather than skips.

### Task 3: Record operation and recoverability

**Files:**
- Create: `docs/development/integration-test-database.md`
- Modify: `README.md`
- Test: `tests/unit/ensure-test-database.test.ts`

**Interfaces:**
- Documents: localhost endpoint, ignored credential file, container/volume names, automatic creation, inspection, and reset commands.

- [ ] **Step 1: Write the operational documentation**

Document `.env.test.local` as the sole credential record, `.env.test.example` as the committed redacted contract, automatic creation, `docker compose --env-file .env.test.local -p infinitequest-test -f compose.test.yaml ps`, and the explicit destructive reset command limited to the test project.

- [ ] **Step 2: Verify the documented workflow**

Run the documented inspection command, `pnpm test:integration -- tests/integration/migrations.integration.test.ts`, `pnpm check`, and `git diff --check`.

- [ ] **Step 3: Commit documentation and resume Edit State Task 2**

Commit the documentation, then run the now-unskipped migration assertion RED cycle from `docs/superpowers/plans/2026-07-26-edit-state-full-corrections.md`.
