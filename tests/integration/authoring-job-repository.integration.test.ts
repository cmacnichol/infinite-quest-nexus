import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authoringExecutionSnapshotSchema, authoringSubmitSchema, worldContentSchema } from "../../packages/contracts/src/index.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { createPostgresAuthoringRepository, createPostgresAuthoringTargetPort } from "../../packages/database/src/authoring-job-repository.js";
import { createAuthoringApplication } from "../../packages/application/src/authoring/use-cases.js";

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

const outlineWithSeeds = (...ids: string[]) => ({
  ...validOutline,
  outline: {
    ...validOutline.outline,
    seeds: ids.map((id, index) => ({ id, name: `Hero ${index + 1}`, role: "Guide", concept: "Knows the old roads.", narrativeHook: "A lantern answers their call." }))
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
      name: "AuthoringRepositoryError", code: "idempotency_conflict"
    });
  });

  it("admits exactly five concurrent active proposals while retaining same-key replay and retry at capacity", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const requests = Array.from({ length: 8 }, (_, index) => input(`active-cap-${index}-${crypto.randomUUID()}`));
    const results = await Promise.allSettled(requests.map((request, index) =>
      repository.submit({ ownerUserId }, request, `${index}`.padStart(64, "a"))
    ));
    const accepted = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof repository.submit>>> => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    jobIds.push(...accepted.map((result) => result.value.id));

    expect(accepted).toHaveLength(5);
    expect(rejected).toHaveLength(3);
    expect(rejected.map((result) => result.reason)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "active_job_limit" })
    ]));
    await expect(repository.submit({ ownerUserId }, requests[0]!, "a".repeat(63) + "0"))
      .resolves.toMatchObject({ id: accepted[0]!.value.id });

    const retryable = accepted[0]!.value;
    await pool.query("UPDATE authoring_jobs SET status = 'recoverable' WHERE id = $1", [retryable.id]);
    await pool.query("UPDATE authoring_job_stages SET status = 'recoverable' WHERE id = $1", [retryable.stages[0]!.id]);
    await expect(repository.retry({ ownerUserId }, retryable.id, retryable.stages[0]!.id, retryable.revision))
      .resolves.toMatchObject({ id: retryable.id, status: "queued" });

    const active = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM authoring_jobs WHERE owner_user_id = $1 AND expires_at > clock_timestamp() AND status = ANY($2::text[])",
      [ownerUserId, ["queued", "running", "awaiting_review", "recoverable", "cancel_requested"]]
    );
    expect(active.rows[0]?.count).toBe(5);
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

  it("rolls back an outline checkpoint and all child inserts when the roster is invalid", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const submitted = await repository.submit({ ownerUserId }, input(), "4".repeat(63) + "a");
    jobIds.push(submitted.id);
    const claim = await repository.claim("atomic-outline", 60);
    const duplicate = outlineWithSeeds("same", "same");

    await expect(repository.checkpoint(claim!, duplicate)).rejects.toThrow("unique assigned character identities");
    const rows = await pool.query<{ stageKey: string; status: string; output: unknown }>(
      "SELECT stage_key AS \"stageKey\", status, output FROM authoring_job_stages WHERE job_id = $1 ORDER BY stage_key", [submitted.id]
    );
    expect(rows.rows).toEqual([{ stageKey: "world", status: "running", output: null }]);
  });

  it("persists one new standalone character stage identity through submit replay and explicit retry", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const request = authoringSubmitSchema.parse({
      kind: "character", idempotencyKey: `standalone-${crypto.randomUUID()}`, target: { kind: "new_world" }, prompt: "Create a guide.",
      content: worldContentSchema.parse({ world: { title: "Standalone" }, playableCharacters: [] })
    });
    const first = await repository.submit({ ownerUserId }, request, "a".repeat(63) + "c");
    const replay = await repository.submit({ ownerUserId }, request, "a".repeat(63) + "c");
    jobIds.push(first.id);
    const persistedId = first.stages[0]?.key.slice("character:".length);
    expect(persistedId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(first.request).not.toHaveProperty("characterId");
    expect(replay.request).toEqual(first.request);
    const claim = await repository.claim("standalone-id", 60);
    expect(first.stages[0]?.key).toBe(`character:${persistedId}`);
    await expect(repository.fail(claim!, { code: "authoring_provider_timeout", stage: "character", retryable: true, issues: [] })).resolves.toBe(true);
    const failed = await repository.read({ ownerUserId }, first.id);
    const retried = await repository.retry({ ownerUserId }, first.id, claim!.stageId, failed!.revision);
    const replacement = retried.stages.filter((stage) => stage.key === `character:${persistedId}`).sort((a, b) => b.generation - a.generation)[0];
    expect(replacement).toMatchObject({ generation: 2, status: "queued" });
    const retryClaim = await repository.claim("standalone-id-retry", 60);
    expect(retryClaim).toMatchObject({ stageId: replacement?.id, stageGeneration: 2 });
  });

  it("rolls back the outline and an already inserted child if a later child insert fails", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const submitted = await repository.submit({ ownerUserId }, input(), "a".repeat(64));
    jobIds.push(submitted.id);
    const claim = (await repository.claim("child-insert-rollback", 60))!;
    await pool.query(`
      CREATE FUNCTION reject_second_authoring_child_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.stage_key = 'character:second' AND EXISTS (
          SELECT 1 FROM authoring_job_stages WHERE job_id = NEW.job_id AND stage_key = 'character:first'
        ) THEN RAISE EXCEPTION 'fixture rejects second child after first insert'; END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER reject_second_authoring_child_fixture BEFORE INSERT ON authoring_job_stages
        FOR EACH ROW EXECUTE FUNCTION reject_second_authoring_child_fixture();
    `);
    try {
      await expect(repository.checkpoint(claim, outlineWithSeeds("first", "second")))
        .rejects.toThrow("fixture rejects second child after first insert");
      const rows = await pool.query("SELECT stage_key, status, output FROM authoring_job_stages WHERE job_id = $1", [submitted.id]);
      expect(rows.rows).toEqual([{ stage_key: "world", status: "running", output: null }]);
      await expect(repository.heartbeat(claim, 60)).resolves.toBe(true);
    } finally {
      await pool.query("DROP TRIGGER reject_second_authoring_child_fixture ON authoring_job_stages; DROP FUNCTION reject_second_authoring_child_fixture()");
    }
  });

  it("reconciles a regenerated roster atomically and excludes obsolete children from completion", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const submitted = await repository.submit({ ownerUserId }, input(), "4".repeat(63) + "b");
    jobIds.push(submitted.id);
    const first = await repository.claim("roster-first", 60);
    await expect(repository.checkpoint(first!, outlineWithSeeds("hero", "obsolete"))).resolves.toBe(true);
    const beforeRetry = await repository.read({ ownerUserId }, submitted.id);
    await pool.query("UPDATE authoring_jobs SET status = 'recoverable' WHERE id = $1", [submitted.id]);
    await repository.retry({ ownerUserId }, submitted.id, first!.stageId, beforeRetry!.revision);
    const replacement = await repository.claim("roster-replacement", 60);
    await expect(repository.checkpoint(replacement!, outlineWithSeeds("hero", "fresh"))).resolves.toBe(true);

    const rows = await pool.query<{ stageKey: string; generation: number; status: string }>(
      "SELECT stage_key AS \"stageKey\", generation, status FROM authoring_job_stages WHERE job_id = $1 ORDER BY stage_key, generation", [submitted.id]
    );
    expect(rows.rows).toContainEqual({ stageKey: "character:obsolete", generation: 2, status: "cancelled" });
    expect(rows.rows).toContainEqual({ stageKey: "character:hero", generation: 2, status: "queued" });
    expect(rows.rows).toContainEqual({ stageKey: "character:fresh", generation: 1, status: "queued" });
    const preview = await repository.read({ ownerUserId }, submitted.id);
    expect(preview).toMatchObject({ status: "running", incomplete: true });
    expect(preview?.stages.find((stage) => stage.key === "character:obsolete" && stage.generation === 2)).toMatchObject({ status: "cancelled" });
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
    const submissions = [];
    for (let index = 0; index < 21; index += 1) {
      const submitted = await repository.submit({ ownerUserId }, input(`page-${index}-${crypto.randomUUID()}`), "a".repeat(63) + (index % 10));
      submissions.push(submitted);
      // These retained rows exercise list pagination without bypassing the
      // production five-active-proposal admission rule.
      await pool.query("UPDATE authoring_jobs SET status = 'failed' WHERE id = $1", [submitted.id]);
    }
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

  it("retries only the selected recoverable child while retaining validated sibling output", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const submitted = await repository.submit({ ownerUserId }, input(), "e".repeat(64));
    jobIds.push(submitted.id);
    await pool.query("INSERT INTO authoring_job_stages (job_id, owner_user_id, stage_key) VALUES ($1, $2, 'character:sibling')", [submitted.id, ownerUserId]);
    await pool.query("INSERT INTO authoring_job_stages (job_id, owner_user_id, stage_key) VALUES ($1, $2, 'character:second')", [submitted.id, ownerUserId]);
    const worldClaim = await repository.claim("retry-world", 60);
    const siblingClaim = await repository.claim("retry-sibling", 60);
    const secondClaim = await repository.claim("retry-second", 60);
    await expect(repository.checkpoint(worldClaim!, validOutline)).resolves.toBe(true);
    await expect(repository.checkpoint(siblingClaim!, validCharacter("sibling"))).resolves.toBe(true);
    await expect(repository.fail(secondClaim!, { code: "authoring_provider_timeout", stage: "character", retryable: true, issues: [] })).resolves.toBe(true);
    const before = await repository.read({ ownerUserId }, submitted.id);

    const retried = await repository.retry({ ownerUserId }, submitted.id, secondClaim!.stageId, before!.revision);

    expect(retried.revision).toBe(before!.revision + 1);
    expect(retried.stages.filter((stage) => stage.key === "character:second").sort((left, right) => right.generation - left.generation)[0]).toMatchObject({ generation: 2, status: "queued" });
    expect(retried.stages.find((stage) => stage.key === "character:sibling")).toMatchObject({ generation: 1, status: "validated" });
    const persisted = await pool.query<{ stageKey: string; generation: number; status: string; output: unknown }>(
      "SELECT stage_key AS \"stageKey\", generation, status, output FROM authoring_job_stages WHERE job_id = $1 ORDER BY stage_key, generation",
      [submitted.id]
    );
    expect(persisted.rows).toContainEqual(expect.objectContaining({ stageKey: "world", generation: 1, status: "validated", output: validOutline }));
    expect(persisted.rows).toContainEqual(expect.objectContaining({ stageKey: "character:sibling", generation: 1, status: "validated", output: expect.objectContaining({ kind: "character", character: expect.objectContaining({ id: "sibling" }) }) }));
  });

  it("world regeneration fences running dependent children and preserves child retry parent generations", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const submitted = await repository.submit({ ownerUserId }, input(), "f".repeat(64));
    jobIds.push(submitted.id);
    await pool.query("INSERT INTO authoring_job_stages (job_id, owner_user_id, stage_key, parent_generations) VALUES ($1, $2, 'character:hero', '{\"world\":1}')", [submitted.id, ownerUserId]);
    const world = await repository.claim("world-regeneration", 60);
    await expect(repository.checkpoint(world!, validOutline)).resolves.toBe(true);
    const child = await repository.claim("child-regeneration", 60);
    await pool.query("UPDATE authoring_jobs SET status = 'recoverable' WHERE id = $1", [submitted.id]);
    const before = await repository.read({ ownerUserId }, submitted.id);
    expect(before!.stages.find((stage) => stage.id === world!.stageId)).toMatchObject({ status: "validated" });

    await repository.retry({ ownerUserId }, submitted.id, world!.stageId, before!.revision);

    const rows = await pool.query<{ stageKey: string; generation: number; status: string; parentGenerations: unknown; leaseToken: string | null }>(
      "SELECT stage_key AS \"stageKey\", generation, status, parent_generations AS \"parentGenerations\", lease_token AS \"leaseToken\" FROM authoring_job_stages WHERE job_id = $1 ORDER BY stage_key, generation",
      [submitted.id]
    );
    expect(rows.rows).toContainEqual({ stageKey: "character:hero", generation: 1, status: "cancelled", parentGenerations: { world: 1 }, leaseToken: null });
    expect(rows.rows).toContainEqual({ stageKey: "character:hero", generation: 2, status: "queued", parentGenerations: { world: 2 }, leaseToken: null });

    await pool.query("UPDATE authoring_jobs SET status = 'recoverable' WHERE id = $1", [submitted.id]);
    const afterWorldRetry = await repository.read({ ownerUserId }, submitted.id);
    const childReplacement = afterWorldRetry!.stages.filter((stage) => stage.key === "character:hero").sort((left, right) => right.generation - left.generation)[0]!;
    await pool.query("UPDATE authoring_job_stages SET status = 'recoverable' WHERE id = $1", [childReplacement.id]);
    const retriedChild = await repository.retry({ ownerUserId }, submitted.id, childReplacement.id, afterWorldRetry!.revision);
    expect(retriedChild.stages.filter((stage) => stage.key === "character:hero").sort((left, right) => right.generation - left.generation)[0]).toMatchObject({ generation: 3, status: "queued" });
    const childParent = await pool.query<{ parentGenerations: unknown }>("SELECT parent_generations AS \"parentGenerations\" FROM authoring_job_stages WHERE job_id = $1 AND stage_key = 'character:hero' AND generation = 3", [submitted.id]);
    expect(childParent.rows[0]).toEqual({ parentGenerations: { world: 2 } });
    const replacementWorld = await repository.claim("world-regeneration-replacement", 60);
    expect(replacementWorld).toMatchObject({ jobId: submitted.id, stageGeneration: 2 });
    await expect(repository.heartbeat(child!, 60)).resolves.toBe(false);
    await expect(repository.checkpoint(child!, validCharacter("hero"))).resolves.toBe(false);
  });

  it("cancellation atomically fences a claim and replays the original revision without a second bump", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const submitted = await repository.submit({ ownerUserId }, input(), "f".repeat(64));
    jobIds.push(submitted.id);
    const claim = await repository.claim("cancellation-fence", 60);

    const cancelled = await repository.cancel({ ownerUserId }, submitted.id, submitted.revision);
    const replay = await repository.cancel({ ownerUserId }, submitted.id, submitted.revision);

    expect(cancelled).toMatchObject({ status: "cancelled", revision: submitted.revision + 1 });
    expect(replay).toEqual(cancelled);
    await expect(repository.heartbeat(claim!, 60)).resolves.toBe(false);
    await expect(repository.checkpoint(claim!, validOutline)).resolves.toBe(false);
    await expect(repository.claim("after-cancel", 60)).resolves.toBeNull();
    const fenced = await pool.query<{ executionGeneration: number; leaseToken: string | null; status: string }>(
      "SELECT jobs.execution_generation AS \"executionGeneration\", stages.lease_token AS \"leaseToken\", stages.status FROM authoring_jobs jobs JOIN authoring_job_stages stages ON stages.job_id = jobs.id WHERE jobs.id = $1",
      [submitted.id]
    );
    expect(fenced.rows).toEqual([{ executionGeneration: 1, leaseToken: null, status: "cancelled" }]);
  });

  it("autosaves a review while a sibling claim runs without fencing its checkpoint", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const submitted = await repository.submit({ ownerUserId }, input(), "2".repeat(64));
    jobIds.push(submitted.id);
    await pool.query("INSERT INTO authoring_job_stages (job_id, owner_user_id, stage_key) VALUES ($1, $2, 'character:sibling')", [submitted.id, ownerUserId]);
    await pool.query("INSERT INTO authoring_job_stages (job_id, owner_user_id, stage_key) VALUES ($1, $2, 'character:active')", [submitted.id, ownerUserId]);
    const world = await repository.claim("review-world", 60);
    const sibling = await repository.claim("review-sibling", 60);
    await expect(repository.checkpoint(world!, validOutline)).resolves.toBe(true);
    await expect(repository.checkpoint(sibling!, validCharacter("sibling"))).resolves.toBe(true);
    const active = await repository.claim("review-active", 60);
    const before = await repository.read({ ownerUserId }, submitted.id);
    const reviewContent = worldContentSchema.parse({ world: { title: "Autosaved review" }, playableCharacters: [] });

    const reviewed = await repository.review({ ownerUserId }, submitted.id, {
      expectedRevision: before!.revision,
      content: reviewContent,
      selectedStageIds: [sibling!.stageId]
    });

    expect(reviewed).toMatchObject({ status: "running", revision: before!.revision + 1, reviewedContent: reviewContent });
    await expect(repository.heartbeat(active!, 60)).resolves.toBe(true);
    await expect(repository.checkpoint(active!, validCharacter("active"))).resolves.toBe(true);
    await expect(repository.read({ ownerUserId }, submitted.id)).resolves.toMatchObject({ reviewedContent: reviewContent });
  });

  it("checks draft owner and revision before enqueue and tombstones an active private proposal", async () => {
    const targets = createPostgresAuthoringTargetPort(pool);
    const world = await pool.query<{ id: string }>("INSERT INTO worlds (owner_user_id, title, status) VALUES ($1, 'Authoring target', 'draft') RETURNING id", [ownerUserId]);
    const worldId = world.rows[0]!.id;
    const content = worldContentSchema.parse({ world: { title: "Authoring target" }, playableCharacters: [validCharacter("hero").character] });
    await pool.query("INSERT INTO world_drafts (world_id, owner_user_id, revision, content) VALUES ($1, $2, 3, $3::jsonb)", [worldId, ownerUserId, JSON.stringify(content)]);
    try {
      await expect(targets.assertCurrent({ ownerUserId }, { kind: "world_draft", worldId, expectedRevision: 3 })).resolves.toBeUndefined();
      await expect(targets.assertCurrent({ ownerUserId }, { kind: "world_draft", worldId, expectedRevision: 3, characterId: "hero" })).resolves.toBeUndefined();
      await expect(targets.assertCurrent({ ownerUserId }, { kind: "world_draft", worldId, expectedRevision: 3, characterId: "missing" })).rejects.toMatchObject({ code: "not_found" });
      await expect(targets.assertCurrent({ ownerUserId }, { kind: "world_draft", worldId, expectedRevision: 2 })).rejects.toMatchObject({ code: "revision_conflict" });
      await expect(targets.assertCurrent({ ownerUserId: crypto.randomUUID() }, { kind: "world_draft", worldId, expectedRevision: 3 })).rejects.toMatchObject({ code: "not_found" });

      const repository = createPostgresAuthoringRepository(pool);
      const draftRequest = (idempotencyKey: string, target: { kind: "world_draft"; worldId: string; expectedRevision: number; characterId?: string }) => authoringSubmitSchema.parse({
        kind: "character",
        idempotencyKey,
        target,
        prompt: "Strengthen this character proposal.",
        content,
        characterId: target.characterId
      });
      const beforeRejectedDrafts = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM authoring_jobs WHERE owner_user_id = $1", [ownerUserId]);
      await expect(repository.submit({ ownerUserId }, draftRequest("draft-stale", { kind: "world_draft", worldId, expectedRevision: 2 }), "1".repeat(64)))
        .rejects.toMatchObject({ code: "revision_conflict" });
      await expect(repository.submit({ ownerUserId }, draftRequest("draft-missing-character", { kind: "world_draft", worldId, expectedRevision: 3, characterId: "missing" }), "2".repeat(64)))
        .rejects.toMatchObject({ code: "not_found" });
      await expect(repository.submit({ ownerUserId: crypto.randomUUID() }, draftRequest("draft-foreign", { kind: "world_draft", worldId, expectedRevision: 3 }), "3".repeat(64)))
        .rejects.toMatchObject({ code: "not_found" });
      const afterRejectedDrafts = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM authoring_jobs WHERE owner_user_id = $1", [ownerUserId]);
      expect(afterRejectedDrafts.rows).toEqual(beforeRejectedDrafts.rows);

      const pinnedCharacter = await repository.submit({ ownerUserId }, draftRequest("draft-valid", { kind: "world_draft", worldId, expectedRevision: 3, characterId: "hero" }), "4".repeat(64));
      jobIds.push(pinnedCharacter.id);
      const pinnedClaim = await repository.claim("pinned-character", 60);
      await expect(repository.checkpoint(pinnedClaim!, validCharacter("hero"))).resolves.toBe(true);
      await expect(repository.review({ ownerUserId }, pinnedCharacter.id, {
        expectedRevision: pinnedCharacter.revision,
        content: { ...content.playableCharacters[0]!, id: "different" },
        selectedStageIds: [pinnedClaim!.stageId]
      })).rejects.toMatchObject({ code: "invalid_state" });

      const submitted = await repository.submit({ ownerUserId }, input(), "0".repeat(64));
      jobIds.push(submitted.id);
      await pool.query("INSERT INTO authoring_job_stages (job_id, owner_user_id, stage_key, parent_generations) VALUES ($1, $2, 'character:active', '{\"world\":1}')", [submitted.id, ownerUserId]);
      const worldClaim = await repository.claim("discard-world", 60);
      const privateSnapshot = snapshot();
      await expect(repository.initializeExecutionSnapshot(worldClaim!, privateSnapshot)).resolves.toEqual(privateSnapshot);
      await expect(repository.checkpoint(worldClaim!, validOutline)).resolves.toBe(true);
      const activeClaim = await repository.claim("discard-active", 60);
      const ready = await repository.read({ ownerUserId }, submitted.id);
      await repository.review({ ownerUserId }, submitted.id, {
        expectedRevision: ready!.revision,
        content: worldContentSchema.parse({ world: { title: "Private discarded review" }, playableCharacters: [] }),
        selectedStageIds: [worldClaim!.stageId]
      });
      const reviewed = await repository.read({ ownerUserId }, submitted.id);
      await expect(repository.discard({ ownerUserId }, submitted.id, reviewed!.revision)).resolves.toBeUndefined();
      await expect(repository.heartbeat(activeClaim!, 60)).resolves.toBe(false);
      await expect(repository.checkpoint(activeClaim!, validCharacter("active"))).resolves.toBe(false);
      await expect(repository.read({ ownerUserId }, submitted.id)).resolves.toBeNull();
      await expect(repository.list({ ownerUserId })).resolves.toMatchObject({ jobs: expect.not.arrayContaining([expect.objectContaining({ id: submitted.id })]) });
      const tombstone = await pool.query<{ input: unknown; reviewedContent: unknown; executionSnapshot: unknown; output: unknown; leaseToken: string | null }>(
        "SELECT jobs.input, jobs.reviewed_content AS \"reviewedContent\", jobs.execution_snapshot AS \"executionSnapshot\", stages.output, stages.lease_token AS \"leaseToken\" FROM authoring_jobs jobs JOIN authoring_job_stages stages ON stages.job_id = jobs.id WHERE jobs.id = $1 ORDER BY stages.stage_key",
        [submitted.id]
      );
      expect(tombstone.rows).toEqual([
        { input: { discarded: true }, reviewedContent: null, executionSnapshot: null, output: null, leaseToken: null },
        { input: { discarded: true }, reviewedContent: null, executionSnapshot: null, output: null, leaseToken: null }
      ]);
    } finally {
      await pool.query("DELETE FROM worlds WHERE id = $1 AND owner_user_id = $2", [worldId, ownerUserId]);
    }
  });

  it("rejects unknown and superseded review selections and refuses expired commands", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const submitted = await repository.submit({ ownerUserId }, input(), "4".repeat(64));
    jobIds.push(submitted.id);
    const world = await repository.claim("review-selection-world", 60);
    await expect(repository.checkpoint(world!, validOutline)).resolves.toBe(true);
    const ready = await repository.read({ ownerUserId }, submitted.id);
    const content = worldContentSchema.parse({ world: { title: "Selection guards" }, playableCharacters: [] });
    await expect(repository.review({ ownerUserId }, submitted.id, {
      expectedRevision: ready!.revision,
      content,
      selectedStageIds: [crypto.randomUUID()]
    })).rejects.toMatchObject({ code: "invalid_state" });
    await pool.query("INSERT INTO authoring_job_stages (job_id, owner_user_id, stage_key, generation) VALUES ($1, $2, 'world', 2)", [submitted.id, ownerUserId]);
    await expect(repository.review({ ownerUserId }, submitted.id, {
      expectedRevision: ready!.revision,
      content,
      selectedStageIds: [world!.stageId]
    })).rejects.toMatchObject({ code: "invalid_state" });
    await pool.query("UPDATE authoring_jobs SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [submitted.id]);
    await expect(repository.cancel({ ownerUserId }, submitted.id, ready!.revision)).rejects.toMatchObject({ code: "invalid_state" });
    await expect(repository.read({ ownerUserId }, submitted.id)).resolves.toMatchObject({ revision: ready!.revision, status: "awaiting_review" });
  });

  it("allows exactly one competing review CAS and retains that winner", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const submitted = await repository.submit({ ownerUserId }, input(), "5".repeat(64));
    jobIds.push(submitted.id);
    const claim = await repository.claim("review-cas", 60);
    await expect(repository.checkpoint(claim!, validOutline)).resolves.toBe(true);
    const ready = await repository.read({ ownerUserId }, submitted.id);
    const leftContent = worldContentSchema.parse({ world: { title: "CAS left" }, playableCharacters: [] });
    const rightContent = worldContentSchema.parse({ world: { title: "CAS right" }, playableCharacters: [] });
    const results = await Promise.allSettled([
      repository.review({ ownerUserId }, submitted.id, { expectedRevision: ready!.revision, content: leftContent, selectedStageIds: [claim!.stageId] }),
      repository.review({ ownerUserId }, submitted.id, { expectedRevision: ready!.revision, content: rightContent, selectedStageIds: [claim!.stageId] })
    ]);
    const successes = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof repository.review>>> => result.status === "fulfilled");
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.reason).toMatchObject({ code: "revision_conflict" });
    await expect(repository.read({ ownerUserId }, submitted.id)).resolves.toMatchObject({ revision: ready!.revision + 1, reviewedContent: successes[0]!.value.reviewedContent });
  });

  it("refuses discard of an applied job and every expired user command", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const applied = await repository.submit({ ownerUserId }, input(), "6".repeat(64));
    jobIds.push(applied.id);
    await pool.query("UPDATE authoring_jobs SET status = 'applied' WHERE id = $1", [applied.id]);
    await expect(repository.discard({ ownerUserId }, applied.id, applied.revision)).rejects.toMatchObject({ code: "invalid_state" });
    await expect(repository.read({ ownerUserId }, applied.id)).resolves.toMatchObject({ status: "applied", request: applied.request });

    const review = await repository.submit({ ownerUserId }, input(), "7".repeat(64));
    const retry = await repository.submit({ ownerUserId }, input(), "8".repeat(64));
    const discard = await repository.submit({ ownerUserId }, input(), "9".repeat(64));
    jobIds.push(review.id, retry.id, discard.id);
    const reviewClaim = await repository.claim("expired-review", 60);
    await expect(repository.checkpoint(reviewClaim!, validOutline)).resolves.toBe(true);
    const retryClaim = await repository.claim("expired-retry", 60);
    await expect(repository.fail(retryClaim!, { code: "authoring_provider_timeout", stage: "world", retryable: true, issues: [] })).resolves.toBe(true);
    await pool.query("UPDATE authoring_jobs SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ANY($1::uuid[])", [[review.id, retry.id, discard.id]]);
    await expect(repository.review({ ownerUserId }, review.id, { expectedRevision: review.revision, content: worldContentSchema.parse({ world: { title: "Expired review" }, playableCharacters: [] }), selectedStageIds: [reviewClaim!.stageId] })).rejects.toMatchObject({ code: "invalid_state" });
    await expect(repository.retry({ ownerUserId }, retry.id, retryClaim!.stageId, retry.revision)).rejects.toMatchObject({ code: "invalid_state" });
    await expect(repository.discard({ ownerUserId }, discard.id, discard.revision)).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("canonically pins existing-draft character identity through application admission and review", async () => {
    const persistedContent = worldContentSchema.parse({ world: { title: "Pinned character" }, playableCharacters: [validCharacter("hero").character] });
    const world = await pool.query<{ id: string }>("INSERT INTO worlds (owner_user_id, title, status) VALUES ($1, 'Pinned character', 'draft') RETURNING id", [ownerUserId]);
    const worldId = world.rows[0]!.id;
    await pool.query("INSERT INTO world_drafts (world_id, owner_user_id, revision, content) VALUES ($1, $2, 7, $3::jsonb)", [worldId, ownerUserId, JSON.stringify(persistedContent)]);
    const repository = createPostgresAuthoringRepository(pool);
    const application = createAuthoringApplication({
      repository,
      targets: createPostgresAuthoringTargetPort(pool),
      sha256: (value) => createHash("sha256").update(value).digest("hex")
    });
    const base = {
      kind: "character" as const,
      idempotencyKey: "canonical-existing-draft-character",
      target: { kind: "world_draft" as const, worldId, expectedRevision: 7 },
      prompt: "Improve the pinned character.",
      content: persistedContent
    };
    try {
      const topLevel = await application.submit({ ownerUserId }, { ...base, characterId: "hero" });
      jobIds.push(topLevel.id);
      const nested = await application.submit({ ownerUserId }, { ...base, target: { ...base.target, characterId: "hero" } });
      const both = await application.submit({ ownerUserId }, { ...base, target: { ...base.target, characterId: "hero" }, characterId: "hero" });
      expect(topLevel.target).toEqual({ kind: "world_draft", worldId, expectedRevision: 7, characterId: "hero" });
      expect(nested).toEqual(topLevel);
      expect(both).toEqual(topLevel);
      await expect(application.submit({ ownerUserId }, { ...base, idempotencyKey: "missing-existing-draft-character", characterId: "missing" }))
        .rejects.toMatchObject({ code: "authoring_not_found" });

      const claim = await repository.claim("canonical-existing-draft-character", 60);
      await expect(repository.checkpoint(claim!, validCharacter("hero"))).resolves.toBe(true);
      await expect(application.review({ ownerUserId }, topLevel.id, {
        expectedRevision: topLevel.revision,
        selectedStageIds: [claim!.stageId],
        content: { ...persistedContent.playableCharacters[0]!, id: "different" }
      })).rejects.toMatchObject({ code: "authoring_invalid_state" });
      const localParent = await application.submit({ ownerUserId }, {
        kind: "character",
        idempotencyKey: "canonical-local-parent-character",
        target: { kind: "new_world" },
        prompt: "Improve the local selected character.",
        content: persistedContent,
        characterId: "hero"
      });
      jobIds.push(localParent.id);
      expect(localParent.request).toMatchObject({ target: { kind: "new_world" }, characterId: "hero" });
      const localClaim = await repository.claim("canonical-local-parent-character", 60);
      await expect(repository.checkpoint(localClaim!, validCharacter("hero"))).resolves.toBe(true);
      await expect(application.review({ ownerUserId }, localParent.id, {
        expectedRevision: localParent.revision,
        selectedStageIds: [localClaim!.stageId],
        content: { ...persistedContent.playableCharacters[0]!, id: "different" }
      })).rejects.toMatchObject({ code: "authoring_invalid_state" });
    } finally {
      await pool.query("DELETE FROM worlds WHERE id = $1 AND owner_user_id = $2", [worldId, ownerUserId]);
    }
  });

  it("keeps a validated outline and sibling character reviewable after a nonretryable child failure", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const submitted = await repository.submit({ ownerUserId }, input(), "b".repeat(64));
    jobIds.push(submitted.id);
    const world = await repository.claim("partial-world", 60);
    const outline = {
      ...validOutline,
      outline: {
        ...validOutline.outline,
        seeds: [
          { id: "hero", name: "Mara", role: "Guide", concept: "Lantern keeper", narrativeHook: "Find the lost gate" },
          { id: "second", name: "Iris", role: "Scout", concept: "Tide reader", narrativeHook: "Read the storm" }
        ]
      }
    };
    await expect(repository.checkpoint(world!, outline)).resolves.toBe(true);
    const afterOutline = await repository.read({ ownerUserId }, submitted.id);
    const hero = await repository.claim("partial-hero", 60);
    expect(afterOutline!.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "character:hero", status: "queued" }),
      expect.objectContaining({ key: "character:second", status: "queued" })
    ]));
    await expect(repository.checkpoint(hero!, validCharacter("hero"))).resolves.toBe(true);
    const second = await repository.claim("partial-second", 60);
    await expect(repository.fail(second!, {
      code: "authoring_provider_rejected", stage: "character", retryable: false, issues: []
    })).resolves.toBe(true);

    const partial = await repository.read({ ownerUserId }, submitted.id);
    expect(partial).toMatchObject({ status: "recoverable", canApply: true, incomplete: true });
    expect(partial!.result).toMatchObject({
      world: { title: "TDD Lantern" },
      playableCharacters: [expect.objectContaining({ id: "hero" })]
    });
    expect(partial!.result!.playableCharacters).toHaveLength(1);
    expect(partial!.stages).toEqual(expect.arrayContaining([expect.objectContaining({ key: "character:second", status: "failed" })]));
    await expect(repository.review({ ownerUserId }, submitted.id, {
      expectedRevision: partial!.revision,
      content: partial!.result!,
      selectedStageIds: [world!.stageId, hero!.stageId]
    })).resolves.toMatchObject({ status: "recoverable" });
  });
});
