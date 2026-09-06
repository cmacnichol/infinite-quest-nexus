# AI Assist Patch 2: Durable Authoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. Execute only this patch when requested; do not start Patch 3.

**Goal:** Preserve AI Assist inputs and validated stage results through failures, retries, refreshes, and restarts, with explicit revision-checked application to world drafts.

**Architecture:** Introduce a provider-free authoring application context backed by owner-scoped PostgreSQL jobs and stages. Runtime adapts Patch 1 generation functions to independently checkpointable operations; the existing worker gains one bounded optional lane. New HTTP job endpoints coexist with synchronous preview endpoints, and the replacement client resumes proposals by job ID.

**Tech Stack:** Existing TypeScript/Zod/Fastify/PostgreSQL/worker scheduler/Vitest/Playwright; no external queue.

**Spec:** [AI Assist roadmap and design](2026-09-06-ai-assist-roadmap.md), especially Patch 2 decisions.
**Prerequisite:** [Patch 1](2026-09-06-ai-assist-patch-1-reliability.md) accepted and its interfaces verified at the actual starting revision.

## Global constraints

- Implement P2.1–P2.10 in order. Do not change source intake or add story extraction.
- Owner-scoped proposals stay separate from authoritative world content.
- Every state write is fenced; no database transaction remains open across provider calls.
- Preserve old synchronous endpoints and the story/illustration/Chronicle/asset/System Archive scheduling guarantees.
- No job may auto-publish, apply content, or mutate campaigns.
- Retention is 7 days for inactive proposals; applied receipts last 30 days. Reads do not refresh retention.
- Migration numbers are allocated at execution time from the actual branch; the reviewed baseline ended at 0083. Do not reserve 0084 before checking.
- Code snippets below are concrete test seeds and interface contracts. Use existing integration database isolation and worker fixture patterns rather than a second test framework.

## File and responsibility map

| Files | Action and responsibility |
| --- | --- |
| packages/contracts/src/authoring.ts and index.ts | Extend: public job, stage, review, apply schemas |
| packages/domain/src/authoring-jobs.ts | Create: pure transition and invalidation rules |
| packages/application/src/authoring/{types,ports,use-cases,index}.ts | Create: provider-free commands and worker orchestration |
| packages/application/src/index.ts | Export authoring context |
| packages/database/src/authoring-job-repository.ts | Create: SQL persistence, leases, checkpoints, receipts |
| packages/database/src/authoring-world-apply-adapter.ts | Create: existing world persistence within authoring apply transaction |
| database/migrations/next-number_authoring_jobs.sql | Create with next unused four-digit prefix: additive job/stage schema |
| services/runtime/src/authoring-stage-adapter.ts | Create: Patch 1 provider pipeline as independently executable stages |
| services/runtime/src/authoring-composition.ts | Create: ports, provider roles, API/worker composition |
| services/runtime/src/provider-world-generation-adapter.ts | Extract narrow stage seams, preserve legacy wrappers |
| services/runtime/src/provider-application-composition.ts / main.ts | Wire authoring execution into actual roles |
| services/worker/src/worker.ts | Add capacity-one authoring lane |
| services/api/src/authoring-routes.ts / server.ts | Add owner-scoped job endpoints |
| packages/database/src/config.ts | Add disabled-by-default rollout setting |
| apps/web-next/src/authoring-jobs-api.ts | Create: validated HTTP client |
| apps/web-next/src/authoring-job-session.ts | Create: resume/review synchronization |
| apps/web-next/src/world-creation-page.ts / character-workspace-page.ts | Integrate durable proposals |
| apps/web-next/src/character-workspace-session.ts / world-editor-character-workspace.ts | Resume parent/child handoff safely |
| packages/application/src/system-archives/portability-registry.ts | Classify new operational tables |
| docs/runbooks/ai-authoring.md | Create during implementation: operations, retention, rollback |
| docs/nexus-guide/worlds/create.md / characters.md | Explain resume/retry/apply |
| docs/architecture/ai-authoring-jobs.md | Create proposed/accepted design record with repository ADR convention at execution |

