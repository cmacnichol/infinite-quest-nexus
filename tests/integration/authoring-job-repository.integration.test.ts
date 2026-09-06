import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authoringExecutionSnapshotSchema, authoringSubmitSchema } from "../../packages/contracts/src/authoring.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { createPostgresAuthoringRepository } from "../../packages/database/src/authoring-job-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

const validOutline = {
  kind: "outline" as const,
  outline: {
    title: "TDD Lantern",
    genre: "fantasy",
    tone: "hopeful",
    backgroundStory: "A city follows a living lantern.",
    premise: "The lantern chooses a new keeper.",
    firstAction: "Follow the lantern into the market.",
    rules: "Magic answers only honest questions.",
    seeds: [],
    rpgStats: [],
    defaultTriggers: [],
    eventTriggers: []
  }
};

const validCharacter = (id = "hero") => ({
  kind: "character" as const,
  character: {
    id,
    name: "Mara",
    characterText: "Mara carries a lantern through the old city.",
    profile: {
      story: {
        role: "A watchful guide.", background: "Mara learned the city's forgotten paths.",
        personality: "Patient.", motivations: "Keep travelers safe.", goals: "Find the lost gate.",
        fearsAndConflicts: "She fears the lantern will fade.", keyRelationships: "She trusts the market keeper.",
        narrativeHooks: "A map appears in the lantern light.", voiceAndMannerisms: "She speaks softly.", otherGuidance: ""
      }
    }
  }
});

