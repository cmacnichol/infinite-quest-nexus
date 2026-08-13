# Infinite Quest Nexus Code Review Report

Independent adversarial review of an existing codebase with no trustworthy
current specification. Read with `review-charter.md` (the standard applied) and
`as-built-specification.md` (what the system demonstrably does).

---

## 1. Executive Summary

**Overall condition.** This is a disciplined, coherently structured codebase.
Type checking, repository-boundary rules, and the unit suite all pass at the
reviewed revision. Security fundamentals that are frequently botched are handled
correctly here: parameterized SQL throughout the reviewed paths, a strict CSP
with no `unsafe-inline`, exact-origin validation, layered archive path-traversal
defenses with `realpath` containment, AES-256-GCM credential encryption with
per-record nonces, a non-root container, correct `FOR UPDATE SKIP LOCKED` job
claiming with lease-based crash recovery, and consistent `owner_user_id` scoping
including inside joins. CI is comprehensive and least-privileged.

**Review scope.** Entire repository at `58d0aa2f9374`, 431 tracked files,
~55.9k LOC. Coverage is partial by design — see §11.

**Confidence.** Medium-high for the server, configuration, security, and
deployment layers, which were read directly. Low for the browser client
(~7 979 lines across `nexus.js` and `story.js`), which was not reviewed in
depth, and for the interiors of the largest API services.

**Is it safe to keep building on?** Yes, with one correction sequenced first.
The architecture is sound and the invariants are real. The single most important
issue is not a coding error but a **gap between a documented security design and
the shipped system**.

**Most important confirmed risk.** The repository documents a P0 network-security
design requiring PostgreSQL-backed rate and concurrency admission on expensive
routes, returning `429 REQUEST_LIMIT_EXCEEDED`. That subsystem is fully built —
implementation, migration `0044`, six validated environment settings, and a
thorough integration test — but **no route ever calls it**. `REQUEST_LIMIT_EXCEEDED`
appears nowhere in the repository and no route returns `429`. Six configuration
settings are accepted and silently ignored. An operator who configures rate
limits gets none (REV-001).

**Most important unknowns.** Whether admission enforcement is still required or
was deliberately deferred; whether the 2 GiB import / 20 GiB uncompressed archive
defaults are intended outside a trusted network; whether authentication is a
committed requirement.

**Most important validation gap.** `pnpm test:unit` silently collects test files
from gitignored `.worktrees/` checkouts — 323 files instead of 56 — so local runs
report failures from unrelated revisions. Local validation is currently
untrustworthy even though CI is clean (REV-002).

**Recommended immediate next action.** Decide REV-001 (enforce admission control,
or explicitly retire it and remove the ignored configuration), then fix REV-002
so local test signal can be trusted.

**Final recommendation: Continue after minor corrections.** See §16.

---

## 2. Repository and Review State

| Field | Value |
| --- | --- |
| Repository path | `C:/Git/InfiniteQuest` |
| Repository identity | `https://github.com/cmacnichol/infinite-quest-nexus.git` |
| Current branch | `main` |
| Current `HEAD` | `58d0aa2f93749d03a1982e6f907fd0f13ff83a4c` |
| Baseline revision | None supplied |
| Working tree | Not clean — see below |
| Staged changes | None |
| Unstaged changes | `AGENTS.md` — Repowise auto-generated block only |
| Untracked files | `docs/prompts/claude-repowise-undocumented-codebase-review-prompt.md` |
| Submodules | None |
| Review scope | Entire repository |
| Exclusions | `node_modules/`, `dist/`, `.worktrees/` (gitignored local worktrees, not part of the revision), vendored `apps/web/public/jszip.min.js` |

The only tracked modification is a generated documentation block between
`REPOWISE_AGENTS` markers. **No application code, test, schema, or deployment
artifact differs from `HEAD`**, so the reviewed state is equivalent to `HEAD`.

**Commands used to establish state:** `pwd`, `git rev-parse --show-toplevel`,
`git branch --show-current`, `git rev-parse HEAD`, `git status --short`,
`git remote -v`, `git submodule status`, `git log --oneline --decorate -n 30`,
`git tag --list`, `git diff`, `git diff --cached`,
`git ls-files --others --exclude-standard`.

**Material limitations.** No repository tags exist, so there is no release
history to correlate. No stakeholder product intent was supplied.

---

## 3. RepoWise Analysis

| Property | Value |
| --- | --- |
| Availability | Available; MCP tools responded |
| Indexed repository | InfiniteQuest |
| Indexed commit | `58d0aa2f9374` |
| Current `HEAD` | `58d0aa2f9374` |
| Freshness | **Exact match; index age 0 days; not stale** |
| Uncommitted-change coverage | Not represented — irrelevant here, since the only diff is a generated docs block |
| Truncated context | `get_health()` dashboard exceeded inline limits and was persisted to a scratch file, then parsed locally |

**Tools used.** `get_overview`, `get_health` (with `performance`, `biomarkers`),
`get_dead_code`.

**Architecture summary as reported.** Layered TypeScript monorepo — API,
Application, Service, Types, Docs & Tooling — with entry points
`services/api/src/server.ts` and `services/runtime/src/main.ts`; 93 hotspots;
average bus factor 0.6 with 226 files at bus factor 1; churn trend increasing;
top churn in `services/api`, `tests/unit`, `tests/integration`, `apps/web`.
Ownership is concentrated: one contributor owns 54.3% of files.

**High-centrality / low-health components reported.** `apps/web/public/nexus.js`
(health 1.0, 4 806 NLOC, 16 dependents), `services/api/src/generation-service.ts`
(max CCN 146), `asset-service.ts`, `image-service.ts`, `memory-service.ts`,
`server.ts`, `world-service.ts`, `packages/story-engine/src/providers.ts`.

**How RepoWise affected priorities.** It correctly directed attention to
`server.ts` and the API service layer as the centrality core, and its
bug-magnet history (campaign archive, generation service, image pipeline)
matched the areas of recent sustained commit activity. That steered the
trust-boundary and archive-safety reading, both of which proved sound.

### Differences between RepoWise and live source

Two divergences were found and resolved in favour of live source.

1. **`get_dead_code()` reported zero findings at ≥0.7 confidence, yet an entire
   subsystem is unreachable from production code.** `acquireAdmission` /
   `releaseAdmission` are referenced only by their own module and by
   `tests/integration/admission-control.integration.test.ts`. Because test files
   reference them, reachability analysis counts them as live. Live tracing found
   what the index-based sweep missed. This is the origin of REV-001 and is a
   caution against treating dead-code output as exhaustive.

2. **`untested_hotspot` does not mean untested.** The biomarker fires on the
   absence of a *paired* test file. `services/api/src/asset-service.ts` is
   flagged untested but is exercised by six test files
   (`tests/unit/asset-archive-service.test.ts`,
   `tests/unit/import-service.test.ts`, `tests/unit/legacy-import.test.ts`, and
   three integration suites). This repository validates through central suites,
   not paired files. Per the charter, no finding was raised from this signal.

No stale-index or tombstone conditions occurred. **No finding in this report
rests on RepoWise output**; every finding below was proved against live source
or executed commands.

---

## 4. Recovered System Summary

**Purpose (Documented).** A self-hosted platform for authoring reusable,
versioned story worlds and running persistent AI-assisted campaigns, with
PostgreSQL holding authoritative state independently of any browser session or
model context window.

**Actors (Observed).** A single implicit owner (`initial-owner`); the browser
client; a background worker; external text/embedding/illustration providers;
PostgreSQL 18 with pgvector; a container orchestrator.