## P2.1 — Define public contracts and pure lifecycle rules

**Size:** 2–3 hours. **Depends on:** Accepted Patch 1.
**Files:** Extend contracts/authoring.ts; create domain/authoring-jobs.ts and tests/unit/authoring-jobs.test.ts.

**Interfaces produced:**

    type AuthoringKind = "world_concept" | "character";
    type AuthoringJobStatus =
      | "queued" | "running" | "awaiting_review" | "recoverable" | "failed"
      | "cancel_requested" | "cancelled" | "applied" | "expired";
    type AuthoringStageStatus = "queued" | "running" | "validated" | "recoverable" | "failed" | "cancelled";
    type AuthoringTarget =
      | { kind: "new_world" }
      | { kind: "world_draft"; worldId: string; expectedRevision: number; characterId?: string };
    type AuthoringSubmit =
      | { kind: "world_concept"; idempotencyKey: string; target: AuthoringTarget; prompt: string }
      | { kind: "character"; idempotencyKey: string; target: AuthoringTarget; prompt: string; content: WorldContent; characterId?: string };
    type AuthoringStageView = {
      id: string; key: string; generation: number; status: AuthoringStageStatus;
      attemptCount: number; failure?: AuthoringFailure;
    };
    type AuthoringJobView = {
      id: string; kind: AuthoringKind; revision: number; status: AuthoringJobStatus;
      target: AuthoringTarget; stages: AuthoringStageView[];
      expiresAt: string; canApply: boolean; result?: WorldContent | PlayableCharacter;
      request?: AuthoringSubmit; reviewedContent?: WorldContent | PlayableCharacter;
    };
    type AuthoringReview = {
      expectedRevision: number; content: WorldContent | PlayableCharacter;
      selectedStageIds: string[];
    };
    type AuthoringApply = {
      expectedRevision: number; idempotencyKey: string;
      selectedStageIds: string[]; content: WorldContent | PlayableCharacter;
    };
    type AuthoringApplyReceipt = {
      jobId: string; worldId: string; draftRevision: number; characterId?: string;
    };
    canTransitionAuthoringJob(from: AuthoringJobStatus, to: AuthoringJobStatus): boolean;

Use strict discriminated schemas to require content kind matches job/target and reject caller-supplied owner/provider credentials. A new-world character proposal is applied only to its parent world's reviewed local draft; applying it to the database requires an explicit world target or full new-world save in P2.8. Job result and reviewed content are separate. The detail route returns the owner's original request and reviewedContent for resumption; list projections omit request, result, and reviewedContent. Extend the failure code allowlist with authoring_conflict, authoring_expired, authoring_cancelled, authoring_retry_exhausted, and authoring_apply_unavailable; these are fixed application errors, never raw exception strings.

- [ ] Write RED transition tests:

        expect(canTransitionAuthoringJob("running", "recoverable")).toBe(true);
        expect(canTransitionAuthoringJob("awaiting_review", "applied")).toBe(true);
        expect(canTransitionAuthoringJob("cancelled", "running")).toBe(false);
        expect(canTransitionAuthoringJob("applied", "queued")).toBe(false);

- [ ] Add strict request validation, zero-character partial-world review, target mismatch, and all terminal-state tests. Recoverable jobs may be reviewed/applied with valid selected results; failed/cancelled/expired jobs may not.
- [ ] Define dependency invalidation: retrying a child preserves siblings; explicitly regenerating an outline increments its generation and supersedes all dependent children, retaining old outputs only for review until expiry.
- [ ] Run RED; implement pure transitions and schemas.
- [ ] Enforce 3 automatic lease recoveries per stage generation and 3 explicit retry generations per failed stage; further retries require a new job. A retried failed stage uses a new generation so stale calls cannot commit.
- [ ] Run new domain and contracts tests GREEN; export the types and record them in the handoff.
- [ ] Review and checkpoint.

**Acceptance:** State changes, partial-review eligibility, and retry invalidation are explicit and testable without a database/provider.

## P2.2 — Persist jobs, stages, leases, and idempotency