integration("authoring job PostgreSQL repository", () => {
  let pool: DatabasePool;
  let ownerUserId: string;
  const foreignUserIds: string[] = [];
  const jobIds: string[] = [];

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 8);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });

  afterEach(async () => {
    if (jobIds.length) await pool.query("DELETE FROM authoring_jobs WHERE id = ANY($1::uuid[])", [jobIds]);
    if (foreignUserIds.length) await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [foreignUserIds]);
    jobIds.length = 0;
    foreignUserIds.length = 0;
  });

  afterAll(async () => { await pool?.end(); });

  function input(key = `authoring-${crypto.randomUUID()}`) {
    return authoringSubmitSchema.parse({
      kind: "world_concept",
      idempotencyKey: key,
      target: { kind: "new_world" },
      prompt: "Create a faithful fantasy world proposal."
    });
  }

  function snapshot() {
    return {
      providerProfileId: crypto.randomUUID(),
      model: "safe-test-model",
      configurationHash: "f".repeat(64),
      contextWindowTokens: 32_768,
      maxOutputTokens: 4_096,
      requestTimeoutMs: 30_000,
      prompts: { world: "Write fiction only." },
      protocols: { authoring: "v1" }
    };
  }

  async function waitForLockWaits(backendPids: number[]) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const waits = await pool.query<{ count: number }>(
        "SELECT count(DISTINCT pid)::int AS count FROM pg_locks WHERE NOT granted AND pid = ANY($1::int[])",
        [backendPids]
      );
      if (waits.rows[0]?.count === backendPids.length) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Expected PostgreSQL lock barrier was not reached.");
  }

  it("makes simultaneous identical submissions one durable owner-scoped job", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const request = input();
    const [first, second] = await Promise.all([
      repository.submit({ ownerUserId }, request, "a".repeat(64)),
      repository.submit({ ownerUserId }, request, "a".repeat(64))
    ]);
    jobIds.push(first.id);

    expect(first.id).toBe(second.id);
    expect(first.stages).toHaveLength(1);
    expect(first.stages[0]?.generation).toBe(1);
    await expect(repository.submit({ ownerUserId }, request, "b".repeat(64))).rejects.toMatchObject({
      name: "AuthoringRepositoryConflict"
    });
  });

  it("rolls back a submission when its required first stage cannot be created", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const request = input();
    await pool.query(`
      CREATE FUNCTION reject_authoring_stage_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fixture rejects initial stage'; END;
      $$;
      CREATE TRIGGER reject_authoring_stage_fixture
      BEFORE INSERT ON authoring_job_stages FOR EACH ROW EXECUTE FUNCTION reject_authoring_stage_fixture();
    `);
    try {
      await expect(repository.submit({ ownerUserId }, request, "e".repeat(64))).rejects.toThrow("fixture rejects initial stage");
      const persisted = await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM authoring_jobs WHERE owner_user_id = $1 AND idempotency_key = $2",
        [ownerUserId, request.idempotencyKey]
      );
      expect(persisted.rows[0]?.count).toBe(0);
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS reject_authoring_stage_fixture ON authoring_job_stages; DROP FUNCTION IF EXISTS reject_authoring_stage_fixture()");
    }
  });

  it("fences simultaneous claims and stale checkpoints across an expired lease", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const submitted = await repository.submit({ ownerUserId }, input(), "c".repeat(64));
    jobIds.push(submitted.id);

    const [first, competing] = await Promise.all([
      repository.claim("worker-one", 60),
      repository.claim("worker-two", 60)
    ]);
    const staleClaim = first ?? competing;
    expect(staleClaim).not.toBeNull();
    expect(first === null || competing === null).toBe(true);
    expect(staleClaim?.jobId).toBe(submitted.id);

    await pool.query(
      "UPDATE authoring_job_stages SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
      [staleClaim!.stageId]
    );
    const currentClaim = await repository.claim("worker-three", 60);
    expect(currentClaim?.stageId).toBe(staleClaim!.stageId);
    expect(currentClaim?.leaseToken).not.toBe(staleClaim!.leaseToken);

    await expect(repository.checkpoint(staleClaim!, validOutline)).resolves.toBe(false);
    await expect(repository.checkpoint(currentClaim!, { ...validOutline, outline: { ...validOutline.outline, rules: "" } })).resolves.toBe(true);
    await expect(repository.checkpoint(currentClaim!, { kind: "outline", outline: { title: 7 } })).rejects.toThrow();
  });

  it("does not expose or mutate a job through a foreign owner claim", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const submitted = await repository.submit({ ownerUserId }, input(), "d".repeat(64));
    jobIds.push(submitted.id);
    const foreign = await pool.query<{ id: string }>(
      "INSERT INTO users (display_name) VALUES ($1) RETURNING id",
      [`Foreign authoring owner ${crypto.randomUUID()}`]
    );
    const foreignOwnerUserId = foreign.rows[0]!.id;
    foreignUserIds.push(foreignOwnerUserId);

    expect(await repository.read({ ownerUserId: foreignOwnerUserId }, submitted.id)).toBeNull();
    const claim = await repository.claim("owner-worker", 60);
    expect(claim?.jobId).toBe(submitted.id);
    const foreignClaim = { ...claim!, ownerUserId: foreignOwnerUserId };
    expect(await repository.heartbeat(foreignClaim, 60)).toBe(false);
    expect(await repository.checkpoint(foreignClaim, validOutline)).toBe(false);
    expect(await repository.read({ ownerUserId }, submitted.id)).toMatchObject({ id: submitted.id, status: "running" });
  });

  it("pins a private snapshot only for the current claim and stops terminal heartbeats", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const submitted = await repository.submit({ ownerUserId }, input(), "f".repeat(64));
    jobIds.push(submitted.id);
    const claim = await repository.claim("snapshot-worker", 60);
    const pinned = snapshot();
    expect(await repository.loadClaim(claim!)).toBeNull();
    expect(() => authoringExecutionSnapshotSchema.parse({ ...pinned, endpoint: "https://forbidden.example" })).toThrow();
    await expect(repository.initializeExecutionSnapshot(claim!, pinned)).resolves.toEqual(pinned);
    await expect(repository.initializeExecutionSnapshot(claim!, { ...snapshot(), model: "replacement-candidate" })).resolves.toEqual(pinned);
    await expect(repository.loadClaim(claim!)).resolves.toMatchObject({ input: submitted.request, snapshot: pinned, stageKey: "world" });
    expect(JSON.stringify(await repository.read({ ownerUserId }, submitted.id))).not.toContain("safe-test-model");
    await pool.query("UPDATE authoring_jobs SET status = 'cancelled' WHERE id = $1", [submitted.id]);
    expect(await repository.heartbeat(claim!, 60)).toBe(false);
    expect(await repository.readClaimInput(claim!)).toBeNull();
  });

  it("validates persisted output again when an out-of-band row is corrupt", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const submitted = await repository.submit({ ownerUserId }, input(), "1".repeat(64));
    jobIds.push(submitted.id);
    const claim = await repository.claim("read-validator", 60);
    await expect(repository.checkpoint(claim!, validOutline)).resolves.toBe(true);
    await pool.query("UPDATE authoring_job_stages SET output = '{\"kind\":\"outline\",\"outline\":{\"title\":7}}'::jsonb WHERE id = $1", [claim!.stageId]);
    await expect(repository.read({ ownerUserId }, submitted.id)).rejects.toThrow();
    await pool.query("UPDATE authoring_job_stages SET output = $2::jsonb WHERE id = $1", [claim!.stageId, JSON.stringify(validCharacter("hero"))]);
    await expect(repository.read({ ownerUserId }, submitted.id)).rejects.toThrow();
  });

  it("rejects a valid shaped durable request larger than 2 MiB before insertion", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const oversized = {
      kind: "character" as const,
      idempotencyKey: `oversized-${crypto.randomUUID()}`,
      target: { kind: "new_world" as const },
      prompt: "Create a character.",
      content: {
        schemaVersion: 5,
        world: {
          title: "Large fixture",
          genre: "fantasy",
          tone: "hopeful",
          premise: "A bounded durable input fixture.",
          backgroundStory: "A bounded durable input fixture.",
          firstAction: "Begin.",
          rules: ""
        },
        playableCharacters: [],
        entities: Array.from({ length: 11 }, () => "x".repeat(200_000)),
        relationships: [],
        rpgStats: [],
        defaultTriggers: [],
        eventTriggers: [],
        assets: [],
        defaults: {}
      }
    };
    await expect(repository.submit({ ownerUserId }, oversized, "2".repeat(64))).rejects.toThrow("2 MiB");
  });

  it("allows only three expired-lease recoveries for one stage generation", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const submitted = await repository.submit({ ownerUserId }, input(), "3".repeat(64));
    jobIds.push(submitted.id);
    let claim = await repository.claim("recovery-worker-0", 60);
    for (let recovery = 1; recovery <= 3; recovery += 1) {
      await pool.query("UPDATE authoring_job_stages SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [claim!.stageId]);
      claim = await repository.claim(`recovery-worker-${recovery}`, 60);
      expect(claim).not.toBeNull();
    }
    await pool.query("UPDATE authoring_job_stages SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [claim!.stageId]);
    await expect(repository.claim("recovery-worker-exhausted", 60)).resolves.toBeNull();
    const settled = await pool.query<{ status: string; leaseToken: string | null; failure: { code: string } }>("SELECT status, lease_token AS \"leaseToken\", failure FROM authoring_job_stages WHERE id = $1", [claim!.stageId]);
    expect(settled.rows[0]).toMatchObject({ status: "recoverable", leaseToken: null, failure: { code: "authoring_retry_exhausted" } });
    const settledJob = await pool.query("SELECT status FROM authoring_jobs WHERE id = $1", [submitted.id]);
    expect(settledJob.rows[0]).toEqual({ status: "recoverable" });
    const settledLease = await pool.query("SELECT lease_owner, lease_expires_at FROM authoring_job_stages WHERE id = $1", [claim!.stageId]);
    expect(settledLease.rows[0]).toEqual({ lease_owner: null, lease_expires_at: null });
  });

  it("rejects an output whose kind or character identity does not match its claimed stage", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const submitted = await repository.submit({ ownerUserId }, input(), "4".repeat(64));
    jobIds.push(submitted.id);
    const worldClaim = await repository.claim("wrong-kind-world", 60);
    await expect(repository.checkpoint(worldClaim!, validCharacter("hero"))).rejects.toThrow();
    await pool.query(
      "INSERT INTO authoring_job_stages (job_id, owner_user_id, stage_key) VALUES ($1, $2, 'character:hero')",
      [submitted.id, ownerUserId]
    );
    const characterClaim = await repository.claim("wrong-kind-character", 60);
    await expect(repository.checkpoint(characterClaim!, validOutline)).rejects.toThrow();
    await expect(repository.checkpoint(characterClaim!, validCharacter("other"))).rejects.toThrow();
  });

  it("does not automatically re-claim a retryable failed generation", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const submitted = await repository.submit({ ownerUserId }, input(), "5".repeat(64));
    jobIds.push(submitted.id);
    const claim = await repository.claim("failure-worker", 60);
    await expect(repository.fail(claim!, {
      code: "authoring_provider_timeout", stage: "world", retryable: true, issues: []
    })).resolves.toBe(true);
    await expect(repository.claim("failure-worker-again", 60)).resolves.toBeNull();
  });

  it("revokes a snapshot initializer that is blocked behind a job lock", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const submitted = await repository.submit({ ownerUserId }, input(), "6".repeat(64));
    jobIds.push(submitted.id);
    const claim = await repository.claim("snapshot-race", 60);
    const operationPool = createDatabasePool(databaseUrl!, 1);
    const backend = await operationPool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const operationRepository = createPostgresAuthoringRepository(operationPool);
    const lock = await pool.connect();
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT id FROM authoring_jobs WHERE id = $1 FOR UPDATE", [submitted.id]);
      const stale = operationRepository.initializeExecutionSnapshot(claim!, { ...snapshot(), model: "stale-lock-owner" });
      await waitForLockWaits([backend.rows[0]!.pid]);
      await lock.query("UPDATE authoring_job_stages SET lease_token = gen_random_uuid() WHERE id = $1", [claim!.stageId]);
      await lock.query("COMMIT");
      await expect(stale).resolves.toBeNull();
      const row = await pool.query<{ executionSnapshot: unknown }>("SELECT execution_snapshot AS \"executionSnapshot\" FROM authoring_jobs WHERE id = $1", [submitted.id]);
      expect(row.rows[0]?.executionSnapshot).toBeNull();
    } finally { await lock.query("ROLLBACK").catch(() => undefined); lock.release(); await operationPool.end(); }
  });

  it("serializes two simultaneous final checkpoints through the job lock", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const submitted = await repository.submit({ ownerUserId }, input(), "7".repeat(64));
    jobIds.push(submitted.id);
    await pool.query("INSERT INTO authoring_job_stages (job_id, owner_user_id, stage_key) VALUES ($1, $2, 'character:hero')", [submitted.id, ownerUserId]);
    const worldClaim = await repository.claim("complete-world", 60);
    const characterClaim = await repository.claim("complete-character", 60);
    const operationPools = [createDatabasePool(databaseUrl!, 1), createDatabasePool(databaseUrl!, 1)];
    const backends = await Promise.all(operationPools.map((operationPool) => operationPool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")));
    const [worldRepository, characterRepository] = operationPools.map(createPostgresAuthoringRepository);
    const lock = await pool.connect();
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT id FROM authoring_jobs WHERE id = $1 FOR UPDATE", [submitted.id]);
      const both = Promise.all([worldRepository!.checkpoint(worldClaim!, validOutline), characterRepository!.checkpoint(characterClaim!, validCharacter("hero"))]);
      await waitForLockWaits(backends.map((backend) => backend.rows[0]!.pid));
      await lock.query("COMMIT");
      await expect(both).resolves.toEqual([true, true]);
      await expect(repository.read({ ownerUserId }, submitted.id)).resolves.toMatchObject({ status: "awaiting_review", incomplete: false });
    } finally { await lock.query("ROLLBACK").catch(() => undefined); lock.release(); await Promise.all(operationPools.map((operationPool) => operationPool.end())); }
  });

  it("claims only current stages whose declared parents are validated", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const submitted = await repository.submit({ ownerUserId }, input(), "8".repeat(64));
    jobIds.push(submitted.id);
    await pool.query("INSERT INTO authoring_job_stages (job_id, owner_user_id, stage_key, parent_generations) VALUES ($1, $2, 'character:hero', '{\"world\":2}')", [submitted.id, ownerUserId]);
    const world = await repository.claim("dependency-world", 60);
    await expect(repository.checkpoint(world!, validOutline)).resolves.toBe(true);
    await expect(repository.claim("missing-parent", 60)).resolves.toBeNull();
    await pool.query("INSERT INTO authoring_job_stages (job_id, owner_user_id, stage_key, generation, parent_generations) VALUES ($1, $2, 'character:hero', 2, '{\"world\":1}')", [submitted.id, ownerUserId]);
    const current = await repository.claim("current-parent", 60);
    expect(current?.stageGeneration).toBe(2);
    await expect(repository.checkpoint(current!, validCharacter("hero"))).resolves.toBe(true);
    await expect(repository.read({ ownerUserId }, submitted.id)).resolves.toMatchObject({ status: "awaiting_review", incomplete: false });
  });

  it.each(["missing", "unvalidated", "superseded"] as const)("rejects claim, load, and checkpoint with a %s parent", async (parentState) => {
    const repository = createPostgresAuthoringRepository(pool);
    const submitted = await repository.submit({ ownerUserId }, input(), "8".repeat(64));
    jobIds.push(submitted.id);
    await pool.query("INSERT INTO authoring_job_stages (job_id, owner_user_id, stage_key, parent_generations) VALUES ($1, $2, 'character:hero', '{\"world\":1}')", [submitted.id, ownerUserId]);
    const world = await repository.claim("parent-fixture", 60);
    await expect(repository.initializeExecutionSnapshot(world!, snapshot())).resolves.not.toBeNull();
    await expect(repository.checkpoint(world!, validOutline)).resolves.toBe(true);
    const child = await repository.claim("valid-child", 60);
    expect(child?.stageId).not.toBe(world!.stageId);
    await expect(repository.loadClaim(child!)).resolves.toMatchObject({ stageKey: "character:hero", parentOutputs: [validOutline] });
    await pool.query("INSERT INTO authoring_job_stages (job_id, owner_user_id, stage_key, parent_generations) VALUES ($1, $2, 'character:waiting', '{\"world\":1}')", [submitted.id, ownerUserId]);

    if (parentState === "missing") {
      await pool.query("DELETE FROM authoring_job_stages WHERE id = $1", [world!.stageId]);
    } else if (parentState === "unvalidated") {
      await pool.query("UPDATE authoring_job_stages SET status = 'queued', output = NULL, next_attempt_at = clock_timestamp() + interval '1 hour' WHERE id = $1", [world!.stageId]);
    } else {
      await pool.query("INSERT INTO authoring_job_stages (job_id, owner_user_id, stage_key, generation, next_attempt_at) VALUES ($1, $2, 'world', 2, clock_timestamp() + interval '1 hour')", [submitted.id, ownerUserId]);
    }

    await expect(repository.claim("invalid-parent-child", 60)).resolves.toBeNull();
    await expect(repository.loadClaim(child!)).resolves.toBeNull();
    await expect(repository.checkpoint(child!, validCharacter("hero"))).resolves.toBe(false);
    const persisted = await pool.query("SELECT status, output, lease_token FROM authoring_job_stages WHERE id = $1", [child!.stageId]);
    expect(persisted.rows[0]).toMatchObject({ status: "running", output: null, lease_token: child!.leaseToken });
  });

  it("does not settle an exhausted historical generation over a healthy replacement", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const submitted = await repository.submit({ ownerUserId }, input(), "8".repeat(64));
    jobIds.push(submitted.id);
    const historical = await repository.claim("historical-worker", 60);
    await pool.query("UPDATE authoring_job_stages SET attempt_count = 4, lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [historical!.stageId]);
    await pool.query("INSERT INTO authoring_job_stages (job_id, owner_user_id, stage_key, generation) VALUES ($1, $2, 'world', 2)", [submitted.id, ownerUserId]);
    const replacement = await repository.claim("healthy-replacement", 60);
    expect(replacement).toMatchObject({ jobId: submitted.id, stageGeneration: 2 });
    await expect(repository.claim("idle-settlement-poll", 60)).resolves.toBeNull();
    const job = await pool.query("SELECT status FROM authoring_jobs WHERE id = $1", [submitted.id]);
    const stages = await pool.query("SELECT generation, status, failure, lease_token FROM authoring_job_stages WHERE job_id = $1 ORDER BY generation", [submitted.id]);
    expect(job.rows[0]).toEqual({ status: "running" });
    expect(stages.rows).toEqual([
      { generation: 1, status: "running", failure: null, lease_token: historical!.leaseToken },
      { generation: 2, status: "running", failure: null, lease_token: replacement!.leaseToken }
    ]);
    await expect(repository.heartbeat(replacement!, 60)).resolves.toBe(true);
    await expect(repository.checkpoint(replacement!, validOutline)).resolves.toBe(true);
    await expect(repository.read({ ownerUserId }, submitted.id)).resolves.toMatchObject({ status: "awaiting_review", incomplete: false });
  });

  it("refreshes retention only for execution mutation and keeps reads inert", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const submitted = await repository.submit({ ownerUserId }, input(), "9".repeat(64));
    jobIds.push(submitted.id);
    await pool.query("UPDATE authoring_jobs SET expires_at = clock_timestamp() + interval '1 hour' WHERE id = $1", [submitted.id]);
    const claim = await repository.claim("retention-worker", 60);
    const refreshed = await pool.query<{ expiresAt: Date }>("SELECT expires_at AS \"expiresAt\" FROM authoring_jobs WHERE id = $1", [submitted.id]);
    expect(refreshed.rows[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
    const before = refreshed.rows[0]!.expiresAt.getTime();
    await repository.read({ ownerUserId }, submitted.id);
    const after = await pool.query<{ expiresAt: Date }>("SELECT expires_at AS \"expiresAt\" FROM authoring_jobs WHERE id = $1", [submitted.id]);
    expect(after.rows[0]!.expiresAt.getTime()).toBe(before);
    await repository.heartbeat(claim!, 60);
    const afterHeartbeat = await pool.query<{ expiresAt: Date }>("SELECT expires_at AS \"expiresAt\" FROM authoring_jobs WHERE id = $1", [submitted.id]);
    expect(afterHeartbeat.rows[0]!.expiresAt.getTime()).toBe(before);
    const activityBeforeList = await pool.query("SELECT expires_at, last_activity_at FROM authoring_jobs WHERE id = $1", [submitted.id]);
    await repository.list({ ownerUserId });
    const activityAfterList = await pool.query("SELECT expires_at, last_activity_at FROM authoring_jobs WHERE id = $1", [submitted.id]);
    expect(activityAfterList.rows).toEqual(activityBeforeList.rows);
  });

  it.each(["checkpoint", "fail"] as const)("refreshes the inactivity deadline on %s", async (operation) => {
    const repository = createPostgresAuthoringRepository(pool);
    const submitted = await repository.submit({ ownerUserId }, input(), "9".repeat(64));
    jobIds.push(submitted.id);
    const claim = await repository.claim("retention-mutation", 60);
    await pool.query("UPDATE authoring_jobs SET expires_at = clock_timestamp() + interval '1 hour', last_activity_at = clock_timestamp() - interval '1 day' WHERE id = $1", [submitted.id]);
    const result = operation === "checkpoint"
      ? await repository.checkpoint(claim!, validOutline)
      : await repository.fail(claim!, { code: "authoring_provider_timeout", stage: "world", retryable: true, issues: [] });
    expect(result).toBe(true);
    const refreshed = await pool.query("SELECT expires_at > clock_timestamp() + interval '6 days' AS retained, last_activity_at > clock_timestamp() - interval '1 minute' AS active FROM authoring_jobs WHERE id = $1", [submitted.id]);
    expect(refreshed.rows[0]).toEqual({ retained: true, active: true });
  });

  it("removes malicious issue text from stored and public failures", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const submitted = await repository.submit({ ownerUserId }, input(), "9".repeat(64));
    jobIds.push(submitted.id);
    const claim = await repository.claim("failure-projection", 60);
    const sentinel = "PRIVATE_PROVIDER_RESPONSE_SENTINEL";
    await expect(repository.fail(claim!, {
      code: "invalid_authoring_output", stage: "world", retryable: true,
      issues: [{ path: sentinel, code: sentinel, message: sentinel }]
    })).resolves.toBe(true);
    const expected = {
      code: "invalid_authoring_output", stage: "world", retryable: true,
      issues: [{ path: "generatedWorld", code: "custom", message: "Generated content failed validation." }]
    };
    const stored = await pool.query("SELECT failure FROM authoring_job_stages WHERE id = $1", [claim!.stageId]);
    const detail = await repository.read({ ownerUserId }, submitted.id);
    const page = await repository.list({ ownerUserId });
    expect(stored.rows[0]!.failure).toEqual(expected);
    expect(detail?.stages[0]?.failure).toEqual(expected);
    expect(page.jobs.find((job) => job.id === submitted.id)?.stages[0]?.failure).toEqual(expected);
    expect(JSON.stringify([stored.rows, detail, page])).not.toContain(sentinel);
  });

  it("paginates owner metadata in stable 20-item pages without proposal fields", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const submissions = await Promise.all(Array.from({ length: 21 }, (_, index) => repository.submit({ ownerUserId }, input(`page-${index}-${crypto.randomUUID()}`), "a".repeat(63) + (index % 10))));
    jobIds.push(...submissions.map((job) => job.id));
    const foreign = await pool.query<{ id: string }>("INSERT INTO users (display_name) VALUES ($1) RETURNING id", [`Foreign list owner ${crypto.randomUUID()}`]);
    const foreignOwnerUserId = foreign.rows[0]!.id;
    foreignUserIds.push(foreignOwnerUserId);
    const foreignSubmission = await repository.submit({ ownerUserId: foreignOwnerUserId }, { ...input(), prompt: "FOREIGN_PRIVATE_PROMPT_SENTINEL" }, "b".repeat(64));
    jobIds.push(foreignSubmission.id);
    await pool.query(
      "UPDATE authoring_jobs SET execution_snapshot = $2::jsonb, reviewed_content = $3::jsonb, apply_receipt = $4::jsonb WHERE id = ANY($1::uuid[])",
      [submissions.map((job) => job.id), JSON.stringify({ ...snapshot(), model: "PRIVATE_SNAPSHOT_SENTINEL" }), JSON.stringify({ privateReview: "PRIVATE_REVIEW_SENTINEL" }), JSON.stringify({ privateReceipt: "PRIVATE_RECEIPT_SENTINEL" })]
    );
    await pool.query("UPDATE authoring_job_stages SET output = $2::jsonb WHERE job_id = ANY($1::uuid[])", [submissions.map((job) => job.id), JSON.stringify({ ...validOutline, outline: { ...validOutline.outline, title: "PRIVATE_OUTPUT_SENTINEL" } })]);
    const first = await repository.list({ ownerUserId });
    const second = await repository.list({ ownerUserId }, first.nextCursor);
    expect(first.jobs).toHaveLength(20);
    expect(second.jobs).toHaveLength(1);
    expect(new Set([...first.jobs, ...second.jobs].map((job) => job.id)).size).toBe(21);
    const ownerJobs = [...first.jobs, ...second.jobs];
    expect(ownerJobs.map((job) => job.id).sort()).toEqual(submissions.map((job) => job.id).sort());
    for (const job of ownerJobs) {
      expect(Object.keys(job).sort()).toEqual(["id", "kind", "revision", "status", "target", "stages", "expiresAt", "canApply", "incomplete"].sort());
      for (const stage of job.stages) {
        expect(Object.keys(stage).sort()).toEqual(["id", "key", "generation", "status", "attemptCount"].sort());
      }
    }
    for (const privateText of ["Create a faithful fantasy world proposal", "FOREIGN_PRIVATE_PROMPT_SENTINEL", "PRIVATE_SNAPSHOT_SENTINEL", "PRIVATE_REVIEW_SENTINEL", "PRIVATE_RECEIPT_SENTINEL", "PRIVATE_OUTPUT_SENTINEL"]) {
      expect(JSON.stringify([first, second])).not.toContain(privateText);
    }
    const foreignPage = await repository.list({ ownerUserId: foreignOwnerUserId });
    expect(foreignPage.jobs.map((job) => job.id)).toEqual([foreignSubmission.id]);
    expect(first.nextCursor).toBeDefined();
    expect(second.nextCursor).toBeUndefined();
  });

  it("uses the PostgreSQL lease clock at heartbeat and checkpoint boundaries", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const submitted = await repository.submit({ ownerUserId }, input(), "b".repeat(64));
    jobIds.push(submitted.id);
    const claim = await repository.claim("database-clock", 60);
    await pool.query("UPDATE authoring_job_stages SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [claim!.stageId]);
    const skewedClock = vi.spyOn(Date, "now").mockReturnValue(Date.now() - 60 * 60 * 1000);
    try {
      const lease = await pool.query<{ expiresAt: Date }>("SELECT lease_expires_at AS \"expiresAt\" FROM authoring_job_stages WHERE id = $1", [claim!.stageId]);
      expect(lease.rows[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
      await expect(repository.heartbeat(claim!, 60)).resolves.toBe(false);
      await expect(repository.checkpoint(claim!, validOutline)).resolves.toBe(false);
    } finally {
      skewedClock.mockRestore();
    }
  });

  it("does not let an older blocked dependency starve a newer ready job", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const blocked = await repository.submit({ ownerUserId }, input(), "c".repeat(64));
    const ready = await repository.submit({ ownerUserId }, input(), "d".repeat(64));
    jobIds.push(blocked.id, ready.id);
    await pool.query("UPDATE authoring_job_stages SET parent_generations = '{\"missing\":1}' WHERE job_id = $1", [blocked.id]);
    await pool.query("UPDATE authoring_jobs SET created_at = clock_timestamp() - interval '1 minute' WHERE id = $1", [blocked.id]);
    const claim = await repository.claim("newer-ready", 60);
    expect(claim?.jobId).toBe(ready.id);
  });
});
