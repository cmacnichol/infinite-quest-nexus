import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { createPostgresTurnCorrectionRepository } from "../../packages/database/src/turn-correction-repository.js";
import { createTurnCorrectionApplication } from "../../packages/application/src/turn-corrections/index.js";
import { toSafeProviderConfiguration } from "../../packages/application/src/providers/index.js";
import {
  branchCampaign,
  buildContextPreview,
  enqueueChronicleReindex,
  enqueueEmbeddingReindex,
  importLegacyStory,
  rebuildCampaignMemories,
  runNextChronicle,
  setCampaignEmbeddingConfig
} from "../helpers/memory-aware-services.js";
import { memoryGeneration } from "../helpers/memory-applications.js";
import { apiProviderGraph } from "../helpers/provider-application-fixtures.js";
import { installIntegrationProviderTransport } from "./provider-transport-test-helper.js";
import { snapshotTurnRows } from "../helpers/turn-row-snapshot.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("Chronicle accepted-turn immutability", () => {
  let pool: DatabasePool;
  let ownerUserId = "";
  let providerTransport: ReturnType<typeof installIntegrationProviderTransport>;

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    providerTransport = installIntegrationProviderTransport(["127.0.0.0/8", "embedding.test"]);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });

  afterAll(async () => {
    if (providerTransport) await providerTransport.close();
    if (pool) await pool.end();
  });

  afterEach(() => vi.unstubAllGlobals());

  async function runChronicleJob(jobId: string, workerId: string, credentialSecret = "test-credential-secret") {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const job = await pool.query<{ status: string }>(
        "SELECT status FROM chronicle_jobs WHERE id = $1",
        [jobId]
      );
      const status = job.rows[0]?.status;
      if (status === "completed") return;
      expect(status).toMatch(/^(queued|running)$/u);
      expect(await runNextChronicle(pool, `${workerId}-${attempt}`, 30, credentialSecret)).toBe(true);
    }
    throw new Error(`Chronicle job ${jobId} did not complete after six worker claims.`);
  }

  it("uses the saved latest narration in the next turn context without changing accepted rows", async () => {
    const story = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    story.turns.at(-1).narration = "The harbor bell is brass.";
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({
      sourceName: `latest-narration-context-${crypto.randomUUID()}.story`,
      story
    }));
    const originalRows = await snapshotTurnRows(pool, ownerUserId, imported.campaignId);
    const latestTurn = await pool.query<{ id: string; turn_number: number }>(
      "SELECT id, turn_number FROM turns WHERE campaign_id = $1 AND owner_user_id = $2 ORDER BY turn_number DESC LIMIT 1",
      [imported.campaignId, ownerUserId]
    );
    const corrections = createTurnCorrectionApplication({
      corrections: createPostgresTurnCorrectionRepository(pool, { memory: memoryGeneration(pool) })
    });
    await corrections.correctNarration({ ownerUserId, campaignId: imported.campaignId }, {
      turnId: latestTurn.rows[0]!.id,
      narration: "The harbor bell is silver.",
      expectedCorrectionRevision: 0,
      expectedActiveTurnNumber: latestTurn.rows[0]!.turn_number,
      source: "user_edit"
    });

    const context = await buildContextPreview(pool, imported.campaignId, {
      budgetTokens: 4_096, compression: "full", query: "Inspect the harbor bell.", recentTurns: 8
    });
    expect(context.scopes.currentScene.content).toContain("The harbor bell is silver.");
    expect(context.scopes.currentScene.content).not.toContain("The harbor bell is brass.");
    await expect(snapshotTurnRows(pool, ownerUserId, imported.campaignId)).resolves.toEqual(originalRows);
  });

  it("keeps corrected source turn rows unchanged by derived Chronicle work", async () => {
    const story = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    story.world.title = `Chronicle turn snapshot ${crypto.randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({
      sourceName: `chronicle-turn-snapshot-${crypto.randomUUID()}.story`,
      story
    }));
    const sourceCampaignId = imported.campaignId;
    const sourceTurn = await pool.query<{ id: string; turn_number: number }>(
      `SELECT id, turn_number
         FROM turns
        WHERE owner_user_id = $1 AND campaign_id = $2
        ORDER BY turn_number
        LIMIT 1`,
      [ownerUserId, sourceCampaignId]
    );
    const sourceTurnRow = sourceTurn.rows[0];
    const activeTurnNumber = await pool.query<{ active_turn_number: number }>(
      "SELECT active_turn_number FROM campaigns WHERE id = $1 AND owner_user_id = $2",
      [sourceCampaignId, ownerUserId]
    );
    if (sourceTurnRow === undefined || activeTurnNumber.rows[0] === undefined) {
      throw new Error("Expected imported campaign to contain an accepted source turn.");
    }

    const corrections = createTurnCorrectionApplication({
      corrections: createPostgresTurnCorrectionRepository(pool, { memory: memoryGeneration(pool) })
    });
    await corrections.correctNarration(
      { ownerUserId, campaignId: sourceCampaignId },
      {
        turnId: sourceTurnRow.id,
        narration: "A corrected moon hangs above the quiet harbor.",
        expectedCorrectionRevision: 0,
        expectedActiveTurnNumber: activeTurnNumber.rows[0].active_turn_number,
        source: "user_edit"
      }
    );
    await pool.query(
      "DELETE FROM chronicle_jobs WHERE owner_user_id = $1 AND campaign_id = $2",
      [ownerUserId, sourceCampaignId]
    );

    const expected = await snapshotTurnRows(pool, ownerUserId, sourceCampaignId);
    expect(expected).not.toHaveLength(0);
    const expectUnchanged = async () => {
      await expect(snapshotTurnRows(pool, ownerUserId, sourceCampaignId)).resolves.toEqual(expected);
    };

    const legacyReindexJobId = await enqueueChronicleReindex(pool, sourceCampaignId);
    expect(legacyReindexJobId).toEqual(expect.any(String));
    await runChronicleJob(legacyReindexJobId, "turn-immutability-reindex");
    await expectUnchanged();

    const provider = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles (
         owner_user_id, name, provider_type, provider_role, base_url, default_model
       ) VALUES ($1,$2,'lmstudio','embedding','http://embedding.test','text-embedding-nomic-embed-text-v1.5')
       RETURNING id`,
      [ownerUserId, `Turn snapshot embedding ${crypto.randomUUID()}`]
    );
    const providerProfileId = provider.rows[0]?.id;
    if (!providerProfileId) throw new Error("Expected embedding provider fixture.");
    await setCampaignEmbeddingConfig(pool, sourceCampaignId, {
      enabled: true,
      providerProfileId,
      model: "text-embedding-nomic-embed-text-v1.5",
      batchSize: 2
    });
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (!init?.body) {
        return new Response(JSON.stringify({
          data: [{ id: "text-embedding-nomic-embed-text-v1.5" }]
        }), { status: 200 });
      }
      const { input } = JSON.parse(String(init?.body)) as { input: string[] };
      return new Response(JSON.stringify({
        model: "text-embedding-nomic-embed-text-v1.5",
        data: input.map((_content, index) => ({ index, embedding: [1, 0, 0] }))
      }), { status: 200 });
    }));
    const legacyEmbeddingJobId = await enqueueEmbeddingReindex(pool, sourceCampaignId);
    expect(legacyEmbeddingJobId).toEqual(expect.any(String));
    await runChronicleJob(legacyEmbeddingJobId!, "turn-immutability-embedding", "");
    const embeddedMemories = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM chronicle_memories
        WHERE owner_user_id = $1 AND campaign_id = $2 AND embedding IS NOT NULL`,
      [ownerUserId, sourceCampaignId]
    );
    expect(Number(embeddedMemories.rows[0]?.count)).toBeGreaterThan(0);
    await expectUnchanged();

    await buildContextPreview(pool, sourceCampaignId, {
      budgetTokens: 4_096,
      compression: "auto",
      query: "What changed above the harbor?",
      recentTurns: 2
    });
    await expectUnchanged();

    const providerConfiguration = await apiProviderGraph(pool, "test-credential-secret").application.updateProfile({
      ownerUserId,
      providerProfileId,
      changes: { configuration: toSafeProviderConfiguration({ streaming: true }) }
    });
    expect(providerConfiguration.profile.configuration).toMatchObject({ streaming: true });
    await expectUnchanged();

    expect(await rebuildCampaignMemories(pool, sourceCampaignId)).toBeGreaterThan(0);
    await expectUnchanged();

    const staleParent = await pool.query<{
      id: string;
      content_hash: string;
      content: string;
      token_estimate: number;
      world_version_id: string;
    }>(
      `SELECT id,content_hash,content,token_estimate,world_version_id
         FROM chronicle_memories
        WHERE owner_user_id=$1 AND campaign_id=$2 AND turn_id=$3 AND memory_kind='turn_fiction'`,
      [ownerUserId, sourceCampaignId, sourceTurnRow.id]
    );
    const staleParentRow = staleParent.rows[0]!;
    const staleChunk = await pool.query<{ id: string }>(
      `INSERT INTO chronicle_memory_chunks (
         owner_user_id,campaign_id,world_version_id,parent_memory_id,parent_content_hash,
         chunking_protocol_version,chunk_ordinal,chunk_kind,content,source_end_offset,
         token_estimate,embedding_status,embedding_skip_reason
       ) VALUES ($1,$2,$3,$4,$5,'chronicle-chunk-v1',0,'turn_narration',$6,length($6),$7,'skipped','semantic_retrieval_disabled')
       RETURNING id`,
      [ownerUserId, sourceCampaignId, staleParentRow.world_version_id, staleParentRow.id,
        staleParentRow.content_hash, staleParentRow.content, staleParentRow.token_estimate]
    );
    await pool.query("DELETE FROM chronicle_chunk_jobs WHERE campaign_id=$1", [sourceCampaignId]);
    await corrections.correctNarration(
      { ownerUserId, campaignId: sourceCampaignId },
      {
        turnId: sourceTurnRow.id,
        narration: "The corrected moon now hangs above the lantern-lit harbor.",
        expectedCorrectionRevision: 1,
        expectedActiveTurnNumber: activeTurnNumber.rows[0].active_turn_number,
        source: "user_edit"
      }
    );
    await expect(pool.query("SELECT id FROM chronicle_memories WHERE id=$1", [staleParentRow.id]))
      .resolves.toMatchObject({ rows: [] });
    await expect(pool.query("SELECT id FROM chronicle_memory_chunks WHERE id=$1", [staleChunk.rows[0]!.id]))
      .resolves.toMatchObject({ rows: [] });
    await expect(pool.query<{ status: string }>(
      "SELECT status FROM chronicle_chunk_jobs WHERE campaign_id=$1",
      [sourceCampaignId]
    )).resolves.toMatchObject({ rows: [{ status: "queued" }] });
    await expectUnchanged();

    const branch = await branchCampaign(pool, sourceCampaignId, {
      targetTurnNumber: sourceTurnRow.turn_number,
      expectedCurrentTurnNumber: activeTurnNumber.rows[0].active_turn_number
    });
    const branchIndexingJob = await pool.query<{ id: string }>(
      `SELECT id
         FROM chronicle_jobs
        WHERE owner_user_id = $1 AND campaign_id = $2 AND job_type = 'embed_campaign'
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [ownerUserId, branch.id]
    );
    const branchIndexingJobId = branchIndexingJob.rows[0]?.id;
    expect(branchIndexingJobId).toEqual(expect.any(String));
    await runChronicleJob(branchIndexingJobId!, "turn-immutability-branch-indexing", "");
    await expectUnchanged();
    await pool.query(
      "DELETE FROM chronicle_chunk_jobs WHERE campaign_id IN ($1,$2)",
      [sourceCampaignId, branch.id]
    );
  });
});
