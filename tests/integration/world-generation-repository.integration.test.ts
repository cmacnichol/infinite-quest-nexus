import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import {
  type DashboardRepositoryPort,
  type SessionProfileRepositoryPort,
  type WorldCampaignRepositoryResult,
  type WorldGenerationCollaboratorPort,
  type WorldGenerationProgressRepositoryPort,
  type WorldGenerationProgressUpdate
} from "../../packages/application/src/world-campaign/index.js";
import type { OwnerScope } from "../../packages/application/src/generation/index.js";
import type {
  PlayableCharacterGenerationPreviewRequest,
  PlayableCharacterGenerationRequest,
  WorldGenerationPreviewRequest
} from "../../packages/contracts/src/world-library.js";
import { userProfileUpdateSchema } from "../../packages/contracts/src/users.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import {
  createDatabasePool,
  initialOwnerId,
  type DatabasePool
} from "../../packages/database/src/pool.js";
import * as repositoryModule from "../../packages/database/src/world-generation-repository.js";
import { createPostgresWorldCampaignTransactionPort } from "../../packages/database/src/world-campaign-transaction.js";
import { getDashboardStats } from "../../services/api/src/dashboard-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("world generation supporting PostgreSQL adapters", () => {
  let pool: DatabasePool;
  let ownerUserId: string;
  const worldIds: string[] = [];
  const userIds: string[] = [];
  const progressKeys: string[] = [];

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });

  afterEach(async () => {
    if (progressKeys.length) {
      await pool.query("DELETE FROM world_generation_progress WHERE progress_key = ANY($1::text[])", [progressKeys]);
    }
    if (worldIds.length) {
      await pool.query("DELETE FROM worlds WHERE id = ANY($1::uuid[])", [worldIds]);
    }
    if (userIds.length) {
      await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
    }
    worldIds.length = 0;
    userIds.length = 0;
    progressKeys.length = 0;
  });

  afterAll(async () => {
    await pool?.end();
  });

  function unwrap<T>(result: WorldCampaignRepositoryResult<T>): T {
    if (!result.ok) throw new Error(`fixture transition failed: ${result.failure.reason}`);
    return result.value;
  }

  it("reads dashboard totals only from the explicit owner scope", async () => {
    const ownedWorld = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id, title, status) VALUES ($1, $2, 'draft') RETURNING id",
      [ownerUserId, `Dashboard owned ${crypto.randomUUID()}`],
    );
    worldIds.push(ownedWorld.rows[0]!.id);
    const foreignUser = await pool.query<{ id: string }>(
      "INSERT INTO users (display_name) VALUES ($1) RETURNING id",
      [`Dashboard foreign ${crypto.randomUUID()}`],
    );
    const foreignUserId = foreignUser.rows[0]!.id;
    userIds.push(foreignUserId);
    const foreignWorld = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id, title, status) VALUES ($1, $2, 'draft') RETURNING id",
      [foreignUserId, `Dashboard foreign world ${crypto.randomUUID()}`],
    );
    worldIds.push(foreignWorld.rows[0]!.id);
    const expected = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM worlds WHERE owner_user_id = $1",
      [ownerUserId],
    );

    const createRepository = Reflect.get(repositoryModule, "createPostgresDashboardRepository");
    expect(createRepository).toBeTypeOf("function");
    const repository = createRepository() as DashboardRepositoryPort;
    const transactions = createPostgresWorldCampaignTransactionPort(pool);
    const dashboard = await transactions.read((transaction) => repository.getDashboard(
      transaction,
      { ownerUserId },
    ));

    expect(dashboard.worlds.total).toBe(expected.rows[0]!.count);
    expect(dashboard).toEqual(await getDashboardStats(pool));
  });

  it("reads and updates only the server-resolved session profile owner", async () => {
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (display_name, settings)
       VALUES ($1, $2::jsonb) RETURNING id`,
      [
        `Session owner ${crypto.randomUUID()}`,
        JSON.stringify({
          autoSubmitTurnChoices: true,
          continuousReading: false,
          defaultTurnControlStyle: "flexible_auto",
          retainedPreference: "keep"
        })
      ],
    );
    const sessionOwnerUserId = user.rows[0]!.id;
    userIds.push(sessionOwnerUserId);
    const createRepository = Reflect.get(repositoryModule, "createPostgresSessionProfileRepository");
    expect(createRepository).toBeTypeOf("function");
    const repository = createRepository() as SessionProfileRepositoryPort;
    const transactions = createPostgresWorldCampaignTransactionPort(pool);

    const updated = unwrap(await transactions.command((transaction) => repository.updateSessionProfile(
      transaction,
      { ownerUserId: sessionOwnerUserId },
      userProfileUpdateSchema.parse({
        displayName: "Updated session owner",
        settings: { continuousReading: true }
      }),
    )));

    expect(updated).toEqual({
      id: sessionOwnerUserId,
      systemKey: null,
      displayName: "Updated session owner",
      settings: {
        autoSubmitTurnChoices: true,
        continuousReading: true,
        defaultTurnControlStyle: "flexible_auto",
        retainedPreference: "keep"
      }
    });
    await expect(transactions.read((transaction) => repository.getSessionProfile(
      transaction,
      { ownerUserId: crypto.randomUUID() },
    ))).rejects.toMatchObject({
      name: "WorldCampaignApplicationError",
      kind: "not_found"
    });
  });

  it("rolls back a session update when persisted profile state is invalid", async () => {
    const originalDisplayName = `Invalid session owner ${crypto.randomUUID()}`;
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (display_name, settings)
       VALUES ($1, '{"continuousReading":"not-a-boolean"}'::jsonb) RETURNING id`,
      [originalDisplayName],
    );
    const sessionOwnerUserId = user.rows[0]!.id;
    userIds.push(sessionOwnerUserId);
    const createRepository = Reflect.get(repositoryModule, "createPostgresSessionProfileRepository");
    expect(createRepository).toBeTypeOf("function");
    const repository = createRepository() as SessionProfileRepositoryPort;
    const transactions = createPostgresWorldCampaignTransactionPort(pool);

    await expect(transactions.command((transaction) => repository.updateSessionProfile(
      transaction,
      { ownerUserId: sessionOwnerUserId },
      { displayName: "Must roll back" },
    ))).rejects.toMatchObject({
      name: "WorldCampaignApplicationError",
      kind: "unavailable"
    });
    const persisted = await pool.query<{ display_name: string }>(
      "SELECT display_name FROM users WHERE id = $1",
      [sessionOwnerUserId],
    );
    expect(persisted.rows[0]!.display_name).toBe(originalDisplayName);
  });

  it("creates, updates, and reads owner-scoped progress with status-specific expiry", async () => {
    const progressKey = `world-generation-${crypto.randomUUID()}`;
    progressKeys.push(progressKey);
    const createRepository = Reflect.get(repositoryModule, "createPostgresWorldGenerationProgressRepository");
    expect(createRepository).toBeTypeOf("function");
    const repository = createRepository() as WorldGenerationProgressRepositoryPort;
    const transactions = createPostgresWorldCampaignTransactionPort(pool);
    const scope = { ownerUserId, progressKey };

    unwrap(await transactions.command((transaction) => repository.createWorldGenerationProgress(
      transaction,
      scope,
    )));
    expect(await transactions.read((transaction) => repository.getWorldGenerationProgress(
      transaction,
      scope,
    ))).toEqual({
      status: "processing",
      phase: "queued",
      progressPercent: 0,
      message: ""
    });
    unwrap(await transactions.command((transaction) => repository.updateWorldGenerationProgress(
      transaction,
      scope,
      {
        status: "completed",
        phase: "complete",
        progressPercent: 100,
        message: "World preview ready"
      },
    )));
    expect(await transactions.read((transaction) => repository.getWorldGenerationProgress(
      transaction,
      scope,
    ))).toEqual({
      status: "completed",
      phase: "complete",
      progressPercent: 100,
      message: "World preview ready"
    });
    const expiry = await pool.query<{ expiry_seconds: number }>(
      `SELECT extract(epoch FROM (expires_at - updated_at))::int AS expiry_seconds
         FROM world_generation_progress WHERE progress_key = $1`,
      [progressKey],
    );
    expect(expiry.rows[0]!.expiry_seconds).toBe(300);
    await expect(transactions.read((transaction) => repository.getWorldGenerationProgress(
      transaction,
      { ownerUserId: crypto.randomUUID(), progressKey },
    ))).resolves.toBeNull();
  });

  it("rejects invalid or expired progress updates without mutation", async () => {
    const progressKey = `world-generation-invalid-${crypto.randomUUID()}`;
    progressKeys.push(progressKey);
    await pool.query(
      `INSERT INTO world_generation_progress (
         progress_key, owner_user_id, status, phase, progress_percent, message, expires_at
       ) VALUES ($1, $2, 'processing', 'queued', 0, '', now() - interval '1 second')`,
      [progressKey, ownerUserId],
    );
    const createRepository = Reflect.get(repositoryModule, "createPostgresWorldGenerationProgressRepository");
    expect(createRepository).toBeTypeOf("function");
    const repository = createRepository() as WorldGenerationProgressRepositoryPort;
    const transactions = createPostgresWorldCampaignTransactionPort(pool);
    const scope = { ownerUserId, progressKey };
    const invalidUpdate = {
      status: "processing",
      phase: "invalid",
      progressPercent: 101,
      message: "Must not persist"
    } as WorldGenerationProgressUpdate;

    await expect(transactions.command((transaction) => repository.updateWorldGenerationProgress(
      transaction,
      scope,
      invalidUpdate,
    ))).rejects.toMatchObject({
      name: "WorldCampaignApplicationError",
      kind: "invalid_request"
    });
    const expiredUpdate = await transactions.command((transaction) => repository.updateWorldGenerationProgress(
      transaction,
      scope,
      { status: "failed", phase: "failed", progressPercent: 10, message: "Expired" },
    ));
    expect(expiredUpdate).toEqual({
      ok: false,
      failure: { reason: "invalid_transition" }
    });
    const persisted = await pool.query<{ status: string; progress_percent: number }>(
      "SELECT status, progress_percent FROM world_generation_progress WHERE progress_key = $1",
      [progressKey],
    );
    expect(persisted.rows[0]).toEqual({ status: "processing", progress_percent: 0 });
  });

  it("cleans up only the explicit owner's expired progress through the caller transaction", async () => {
    const foreignUser = await pool.query<{ id: string }>(
      "INSERT INTO users (display_name) VALUES ($1) RETURNING id",
      [`Progress foreign ${crypto.randomUUID()}`],
    );
    const foreignUserId = foreignUser.rows[0]!.id;
    userIds.push(foreignUserId);
    const expiredKey = `world-generation-expired-${crypto.randomUUID()}`;
    const futureKey = `world-generation-future-${crypto.randomUUID()}`;
    const foreignKey = `world-generation-foreign-${crypto.randomUUID()}`;
    progressKeys.push(expiredKey, futureKey, foreignKey);
    await pool.query(
      `INSERT INTO world_generation_progress (
         progress_key, owner_user_id, status, phase, progress_percent, message, expires_at
       ) VALUES
         ($1, $4, 'completed', 'complete', 100, '', now() - interval '10 minutes'),
         ($2, $4, 'processing', 'queued', 0, '', now() + interval '10 minutes'),
         ($3, $5, 'completed', 'complete', 100, '', now() - interval '10 minutes')`,
      [expiredKey, futureKey, foreignKey, ownerUserId, foreignUserId],
    );
    const createRepository = Reflect.get(repositoryModule, "createPostgresWorldGenerationProgressRepository");
    expect(createRepository).toBeTypeOf("function");
    const repository = createRepository() as WorldGenerationProgressRepositoryPort;
    const transactions = createPostgresWorldCampaignTransactionPort(pool);
    const expiredBefore = new Date().toISOString();

    await expect(transactions.command(async (transaction) => {
      const deleted = unwrap(await repository.deleteExpiredWorldGenerationProgress(
        transaction,
        { ownerUserId },
        expiredBefore,
      ));
      expect(deleted).toBe(1);
      throw new Error("expiry rollback witness");
    })).rejects.toThrow("expiry rollback witness");
    const afterRollback = await pool.query<{ progress_key: string }>(
      "SELECT progress_key FROM world_generation_progress WHERE progress_key = ANY($1::text[]) ORDER BY progress_key",
      [[expiredKey, futureKey, foreignKey]],
    );
    expect(afterRollback.rows.map((row) => row.progress_key).sort()).toEqual(
      [expiredKey, futureKey, foreignKey].sort(),
    );
    const deleted = unwrap(await transactions.command((transaction) => repository.deleteExpiredWorldGenerationProgress(
      transaction,
      { ownerUserId },
      expiredBefore,
    )));
    expect(deleted).toBe(1);
    const remaining = await pool.query<{ progress_key: string }>(
      "SELECT progress_key FROM world_generation_progress WHERE progress_key = ANY($1::text[]) ORDER BY progress_key",
      [[expiredKey, futureKey, foreignKey]],
    );
    expect(remaining.rows.map((row) => row.progress_key).sort()).toEqual([futureKey, foreignKey].sort());
  });

  it("rolls back progress creation through the caller-owned transaction", async () => {
    const progressKey = `world-generation-rollback-${crypto.randomUUID()}`;
    progressKeys.push(progressKey);
    const createRepository = Reflect.get(repositoryModule, "createPostgresWorldGenerationProgressRepository");
    expect(createRepository).toBeTypeOf("function");
    const repository = createRepository() as WorldGenerationProgressRepositoryPort;
    const transactions = createPostgresWorldCampaignTransactionPort(pool);

    await expect(transactions.command(async (transaction) => {
      unwrap(await repository.createWorldGenerationProgress(
        transaction,
        { ownerUserId, progressKey },
      ));
      throw new Error("progress rollback witness");
    })).rejects.toThrow("progress rollback witness");
    const persisted = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM world_generation_progress WHERE progress_key = $1",
      [progressKey],
    );
    expect(persisted.rows[0]!.count).toBe(0);
  });

  it("keeps the world-generation collaborator seam provider-free", () => {
    type WorldPreviewParameters = Parameters<WorldGenerationCollaboratorPort["generateWorldPreview"]>;
    type CharacterPreviewParameters = Parameters<WorldGenerationCollaboratorPort["generatePlayableCharacterPreview"]>;
    type CharacterParameters = Parameters<WorldGenerationCollaboratorPort["generatePlayableCharacter"]>;

    expectTypeOf<WorldPreviewParameters>().toEqualTypeOf<[OwnerScope, WorldGenerationPreviewRequest]>();
    expectTypeOf<CharacterPreviewParameters>().toEqualTypeOf<[OwnerScope, PlayableCharacterGenerationPreviewRequest]>();
    expectTypeOf<CharacterParameters>().toEqualTypeOf<[
      OwnerScope & Readonly<{ worldId: string }>,
      PlayableCharacterGenerationRequest
    ]>();
  });
});