**Size:** 2–3 hours. **Depends on:** P2.1.
**Files:** Create migration and database repository; create tests/integration/authoring-job-repository.integration.test.ts; extend migration-order and System Archive portability tests.

**Storage contract:**
- authoring_jobs: id, owner_user_id, kind, target JSONB, immutable input JSONB, request_hash, idempotency_key, status, revision, execution_generation, execution_snapshot JSONB, reviewed_content JSONB, review_generation, apply_key, apply_hash, apply_receipt JSONB, last_activity_at, expires_at, created_at, updated_at.
- authoring_job_stages: id, job_id, owner_user_id, stage_key, generation, parent_generations JSONB, status, attempt_count, retry_count, next_attempt_at, lease_token UUID, lease_owner, lease_expires_at, output JSONB, failure JSONB, started_at, completed_at.
- Unique (owner_user_id, idempotency_key), unique (job_id, stage_key, generation), composite job/owner foreign key, explicit status and nonnegative-counter constraints.
- Index claimable stages by status/next_attempt_at/lease_expires_at, jobs by owner/status/created_at, and cleanup by expires_at. Bound input JSONB to 2 MiB before insert; Patch 3 source intake fits within it.

**Interfaces produced in application/authoring/ports.ts:**

    interface AuthoringRepository {
      submit(scope: OwnerScope, input: AuthoringSubmit, hash: string): Promise&lt;AuthoringJobView&gt;;
      read(scope: OwnerScope, jobId: string): Promise&lt;AuthoringJobView | null&gt;;
      list(scope: OwnerScope, cursor?: string): Promise&lt;{ jobs: AuthoringJobView[]; nextCursor?: string }&gt;;
      claim(workerId: string, leaseSeconds: number): Promise&lt;AuthoringClaim | null&gt;;
      heartbeat(claim: AuthoringClaim, leaseSeconds: number): Promise&lt;boolean&gt;;
      checkpoint(claim: AuthoringClaim, output: unknown): Promise&lt;boolean&gt;;
      fail(claim: AuthoringClaim, failure: AuthoringFailure): Promise&lt;boolean&gt;;
    }
    type AuthoringClaim = {
      jobId: string; stageId: string; ownerUserId: string;
      jobGeneration: number; stageGeneration: number;
      leaseToken: string; leaseExpiresAt: string;
    };

Define jobGeneration as execution_generation for execution dependency fencing; review_generation tracks reviewed content and public revision changes on user-visible mutations. Review autosave must not increment execution_generation or invalidate an unrelated in-flight stage. Add private loadClaim(claim): Promise&lt;{ input: AuthoringSubmit; snapshot: AuthoringExecutionSnapshot; stageKey: string; parentOutputs: AuthoringStageOutput[] } | null&gt; for P2.4. AuthoringExecutionSnapshot is the pinned safe provider/prompt/limit projection defined in P2.4; keep it out of every HTTP response. User input can be returned through the owner-scoped detail projection, never list responses.

- [ ] Add real-PostgreSQL RED tests: simultaneous identical submissions return one ID; changed request hash returns conflict; a foreign owner cannot read/update/checkpoint; two workers cannot claim one generation.
- [ ] Seed two claims over an expired lease and assert:

        expect(await repository.checkpoint(staleClaim, validOutput)).toBe(false);
        expect(await repository.checkpoint(currentClaim, validOutput)).toBe(true);

The integration fixture inserts a job and stage, advances lease time through SQL in its isolated test database, and obtains the two claims using repository.claim.

- [ ] Run with vitest.integration.config.ts RED.
- [ ] Implement short transactions with FOR UPDATE SKIP LOCKED and compare-and-set lease/generation predicates. Never persist provider credentials, raw responses, or exception objects.
- [ ] Validate outputs against stage schema before writing and again on reading persisted data. Ensure heartbeat cannot resurrect cancelled/terminal work.
- [ ] Mark both tables operational in the portability registry immediately so the schema inventory tests continue to pass.
- [ ] Run repository, migration-order, and portability tests GREEN.
- [ ] Review SQL/indexes and checkpoint.

