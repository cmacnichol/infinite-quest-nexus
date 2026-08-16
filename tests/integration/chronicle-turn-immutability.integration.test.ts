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

    await branchCampaign(pool, sourceCampaignId, {
      targetTurnNumber: sourceTurnRow.turn_number,
      expectedCurrentTurnNumber: activeTurnNumber.rows[0].active_turn_number
    });
    await expectUnchanged();
  });
});