**Major workflows (Observed).** Turn generation (enqueue → worker claim →
provider call → validate → commit, streamed to the client over SSE); world
authoring and immutable publication; campaign creation, rewind, branch, and
world transfer; import/export of worlds, legacy stories, and campaign archives;
Chronicle memory indexing and optional embeddings; illustration and world-cover
generation.

**Major components.** API service layer (~29 modules), worker loop, runtime
composition, shared Zod contracts, domain rules, story engine, database
lifecycle, security package, browser client.

**Data stores.** PostgreSQL (50 ordered migrations) plus a filesystem asset store
and archive store, both mounted as named volumes.

**External integrations.** Model providers reached through a transport
constrained by a network allowlist; Sogni has both an HTTP and an SDK
implementation; OpenRouter image-model discovery with unit pricing.

**Security boundaries.** Browser→API (origin policy, CSP, body limits, Zod
validation); API→DB (parameterized queries, owner scoping); API→providers (SSRF
allowlist); archive extraction (path containment); secrets (env or `_FILE`,
gitignored).

**Operational model.** One container image, role-selected by `APP_ROLE`
(`all|api|worker|migrate`); Compose for local, Swarm for split replicas;
readiness gated on database plus pgvector.

**Confidence.** Documented and Observed for the above. Product *intent* behind
any of it remains **Unknown** — no stakeholder input was available.

---

## 5. As-Built Behavior Matrix

| Area or Workflow | Current Behavior | Evidence Classification | Evidence | Confidence | Unknowns |
| --- | --- | --- | --- | --- | --- |
| Authentication | None; every request resolves to `initial-owner`; `GET /api/v1/session` returns `authentication: "deferred"` | Documented + Observed | `README.md:122`; `user-service.ts:6-23`; `server.ts:292-295` | Confirmed | Is auth a committed requirement? |
| Authorization | Constant owner id applied as a SQL predicate, including inside joins | Observed | `server.ts:602-614`; migrations 0002, 0019 | Confirmed | Is multi-tenancy intended? |
| Rate limiting / concurrency | **Not enforced anywhere.** Module, schema, and config exist; no caller | Observed (contradicts Documented design) | grep `acquireAdmission`; `config.ts:196-201`; spec lines 283/311/382 | Confirmed | Deferred deliberately, or forgotten? |
| Cross-origin policy | Exact-origin allowlist; loopback same-origin permitted; missing `Origin` allowed | Observed | `exact-origins.ts:29-50` | Confirmed | Is allowing absent `Origin` intended? |
| CSP | `default-src 'none'`, no `unsafe-inline`/`unsafe-eval` | Observed | `content-security-policy.ts` | Confirmed | — |
| Untrusted input | Zod validation on every reviewed body/query/param; UUID parsing on path ids | Observed | `server.ts` throughout | High | — |
| Archive extraction | Traversal blocked by normalization + `realpath` containment + duplicate detection | Observed | `archive-io.ts:187-209,276-360,537-556` | High | — |
| Credential storage | AES-256-GCM, per-record nonce, auth tag, key version; key = unsalted `sha256(secret)` | Observed | `credentials.ts:10-35` | Confirmed | Acceptable KDF for the threat model? |
| Job claiming | `FOR UPDATE SKIP LOCKED` + lease expiry re-claim | Observed | `generation-service.ts::claimGeneration` | Confirmed | — |
| Generation streaming | SSE polls DB every 350 ms, unbounded duration, no stream cap | Observed | `server.ts:744-782` | Confirmed | Intended max stream lifetime? |
| Error exposure | Central handler hides ≥500 messages; SSE path does not | Observed | `server.ts:182-226` vs `776` | Confirmed | — |
| Import progress | In-memory map, never pruned, key is user-supplied | Observed | `infinite-worlds-import-service.ts:52,467,470-533` | Confirmed | Intended retention? |
| Body / archive limits | Import default 2 GiB; campaign archive 20 GiB uncompressed | Observed + Historically supported | `config.ts:178-187,194`; commit `eee172b` | Confirmed | Intended for untrusted networks? |
| Readiness | Requires DB reachable *and* pgvector present | Observed | `server.ts:273-286` | Confirmed | — |
| Legacy root client | `index.html` retained but CI-blocked from being served | Documented + Observed | `README.md:118`; `check-repository-boundaries.mjs` | Confirmed | — |
| Observability | Structured Pino logs + correlation ids; no metrics or tracing exporter | Observed | `logger/src/index.ts`; `server.ts:203-204` | High | Are metrics required? |

---

## 6. Architecture and Trust-Boundary Assessment

### Strengths (evidence-backed, not stylistic)

- **Enforced architectural rules.** `scripts/check-repository-boundaries.mjs`
  runs in CI and mechanically prevents the historical root `index.html` from
  being loaded or served, restricts legacy-compatibility code to an explicit
  allowlist, and bans stray `console.*` writes in shipped code. Architectural
  intent is executable, not aspirational — genuinely uncommon.
- **Clean role separation.** One image, four roles, with `lifecycle.ts`
  guaranteeing transport-then-pool teardown even on failure.
- **Correct durable-work patterns.** Lease-based claiming with `SKIP LOCKED`,
  idempotent enqueue signalled by a `duplicate` flag and distinct status codes,
  graceful worker drain on shutdown.
- **Defense in depth at the archive boundary**, the most dangerous untrusted-input
  surface here, including `realpath` checks that defeat symlink indirection.
- **Deliberate secret hygiene.** `_FILE` indirection, `.env*` gitignored except
  examples, a CI step (`pnpm check:data`) that rejects committed story exports
  and sensitive data. A scan of tracked files found no embedded credentials.

### Risks

- **Documented-vs-shipped drift at the security boundary** (REV-001). The most
  consequential architectural risk found: a design record and its acceptance
  criteria describe a control that does not execute. Configuration that is
  accepted and ignored is worse than configuration that is absent, because it
  creates false assurance.
- **Centrality concentration.** `server.ts` registers essentially the entire
  route surface in one 1 009-line function; `generation-service.ts` carries max
  CCN 146 across 2 263 lines. Neither is a defect, but both raise the cost and
  risk of every future change. Recorded as a lead, not a finding.
- **Knowledge silo.** Bus factor 1 on 226 files with 54.3% single-owner
  concentration. An operational risk, not a code defect.
- **Unbounded streaming path** (REV-004) is the one place where the otherwise
  careful resource-bounding discipline lapses.

### Trust boundaries and single points of failure

PostgreSQL is a hard single point of failure — correctly reflected in the
readiness probe, which fails closed. The provider transport is a shared
outbound boundary governed by the allowlist. The asset and archive filesystem
roots are process-local state; in Swarm they must be shared storage, which the
stack manifest should be confirmed to provide (not verified — see §15).

### Architectural drift

The admission-control subsystem is drift made visible: schema, module, config,
and tests landed; the enforcement layer never did.
`git log -S acquireAdmission -- services/api/src/server.ts` returns no commits,
confirming it was never wired at any point — an incomplete implementation
rather than a regression.

---

## 7. Findings

### Critical

**None.**

No finding met the Critical bar. No reachable remote code execution, broad
compromise, irrecoverable data loss, or unmitigated system-wide outage was
identified.

---

### High

#### REV-001 — Documented P0 admission control is fully built but never enforced

| Field | Value |
| --- | --- |
| **Severity** | High |
| **Confidence** | Confirmed |
| **Category** | Security / Compatibility (configuration accepted but ignored) |
| **Location** | `services/api/src/admission-service.ts` (whole module); `packages/database/src/config.ts:196-201`; `database/migrations/0044_api_admission_control.sql`; absent from `services/api/src/server.ts:198-1005` |