**Acceptance:** Durable storage resists duplicate submission and stale-worker writes under real PostgreSQL concurrency.

## P2.3 — Implement owner-scoped commands, review, retry, and cancellation

**Size:** 2–3 hours. **Depends on:** P2.2.
**Files:** Create application/authoring/{types,ports,use-cases,index}.ts and tests/unit/application/authoring-use-cases.test.ts; extend repository with mutation methods.

**Interfaces produced:**

    interface AuthoringApplication {
      submit(scope: OwnerScope, input: AuthoringSubmit): Promise&lt;AuthoringJobView&gt;;
      get(scope: OwnerScope, id: string): Promise&lt;AuthoringJobView | null&gt;;
      list(scope: OwnerScope, cursor?: string): Promise&lt;{ jobs: AuthoringJobView[]; nextCursor?: string }&gt;;
      review(scope: OwnerScope, id: string, input: AuthoringReview): Promise&lt;AuthoringJobView&gt;;
      retry(scope: OwnerScope, id: string, stageId: string, expectedRevision: number): Promise&lt;AuthoringJobView&gt;;
      cancel(scope: OwnerScope, id: string, expectedRevision: number): Promise&lt;AuthoringJobView&gt;;
      discard(scope: OwnerScope, id: string, expectedRevision: number): Promise&lt;void&gt;;
      apply(scope: OwnerScope, id: string, input: AuthoringApply): Promise&lt;AuthoringApplyReceipt&gt;;
    }

The apply method is implemented in P2.8; before then it rejects with authoring_apply_unavailable and cannot mutate state. Add repository methods for these commands with explicit expectedRevision and generation predicates. Provider-free ports take domain values and safe identifiers only.

- [ ] Write RED unit tests against a typed in-memory repository fixture: retry only one child, cancel twice safely, reject wrong revision, reject foreign owner, and no publisher/campaign dependency invocation.
- [ ] Exercise the state outcome directly:

        const retried = await app.retry(owner, job.id, failedStage.id, job.revision);
        expect(retried.stages.find((s) => s.id === successfulStage.id)?.status).toBe("validated");
        expect(retried.stages.find((s) => s.key === failedStage.key)?.generation).toBe(2);

Construct the fixture with one validated and one recoverable stage using the P2.1 contracts; the fake repository must enforce the same revision checks, not return canned successful answers.

- [ ] Run RED; implement use cases and transactional repository commands.
- [ ] Treat same idempotency key plus changed normalized request as 409. Validate current world ownership/revision before enqueue; persist the target snapshot for final apply comparison.
- [ ] Implement review autosave separately from generated outputs. It refreshes proposal inactivity only after successful CAS; late generation must never replace reviewed_content automatically.
- [ ] Cancellation prevents subsequent stage claims and checkpoints. Discard clears input/output/review payloads transactionally after fencing active claims.
- [ ] Run application and repository suites GREEN; update package exports/boundary fixtures.
- [ ] Review and checkpoint.

**Acceptance:** The application expresses safe user operations without knowing provider credentials or SQL.

## P2.4 — Execute checkpointable world and character stages

**Size:** 2–3 hours. **Depends on:** P2.3.
**Files:** Create runtime/authoring-stage-adapter.ts; extract stage seams from provider-world-generation-adapter.ts; create tests/unit/authoring-stage-adapter.test.ts; retain world-generator-service.test.ts.

**Interfaces produced:**

    type AuthoringWorldOutline = {
      title: string; genre: string; tone: string; backgroundStory: string;
      premise: string; firstAction: string; rules: string;
      seeds: { id: string; name: string; role: string; concept: string; narrativeHook: string }[];
      rpgStats: unknown[]; defaultTriggers: unknown[]; eventTriggers: unknown[];
    };
    type AuthoringStageOutput =
      | { kind: "outline"; outline: AuthoringWorldOutline }
      | { kind: "character"; character: PlayableCharacter };
    executeAuthoringStage(claim: AuthoringClaim): Promise&lt;AuthoringStageOutput&gt;;

