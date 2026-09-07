import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createPostgresAuthoringRepository } from "../../packages/database/src/authoring-job-repository.js";
import { createRuntimeAuthoringApplication } from "../../services/runtime/src/authoring-composition.js";
import { buildServer } from "../../services/api/src/server.js";
import { inertStorageServerOptions } from "../helpers/build-server-options.js";
import type { RuntimeConfig } from "../../packages/database/src/config.js";
import type { AuthoringSubmit } from "../../packages/contracts/src/authoring.js";
import { worldContentSchema } from "../../packages/contracts/src/world-library.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe.sequential : describe.skip;

const appliedContent = worldContentSchema.parse({
  world: { title: "HTTP Receipt Lantern", genre: "fantasy", tone: "hopeful", premise: "A lantern remembers every promise.", backgroundStory: "The city follows its light.", firstAction: "Follow the lantern.", rules: "Promises have weight." },
  playableCharacters: [], entities: [], relationships: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], assets: [], defaults: {}
});
const appliedOutline = {
  kind: "outline",
  outline: {
    title: appliedContent.world.title, genre: appliedContent.world.genre, tone: appliedContent.world.tone,
    premise: appliedContent.world.premise, backgroundStory: appliedContent.world.backgroundStory,
    firstAction: appliedContent.world.firstAction, rules: appliedContent.world.rules,
    seeds: [], rpgStats: [], defaultTriggers: [], eventTriggers: []
  }
};

function config(enabled = true): RuntimeConfig {
  return {
    role: "api",
    host: "127.0.0.1",
    port: 8080,
    databaseUrl: databaseUrl!,
    databaseMaxConnections: 4,
    migrationDirectory: resolve("database/migrations"),
    migrationWaitSeconds: 10,
    allowMaintenanceMigrations: false,
    workerPollIntervalMs: 1_000,
    workerLeaseSeconds: 60,
    workerGenerationConcurrency: 1,
    aiAuthoringJobsEnabled: enabled,
    legacyWebRoot: resolve("apps/web/public"),
    nextWebRoot: resolve("apps/web-next"),
    assetStorageDriver: "filesystem",
    assetStorageRoot: resolve("local-data/assets"),
    archiveStorageRoot: resolve("local-data/archives"),
    archivePreviewTtlSeconds: 1_800,
    systemArchiveArtifactTtlSeconds: 86_400,
    campaignArchiveLimits: { maxCompressedBytes: 2_147_483_648, maxUncompressedBytes: 21_474_836_480, maxEntries: 100_000, maxExpansionRatio: 100, maxManifestBytes: 5_242_880, maxJsonEntryBytes: 1_073_741_824, maxOriginalImageBytes: 26_214_400 },
    systemArchiveLimits: { maxCompressedBytes: 53_687_091_200, maxUncompressedBytes: 214_748_364_800, maxEntries: 1_000_000, maxExpansionRatio: 100, maxManifestBytes: 5_242_880, maxJsonEntryBytes: 1_073_741_824, maxOriginalImageBytes: 26_214_400 },
    credentialEncryptionKey: "authoring-route-test-key",
    security: {
      corsAllowedOrigins: [], providerNetworkAllowlist: ["localhost", "127.0.0.0/8", "::1/128"], cspImageAllowedOrigins: [],
      apiDefaultBodyLimitBytes: 1_048_576, apiImportBodyLimitBytes: 16_777_216, apiAssetBodyLimitBytes: 33_554_432,
      apiRateLimitWindowSeconds: 60, apiRateLimitProviderRequests: 1_000, apiRateLimitGenerationRequests: 1_000, apiRateLimitImportRequests: 4,
      apiConcurrencyProviderRequests: 100, apiConcurrencyImportRequests: 1, trustProxyHops: 0
    }
  };
}

function submit(idempotencyKey: string): Extract<AuthoringSubmit, { kind: "world_concept" }> {
  return { kind: "world_concept", idempotencyKey, target: { kind: "new_world" }, prompt: "Create a durable world proposal." };
}

function boundedCharacterSubmit(idempotencyKey: string, entityCount: number) {
  return {
    kind: "character",
    idempotencyKey,
    target: { kind: "new_world" },
    prompt: "Create a durable character proposal.",
    content: {
      schemaVersion: 5,
      world: { title: "Large fixture", genre: "fantasy", tone: "hopeful", premise: "A bounded durable input fixture.", backgroundStory: "A bounded durable input fixture.", firstAction: "Begin.", rules: "" },
      playableCharacters: [],
      // Each character occupies three UTF-8 bytes, proving byte rather than
      // JavaScript-character accounting at the persistence boundary.
      entities: Array.from({ length: entityCount }, () => "漢".repeat(65_000)),
      relationships: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], assets: [], defaults: {}
    }
  };
}