**Issue.** The repository's P0 network-security design requires PostgreSQL-backed
rate and concurrency admission on expensive routes, returning
`429 REQUEST_LIMIT_EXCEEDED` with `Retry-After`. The subsystem is implemented,
migrated, configured, and integration-tested — but is never invoked by any route
or service. Six environment settings are validated at startup and then ignored.

**Evidence.**
- Documented requirement: `docs/superpowers/specs/2026-07-23-p0-network-security-design.md`
  — line 30 ("PostgreSQL-backed rate and concurrency admission control"),
  lines 53-54 ("Route request policy assigns explicit body-size and admission
  policies to sensitive routes"), line 283 ("return `429 REQUEST_LIMIT_EXCEEDED`
  with `Retry-After`"), line 311, line 344, line 382 ("Multiple API replicas
  enforce one PostgreSQL-backed rate/concurrency limit").
- `git grep acquireAdmission\|releaseAdmission` → matches only in
  `services/api/src/admission-service.ts` and
  `tests/integration/admission-control.integration.test.ts`. No production caller.
- `git grep REQUEST_LIMIT_EXCEEDED` → **no matches anywhere in the repository**,
  including tests.
- `git grep -E "code\(429\)|statusCode\s*=\s*429|status:\s*429" -- services packages`
  → no matches.
- `retryAfterSeconds` is computed in `admission-service.ts:63-65` and returned in
  `AdmissionDecision`, but no code path converts it into a `Retry-After` header.
- `config.ts:196-201` parses all six settings; each appears in exactly one
  source file (its own definition) and five test files.
- `database/migrations/0044_api_admission_control.sql` creates
  `api_admission_buckets` and `api_admission_leases` — tables that are written
  only by tests.
- `git log -S "acquireAdmission" -- services/api/src/server.ts` → no commits.

**Evidence classification.** Documented (the requirement) contradicted by
Observed (the shipped code). Historically supported: commit `bb7e067` added the
module without the call sites.

**Failure scenario.** An operator deploys with
`API_RATE_LIMIT_GENERATION_REQUESTS=12` and `API_CONCURRENCY_IMPORT_REQUESTS=1`,
reasonably believing expensive operations are capped. A script — or a runaway
browser tab, or a retry loop in the client — issues 10 000 requests to
`POST /api/v1/campaigns/:id/generations` and `POST /api/v1/imports/infinite-worlds`.
Every one is accepted. Each generation triggers a paid model-provider call; each
import may carry a 2 GiB body (`config.ts:194`) and expand to 20 GiB
(`config.ts:178-182`). Result: uncapped provider spend, database connection
exhaustion (pool max 12), asset-volume exhaustion, and API unavailability. No
`429` is ever returned and no limit is recorded, so the cause is not visible in
logs as a limit event.

**Blast radius.** Every expensive route — generation, provider text, world
generation, all three import families, illustration and cover generation. Affects
the API and worker processes, the database, the asset/archive volumes, external
provider billing, and every user of the deployment. In a multi-replica Swarm
deployment the documented cross-replica limit does not exist at all.

**Mitigating context (why High, not Critical).** `README.md:13,122` documents a
trusted-network, pre-authentication deployment, so the expected attacker
population is small or absent. The realistic trigger is accident or runaway
client, not hostile traffic. This bounds likelihood but not impact, and it does
not reconcile the shipped system with its own design record.

**Recommended correction (smallest reasonable).** Choose one and make the
repository self-consistent:

- **(a) Enforce.** Add a Fastify `preHandler` on the route groups the design
  names, calling `acquireAdmission` with the policy built from
  `config.security`, releasing the lease in an `onResponse`/`onError` hook, and
  mapping `allowed: false` to `429 REQUEST_LIMIT_EXCEEDED` with `Retry-After:
  retryAfterSeconds`. The service already returns exactly the values this needs.
- **(b) Retire explicitly.** If admission is deliberately deferred, remove the
  six settings from `config.ts`, mark migration `0044` and the module as
  dormant, and amend the design record to record the deferral — so no operator
  can set a limit that does nothing.

Option (a) is recommended: the hard part is already written and tested.

**Validation.** Add an integration test asserting that the
`(maxRequests + 1)`-th request to a protected route returns `429`,
`code === "REQUEST_LIMIT_EXCEEDED"`, and a `Retry-After` header; and that a
second concurrent import is rejected while one lease is held. Assert that
`api_admission_buckets` is written during an HTTP test, not only a direct unit
call. The existing `tests/integration/admission-control.integration.test.ts`
covers the service in isolation and should be extended to the HTTP layer — its
current passing state is precisely why this gap went unnoticed.

**RepoWise role.** Discovery only, and by inversion: `get_dead_code()` reported
**no** dead code at ≥0.7 confidence because integration tests reference the
module. The finding came from live call-graph tracing and exhaustive grep, then
was corroborated against the design record and Git history. RepoWise is not
evidence for this finding.

---

### Medium

#### REV-002 — `pnpm test:unit` collects tests from gitignored worktrees, producing false failures

| Field | Value |
| --- | --- |
| **Severity** | Medium |
| **Confidence** | Confirmed |
| **Category** | Testing |
| **Location** | `package.json:19` (`"test:unit": "vitest run tests/unit"`); no root `vitest.config.ts`; contrast `vitest.integration.config.ts:5` |

**Issue.** There is no root Vitest configuration, so `vitest run tests/unit`
does not scope collection to that directory — the argument is a *substring
filter* applied to Vitest's default `**/*.test.ts` glob. Vitest's default
excludes cover `node_modules` and `dist` but not `.worktrees/`. Any local Git
worktree therefore contributes its own copy of the suite.

**Evidence (executed).**
- `pnpm test:unit` → `Test Files 6 failed | 317 passed (323)`,
  `Tests 8 failed | 3766 passed | 12 skipped`, duration 41.82 s.
- Every failure path reported was
  `.worktrees/portable-archives/tests/unit/story-player-ui.test.ts`.
- `ls tests/unit/*.test.ts | wc -l` → **56**.
- `find .worktrees -name '*.test.ts' -path '*tests/unit*' | wc -l` → **267**.
- 56 + 267 = **323**, exactly the collected count.
- `npx vitest run --dir tests/unit` (correctly scoped) →
  **`Test Files 56 passed (56)`, `Tests 664 passed | 2 skipped (666)`, 3.99 s.**
- `ls .worktrees/` → five checkouts: `feature-cancel-turn-generation`,
  `fix-rewind-chronicle-projections`, `fix-rewind-streaming-images`,
  `portable-archives`, `turn-generation-diagnostics`.
- `.gitignore` contains `/.worktrees/`, so these are not part of the revision.
- `vitest.integration.config.ts:5` correctly uses
  `include: ["tests/integration/**/*.test.ts"]` — the sibling configuration does
  this right, making the inconsistency internal to the repository.

**Evidence classification.** Observed, by direct execution.

**Failure scenario.** A developer using worktrees — a workflow this repository
clearly encourages, given five exist — runs `pnpm test`, sees 8 failures in
`story-player-ui.test.ts`, and either debugs code that is not broken at `HEAD`
or, worse, learns to dismiss red output. Conversely a genuine regression at
`HEAD` can be masked among hundreds of foreign results. The run also takes ~10×
longer (41.8 s vs 4.0 s). CI is unaffected because it checks out a clean tree,
which is exactly why this has persisted unnoticed.

**Blast radius.** Every local developer and agent validation run; the
reliability of pre-commit signal. No production impact.

**Recommended correction.** Add a root `vitest.config.ts` mirroring the
integration config's discipline:

```ts
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.worktrees/**"]
  }
});
```

**Validation.** With a worktree present, `pnpm test:unit` must report exactly
56 files and 0 failures. Add an assertion to the existing
`tests/unit/ci-workflow.test.ts` (which already validates repository tooling)
that the resolved unit include pattern is anchored to `tests/unit/`.

**RepoWise role.** None. Found by executing the documented test command and
reading the output paths.

---

#### REV-003 — Credential encryption key is derived by unsalted SHA-256 with no strength validation

| Field | Value |
| --- | --- |
| **Severity** | Medium |
| **Confidence** | Confirmed |
| **Category** | Security |
| **Location** | `packages/story-engine/src/credentials.ts:10-13`; `packages/database/src/config.ts:55-61, 188` |

**Issue.** `CREDENTIAL_ENCRYPTION_KEY` is converted to an AES-256 key by a
single unsalted SHA-256 pass, with no key-derivation function and no minimum
length or entropy validation. The AES-256-GCM usage itself is correct; the
weakness is entirely in key derivation and input validation.

**Evidence.**
- `credentials.ts:12` — `return createHash("sha256").update(secret, "utf8").digest();`
  No salt, no iteration count, no PBKDF2/scrypt/Argon2.
- `credentials.ts:11` — the only validation is `if (!secret.trim())`. A
  one-character key is accepted.
- `config.ts:188` — `credentialEncryptionKey: secretSetting("CREDENTIAL_ENCRYPTION_KEY")`;
  `secretSetting` (lines 55-61) only trims and supports `_FILE` indirection. No
  length or entropy check, in contrast to the same file's rigorous bounded
  integer validators (lines 63-113).
- `compose.yaml` passes `CREDENTIAL_ENCRYPTION_KEY: ${CREDENTIAL_ENCRYPTION_KEY:-}`
  — an **empty default**, so a misconfigured deployment starts and fails later
  at first credential use with a 503, rather than refusing to start.
- `compose.test.yaml` ships the literal default
  `testkey12345678901234567890123456`.
- Mitigation is documentation-only: `README.md:42` asks for "a long random
  `CREDENTIAL_ENCRYPTION_KEY`" — operator discipline, unenforced.

**Evidence classification.** Observed; the documented mitigation is Documented
but advisory.

**Failure scenario.** An operator sets `CREDENTIAL_ENCRYPTION_KEY=infinitequest`
because nothing objects. Every provider API key — text, embedding, and
illustration, all real billable credentials — is encrypted under
`sha256("infinitequest")`. An attacker who obtains a database dump (backup on a
NAS, snapshot, stolen volume) brute-forces the passphrase offline at billions of
guesses per second, since a single SHA-256 is exactly what commodity cracking
hardware is optimized for. A proper KDF would make the same dump economically
impractical to attack. Note the encrypted credentials are the highest-value data
in the system: they authorize spending real money.

**Blast radius.** All stored provider credentials for all profiles; any
deployment whose database or backup is exposed.

**Recommended correction.** Two small, independent changes:
1. Replace the derivation with `scrypt` (already in `node:crypto`) over a
   per-deployment salt, and bump `keyVersion` to 2. `decryptCredential` already
   dispatches on `keyVersion` (line 28), so version 1 records can still be read
   and re-encrypted on next write — the migration path is already designed in.
2. Validate at startup in `config.ts`: require a minimum length (e.g. 32 chars)
   and reject the known placeholder values, so misconfiguration fails fast
   rather than silently weakening every record.

**Validation.** Unit tests: a short or placeholder key is rejected by
`loadRuntimeConfig`; a `keyVersion: 1` record still decrypts after the change;
a value encrypted at version 2 round-trips; two deployments with the same
passphrase and different salts produce different ciphertext.

**RepoWise role.** None. Found by reading the security-sensitive module directly.

---

#### REV-004 — SSE generation stream polls the database indefinitely with no timeout or stream cap

| Field | Value |
| --- | --- |
| **Severity** | Medium |
| **Confidence** | Confirmed |
| **Category** | Performance / Concurrency |
| **Location** | `services/api/src/server.ts:724-794` (loop at 744-782) |

**Issue.** `GET /api/v1/generation-jobs/:jobId/stream` runs
`while (!isClosed)`, calling `getGenerationJob(pool, jobId)` and sleeping 350 ms.
There is no maximum stream duration, no cap on concurrent streams, no
server-side idle timeout, and no admission gate (REV-001 means none exists).
Termination depends solely on the job reaching a terminal status or the client
closing the socket.

**Evidence.**
- `server.ts:744` — `while (!isClosed) {` with the only breaks being terminal
  status (762-765), an error (779), or client close.
- `server.ts:781` — `await new Promise((resolve) => setTimeout(resolve, 350));`
- `server.ts:746` — a database round trip every iteration ⇒ ~2.86 queries/sec
  per open stream.
- `isClosed` is set only by `request.raw.on("close", …)` (line 730). A
  half-open TCP connection — a laptop sleeping, a dropped VPN, a proxy that
  fails to propagate close — does not fire it.
- Pool ceiling is `DATABASE_MAX_CONNECTIONS`, defaulting to 12 for the API role
  (`config.ts:166`).
- The route is registered with no `bodyLimit`, no timeout option, and no
  admission policy.

**Evidence classification.** Observed.

**Failure scenario.** A job enters a non-terminal status and stays there — for
example `recoverable` handling that never advances, or a worker that dies
between claim and lease expiry while the client is already streaming. The client
tab is left open overnight. The loop issues ~247 000 queries in 24 hours from a
single forgotten tab. Twenty such streams sustain ~57 queries/sec purely for
polling and can occupy the entire 12-connection pool during contention,
starving normal API traffic. Because there is no admission control, nothing
caps how many streams may be opened.

**Blast radius.** API process, database connection pool, and consequently every
route sharing that pool. Degrades gradually rather than failing loudly.

**Recommended correction.** Bound the loop: add a maximum stream lifetime (e.g.
15 minutes) after which the server sends a terminal frame and calls
`reply.raw.end()`, and add a periodic SSE comment heartbeat (`: ping\n\n`) so
that write failures on half-open sockets surface and set `isClosed`. If REV-001
is resolved via option (a), also apply a concurrency policy to this route. A
backoff — 350 ms while a job is actively progressing, widening to a few seconds
once it is idle — would cut steady-state query volume substantially at no cost
to perceived latency.

**Validation.** Integration test: open a stream against a job pinned in a
non-terminal status, assert the connection is closed by the server within the
configured maximum and that query count is bounded. Test that a heartbeat write
failure terminates the loop.

**RepoWise role.** None for the finding. RepoWise's performance dimension flagged
64 I/O-in-loop / N+1 candidates, but they were concentrated in tests, scripts,
and migration helpers; this route was not among them. Found by reading the
route.

---

### Low

#### REV-005 — SSE error frames leak raw internal error messages, bypassing central sanitization

| Field | Value |
| --- | --- |
| **Severity** | Low |
| **Confidence** | Confirmed |
| **Category** | Security / Error handling |
| **Location** | `services/api/src/server.ts:776` vs. the central handler at `182-184, 207-226` |

**Issue.** The application's central error handler deliberately withholds
messages for status ≥ 500 unless the error opts in via `expose === true`, and
strips `path`/`rawPayload` keys through `safeErrorDetails`. The SSE stream
bypasses all of it and writes the raw message to the client.

**Evidence.**
- `server.ts:182-184` — `exposeError` returns true only when `code < 500` or
  `expose === true`.
- `server.ts:217-218` — non-exposed errors yield `"Internal server error"` and a
  correlation-id-only message.
- `server.ts:776` — `reply.raw.write(\`data: ${JSON.stringify({ status: "failed", errorMessage: error instanceof Error ? error.message : String(error) })}\n\n\`)`
  — no `exposeError` check, no `safeErrorDetails`.
- The adjacent `logger.warn` at 769-774 is careful (`safeLogErrorCode`,
  `errorName` only), which shows the sanitizing intent the write does not follow.

**Evidence classification.** Observed; a direct internal contradiction between
two components' handling of the same class of error.

**Failure scenario.** `getGenerationJob` throws a `pg` error while a stream is
open. The browser receives the raw driver message, which can include SQL
fragments, column names, constraint names, or connection details — precisely the
information the central handler exists to withhold. Impact is bounded because
the deployment is documented as a trusted network with no authentication, so
there is no privilege boundary being crossed; this is an inconsistency with the
system's own stated error-handling policy rather than an exploitable disclosure.

**Blast radius.** Any client with an open generation stream.

**Recommended correction.** Route the SSE error path through the same predicate:
send `error.message` only when `exposeError(error, statusCode(error))` is true,
otherwise emit a generic message plus `correlationId: request.id` — which the
handler already returns and which is the intended diagnostic channel.

**Validation.** Unit or integration test asserting that a non-exposed error
produces an SSE frame containing the correlation id and **not** the raw message,
while an `expose: true` error still surfaces its message.

**RepoWise role.** None.

---

#### REV-006 — In-memory import progress map is never pruned

| Field | Value |
| --- | --- |
| **Severity** | Low |
| **Confidence** | Confirmed |
| **Category** | Performance / Data integrity |
| **Location** | `services/api/src/infinite-worlds-import-service.ts:52, 467, 470-533`; exposed via `services/api/src/server.ts:380-385` |

**Issue.** `activeProgressMap` is a module-level `Map` written at five points
during import and read by the progress route, but **never** deleted or expired
in production code. The only `delete` in the repository is in a test.

**Evidence.**
- `infinite-worlds-import-service.ts:52` —
  `export const activeProgressMap = new Map<string, ImportProgressReport>();`
- Writes at lines 470, 491, 505, 512, 530; read at 55.
- Repository-wide search for `activeProgressMap.delete|clear` matches only
  `tests/integration/world-generation.integration.test.ts:237` (and its copies
  inside `.worktrees/`). **No production cleanup exists.**
- Key construction, line 467:
  `const progressKey = request.sourceName + ":" + request.sourceText.length;`
  — derived from client-supplied values.
- `server.ts:380-385` returns the record to anyone supplying the key.

**Evidence classification.** Observed.

**Failure scenario.** Two concrete consequences. (1) Memory: every distinct
`sourceName:length` pair retains a progress record for the lifetime of the API
process. Growth is slow — records are small and repeated imports of the same
source reuse their key — but it is strictly monotonic, so a long-lived process
performing many distinct imports never reclaims the memory. (2) Staleness: a
terminal record persists indefinitely, so a client polling
`/api/v1/imports/progress?key=…` immediately after starting a *new* import of a
source with the same name and length can read the previous run's completed
state during the window before line 470 overwrites it, and can read a stale
`completed` result long after the fact.

**Blast radius.** The API process only; no persisted data is affected. Bounded
by process restarts.

**Recommended correction.** Delete the entry on terminal status after a short
grace period (e.g. 60 s), or store `expiresAt` on the record and sweep lazily on
read — mirroring the pattern `server.ts:405-408` already uses for expired
world-generation progress. Consider keying on a server-generated id rather than
client-supplied name and length, which would also remove the collision window.

**Validation.** Unit test asserting the map returns to its prior size after a
completed import plus grace period, and that a stale terminal record is not
returned for a newly started import.

**RepoWise role.** None.

---

#### REV-007 — Admission control discards the cause of every failure without logging

| Field | Value |
| --- | --- |
| **Severity** | Low |
| **Confidence** | Confirmed |
| **Category** | Error handling / Observability |
| **Location** | `services/api/src/admission-service.ts:198-206` |

**Issue.** `acquireAdmission` wraps its entire body in a bare `catch {}` that
discards the caught error and throws `AdmissionControlUnavailableError`. Nothing
is logged. This also swallows the module's own internal invariant violation —
the `throw new Error("Admission lease creation returned no identifier.")` at
line 185 — converting a genuine bug into an indistinguishable "temporarily
unavailable" 503.

**Evidence.**
- `admission-service.ts:198` — `} catch {` with no binding.
- Lines 199-205 — rollback attempt inside a nested bare `catch`; the comment at
  203 states the error hiding is intentional for *client-facing* safety.
- Line 206 — `throw new AdmissionControlUnavailableError();` — no logger call
  anywhere in the module (it imports no logger).
- Line 185 — the internal invariant `throw` is inside the same `try`.

**Evidence classification.** Observed. Note the design record
(`…p0-network-security-design.md:290`) requires failing closed with
`503 ADMISSION_CONTROL_UNAVAILABLE` — the *client-facing* behavior is correct
and intended; the gap is the absent server-side diagnostic.

**Failure scenario.** Once REV-001 is fixed and this module is on the request
path, a persistent failure — a missing migration, a permissions error on
`api_admission_leases`, or the line-185 invariant — presents to operators only
as blanket 503s on expensive routes, with no log line naming the cause. The
documented recovery path ("use the correlation ID to locate server diagnostics")
yields nothing, because no diagnostic was written.

**Blast radius.** Operational diagnosis of every protected route, once
enforcement is enabled. Currently latent, since the module never executes.

**Recommended correction.** Bind the error (`catch (error)`), log it at `error`
level with the operation key and owner id before throwing the safe typed error.
Keep the client-facing message exactly as it is. Separately, let the line-185
invariant escape as a distinct error rather than being masked as "unavailable".

**Validation.** Extend the existing
`tests/integration/admission-control.integration.test.ts` case "fails closed
with a safe typed error when admission storage is unavailable" to also assert a
diagnostic log entry is emitted.

**RepoWise role.** None.

---

#### REV-008 — Test-database provisioner fails opaquely for 150 s when volume and credentials diverge

| Field | Value |
| --- | --- |
| **Severity** | Low |
| **Confidence** | Confirmed |
| **Category** | Testing / Observability |
| **Location** | `scripts/ensure-test-database.mjs:59-63, 104-120, 148` |

**Issue.** The provisioner reuses the password stored in `.env.test.local` and a
persistent named Docker volume. PostgreSQL applies `POSTGRES_PASSWORD` only when
initializing an empty data directory. If the two ever diverge, every subsequent
run retries for 150 seconds and then fails with a message that does not mention
the documented recovery procedure.

**Evidence (executed).**
- `pnpm test:integration` →
  `Error: The local PostgreSQL test database did not become ready within 150 seconds: password authentication failed for user "infinitequest_test"`.
- The container was healthy at the time
  (`docker ps` → `infinitequest-integration-postgres  Up 55 seconds (healthy)`),
  so `pg_isready` passed while authentication failed — the healthcheck cannot
  detect this state.
- `docker volume ls` → `infinitequest-test_infinitequest-integration-postgres-data`
  persists across runs, as documented.
- `ensure-test-database.mjs:59` — `const password = values.POSTGRES_PASSWORD || generatePassword();`
  reuses whatever the file holds.
- `ensure-test-database.mjs:117-119` — the thrown message reports only the raw
  connection error.
- `docs/contributing/integration-test-database.md` **does** document the exact
  three-command reset, and `README.md:102` links to it.

**Evidence classification.** Observed. The recovery procedure is Documented; the
gap is that the error does not point to it.

**Failure scenario.** A developer whose `.env.test.local` was regenerated,
restored from a different machine, or created after the volume, waits 2.5
minutes to receive an authentication error that reads like a code fault. The
documented fix exists but is not surfaced at the point of failure. The
documentation asserts that a Docker problem produces "an actionable startup
error" — true for a stopped engine, not for this case.

**Blast radius.** Developer and CI-local onboarding only. CI is unaffected: it
starts from a clean runner with no pre-existing volume.

**Recommended correction.** Detect authentication failure specifically (the `pg`
error code for invalid password) and fail fast — without consuming all 120
attempts — with a message naming the volume and quoting the documented reset
commands. Optionally abort early when the container is healthy but authentication
is rejected, since further retries cannot succeed.

**Validation.** Unit test against `connectWhenReady` with an injected client
that raises an authentication error, asserting an early exit and that the
message references the reset procedure. `tests/unit/ensure-test-database.test.ts`
already exercises this module with injected dependencies.

**RepoWise role.** None. Encountered while executing the documented test command.

---

## 8. Human Decisions and Requirement Unknowns

| Decision or Unknown | Why It Matters | Evidence Reviewed | Options | Risk of Wrong Choice | Recommended Default |
| --- | --- | --- | --- | --- | --- |
| Is admission control still a requirement? | Determines whether REV-001 is "finish the feature" or "delete dead code". Six settings currently promise a control that does not exist. | P0 design spec lines 30/53-54/283/311/382; `admission-service.ts`; migration 0044; commit `bb7e067` | (a) Wire it into expensive routes; (b) remove config + mark dormant and amend the design record | Leaving it as-is preserves false assurance — an operator sets a limit and is silently unprotected | **(a) Enforce.** The implementation and its tests already exist; only the call sites are missing |
| Are 2 GiB import / 20 GiB uncompressed archive defaults intended? | Combined with no rate limiting, a single request can exhaust disk and memory | `config.ts:178-187,194`; commit `eee172b` "Raise campaign archive import limit" | Keep for trusted single-operator use; lower defaults and document raising them; make them deployment-profile dependent | Too low breaks a deliberate recent change; too high plus REV-001 enables accidental self-DoS | Keep the ceiling, but resolve REV-001 first — engineering evidence does not settle the product question |
| Is interactive authentication committed? | Determines whether `owner_user_id` scoping is forward-looking design or permanent dead weight, and whether CSRF/session concerns ever become live | `README.md:122`; `user-service.ts`; `authentication: "deferred"` at `server.ts:294`; migrations 0002/0019 | Keep pre-auth and document it as terminal; implement auth; implement full multi-tenancy | Building features assuming a future identity model that never arrives, or vice versa | None — this is a product decision. The schema already supports either path at no extra cost |
| Should a request with **no** `Origin` header be allowed? | Currently permitted for state-changing methods (`exact-origins.ts:34`) | `exact-origins.ts:29-50`; CSP `form-action 'self'` | Keep (browsers send `Origin` on cross-origin writes, so CSRF is still blocked); require `Origin` on unsafe methods | Requiring it may break non-browser clients and health tooling | **Keep.** The current behavior is defensible; document the reasoning so it is not "fixed" by mistake |
| Are metrics/tracing required? | No exporter exists; diagnosis relies on logs plus correlation ids | `logger/src/index.ts`; `server.ts:203-204`; health routes | Add Prometheus/OTel; rely on logs | Operating a multi-replica Swarm deployment without metrics makes saturation hard to detect — especially given REV-004 | Defer until REV-001/REV-004 are resolved; revisit before any untrusted-network deployment |
| Is the `.worktrees` test contamination known and accepted? | Determines whether REV-002 is a bug or a tolerated local quirk | `package.json:19`; absent root Vitest config; five live worktrees | Fix the include scope; accept and document | Accepting it means continuing to run 267 foreign test files and distrusting local red output | **Fix.** The sibling integration config already demonstrates the correct pattern |
| Should duplicate user-profile alias routes be retained? | Four routes serve one operation (`/users/me/profile` and `/user/profile` × `PATCH`/`PUT`) | `server.ts:300-311` | Keep for client compatibility; deprecate and consolidate | Removing may break an unknown client; keeping grows the surface | Keep until client usage is confirmed; this is a compatibility question, not a defect |

---

## 9. Test and Validation Results

| Command | Working Directory | Result | Relevant Output | Interpretation |
| --- | --- | --- | --- | --- |
| `git rev-parse HEAD` | repo root | Pass | `58d0aa2f9374…` | Reviewed revision fixed |
| `git status --short` | repo root | Pass | `M AGENTS.md`, `?? docs/prompts/` | No application code differs from `HEAD` |
| `pnpm check` | repo root | **Pass (exit 0)** | boundaries + `check:data` + `tsc --noEmit` + `node --check` on both browser bundles | Type-clean; architectural boundary rules satisfied at `HEAD` |
| `pnpm test:unit` | repo root | **Fail (exit 1)** | `6 failed \| 317 passed (323)`; `8 failed \| 3766 passed \| 12 skipped`; 41.82 s | **Not a code failure.** All failures came from `.worktrees/portable-archives/…`. See REV-002 |
| `npx vitest run --dir tests/unit` | repo root | **Pass** | `56 passed (56)`; `664 passed \| 2 skipped (666)`; 3.99 s | **Authoritative unit result for the reviewed revision: clean** |
| `pnpm test:integration` | repo root | **Blocked (exit 1)** | `password authentication failed for user "infinitequest_test"` after 150 s | Environmental; persistent volume predates current `.env.test.local`. See REV-008 |
| `ls tests/unit/*.test.ts \| wc -l` | repo root | Pass | `56` | Baseline for REV-002 |
| `find .worktrees -name '*.test.ts' -path '*tests/unit*' \| wc -l` | repo root | Pass | `267` | 56 + 267 = 323 collected — proves REV-002 |
| `git grep acquireAdmission` | repo root | Pass | module + one integration test only | Proves REV-001 |
| `git grep REQUEST_LIMIT_EXCEEDED` | repo root | Pass | **no matches** | Proves REV-001 |
| `git log -S acquireAdmission -- services/api/src/server.ts` | repo root | Pass | no commits | Never wired at any point in history |
| `docker ps -a --filter name=infinitequest-integration-postgres` | repo root | Pass | `Up 55 seconds (healthy)` | Healthy container with failing auth — REV-008 |
| Secret scan over tracked files | repo root | Pass | no matches | No embedded credentials found in tracked files |

**Commands not run, and why.**

- `pnpm build` — not run. `pnpm check` already performs full `tsc` type
  checking with `--noEmit`; a compile-only artifact build adds little review
  evidence and writes to `dist/`.
- `docker build` / `docker compose up` — not run. Building and starting the
  application stack is a state-changing operation beyond a read-only review;
  CI already runs both on every push.
- Integration database reset (`docker volume rm …`, `Remove-Item .env.test.local`) —
  **deliberately declined.** The procedure is documented and would likely have
  unblocked the suite, but it destroys a Docker volume and local credentials,
  which is outside a read-only mandate. This was the correct trade-off, and it
  is why the integration suite is reported as *not validated* rather than
  passing.
- `pnpm test:sogni-live` — not run. It calls a live external provider and needs
  real credentials.

**Environmental limitations.** Windows 11 host, Docker 29.4.3. Five local Git
worktrees exist under `.worktrees/`, which materially affected the default unit
test command (REV-002).

**Untested high-risk paths.** Multi-replica behavior; provider failure and
timeout handling under load; migration rollback; archive import at the
documented 2 GiB / 20 GiB ceilings; the SSE stream lifecycle described in
REV-004; and the entire browser client.

**Suspected pre-existing failures.** None at the reviewed revision. The 8 unit
failures observed belong to other revisions checked out in worktrees, and the
integration blocker is local environment state.

**Failures likely caused by current code.** None observed.

**Remaining uncertainty.** The integration suite — 20 files covering campaign
archives, transfers, gameplay, generation, migrations, image pipeline, world
library, and admission control — was not executed. CI runs it on every push and
`HEAD` is a merge commit of a passing PR, which is indirect evidence of health
but is **not** direct verification of this working tree.

---

## 10. Test and Validation Gaps

| # | Component / workflow | Missing validation | Failure behavior not covered | Risk | Recommended test | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| G-1 | Admission control at the HTTP layer | Integration test through a route | The subsystem passes its own tests while being entirely unreachable — the tests validate the unit, never the wiring | **This gap is why REV-001 survived.** A green suite masked a missing feature | Assert `429` + `REQUEST_LIMIT_EXCEEDED` + `Retry-After` on the `(n+1)`-th request to a protected route | High |
| G-2 | Unit-suite scoping | Assertion that collection is anchored to `tests/unit/` | Foreign test files silently join the run | Local signal untrustworthy; genuine regressions maskable | Extend `tests/unit/ci-workflow.test.ts` to assert the resolved include pattern | High |
| G-3 | SSE generation stream | Lifecycle/termination test | Non-terminal job, half-open socket, unbounded duration | Slow pool exhaustion (REV-004) | Pin a job in a non-terminal status; assert server-side close within the maximum | Medium |
| G-4 | Credential key strength | Startup validation test | Weak or placeholder key accepted silently | Weak encryption of billable credentials (REV-003) | Assert `loadRuntimeConfig` rejects short/placeholder keys; assert `keyVersion` 1→2 compatibility | Medium |
| G-5 | Browser client (`nexus.js`, `story.js`, 7 979 lines) | Behavioral coverage beyond DOM-string assertions | Current UI tests largely assert that source text contains expected substrings | Brittle; passes while behavior is broken. Observed directly in the failing worktree test, which asserted `storyScript).toContain(…)` | Behavior-level tests against a DOM (`linkedom` is already a dev dependency) | Medium |
| G-6 | Error-exposure policy | Test that `exposeError` governs *all* client-facing error paths | SSE bypasses it (REV-005) | Inconsistent disclosure policy | Assert non-exposed errors never reach a client on any channel | Low |
| G-7 | Multi-replica deployment | Any test of split API/worker roles | Startup ordering, shared asset volume, per-process cleanup timers | Swarm manifest is validated for syntax only (`docker stack config`) | Compose-based two-replica smoke test | Low |
| G-8 | Migration rollback | Down-migration / rollback test | 50 forward migrations; no rollback verification found | Unsafe or irreversible deploy | Apply-then-rollback test on the newest migrations | Low |

**These are gaps, not defects.** Per the charter, a missing test is not itself a
runtime fault. G-1 is the exception worth emphasizing: it is not merely absent
coverage but coverage shaped so that a complete feature could be missing while
its tests stayed green.

---

## 11. Coverage Report

| Component or Path | Coverage Level | Review Method | RepoWise Used | Source Verified | Limitations |
| --- | --- | --- | --- | --- | --- |
| `services/api/src/server.ts` | Reviewed in depth | Full read (1 009 lines) | Prioritization | Yes | Delegated service bodies not all followed |
| `services/api/src/admission-service.ts` | Reviewed in depth | Full read + call-graph + history | Inverse signal | Yes | — |
| `services/api/src/request-security.ts` | Reviewed in depth | Full read | No | Yes | — |
| `services/api/src/user-service.ts` | Reviewed in depth | Full read | No | Yes | — |
| `packages/security/src/{exact-origins,content-security-policy}.ts` | Reviewed in depth | Full read | No | Yes | `provider-network-policy.ts` interface-level only |
| `packages/database/src/config.ts` | Reviewed in depth | Full read + consumer trace | No | Yes | — |
| `packages/story-engine/src/credentials.ts` | Reviewed in depth | Full read | No | Yes | — |
| `services/worker/src/worker.ts`, `services/runtime/src/lifecycle.ts` | Reviewed in depth | Full read | No | Yes | Job bodies not traced |
| `scripts/ensure-test-database.mjs` | Reviewed in depth | Full read + execution | No | Yes | — |
| `Dockerfile`, `compose*.yaml`, `deploy/swarm/stack.yaml`, `.github/workflows/*` | Reviewed in depth | Full read | No | Yes | Swarm not deployed; shared-storage assumption unverified |
| `services/api/src/archive-io.ts` | Interface and dependency review | Targeted read of path-safety logic | Risk history | Yes | 1 585 lines; only traversal defenses examined |
| `services/api/src/generation-service.ts` | Interface and dependency review | `claimGeneration` + diagnostics | Risk history | Partial | **2 263 lines, max CCN 146 — largest unreviewed logic mass** |
| `services/api/src/infinite-worlds-import-service.ts` | Interface and dependency review | Progress store only | No | Partial | Import transform logic not reviewed |
| `scripts/check-repository-boundaries.mjs` | Sampled | Rule inspection | No | Yes | Rules read, not exhaustively tested |
| `tests/unit/**` (56 files) | Execution validated | Executed, scoped correctly | No | Yes | Individual assertion quality sampled only |
| `tests/integration/**` (20 files) | **Blocked** | Inventory + admission test read | No | Partial | **Not executed** — REV-008 |
| `database/migrations/**` (50 files) | Sampled | Listed, ordered, 0044 read | No | Partial | Not read line by line |
| `packages/domain/**`, most of `packages/contracts/**` | Interface and dependency review | Import graph from `server.ts` | Overview | Partial | Schema internals not audited |
| `services/api/src/{memory,image,world,asset,cost,dashboard,character-profile,…}-service.ts` | Not reviewed | — | Health scores only | No | ~6 000 lines of business logic |
| `apps/web/public/nexus.js` (5 077), `story.js` (2 902) | **Not reviewed** | — | Health scores only | No | **Largest and lowest-health area (health 1.0/10, 16 dependents)** |
| `apps/web/public/jszip.min.js` | Generated or vendored | Excluded | — | — | Third-party bundle |
| `docs/**` (174 files) | Sampled | README, P0 spec, test-DB guide, capabilities | No | Partial | Most not read |
| `.worktrees/**` | Excluded | — | — | — | Gitignored; not part of the revision |

**This review does not claim complete repository coverage.** The browser client
and the interiors of the largest API services — together the majority of
executable logic — were not reviewed in depth, and the integration suite did not
run.

---

## 12. Recommended Corrections

### Immediate

**1. Resolve REV-001 — admission control enforced or explicitly retired.**
- Related findings: REV-001 (and REV-007, which becomes live once enforcement is on).
- Expected benefit: the shipped system matches its own P0 design record;
  configuration stops promising protection it does not deliver; expensive routes
  and provider spend gain a ceiling.
- Dependencies: none — implementation, schema, and tests already exist.
- Risk of delay: uncapped provider cost and accidental self-DoS remain possible,
  and every day the ignored settings stay in `config.ts` increases the chance an
  operator relies on them.
- Suggested validation: G-1.

### Near term

**2. Fix REV-002 — scope unit-test collection.**
- Expected benefit: trustworthy local test signal; ~10× faster runs.
- Dependencies: none. Pattern already exists in `vitest.integration.config.ts`.
- Risk of delay: real regressions stay maskable among foreign results.
- Suggested validation: G-2.

**3. Fix REV-003 — proper KDF plus key-strength validation.**
- Expected benefit: stored provider credentials survive database or backup
  exposure.
- Dependencies: none; `keyVersion` already provides the migration path.
- Risk of delay: every credential written meanwhile is protected by a
  brute-forceable derivation.
- Suggested validation: G-4.

**4. Fix REV-004 — bound the SSE stream.**
- Expected benefit: removes the one unbounded resource path; protects the
  connection pool.
- Dependencies: benefits from REV-001 if a concurrency policy is applied.
- Risk of delay: gradual, hard-to-diagnose degradation.
- Suggested validation: G-3.

**5. Close G-1 and G-2 as tests in their own right**, not only as side effects
of the fixes above — the shape of the coverage is what allowed REV-001 to persist.

### Planned improvement

**6. REV-005** — route SSE errors through `exposeError`. Benefit: one consistent
disclosure policy. Validation: G-6.

**7. REV-006** — expire `activeProgressMap` entries, reusing the lazy-sweep
pattern at `server.ts:405-408`. Benefit: bounded memory; no stale progress reads.

**8. REV-007** — log the cause before throwing the safe admission error.
Benefit: the documented correlation-id workflow actually yields a diagnostic.

**9. REV-008** — fail fast with an actionable message pointing at the documented
reset. Benefit: removes a 150-second dead end from developer onboarding.

**10. Review the browser client and `generation-service.ts`** — the two largest
unreviewed areas (§11). Not a finding; a coverage debt this review could not
retire.

**Explicitly not recommended.** No rewrite of `nexus.js`, `server.ts`, or
`generation-service.ts` is proposed. Their size and complexity are leads, not
defects, and no evidence gathered here justifies broad restructuring over
focused correction.

---

## 13. Proposed Specification Recovery Process

`as-built-specification.md` is a recovered description, **not** an approved
specification. To convert it:

1. **Review each behavior** in §21 (Documented Requirements) and §22 (Observed
   Behaviors) of the as-built document.
2. **Mark each** as *intended*, *accidental but acceptable*, *defective*,
   *obsolete*, or *unknown*. The B-1 … B-12 identifiers exist for this purpose.
   B-1/B-2 (admission) and B-4/B-5 (streaming) should be adjudicated first.
3. **Resolve the material unknowns** in §8 above — admission enforcement,
   archive limit intent, and the authentication commitment gate the others.
4. **Convert approved behaviors** into a target-state specification, keeping the
   evidence classification so future reviewers can distinguish a decided
   requirement from an inherited behavior.
5. **Add explicit acceptance criteria** for each requirement — the P0 design
   record is a good model: its numbered criteria are exactly what made REV-001
   provable rather than arguable.
6. **Define security, data, migration, deployment, rollback, and observability
   requirements** explicitly, including the currently absent metrics/tracing
   decision.
7. **Approve the target-state specification** before any implementation planning.

Do not treat the as-built document as approved intent at any step. Several
behaviors it records are, in this report's assessment, defects.

---

## 14. Proposed Implementation-Planning Process

To be started only after §13 completes and findings are accepted:

1. Create or update the target-state specification.
2. Map each accepted finding to a requirement it satisfies.
3. Use a planning process to decompose into small, individually testable tasks.
4. Specify exact files, interfaces, tests, commands, and commit boundaries per task.
5. Sequence REV-001 first, then REV-002 (so subsequent work has trustworthy test
   signal), then REV-003 and REV-004 — before unrelated feature work.
6. Work on an isolated branch or worktree — noting that REV-002 must be fixed
   for worktree-based development to have reliable local validation.
7. Review each task independently against its acceptance criteria.
8. Perform a final cross-model review before merge.

**No implementation plan is produced as part of this review**, per its terms.

---

## 15. Unverified Areas

- **Code not inspected:** `apps/web/public/nexus.js` (5 077 lines) and
  `story.js` (2 902 lines); the interiors of `generation-service.ts`,
  `memory-service.ts`, `image-service.ts`, `world-service.ts`,
  `asset-service.ts`, `segmented-illustration-service.ts`,
  `world-generator-service.ts`, `campaign-archive-service.ts`; most of
  `packages/domain` and `packages/contracts`; 49 of 50 SQL migrations line by line.
- **Tests not run:** the entire integration suite (20 files); `pnpm build`;
  `docker build`; Compose/Swarm startup; `pnpm test:sogni-live`.
- **Environments not available:** no Swarm cluster; no multi-replica deployment;
  no production-like data volume. Shared-storage assumptions for the asset and
  archive roots in Swarm were **not** verified.
- **External systems not tested:** no model provider (text, embedding, or
  illustration) was contacted; provider failure, timeout, and retry behavior is
  unverified.
- **RepoWise gaps:** `get_dead_code()` under-reports when test files reference
  otherwise-unreachable code (§3); `untested_hotspot` reflects paired-file
  absence, not coverage. `get_health()` output was truncated inline and parsed
  from a persisted file.
- **Stale-index concerns:** none. The index matched `HEAD` exactly.
- **Missing historical information:** no tags or releases; no issue or PR bodies
  were retrieved; commit messages were the only historical narrative available.
- **Missing product requirements:** no stakeholder input. `Known users or system
  purpose` was supplied as `UNKNOWN`, so no **Desired** evidence exists and every
  product-intent question in §8 remains open.
- **Missing operational knowledge:** no incident history, no production
  telemetry, no information about actual deployment topology or user population.
- **Why full confidence is not claimed:** the majority of executable logic was
  not read line by line, the integration suite did not execute, and no runtime
  behavior under load or failure was observed.

---

## 16. Final Recommendation

### Continue after minor corrections

**Why this and not something stronger.** No Critical finding exists. The
foundations that are expensive to retrofit — schema-level ownership scoping,
parameterized queries, strict CSP, exact-origin policy, archive path containment,
lease-based durable job claiming, non-root containers, CI-enforced architectural
boundaries — are already correct. `pnpm check` passes and the unit suite is clean
at the reviewed revision (56 files, 664 tests, 0 failures). Nothing found
warrants pausing development.

**Why not "continue normal development".** REV-001 is a documented P0 security
control that does not execute, and six configuration settings actively promise
protection the system does not provide. That is a correctness gap between the
repository's own design record and its shipped behavior, and it should be closed
deliberately rather than carried forward. REV-002 compounds it: local test
signal is currently unreliable, and the specific shape of the test suite is what
let REV-001 stay invisible.

**Why not "stop pending human decisions".** The decisions in §8 are real, but
only one — whether to enforce or retire admission control — blocks the immediate
work, and engineering evidence supports a clear default (enforce; the code and
tests exist). The rest can proceed in parallel.

**Confidence in this recommendation.** Medium-high for the reviewed layers,
tempered by §11 and §15: the browser client and the largest service interiors
were not reviewed, and the integration suite did not run. A reviewer with those
areas covered could reasonably reach a different conclusion about them; nothing
in this report should be read as clearing them.

### First three actions

1. **Decide REV-001** — enforce admission control on the routes the P0 design
   names, or retire it and remove the six ignored settings. Add the HTTP-layer
   test (G-1) either way.
2. **Fix REV-002** — add a root `vitest.config.ts` scoping collection to
   `tests/unit/**` and excluding `.worktrees/**`, so all subsequent verification
   is trustworthy.
3. **Run the integration suite on a clean environment** — apply the documented
   reset in `docs/contributing/integration-test-database.md` and execute
   `pnpm test:integration`, closing the one validation gap this review could not
   close itself.