Runtime loads the private claim input and pinned execution snapshot, then uses Patch 1 runAuthoringResponse. The snapshot holds provider ID, model, non-secret configuration hash, context/output limits, effective prompts and protocol versions. Resolve secrets freshly through the existing runtime adapter. A disabled/deleted provider or changed incompatible configuration becomes recoverable; never silently switch to another default.

Define AuthoringExecutionSnapshot in application/authoring/types.ts with fields providerProfileId: string, model: string, configurationHash: string, contextWindowTokens: number, maxOutputTokens: number, requestTimeoutMs: number, prompts: Record<string, string>, and protocols: Record<string, string>. Capture it exactly once before the first stage through a repository CAS. RuntimeTextExecution already exposes safe limits and an opaque endpointIdentity; hash that identity with non-secret model/configuration values. Do not persist endpoint URLs or credentials. Response chains, if used for repair, belong only to that stage generation and exact snapshot; never carry one into another stage, job, or campaign.

- [ ] Add RED test: outline and first character checkpoint; second character fails twice; resume invokes only the second character, leaving outline and first character byte-identical.
- [ ] Assert call identity:

        expect(executedStageKeys).toEqual(["world", "character:second"]);
        expect(reloadedSuccessfulOutput).toEqual(originalSuccessfulOutput);

Build executedStageKeys from the injected provider/stage dispatcher in the test, not from expected fixture data.

- [ ] Run RED; split world outline generation and seed expansion into named functions consumed by both old wrappers and the new executor.
- [ ] Assign seed/application IDs in code, create child rows in the same transaction as the outline checkpoint, and bind each child to the exact outline generation.
- [ ] Compose partial previews from validated stages only. Label failed/unstarted characters; do not fabricate replacement characters to meet the legacy 3–4 completion gate. Partial previews use storage validation and an explicit incomplete flag.
- [ ] Retain immutable accepted stage output after a lost client response. Changed user prompts create a new job; failed-stage retry preserves its original snapshot.
- [ ] Run stage, Patch 1, and repository suites GREEN.
- [ ] Review and checkpoint.

**Acceptance:** A later failure cannot erase earlier validated generation work, and old synchronous behavior remains compatible.

## P2.5 — Integrate worker scheduling, leases, and restart recovery

**Size:** 2–3 hours. **Depends on:** P2.4.
**Files:** Create authoring-composition.ts; modify main.ts, worker.ts, provider-application-composition.ts and actual worker-role composition; extend config.ts; create tests/unit/authoring-worker.test.ts and tests/unit/runtime-authoring-composition.test.ts; extend worker-concurrency.test.ts and runtime-shutdown.test.ts.

**Interfaces produced:**

    interface AuthoringWorkerApplication {
      runNext(input: { workerId: string; leaseSeconds: number }): Promise&lt;boolean&gt;;
    }

Compose one such application per worker. Add optional authoring(): Promise&lt;boolean&gt; to WorkerOptionalLanes and an "authoring" ActiveLane entry with capacity 1. All current lanes retain their relative order and independent capacity.

- [ ] Write RED scheduler test with blocked story and authoring promises; confirm story capacity is filled and other optional lanes are visited while authoring remains pending.
- [ ] Add restart/fencing test:

        await workerA.startClaim();
        await expireLeaseInTestDatabase();
        await workerB.runNext({ workerId: "worker-b", leaseSeconds: 30 });
        expect(await workerA.finishLate()).toBe(false);

Implement the fixture by injecting a deferred provider response into the real executor and advancing the isolated database lease, not by replacing checkpoint with a constant false.

- [ ] Run RED; wire the worker lane and heartbeat around provider execution using short independent transactions.
- [ ] Heartbeat loss marks the execution stale, prevents new calls, and discards late output. Cancellation is checked before initial request, transport retry, content repair, and checkpoint.
- [ ] On worker shutdown stop new claims; drain according to existing shutdown policy. If a provider cannot abort, allow the existing request timeout and release/recover through lease expiry. Do not hold a never-settling shutdown promise.
- [ ] Add AI_AUTHORING_JOBS_ENABLED with default false, parsed identically in API and worker runtime configuration. Disabled workers do not claim new jobs.
- [ ] Run new tests plus existing concurrency, role-composition, and shutdown tests GREEN.
- [ ] Review and checkpoint.