integration("authoring HTTP commands", () => {
  let pool: DatabasePool;
  let ownerUserId: string;
  const jobIds: string[] = [];
  const worldIds: string[] = [];
  const foreignUserIds: string[] = [];

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 8);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });

  afterEach(async () => {
    if (worldIds.length) await pool.query("DELETE FROM worlds WHERE id = ANY($1::uuid[])", [worldIds]);
    if (jobIds.length) await pool.query("DELETE FROM authoring_jobs WHERE id = ANY($1::uuid[])", [jobIds]);
    if (foreignUserIds.length) await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [foreignUserIds]);
    jobIds.length = 0;
    worldIds.length = 0;
    foreignUserIds.length = 0;
  });

  afterAll(async () => { await pool?.end(); });

  async function app(enabled = true) {
    return buildServer(inertStorageServerOptions({
      config: config(enabled),
      pool,
      authoring: createRuntimeAuthoringApplication(pool, (value) => createHash("sha256").update(value).digest("hex"))
    }));
  }

  it("uses the composed owner-scoped application for durable commands and metadata-only pages", async () => {
    const server = await app();
    try {
      const request = submit(`route-${crypto.randomUUID()}`);
      const accepted = await server.inject({ method: "POST", url: "/api/v1/authoring/jobs", payload: request });
      expect(accepted.statusCode).toBe(202);
      expect(accepted.headers["cache-control"]).toBe("no-store");
      const job = accepted.json();
      jobIds.push(job.id);

      const replay = await server.inject({ method: "POST", url: "/api/v1/authoring/jobs", payload: request });
      expect(replay.statusCode).toBe(202);
      expect(replay.json().id).toBe(job.id);

      const spoofed = await server.inject({ method: "POST", url: "/api/v1/authoring/jobs", payload: { ...request, ownerUserId: crypto.randomUUID() } });
      expect(spoofed.statusCode).toBe(400);

      const detail = await server.inject({ method: "GET", url: `/api/v1/authoring/jobs/${job.id}` });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({ id: job.id, request: { prompt: request.prompt } });

      const page = await server.inject({ method: "GET", url: "/api/v1/authoring/jobs" });
      expect(page.statusCode).toBe(200);
      expect(page.json().jobs).toEqual(expect.arrayContaining([expect.objectContaining({ id: job.id })]));
      expect(JSON.stringify(page.json())).not.toContain(request.prompt);

      const stale = await server.inject({ method: "POST", url: `/api/v1/authoring/jobs/${job.id}/cancel`, payload: { expectedRevision: 7 } });
      expect(stale.statusCode).toBe(409);

      const foreign = await pool.query<{ id: string }>("INSERT INTO users (display_name) VALUES ($1) RETURNING id", [`authoring foreign ${crypto.randomUUID()}`]);
      const foreignOwner = foreign.rows[0]!.id;
      foreignUserIds.push(foreignOwner);
      const foreignJob = await createPostgresAuthoringRepository(pool).submit({ ownerUserId: foreignOwner }, submit(`foreign-${crypto.randomUUID()}`), "f".repeat(64));
      jobIds.push(foreignJob.id);
      const hidden = await server.inject({ method: "GET", url: `/api/v1/authoring/jobs/${foreignJob.id}` });
      expect(hidden.statusCode).toBe(404);
    } finally { await server.close(); }
  });

  it("inherits request security, bounded authoring bodies, and routes apply through the composed application", async () => {
    const server = await app();
    try {
      const rejectedOrigin = await server.inject({ method: "POST", url: "/api/v1/authoring/jobs", headers: { host: "localhost:8080", origin: "https://untrusted.invalid" }, payload: submit(`origin-${crypto.randomUUID()}`) });
      expect(rejectedOrigin.statusCode).toBe(403);
      expect(rejectedOrigin.headers["cache-control"]).toBe("no-store");

      const oversized = await server.inject({ method: "POST", url: "/api/v1/authoring/jobs", headers: { "content-type": "application/json" }, payload: JSON.stringify({ padding: "x".repeat(2 * 1024 * 1024 + 300 * 1024) }) });
      expect(oversized.statusCode).toBe(413);

      const accepted = await server.inject({ method: "POST", url: "/api/v1/authoring/jobs", payload: submit(`apply-${crypto.randomUUID()}`) });
      jobIds.push(accepted.json().id);
      const invalidApply = await server.inject({ method: "POST", url: `/api/v1/authoring/jobs/${accepted.json().id}/apply`, payload: { expectedRevision: 0, idempotencyKey: "apply-test", selectedStageIds: [], content: { schemaVersion: 5, world: { title: "Test", genre: "Test", tone: "Test", premise: "Test", backgroundStory: "Test", firstAction: "Test", rules: "" }, playableCharacters: [], entities: [], relationships: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], assets: [], defaults: { trackers: [] } } } });
      expect(invalidApply.statusCode).toBe(409);
      expect(invalidApply.json().code).toBe("authoring_invalid_state");
    } finally { await server.close(); }

    const disabled = await app(false);
    try {
      expect((await disabled.inject({ method: "GET", url: "/api/v1/authoring/capabilities" })).json()).toMatchObject({ enabled: false });
      expect((await disabled.inject({ method: "POST", url: "/api/v1/authoring/jobs", payload: submit(`disabled-${crypto.randomUUID()}`) })).statusCode).toBe(503);
    } finally { await disabled.close(); }
  });

  it("executes a reviewed apply through the actual HTTP runtime composition and returns its durable receipt", async () => {
    const server = await app();
    try {
      const accepted = await server.inject({ method: "POST", url: "/api/v1/authoring/jobs", payload: submit(`http-apply-${crypto.randomUUID()}`) });
      expect(accepted.statusCode).toBe(202);
      const job = accepted.json();
      jobIds.push(job.id);
      const stageId = job.stages[0].id;
      await pool.query("UPDATE authoring_jobs SET status = 'awaiting_review' WHERE id = $1", [job.id]);
      await pool.query("UPDATE authoring_job_stages SET status = 'validated', output = $2::jsonb WHERE id = $1", [stageId, JSON.stringify(appliedOutline)]);
      const reviewed = await server.inject({ method: "PUT", url: `/api/v1/authoring/jobs/${job.id}/review`, payload: {
        expectedRevision: job.revision, content: appliedContent, selectedStageIds: [stageId]
      } });
      expect(reviewed.statusCode).toBe(200);

      const applied = await server.inject({ method: "POST", url: `/api/v1/authoring/jobs/${job.id}/apply`, payload: {
        expectedRevision: reviewed.json().revision, idempotencyKey: "http-apply-receipt", selectedStageIds: [stageId], content: appliedContent
      } });
      expect(applied.statusCode).toBe(200);
      expect(applied.headers["cache-control"]).toBe("no-store");
      expect(applied.json()).toMatchObject({ jobId: job.id, draftRevision: 1 });
      worldIds.push(applied.json().worldId);
      await expect(pool.query("SELECT status, reviewed_content AS \"reviewedContent\", apply_receipt AS \"applyReceipt\" FROM authoring_jobs WHERE id = $1", [job.id]))
        .resolves.toMatchObject({ rows: [{ status: "applied", reviewedContent: null, applyReceipt: applied.json() }] });
    } finally { await server.close(); }
  });

  it("maps the repository's transactional active-proposal limit to a safe HTTP 429", async () => {
    const server = await app();
    try {
      const requests = Array.from({ length: 5 }, (_, index) => submit(`route-cap-${index}-${crypto.randomUUID()}`));
      for (const request of requests) {
        const response = await server.inject({ method: "POST", url: "/api/v1/authoring/jobs", payload: request });
        expect(response.statusCode).toBe(202);
        jobIds.push(response.json().id);
      }
      const rejected = await server.inject({ method: "POST", url: "/api/v1/authoring/jobs", payload: submit(`route-cap-overflow-${crypto.randomUUID()}`) });
      expect(rejected.statusCode).toBe(429);
      expect(rejected.json()).toMatchObject({ code: "authoring_active_job_limit", message: expect.stringContaining("Finish, cancel, or discard") });
      expect(rejected.payload).not.toContain("route-cap-overflow");

      const replay = await server.inject({ method: "POST", url: "/api/v1/authoring/jobs", payload: requests[0]! });
      expect(replay.statusCode).toBe(202);
      expect(replay.json().id).toBe(jobIds[0]);
    } finally { await server.close(); }
  });

  it("accepts contract-sized UTF-8 input beyond the old global limit and safely rejects durable oversize", async () => {
    const server = await app();
    try {
      const acceptedPayload = boundedCharacterSubmit(`utf8-accepted-${crypto.randomUUID()}`, 6);
      expect(Buffer.byteLength(JSON.stringify(acceptedPayload), "utf8")).toBeGreaterThan(1_048_576);
      expect(Buffer.byteLength(JSON.stringify(acceptedPayload), "utf8")).toBeLessThan(2 * 1024 * 1024);
      const accepted = await server.inject({ method: "POST", url: "/api/v1/authoring/jobs", payload: acceptedPayload });
      expect(accepted.statusCode).toBe(202);
      jobIds.push(accepted.json().id);

      const tooLargePayload = boundedCharacterSubmit(`utf8-too-large-${crypto.randomUUID()}`, 11);
      expect(Buffer.byteLength(JSON.stringify(tooLargePayload), "utf8")).toBeGreaterThan(2 * 1024 * 1024);
      expect(Buffer.byteLength(JSON.stringify(tooLargePayload), "utf8")).toBeLessThan(2 * 1024 * 1024 + 256 * 1024);
      const tooLarge = await server.inject({ method: "POST", url: "/api/v1/authoring/jobs", payload: tooLargePayload });
      expect(tooLarge.statusCode).toBe(413);
      expect(tooLarge.json()).toMatchObject({ code: "authoring_input_too_large" });
    } finally { await server.close(); }
  });
});
