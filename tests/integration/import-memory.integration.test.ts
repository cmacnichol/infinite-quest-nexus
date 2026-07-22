import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabasePool, initialOwnerId, withTransaction, type DatabasePool } from "../../packages/database/src/pool.js";
import { sha256 } from "../../packages/domain/src/text.js";
import { createCanonicalFactId } from "../../packages/domain/src/canonical-facts.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { importLegacyStory } from "../../services/api/src/import-service.js";
import { exportCampaign } from "../../services/api/src/world-service.js";
import {
  buildContextPreview,
  enqueueChronicleReindex,
  enqueueEmbeddingReindex,
  getChronicleMetrics,
  rebuildCampaignMemories,
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
    const draft = await pool.query<{ based_on_world_version_id: string; revision: number }>(
      `SELECT wd.based_on_world_version_id, wd.revision
         FROM world_drafts wd JOIN campaigns c ON c.world_version_id = wd.based_on_world_version_id
        WHERE c.id = $1`,
      [campaignId]
    );
    expect(draft.rows[0]).toMatchObject({ revision: 1 });
  });

  it("reconnects an exact ledger when its saved world-version id is stale", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    const before = await pool.query<{ worlds: string; campaigns: string; world_id: string }>(
      `SELECT (SELECT count(*) FROM worlds)::text AS worlds,
              (SELECT count(*) FROM campaigns)::text AS campaigns,
              wv.world_id
         FROM campaigns c JOIN world_versions wv ON wv.id = c.world_version_id
        WHERE c.id = $1`,
      [campaignId]
    );
    const result = await importLegacyStory(pool, storyImportRequestSchema.parse({
      sourceName: `stale-link-${crypto.randomUUID()}.story`,
      story: fixture,
      targetWorldVersionId: crypto.randomUUID()
    }));
    const after = await pool.query<{ worlds: string; campaigns: string }>(
      `SELECT (SELECT count(*) FROM worlds)::text AS worlds,
              (SELECT count(*) FROM campaigns)::text AS campaigns`
    );
    expect(result).toMatchObject({ campaignId, worldId: before.rows[0]?.world_id, duplicate: true });
    expect(after.rows[0]).toEqual({ worlds: before.rows[0]?.worlds, campaigns: before.rows[0]?.campaigns });
  });

  it("creates an explicit campaign branch while reusing identical world canon", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.storyImportProvenance = {
      sourceType: "nexus_campaign_branch",
      parentCampaignId: campaignId,
      branchTurnNumber: fixture.turns.length,
      branchId: crypto.randomUUID()
    };
    const before = await pool.query<{ worlds: string; campaigns: string; world_id: string }>(
      `SELECT (SELECT count(*) FROM worlds)::text AS worlds,
              (SELECT count(*) FROM campaigns)::text AS campaigns,
              wv.world_id
         FROM campaigns c JOIN world_versions wv ON wv.id = c.world_version_id
        WHERE c.id = $1`,
      [campaignId]
    );
    const result = await importLegacyStory(pool, storyImportRequestSchema.parse({
      sourceName: `explicit-branch-${crypto.randomUUID()}.story`,
      story: fixture,
      targetWorldVersionId: crypto.randomUUID()
    }));
    const after = await pool.query<{ worlds: string; campaigns: string }>(
      `SELECT (SELECT count(*) FROM worlds)::text AS worlds,
              (SELECT count(*) FROM campaigns)::text AS campaigns`
    );
    expect(result.campaignId).not.toBe(campaignId);
    expect(result.worldId).toBe(before.rows[0]?.world_id);
    expect(Number(after.rows[0]?.worlds)).toBe(Number(before.rows[0]?.worlds));
    expect(Number(after.rows[0]?.campaigns)).toBe(Number(before.rows[0]?.campaigns) + 1);
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
    expect(metrics.semanticHealth).toMatchObject({ status: "disabled", enabled: false, totalMemories: 3 });
  });

  it("round-trips loadable story settings and history without credentials", async () => {
    const exported = await exportCampaign(pool, campaignId) as Record<string, any>;
    expect(exported.format).toBe("infinite-quest-campaign");
    expect(exported.settings.aiProvider).toBe("openrouter");
    expect(exported.settings).not.toHaveProperty("apiKey");
    expect(exported.settings.storyHistoryTokenLimit).toBe(128000);
    expect(exported.settings.storyLength).toBe("long");
    expect((await pool.query<{ story_length_profile: string }>("SELECT story_length_profile FROM campaigns WHERE id = $1", [campaignId])).rows[0]?.story_length_profile).toBe("long");
    expect(exported.fullHistory).toMatchObject({
      characters: "Test Character remains present.",
      otherImportantNotes: "Object Gamma remains unresolved."
    });
    expect(exported.fullHistoryCompressedThroughTurn).toBe(2);
    expect(exported.baseTrackersAtStart).toEqual(exported.defaultTriggers);
  });

  it("builds a relevant fiction-only context without private mechanics", async () => {
    const context = await buildContextPreview(pool, campaignId, {
      budgetTokens: 4096,
      compression: "auto",
      query: "Location Beta Object Gamma",
      recentTurns: 8
    });
    const serialized = JSON.stringify(context.scopes);
    expect(context.budget.estimatedSelectedTokens).toBeLessThanOrEqual(context.budget.configuredTokens);
    expect(context.scopes.authoritativeRules).toBe("Use synthetic fixture markers only.");
    expect(context.scopes.worldCanon).not.toHaveProperty("rules");
    expect(serialized).toContain("Location Beta");
    expect(serialized).toContain("Object Gamma");
    expect(serialized).not.toContain("d100");
    expect(serialized).not.toContain("target was 65");
    expect(serialized).not.toContain("Private synthetic state");
  });

  it("keeps semantic retrieval inside a historical turn cutoff", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Temporal semantic fixture ${crypto.randomUUID()}`;
    const imported = await importLegacyStory(
      pool,
      storyImportRequestSchema.parse({ sourceName: "temporal-semantic.story", story: fixture })
    );
    const ownerUserId = await initialOwnerId(pool);
    const campaign = await pool.query<{ world_version_id: string }>(
      "SELECT world_version_id FROM campaigns WHERE id = $1 AND owner_user_id = $2",
      [imported.campaignId, ownerUserId]
    );
    await pool.query(
      `INSERT INTO chronicle_memories (
         owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content,
         token_estimate, importance, entities, metadata
       ) VALUES ($1,$2,$3,'canonical_fact',99,$4,8,1,$5,'{}'::jsonb)`,
      [ownerUserId, imported.campaignId, campaign.rows[0]!.world_version_id,
        "Canonical facts established at future turn\n- Future Semantic Marker", ["Future Semantic Marker"]]
    );
    const provider = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles (
         owner_user_id, name, provider_type, provider_role, base_url, default_model
       ) VALUES ($1,$2,'openai_compatible','embedding','http://embedding.test','text-embedding-nomic-embed-text-v1.5') RETURNING id`,
      [ownerUserId, `Temporal embedding fixture ${crypto.randomUUID()}`]
    );
    await setCampaignEmbeddingConfig(pool, imported.campaignId, {
      enabled: true,
      providerProfileId: provider.rows[0]!.id,
      model: "text-embedding-nomic-embed-text-v1.5",
      batchSize: 8
    });
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (!init?.body) {
        return new Response(JSON.stringify({ data: [{ id: "text-embedding-nomic-embed-text-v1.5" }] }), { status: 200 });
      }
      const { input } = JSON.parse(String(init?.body)) as { input: string[] };
      return new Response(JSON.stringify({
        model: "text-embedding-nomic-embed-text-v1.5",
        data: input.map((_content, index) => ({ index, embedding: [1, 0, 0] }))
      }), { status: 200 });
    }));
    const embeddingJobId = await enqueueEmbeddingReindex(pool, imported.campaignId);
    expect(embeddingJobId).toBeTruthy();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const pending = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM chronicle_jobs
          WHERE campaign_id = $1 AND status IN ('queued','running')`,
        [imported.campaignId]
      );
      if (Number(pending.rows[0]?.count) === 0) break;
      expect(await runChronicleJob(pool, `temporal-embedding-worker-${attempt}`, 30, "")).toBe(true);
    }
    const completed = await pool.query<{ status: string }>("SELECT status FROM chronicle_jobs WHERE id = $1", [embeddingJobId]);
    expect(completed.rows[0]?.status).toBe("completed");
    const remaining = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM chronicle_jobs
        WHERE campaign_id = $1 AND status IN ('queued','running')`,
      [imported.campaignId]
    );
    expect(Number(remaining.rows[0]?.count)).toBe(0);

    const historical = await buildContextPreview(
      pool,
      imported.campaignId,
      { budgetTokens: 4096, compression: "auto", query: "Future Semantic Marker", recentTurns: 8 },
      "",
      {},
      { throughTurnNumber: 1 }
    );
    expect(historical.retrieval.mode).toBe("hybrid");
    expect(JSON.stringify(historical.scopes)).not.toContain("Future Semantic Marker");
    const current = await buildContextPreview(pool, imported.campaignId, {
      budgetTokens: 4096,
      compression: "auto",
      query: "Future Semantic Marker",
      recentTurns: 8
    });
    expect(JSON.stringify(current.scopes)).toContain("Future Semantic Marker");
    await setCampaignEmbeddingConfig(pool, imported.campaignId, {
      enabled: false,
      providerProfileId: provider.rows[0]!.id,
      model: "text-embedding-nomic-embed-text-v1.5",
      batchSize: 8
    });
    await pool.query("UPDATE provider_profiles SET enabled = false WHERE id = $1", [provider.rows[0]!.id]);
  });

  it("rebuilds stable canonical facts and supersedes paraphrased facts by id", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Structured facts ${crypto.randomUUID()}`;
    const imported = await importLegacyStory(
      pool,
      storyImportRequestSchema.parse({ sourceName: "structured-facts.story", story: fixture })
    );
    const ownerUserId = await initialOwnerId(pool);
    const turns = await pool.query<{ id: string; turn_number: number }>(
      "SELECT id, turn_number FROM turns WHERE campaign_id = $1 ORDER BY turn_number",
      [imported.campaignId]
    );
    const firstTurn = turns.rows.find((turn) => turn.turn_number === 1)!;
    const secondTurn = turns.rows.find((turn) => turn.turn_number === 2)!;
    const originalContent = "The eastern gate is open to travelers.";
    const replacementContent = "No traveler can pass through the eastern gate now.";
    const originalFactId = createCanonicalFactId({
      campaignId: imported.campaignId,
      sourceTurnId: firstTurn.id,
      factIndex: 0,
      content: originalContent
    });
    const replacementFactId = createCanonicalFactId({
      campaignId: imported.campaignId,
      sourceTurnId: secondTurn.id,
      factIndex: 0,
      content: replacementContent
    });
    await pool.query(
      `UPDATE turns SET state_snapshot_private = state_snapshot_private || $3::jsonb
        WHERE campaign_id = $1 AND id = $2`,
      [imported.campaignId, firstTurn.id, JSON.stringify({
        canonicalFacts: [originalContent],
        supersededFacts: [],
        canonicalFactUpdates: [{ content: originalContent, supersedesFactIds: [] }]
      })]
    );
    await pool.query(
      `UPDATE turns SET state_snapshot_private = state_snapshot_private || $3::jsonb
        WHERE campaign_id = $1 AND id = $2`,
      [imported.campaignId, secondTurn.id, JSON.stringify({
        canonicalFacts: [replacementContent],
        supersededFacts: [],
        canonicalFactUpdates: [{ content: replacementContent, supersedesFactIds: [originalFactId] }]
      })]
    );

    await withTransaction(pool, (client) => rebuildCampaignMemories(client, ownerUserId, imported.campaignId));
    const facts = await pool.query<{
      id: string;
      content: string;
      valid_until_turn: number | null;
      superseded_by_fact_id: string | null;
    }>(
      `SELECT id, content, valid_until_turn, superseded_by_fact_id
         FROM campaign_canonical_facts
        WHERE owner_user_id = $1 AND campaign_id = $2 ORDER BY source_turn_number`,
      [ownerUserId, imported.campaignId]
    );
    expect(facts.rows).toEqual([
      { id: originalFactId, content: originalContent, valid_until_turn: 2, superseded_by_fact_id: replacementFactId },
      { id: replacementFactId, content: replacementContent, valid_until_turn: null, superseded_by_fact_id: null }
    ]);

    const current = await buildContextPreview(pool, imported.campaignId, {
      budgetTokens: 4096,
      compression: "auto",
      query: "eastern gate",
      recentTurns: 8
    });
    expect(JSON.stringify(current.scopes)).toContain(replacementContent);
    expect(JSON.stringify(current.scopes)).not.toContain(originalContent);
    const historical = await buildContextPreview(
      pool,
      imported.campaignId,
      { budgetTokens: 4096, compression: "auto", query: "eastern gate", recentTurns: 8 },
      "",
      {},
      { throughTurnNumber: 1 }
    );
    expect(JSON.stringify(historical.scopes)).toContain(originalContent);
    expect(JSON.stringify(historical.scopes)).not.toContain(replacementContent);

    await withTransaction(pool, (client) => rebuildCampaignMemories(client, ownerUserId, imported.campaignId));
    const rebuiltIds = await pool.query<{ id: string }>(
      "SELECT id FROM campaign_canonical_facts WHERE campaign_id = $1 ORDER BY source_turn_number",
      [imported.campaignId]
    );
    expect(rebuiltIds.rows.map((fact) => fact.id)).toEqual([originalFactId, replacementFactId]);
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
       ) VALUES ($1,$2,'lmstudio','embedding','http://embedding.test','text-embedding-nomic-embed-text-v1.5') RETURNING id`,
      [ownerUserId, `Embedding fixture ${crypto.randomUUID()}`]
    );
    await setCampaignEmbeddingConfig(pool, campaignId, {
      enabled: true,
      providerProfileId: provider.rows[0]!.id,
      model: "text-embedding-nomic-embed-text-v1.5",
      batchSize: 2
    });
    const embeddingInputs: string[][] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const { input } = JSON.parse(String(init?.body)) as { input: string[] };
      embeddingInputs.push(input);
      return new Response(JSON.stringify({
        model: "text-embedding-nomic-embed-text-v1.5",
        data: input.map((content, index) => ({
          index,
          embedding: /Object Gamma|related marker|Marker One/i.test(content) ? [1, 0, 0] : [0, 1, 0]
        }))
      }), { status: 200 });
    }));
    const jobId = await enqueueEmbeddingReindex(pool, campaignId);
    expect(jobId).toBeTruthy();
    expect(await runChronicleJob(pool, "embedding-worker", 30, "")).toBe(true);
    expect(embeddingInputs.flat().every((input) => input.startsWith("search_document: "))).toBe(true);
    const indexed = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM chronicle_memories
        WHERE owner_user_id = $1 AND campaign_id = $2 AND embedding IS NOT NULL
          AND embedding_content_hash IS NOT NULL`,
      [ownerUserId, campaignId]
    );
    expect(Number(indexed.rows[0]?.count)).toBeGreaterThan(0);
    const health = (await getChronicleMetrics(pool, campaignId)).semanticHealth;
    expect(health).toMatchObject({
      status: "healthy",
      providerHealth: "healthy",
      coveragePercent: 100,
      jobId,
      jobStatus: "completed"
    });
    expect(health.indexedMemories).toBe(health.totalMemories);

    const hybrid = await buildContextPreview(pool, campaignId, {
      budgetTokens: 4096,
      compression: "auto",
      query: "related marker",
      recentTurns: 1
    });
    expect(hybrid.retrieval.mode).toBe("hybrid");
    expect(embeddingInputs.at(-1)?.[0]).toMatch(/^search_query: /);
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

  it("requeues a running embedding job when Chronicle content changes concurrently", async () => {
    await pool.query(
      `UPDATE chronicle_memories SET content = content || E'\\nRace preparation.'
        WHERE id = (SELECT id FROM chronicle_memories WHERE campaign_id = $1 ORDER BY ordinal LIMIT 1)`,
      [campaignId]
    );
    let releaseFirstBatch!: () => void;
    let markStarted!: () => void;
    const firstBatchStarted = new Promise<void>((resolveStarted) => { markStarted = resolveStarted; });
    const release = new Promise<void>((resolveRelease) => { releaseFirstBatch = resolveRelease; });
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (!init?.body) {
        return new Response(JSON.stringify({ data: [{ id: "text-embedding-nomic-embed-text-v1.5" }] }), { status: 200 });
      }
      const { input } = JSON.parse(String(init.body)) as { input: string[] };
      markStarted();
      await release;
      return new Response(JSON.stringify({
        model: "text-embedding-nomic-embed-text-v1.5",
        data: input.map((_content, index) => ({ index, embedding: [1, 0, 0] }))
      }), { status: 200 });
    }));
    const jobId = await enqueueEmbeddingReindex(pool, campaignId);
    expect(jobId).toBeTruthy();
    const firstRun = runChronicleJob(pool, "embedding-race-worker-a", 30, "");
    await firstBatchStarted;
    await pool.query(
      `UPDATE chronicle_memories SET content = content || E'\\nConcurrent accepted fact.'
        WHERE id = (SELECT id FROM chronicle_memories WHERE campaign_id = $1 ORDER BY ordinal LIMIT 1)`,
      [campaignId]
    );
    expect(await enqueueEmbeddingReindex(pool, campaignId)).toBe(jobId);
    releaseFirstBatch();
    expect(await firstRun).toBe(true);
    const queued = await pool.query<{ status: string; work_version: string }>(
      "SELECT status, work_version::text FROM chronicle_jobs WHERE id = $1",
      [jobId]
    );
    expect(queued.rows[0]?.status).toBe("queued");

    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (!init?.body) {
        return new Response(JSON.stringify({ data: [{ id: "text-embedding-nomic-embed-text-v1.5" }] }), { status: 200 });
      }
      const { input } = JSON.parse(String(init.body)) as { input: string[] };
      return new Response(JSON.stringify({
        model: "text-embedding-nomic-embed-text-v1.5",
        data: input.map((_content, index) => ({ index, embedding: [1, 0, 0] }))
      }), { status: 200 });
    }));
    expect(await runChronicleJob(pool, "embedding-race-worker-b", 30, "")).toBe(true);
    const fresh = await pool.query<{ content: string; embedding_content_hash: string | null; embedded: boolean }>(
      `SELECT content, embedding_content_hash, embedding IS NOT NULL AS embedded
         FROM chronicle_memories WHERE campaign_id = $1`,
      [campaignId]
    );
    expect(fresh.rows.every((memory) => memory.embedded && memory.embedding_content_hash === sha256(memory.content))).toBe(true);
  });

  it("keeps long-history retrieval bounded while recovering a middle-period fact", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Long Chronicle ${crypto.randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "long-chronicle.story", story: fixture }));
    const ownerUserId = await initialOwnerId(pool);
    await pool.query(
      `INSERT INTO turns (owner_user_id, campaign_id, turn_number, action, narration)
       SELECT $1, $2, ordinal, 'Continue the expedition.',
              CASE WHEN ordinal = 350 THEN 'NeedleMiddleMarker is hidden beneath Location Delta.'
                   ELSE 'The expedition advances through a synthetic location.' END
         FROM generate_series(3, 702) ordinal`,
      [ownerUserId, imported.campaignId]
    );
    await pool.query(
      `INSERT INTO chronicle_memories (
         owner_user_id, campaign_id, world_version_id, turn_id, memory_kind, ordinal,
         content, token_estimate, importance, entities, metadata
       )
       SELECT t.owner_user_id, t.campaign_id, c.world_version_id, t.id, 'turn_fiction', t.turn_number,
              'Turn ' || t.turn_number || E'\nPlayer action: ' || t.action || E'\nNarration: ' || t.narration,
              24, 0.5, ARRAY[]::text[], '{}'::jsonb
         FROM turns t JOIN campaigns c ON c.id = t.campaign_id
        WHERE t.campaign_id = $1 AND t.turn_number >= 3`,
      [imported.campaignId]
    );
    await pool.query("UPDATE campaigns SET active_turn_number = 702 WHERE id = $1", [imported.campaignId]);
    const context = await buildContextPreview(pool, imported.campaignId, {
      budgetTokens: 4096,
      compression: "auto",
      query: "Where is NeedleMiddleMarker?",
      recentTurns: 8
    });
    expect(JSON.stringify(context.scopes)).toContain("NeedleMiddleMarker");
    expect(context.scopes.chronicle.length).toBeLessThan(100);
    expect(context.budget.estimatedSelectedTokens).toBeLessThanOrEqual(4096);
    expect(context.metrics.turns).toBe(702);
  });
});