**Acceptance:** Durable AI Assist cannot starve story/image/memory work, and restarts cannot commit stale stage output.

## P2.6 — Add HTTP job commands with compatibility rollout

**Size:** 1–2 hours. **Depends on:** P2.5.
**Files:** Create services/api/src/authoring-routes.ts; modify server.ts and runtime composition; create tests/unit/authoring-routes.test.ts and tests/integration/authoring-routes.integration.test.ts.

**Public routes:**

| Method/path | Behavior |
| --- | --- |
| GET /api/v1/authoring/capabilities | enabled flag, supported kinds, limits; no credentials |
| POST /api/v1/authoring/jobs | 202 plus AuthoringJobView; identical duplicate returns same job |
| GET /api/v1/authoring/jobs?cursor=... | Owner-scoped 20-item page, no raw input/output in list |
| GET /api/v1/authoring/jobs/:id | Full owner-scoped proposal and review projection |
| PUT /api/v1/authoring/jobs/:id/review | Revision-checked reviewed candidate |
| POST /api/v1/authoring/jobs/:id/retry | stageId and expectedRevision |
| POST /api/v1/authoring/jobs/:id/cancel | expectedRevision |
| POST /api/v1/authoring/jobs/:id/apply | AuthoringApply, enabled after P2.8 |
| DELETE /api/v1/authoring/jobs/:id | Discard with expectedRevision |

- [ ] Write RED route tests for 202, duplicate submission, 409 stale revision, 404 foreign-owned ID, disabled capability, sanitized failures, request size limits, and CSRF/origin enforcement matching existing mutation routes.
- [ ] Assert owner spoofing fails:

        const response = await server.inject({
          method: "POST", url: "/api/v1/authoring/jobs",
          payload: { ...validSubmit, ownerUserId: foreignOwnerId }
        });
        expect(response.statusCode).toBe(400);

Create validSubmit from the P2.1 discriminated schema fixture. Resolve the actual request owner through the existing server bootstrap, not the payload.

- [ ] Run RED; register routes through the application composition, not direct SQL/provider imports.
- [ ] Apply current admission controls to job submission and costly retries; bound list results to 20. Add a per-owner active-job cap of 5 with a safe 429. Check the cap transactionally against concurrent submissions.
- [ ] Preserve legacy synchronous routes; capability false permits clients to use those routes. A transient error on new-job submission must not trigger fallback and duplicate generation.
- [ ] Run route/unit/integration cases GREEN.
- [ ] Review and checkpoint.

**Acceptance:** API commands are bounded, scoped, and compatible with rolling deployment.

## P2.7 — Resume jobs and review safely in the browser

**Size:** 2–3 hours. **Depends on:** P2.6.
**Files:** Create authoring-jobs-api.ts, authoring-job-session.ts, tests/unit/web-next-authoring-jobs-api.test.ts, tests/unit/web-next-authoring-job-session.test.ts; modify world/character creation and parent handoff files; create tests/e2e/ai-assist-resume.e2e.test.ts.

**Interfaces produced:**

The client exposes submitAuthoringJob, loadAuthoringJob, and saveAuthoringReview, each returning an AuthoringJobView. Its AuthoringResumeState contains jobId, observedRevision, and localDirty.

Add corresponding typed clients for list/retry/cancel/discard/apply. Store only opaque job IDs in URL/session resume metadata. Review buffers are saved through the owner-scoped server proposal endpoint, not embedded in URLs.

- [ ] Write RED session tests for refresh, lost session storage, stale polling responses, two tabs editing the same review, cancelled jobs, expired proposals, and changed local character/world inputs.
- [ ] Assert local edits survive a delayed result:

        session.edit(localCandidate);
        session.receive(remoteCompletedJob);
        expect(session.currentCandidate()).toEqual(localCandidate);
        expect(session.hasPendingGeneratedResult()).toBe(true);

