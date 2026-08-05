import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toSafeProviderConfiguration } from "../../packages/application/src/providers/index.js";
import {
  createProviderCostRepository,
  createProviderCostTransactionContext
} from "../../packages/database/src/cost-repository.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, type DatabaseClient, type DatabasePool } from "../../packages/database/src/pool.js";
import { createPostgresProviderRepositories, writeEncryptedProviderCredential } from "../../packages/database/src/provider-repository.js";
import { createPromptRepository } from "../../packages/database/src/prompt-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

type Fixture = Readonly<{ ownerUserId: string; campaignId: string; turnId: string }>;

integration("provider PostgreSQL adapters", () => {
  let pool: DatabasePool;
  let first: Fixture;
  let second: Fixture;

  async function fixture(label: string): Promise<Fixture> {
    const owner = await pool.query<{ id: string }>(
      "INSERT INTO users(display_name) VALUES($1) RETURNING id",
      [`Provider adapter ${label} ${crypto.randomUUID()}`]
    );
    const ownerUserId = owner.rows[0]!.id;
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds(owner_user_id,title) VALUES($1,$2) RETURNING id",
      [ownerUserId, `World ${label}`]
    );
    const version = await pool.query<{ id: string }>(
      "INSERT INTO world_versions(world_id,owner_user_id,version_number,content) VALUES($1,$2,1,'{}') RETURNING id",
      [world.rows[0]!.id, ownerUserId]
    );
    const campaign = await pool.query<{ id: string }>(
      "INSERT INTO campaigns(owner_user_id,world_version_id,title) VALUES($1,$2,$3) RETURNING id",
      [ownerUserId, version.rows[0]!.id, `Campaign ${label}`]
    );
    const turn = await pool.query<{ id: string }>(
      "INSERT INTO turns(owner_user_id,campaign_id,turn_number,narration) VALUES($1,$2,1,$3) RETURNING id",
      [ownerUserId, campaign.rows[0]!.id, "A test turn."]
    );
    return { ownerUserId, campaignId: campaign.rows[0]!.id, turnId: turn.rows[0]!.id };
  }

  function profileCommand(ownerUserId: string, name: string, role: "text" | "image" | "embedding" = "text") {
    return {
      ownerUserId,
      name,
      providerType: "openai_compatible" as const,
      providerRole: role,
      baseUrl: "http://127.0.0.1:1234/v1///",
      defaultModel: `${role}-model`,
      contextWindowTokens: 16_384,
      maxOutputTokens: 2_048,
      temperature: 0.4,
      requestTimeoutMs: 60_000,
      configuration: toSafeProviderConfiguration({ streaming: true, apiKey: "discard" }),
      enabled: true,
      isDefault: false
    };
  }

  async function inTransaction<T>(work: (client: DatabaseClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 8);
    await migrateDatabase(pool, resolve("database/migrations"));
    first = await fixture("first");
    second = await fixture("second");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("keeps profiles owner-scoped, normalized, redacted, and role/model resolution explicit", async () => {
    const created = await inTransaction(async (client) => {
      const repository = createPostgresProviderRepositories(client);
      const text = await repository.profiles.createProfile(profileCommand(first.ownerUserId, `Text ${crypto.randomUUID()}`));
      const embedding = await repository.profiles.createProfile(profileCommand(first.ownerUserId, `Embedding ${crypto.randomUUID()}`, "embedding"));
      await writeEncryptedProviderCredential(client, first.ownerUserId, text.id, {
        ciphertext: "ciphertext-only",
        nonce: "nonce-only",
        authTag: "tag-only",
        keyVersion: 1
      });
      return { text, embedding };
    });

    await inTransaction(async (client) => {
      const repository = createPostgresProviderRepositories(client);
      expect(await repository.profiles.listProfiles({ ownerUserId: second.ownerUserId })).toEqual([]);
      const visible = await repository.profiles.listProfiles({ ownerUserId: first.ownerUserId });
      const text = visible.find((profile) => profile.id === created.text.id)!;
      expect(text.baseUrl).toBe("http://127.0.0.1:1234/v1");
      expect(text.hasCredential).toBe(true);
      expect(JSON.stringify(text)).not.toMatch(/ciphertext-only|nonce-only|tag-only|apiKey/i);

      expect(await repository.resolution.resolveDirect({
        ownerUserId: first.ownerUserId,
        providerRole: "text",
        selectedProviderProfileId: created.text.id,
        model: "explicit-model"
      })).toMatchObject({ status: "resolved", resolvedRole: "text", model: "explicit-model" });
      expect(await repository.resolution.resolveEmbedding({
        ownerUserId: first.ownerUserId,
        selectedProviderProfileId: created.embedding.id,
        allowTextFallback: false
      })).toMatchObject({ status: "resolved", source: "dedicated_embedding", resolvedRole: "embedding" });
    });

    const fallbackOwner = await fixture("fallback");
    const fallbackText = await inTransaction((client) =>
      createPostgresProviderRepositories(client).profiles.createProfile(profileCommand(fallbackOwner.ownerUserId, `Fallback ${crypto.randomUUID()}`))
    );
    await inTransaction(async (client) => {
      const resolution = createPostgresProviderRepositories(client).resolution;
      expect(await resolution.resolveEmbedding({ ownerUserId: fallbackOwner.ownerUserId })).toMatchObject({ status: "unconfigured", source: "none" });
      expect(await resolution.resolveEmbedding({ ownerUserId: fallbackOwner.ownerUserId, allowTextFallback: true })).toMatchObject({
        status: "resolved",
        source: "text_fallback",
        resolvedRole: "text",
        providerProfileId: fallbackText.id
      });
    });
  });

  it("serializes concurrent default changes and leaves exactly one enabled role default", async () => {
    const [one, two] = await inTransaction(async (client) => {
      const profiles = createPostgresProviderRepositories(client).profiles;
      return Promise.all([
        profiles.createProfile(profileCommand(first.ownerUserId, `Default one ${crypto.randomUUID()}`)),
        profiles.createProfile(profileCommand(first.ownerUserId, `Default two ${crypto.randomUUID()}`))
      ]);
    });
    const firstClient = await pool.connect();
    const secondClient = await pool.connect();
    try {
      await firstClient.query("BEGIN");
      await secondClient.query("BEGIN");
      await createPostgresProviderRepositories(firstClient).profiles.setDefaultProfile({
        ownerUserId: first.ownerUserId,
        providerProfileId: one.id,
        providerRole: "text"
      });
      const secondDefault = createPostgresProviderRepositories(secondClient).profiles.setDefaultProfile({
        ownerUserId: first.ownerUserId,
        providerProfileId: two.id,
        providerRole: "text"
      });
      await firstClient.query("COMMIT");
      await secondDefault;
      await secondClient.query("COMMIT");
    } finally {
      await firstClient.query("ROLLBACK").catch(() => undefined);
      await secondClient.query("ROLLBACK").catch(() => undefined);
      firstClient.release();
      secondClient.release();
    }
    const defaults = await pool.query<{ id: string }>(
      "SELECT id FROM provider_profiles WHERE owner_user_id=$1 AND provider_role='text' AND enabled AND is_default",
      [first.ownerUserId]
    );
    expect(defaults.rows).toEqual([{ id: two.id }]);
  });

  it("records stable health transitions without exposing a raw provider error", async () => {
    const profile = await inTransaction((client) =>
      createPostgresProviderRepositories(client).profiles.createProfile(profileCommand(second.ownerUserId, `Health ${crypto.randomUUID()}`))
    );
    await inTransaction(async (client) => {
      const repository = createPostgresProviderRepositories(client);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await repository.health.recordHealth({
          ownerUserId: second.ownerUserId,
          providerProfileId: profile.id,
          outcome: "failed",
          diagnosticCode: "transport_failure"
        });
      }
      const [view] = await repository.profiles.listProfiles({ ownerUserId: second.ownerUserId });
      expect(view?.health).toMatchObject({ status: "unavailable", consecutiveFailures: 3 });
      expect(JSON.stringify(view)).not.toContain("transport_failure");
      await repository.health.recordHealth({ ownerUserId: second.ownerUserId, providerProfileId: profile.id, outcome: "healthy" });
      const [healthy] = await repository.profiles.listProfiles({ ownerUserId: second.ownerUserId });
      expect(healthy?.health).toMatchObject({ status: "healthy", consecutiveFailures: 0 });
    });
  });

  it("invalidates Chronicle embeddings and queues campaign re-embedding after profile mutation", async () => {
    const profile = await inTransaction((client) =>
      createPostgresProviderRepositories(client).profiles.createProfile(
        profileCommand(first.ownerUserId, `Chronicle ${crypto.randomUUID()}`, "embedding")
      )
    );
    const campaign = await pool.query<{ world_version_id: string }>(
      "SELECT world_version_id FROM campaigns WHERE id=$1 AND owner_user_id=$2",
      [first.campaignId, first.ownerUserId]
    );
    const memory = await pool.query<{ id: string }>(
      `INSERT INTO chronicle_memories(
         owner_user_id,campaign_id,world_version_id,memory_kind,content,token_estimate,
         embedding,embedding_provider_profile_id,embedding_model,embedding_dimensions,
         embedding_content_hash,embedding_updated_at,embedding_provider_fingerprint
       ) VALUES($1,$2,$3,'canonical_fact','A test fact.',3,'[0.1,0.2]',$4,'embed-model',2,'hash',now(),'fingerprint')
       RETURNING id`,
      [first.ownerUserId, first.campaignId, campaign.rows[0]!.world_version_id, profile.id]
    );
    await pool.query(
      `INSERT INTO campaign_memory_configs(
         campaign_id,owner_user_id,embedding_enabled,embedding_provider_profile_id,embedding_model
       ) VALUES($1,$2,true,$3,'embed-model')`,
      [first.campaignId, first.ownerUserId, profile.id]
    );

    await inTransaction((client) => createPostgresProviderRepositories(client).profiles.updateProfile({
      ownerUserId: first.ownerUserId,
      providerProfileId: profile.id,
      changes: { defaultModel: "embed-model-v2" }
    }));

    const state = await pool.query<{ embedding: string | null; profile_id: string | null; queued: string }>(
      `SELECT memory.embedding::text, memory.embedding_provider_profile_id AS profile_id,
              (SELECT count(*)::text FROM chronicle_jobs job
                WHERE job.owner_user_id=$1 AND job.campaign_id=$2 AND job.job_type='embed_campaign' AND job.status='queued') AS queued
         FROM chronicle_memories memory WHERE memory.id=$3`,
      [first.ownerUserId, first.campaignId, memory.rows[0]!.id]
    );
    expect(state.rows[0]).toEqual({ embedding: null, profile_id: null, queued: "1" });
  });

  it("changes prompt protocol versions deterministically while preserving owner and campaign scope", async () => {
    const before = await inTransaction((client) => createPromptRepository(client).loadPromptSnapshot({
      ownerUserId: first.ownerUserId,
      scope: "campaign",
      campaignId: first.campaignId
    }));
    const changed = await inTransaction(async (client) => {
      const prompts = createPromptRepository(client);
      await prompts.savePromptOverride({
        ownerUserId: first.ownerUserId,
        scope: "campaign",
        campaignId: first.campaignId,
        key: "story_system",
        content: "Owner-scoped changed story protocol."
      });
      return prompts.loadPromptSnapshot({ ownerUserId: first.ownerUserId, scope: "campaign", campaignId: first.campaignId });
    });
    const repeated = await inTransaction((client) => createPromptRepository(client).loadPromptSnapshot({
      ownerUserId: first.ownerUserId, scope: "campaign", campaignId: first.campaignId
    }));
    expect(changed.protocolVersion).not.toBe(before.protocolVersion);
    expect(repeated).toEqual(changed);
    await inTransaction(async (client) => {
      await expect(createPromptRepository(client).loadPromptSnapshot({
        ownerUserId: second.ownerUserId, scope: "campaign", campaignId: first.campaignId
      })).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  it("keeps cost writes caller-transaction-owned and reads isolated by owner, campaign, turn, category, and currency", async () => {
    const profile = await inTransaction((client) =>
      createPostgresProviderRepositories(client).profiles.createProfile(profileCommand(first.ownerUserId, `Cost ${crypto.randomUUID()}`))
    );
    await inTransaction(async (client) => {
      const costs = createProviderCostRepository(pool);
      const id = await costs.recordCost(createProviderCostTransactionContext(client), {
        ownerUserId: first.ownerUserId,
        campaignId: first.campaignId,
        turnId: first.turnId,
        providerProfileId: profile.id,
        providerType: "openai_compatible",
        requestedModel: "text-model",
        category: "story",
        operation: "story.generate",
        usage: { inputTokens: 20, outputTokens: 10 },
        reportedCost: { amount: "1.250", currency: "USD" },
        localCallId: crypto.randomUUID()
      });
      expect(id).toMatch(/[0-9a-f-]{36}/);
    });
    const costs = createProviderCostRepository(pool);
    const turnCosts = await costs.getTurnCosts({ ownerUserId: first.ownerUserId, campaignId: first.campaignId, turnIds: [first.turnId] });
    expect(turnCosts.get(first.turnId)).toMatchObject({ currency: "USD", byCategory: { story: "1.250000000000", image: "0", memory: "0" } });
    expect(await costs.getTurnCosts({ ownerUserId: second.ownerUserId, campaignId: first.campaignId, turnIds: [first.turnId] })).toEqual(new Map());
    await expect(costs.getCampaignCostSummary({ ownerUserId: second.ownerUserId, campaignId: first.campaignId })).rejects.toMatchObject({ statusCode: 404 });
  });
});
