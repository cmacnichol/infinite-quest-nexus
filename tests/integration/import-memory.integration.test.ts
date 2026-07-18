import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { importLegacyStory } from "../../services/api/src/import-service.js";
import {
  buildContextPreview,
  enqueueChronicleReindex,
  enqueueEmbeddingReindex,
  getChronicleMetrics,
  runChronicleJob,
  setCampaignEmbeddingConfig
} from "../../services/api/src/memory-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("legacy import and Chronicle integration", () => {
  let pool: DatabasePool;
  let campaignId = "";
  let assetRoot = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    assetRoot = await mkdtemp(resolve(tmpdir(), "infinitequest-assets-"));
    await migrateDatabase(pool, resolve("database/migrations"));
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    const request = storyImportRequestSchema.parse({ sourceName: "legacy-story.json", story: fixture });
    const imported = await importLegacyStory(pool, request);
    campaignId = imported.campaignId;
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (assetRoot) await rm(assetRoot, { recursive: true, force: true });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("imports idempotently", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.settings = {
      ...(fixture.settings || {}),
      nexusCampaignId: crypto.randomUUID(),
      nexusCampaignTurnCount: 999,
      nexusPendingGeneration: { jobId: crypto.randomUUID() }
    };
    const request = storyImportRequestSchema.parse({ sourceName: "same-content.story", story: fixture });
    const result = await importLegacyStory(pool, request);
    expect(result.campaignId).toBe(campaignId);
    expect(result.duplicate).toBe(true);
  });

  it("serializes concurrent imports of identical content", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Concurrent import ${crypto.randomUUID()}`;
    const request = storyImportRequestSchema.parse({ sourceName: "concurrent.story", story: fixture });
    const results = await Promise.all([
      importLegacyStory(pool, request),
      importLegacyStory(pool, request)
    ]);
    expect(results[0]?.campaignId).toBe(results[1]?.campaignId);
    expect(results.map((result) => result.duplicate).sort()).toEqual([false, true]);
  });

  it("retains complete history metrics", async () => {
    const metrics = await getChronicleMetrics(pool, campaignId);
    expect(metrics.turns).toBe(2);
    expect(metrics.memoryCount).toBe(3);
    expect(metrics.estimatedCompleteHistoryTokens).toBeGreaterThan(0);
  });

  it("builds a relevant fiction-only context without private mechanics", async () => {
    const context = await buildContextPreview(pool, campaignId, {
      budgetTokens: 4096,
      compression: "auto",
      query: "Location Beta Object Gamma",
      recentTurns: 8
    });
    const serialized = JSON.stringify(context.scopes);
    expect(serialized).toContain("Location Beta");
    expect(serialized).toContain("Object Gamma");
    expect(serialized).not.toContain("d100");
    expect(serialized).not.toContain("target was 65");
    expect(serialized).not.toContain("Private synthetic state");
  });

  it("moves imported data-URL illustrations into filesystem asset storage", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Asset import fixture ${crypto.randomUUID()}`;
    fixture.turns[0].imageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const request = storyImportRequestSchema.parse({ sourceName: "asset-import.story", story: fixture });
    const imported = await importLegacyStory(pool, request, { root: assetRoot });
    const result = await pool.query<{ image_url: string; storage_path: string }>(
      `SELECT t.image_url, a.storage_path
         FROM turns t
         JOIN asset_references ar ON ar.turn_id = t.id AND ar.campaign_id = t.campaign_id
         JOIN assets a ON a.id = ar.asset_id
        WHERE t.campaign_id = $1 AND t.turn_number = 1`,
      [imported.campaignId]
    );
    expect(result.rows[0]?.image_url).toMatch(/^\/api\/v1\/assets\//);
    expect(await readFile(resolve(assetRoot, result.rows[0]!.storage_path))).toBeInstanceOf(Buffer);
  });

  it("deduplicates active reindex requests and lets worker replicas claim different campaigns", async () => {
    const firstJob = await enqueueChronicleReindex(pool, campaignId);
    const duplicateJob = await enqueueChronicleReindex(pool, campaignId);
    expect(duplicateJob).toBe(firstJob);

    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Worker replica fixture ${crypto.randomUUID()}`;
    const secondCampaign = await importLegacyStory(
      pool,
      storyImportRequestSchema.parse({ sourceName: "worker-replica.story", story: fixture })
    );
    const secondJob = await enqueueChronicleReindex(pool, secondCampaign.campaignId);

    const claims = await Promise.all([
      runChronicleJob(pool, "integration-worker-a", 30),
      runChronicleJob(pool, "integration-worker-b", 30)
    ]);
    expect(claims).toEqual([true, true]);

    const jobs = await pool.query<{ id: string; status: string; attempts: number }>(
      "SELECT id, status, attempts FROM chronicle_jobs WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[firstJob, secondJob]]
    );
    expect(jobs.rows).toHaveLength(2);
    expect(jobs.rows.every((job) => job.status === "completed" && job.attempts === 1)).toBe(true);
  });

  it("indexes fresh vectors and uses hybrid retrieval with a safe lexical fallback", async () => {
    const ownerUserId = await initialOwnerId(pool);
    const provider = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles (
         owner_user_id, name, provider_type, provider_role, base_url, default_model
       ) VALUES ($1,$2,'lmstudio','embedding','http://embedding.test','fixture-embed') RETURNING id`,
      [ownerUserId, `Embedding fixture ${crypto.randomUUID()}`]
    );
    await setCampaignEmbeddingConfig(pool, campaignId, {
      enabled: true,
      providerProfileId: provider.rows[0]!.id,
      model: "fixture-embed",
      batchSize: 2
    });
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const { input } = JSON.parse(String(init?.body)) as { input: string[] };
      return new Response(JSON.stringify({
        model: "fixture-embed",
        data: input.map((content, index) => ({
          index,
          embedding: /Object Gamma|related marker|Marker One/i.test(content) ? [1, 0, 0] : [0, 1, 0]
        }))
      }), { status: 200 });
    }));
    const jobId = await enqueueEmbeddingReindex(pool, campaignId);
    expect(jobId).toBeTruthy();
    expect(await runChronicleJob(pool, "embedding-worker", 30, "")).toBe(true);
    const indexed = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM chronicle_memories
        WHERE owner_user_id = $1 AND campaign_id = $2 AND embedding IS NOT NULL
          AND embedding_content_hash IS NOT NULL`,
      [ownerUserId, campaignId]
    );
    expect(Number(indexed.rows[0]?.count)).toBeGreaterThan(0);

    const hybrid = await buildContextPreview(pool, campaignId, {
      budgetTokens: 4096,
      compression: "auto",
      query: "related marker",
      recentTurns: 1
    });
    expect(hybrid.retrieval.mode).toBe("hybrid");
    expect(hybrid.scopes.chronicle.some((memory) => Number(memory.semanticRelevance) > 0.9)).toBe(true);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("offline", { status: 503 })));
    const fallback = await buildContextPreview(pool, campaignId, {
      budgetTokens: 4096,
      compression: "auto",
      query: "Location Beta",
      recentTurns: 1
    });
    expect(fallback.retrieval.mode).toBe("lexical_fallback");
    expect(JSON.stringify(fallback.scopes)).toContain("Location Beta");
  });
});