Define session as the actual new session controller over injected API and storage ports; its public methods edit, receive, currentCandidate, and hasPendingGeneratedResult are part of this task's exported session interface.

- [ ] Run RED; add an owner-scoped “Resume AI Assist” entry/list to creation views. A job ID supports refresh; the list supports another browser or expired local handoff.
- [ ] Autosave review edits with 500 ms debounce and CAS revision. Show saving/saved/conflict states. On conflict keep the local candidate and offer explicit reload/compare; never silently retry by overwriting the server.
- [ ] Pause polling on hidden pages, resume with bounded 1–5 second backoff, stop at terminal state, and keep retry/cancel buttons idempotent while requests are pending.
- [ ] Add per-stage retry and “Review available results.” New-world character proposals return through the existing parent review flow; when its local session expired, resume/reconstruct the parent draft explicitly before allowing save.
- [ ] Add rendered Playwright coverage for refresh, one failed child, lost session key, cancellation, and two-tab conflict. Save desktop and narrow-width screenshots.
- [ ] Run unit/browser tests GREEN; review and checkpoint.

**Acceptance:** Refresh/disconnection preserves proposals and completed work; incoming results never overwrite newer human edits.

## P2.8 — Apply reviewed results atomically and once

**Size:** 2–3 hours. **Depends on:** P2.7.
**Files:** Create database/authoring-world-apply-adapter.ts; finish application apply and repository receipt methods; extend world-creation and character-workspace clients; create tests/integration/authoring-apply.integration.test.ts.

**Interfaces produced:**

    interface AuthoringWorldApplyPort {
      applyInTransaction(
        transaction: AuthoringTransaction,
        scope: OwnerScope,
        target: AuthoringTarget,
        content: WorldContent | PlayableCharacter
      ): Promise&lt;{ worldId: string; draftRevision: number; characterId?: string }&gt;;
    }

AuthoringTransaction is an opaque application transaction context defined in application/authoring/ports.ts. Its database implementation wraps the existing world persistence transaction/context adapter so applying content and writing a receipt use the same connection and transaction.

- [ ] Write RED real-database tests: double-click creates one world/revision; lost apply response replays receipt; changed apply payload with same key conflicts; stale world revision leaves job/world unchanged.
- [ ] Assert atomicity:

        await expect(app.apply(owner, jobId, applyInput)).rejects.toThrow();
        expect(await readWorldRevision(worldId)).toBe(beforeRevision);
        expect(await readApplyReceipt(jobId)).toBeNull();

Inject a failure between world mutation and receipt persistence within the test transaction; do not simulate rollback by deleting records afterwards.

- [ ] Run RED; lock the job and target draft, validate selection membership/current stage generations, canonicalize reviewed content, enforce world revision, persist through existing domain/application rules, and write receipt in one transaction.
- [ ] Check already-applied same-key/same-hash receipt before stale-revision rejection so an HTTP replay returns the original outcome. A different apply key on an applied job cannot apply again.
- [ ] For existing character edits preserve ID and unselected roster entries; reject stale target character/world revisions. For new-world character proposals, “Use character” updates only the local parent review until the full new-world apply occurs.
- [ ] Allow explicit saving of valid incomplete world drafts from selected validated stages; clearly mark campaign readiness separately. No publish action occurs here.
- [ ] Verify world versions, campaigns, accepted turns, memory rows, and unrelated owner records are unchanged.
- [ ] Run application, API, and database tests GREEN; review and checkpoint.

**Acceptance:** Human application is atomic, revision-safe, and idempotent even after response loss.

## P2.9 — Implement retention, portability, and rollout operations

**Size:** 1–2 hours. **Depends on:** P2.8.
**Files:** Extend authoring repository/composition cleanup, config tests, portability-registry.ts; create tests/integration/authoring-retention.integration.test.ts and docs/runbooks/ai-authoring.md; update deployment.md and the two world user guides. Add the architecture decision record listed above.

- [ ] Write RED cases for 7-day inactive expiry, no expiry extension on reads, pending cancellation, applied receipt expiry, and bounded cleanup:

        const removed = await cleanupAuthoring({ batchSize: 100, now: cutoff });
        expect(removed).toBeLessThanOrEqual(100);
        expect(await readAppliedWorld(worldId)).toEqual(savedWorld);

cleanupAuthoring is a repository/composition operation created here; its timestamp is injected for tests. Lock candidate jobs with SKIP LOCKED and fence running stages before payload deletion.

- [ ] Run RED; implement at most 100 jobs per cleanup tick, expiring/fencing active stale proposals before deleting payloads. Applied receipt cleanup leaves saved world content intact.
- [ ] Test System Archive excludes job inputs/stages/receipts and migration inventory still classifies every table. Do not add operational data to portable world exports.
- [ ] Document rollout: additive migration; deploy compatible API and workers with setting false; verify new lane in disposable environment; enable AI_AUTHORING_JOBS_ENABLED; use capabilities to switch clients.
- [ ] Document rollback: stop new submissions and disable the lane, retain tables and checkpoints, return clients to synchronous compatibility through capability false. Do not down-migrate or delete proposals. Re-enable compatible code to resume them.
- [ ] Document that pre-rollout synchronous in-flight previews cannot be retroactively recovered and that provider calls can be repeated after lease loss.
- [ ] Run retention, archive portability, deployment configuration, and link tests GREEN.
- [ ] Review and checkpoint.

**Acceptance:** Operators can roll out/back out safely and users know exactly what is retained and portable.

## P2.10 — Prove restart, concurrency, and human-apply behavior

**Size:** 2–3 hours. **Depends on:** P2.1–P2.9.
**Files:** Create tests/integration/authoring-jobs.integration.test.ts and docs/review/2026-09-06-ai-assist-patch-2-verification.md during execution; extend browser tests and worker-concurrency fixtures.

- [ ] Add a deterministic HTTP-provider test that stops a worker after a successful child checkpoint, starts another worker, and proves only unfinished stages execute. Query persisted stage hashes before/after.
- [ ] Add failures after provider success/before checkpoint, after checkpoint/before HTTP response, cancellation during repair, deletion of target world/provider, stale review/apply revisions, duplicate submission/apply, and owner isolation.
- [ ] Run each new scenario RED before related fixes; do not weaken fencing or admission controls to get GREEN.
- [ ] Run:

        node node_modules/vitest/vitest.mjs run tests/unit/authoring-jobs.test.ts tests/unit/application/authoring-use-cases.test.ts tests/unit/authoring-stage-adapter.test.ts tests/unit/authoring-worker.test.ts tests/unit/runtime-authoring-composition.test.ts tests/unit/authoring-routes.test.ts tests/unit/web-next-authoring-jobs-api.test.ts tests/unit/web-next-authoring-job-session.test.ts tests/unit/worker-concurrency.test.ts tests/unit/runtime-shutdown.test.ts tests/unit/system-archive-portability.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
        node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/authoring-job-repository.integration.test.ts tests/integration/authoring-routes.integration.test.ts tests/integration/authoring-apply.integration.test.ts tests/integration/authoring-retention.integration.test.ts tests/integration/authoring-jobs.integration.test.ts tests/integration/world-generation.integration.test.ts
        pnpm exec playwright test tests/e2e/ai-assist-errors.e2e.test.ts tests/e2e/ai-assist-resume.e2e.test.ts
        pnpm check
        pnpm build
        git diff --check

- [ ] Re-run Patch 1 focused suites and current worker-concurrency regressions. If scheduling performance changes, run the documented worker benchmark and report measured story latency/throughput; do not assume a new optional lane is free.
- [ ] In a disposable Compose environment verify API restart, worker restart, browser refresh, stage retry, explicit apply, and disabled-capability rollback. Validate Swarm configuration separately; do not claim a live Swarm test when none ran.
- [ ] Inspect screenshots and log projections. Record migration filename actually allocated, schema compatibility, and rollout setting.
- [ ] Produce the patch completion record and stop before story-source work.

**Patch 2 gate:** Durable restart recovery, stale-worker fencing, atomic apply, owner isolation, and rendered resumption are proven. No Patch 3 work is included.
