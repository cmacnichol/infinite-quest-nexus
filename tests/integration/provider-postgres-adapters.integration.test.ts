import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  toSafeProviderConfiguration,
  type ProviderProfileView,
  type ProviderRole
} from "../../packages/application/src/providers/index.js";
import {
  createProviderCostRepository,
  createProviderCostTransactionContext
} from "../../packages/database/src/cost-repository.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, type DatabaseClient, type DatabasePool } from "../../packages/database/src/pool.js";
import { createPostgresProviderRepositories, writeEncryptedProviderCredential } from "../../packages/database/src/provider-repository.js";
import { createPostgresChronicleConfigurationRepository } from "../../packages/database/src/chronicle-repository.js";
import { createPostgresPreparedTextAttemptRepository } from "../../packages/database/src/prepared-text-attempt-repository.js";
import { createPromptRepository } from "../../packages/database/src/prompt-repository.js";
import { promptCompatibilityRequirement } from "../../packages/contracts/src/prompt-library.js";
import { encryptCredential } from "../../packages/story-engine/src/credentials.js";
import { createRuntimeProviderAdapter } from "../../services/runtime/src/provider-credential-transport-adapter.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

type Fixture = Readonly<{ ownerUserId: string; campaignId: string; turnId: string }>;

integration("provider PostgreSQL adapters", () => {
  let pool: DatabasePool;
  let first: Fixture;
  let second: Fixture;
  const fixtureOwnerUserIds: string[] = [];

  async function fixture(label: string): Promise<Fixture> {
    const owner = await pool.query<{ id: string }>(
      "INSERT INTO users(display_name) VALUES($1) RETURNING id",
      [`Provider adapter ${label} ${crypto.randomUUID()}`]
    );
    const ownerUserId = owner.rows[0]!.id;
    fixtureOwnerUserIds.push(ownerUserId);
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

  function profileCommand(ownerUserId: string, name: string, role: "text" | "image" | "embedding" | "intent" = "text") {
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
    if (!pool) return;
    try {
      if (fixtureOwnerUserIds.length) {
        const parameters = [fixtureOwnerUserIds];
        await pool.query("DELETE FROM prepared_text_physical_attempts WHERE owner_user_id=ANY($1::uuid[])", parameters);
        await pool.query("DELETE FROM provider_cost_events WHERE owner_user_id=ANY($1::uuid[])", parameters);
        await pool.query("DELETE FROM prompt_template_overrides WHERE owner_user_id=ANY($1::uuid[])", parameters);
        await pool.query("DELETE FROM chronicle_jobs WHERE owner_user_id=ANY($1::uuid[])", parameters);
        await pool.query("DELETE FROM chronicle_memories WHERE owner_user_id=ANY($1::uuid[])", parameters);
        await pool.query("DELETE FROM campaign_memory_configs WHERE owner_user_id=ANY($1::uuid[])", parameters);
        await pool.query("DELETE FROM turns WHERE owner_user_id=ANY($1::uuid[])", parameters);
        await pool.query("DELETE FROM campaigns WHERE owner_user_id=ANY($1::uuid[])", parameters);
        await pool.query("DELETE FROM provider_profiles WHERE owner_user_id=ANY($1::uuid[])", parameters);
        await pool.query("DELETE FROM world_versions WHERE owner_user_id=ANY($1::uuid[])", parameters);
        await pool.query("DELETE FROM worlds WHERE owner_user_id=ANY($1::uuid[])", parameters);
        await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", parameters);
        const residue = await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM users WHERE id=ANY($1::uuid[])",
          parameters
        );
        expect(residue.rows[0]?.count).toBe("0");
      }
    } finally {
      await pool.end();
    }
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
      })).toEqual({
        status: "resolved",
        requestedRole: "embedding",
        source: "dedicated_embedding",
        resolvedRole: "embedding",
        providerProfileId: created.embedding.id,
        providerType: "openai_compatible",
        model: "embedding-model"
      });
    });

    const fallbackOwner = await fixture("fallback");
    const fallbackText = await inTransaction((client) =>
      createPostgresProviderRepositories(client).profiles.createProfile(profileCommand(fallbackOwner.ownerUserId, `Fallback ${crypto.randomUUID()}`))
    );
    await inTransaction(async (client) => {
      const resolution = createPostgresProviderRepositories(client).resolution;
      expect(await resolution.resolveEmbedding({ ownerUserId: fallbackOwner.ownerUserId })).toEqual({
        status: "unconfigured",
        requestedRole: "embedding",
        source: "none",
        resolvedRole: null
      });
      expect(await resolution.resolveEmbedding({ ownerUserId: fallbackOwner.ownerUserId, allowTextFallback: true })).toEqual({
        status: "resolved",
        requestedRole: "embedding",
        source: "text_fallback",
        resolvedRole: "text",
        providerProfileId: fallbackText.id,
        providerType: "openai_compatible",
        model: "text-model"
      });
      expect(await resolution.resolveEmbedding({
        ownerUserId: fallbackOwner.ownerUserId,
        selectedProviderProfileId: fallbackText.id,
        allowTextFallback: true,
      })).toEqual({
        status: "resolved",
        requestedRole: "embedding",
        source: "text_fallback",
        resolvedRole: "text",
        providerProfileId: fallbackText.id,
        providerType: "openai_compatible",
        model: "text-model"
      });
      await expect(resolution.resolveEmbedding({
        ownerUserId: fallbackOwner.ownerUserId,
        selectedProviderProfileId: fallbackText.id,
        allowTextFallback: false,
      })).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  it("keeps text presets out of implicit embedding fallback while rejecting explicit selection", async () => {
    const nativeOwner = await fixture("native-preset-embedding-fallback");
    const nativePreset = await inTransaction((client) =>
      createPostgresProviderRepositories(client).profiles.createProfile({
        ...profileCommand(nativeOwner.ownerUserId, `Native preset ${crypto.randomUUID()}`),
        providerType: "openrouter",
        defaultModel: "",
        textSelection: { kind: "openrouter_preset", slug: "nexus-nsfw" },
        isDefault: true
      })
    );
    await pool.query(
      "UPDATE provider_profiles SET default_model=$2 WHERE id=$1",
      [nativePreset.id, "stale/concrete-model"]
    );

    await inTransaction(async (client) => {
      const resolution = createPostgresProviderRepositories(client).resolution;
      await expect(resolution.resolveEmbedding({
        ownerUserId: nativeOwner.ownerUserId,
        allowTextFallback: true
      })).resolves.toEqual({
        status: "unconfigured",
        requestedRole: "embedding",
        resolvedRole: null,
        source: "none"
      });
      await expect(resolution.resolveEmbedding({
        ownerUserId: nativeOwner.ownerUserId,
        selectedProviderProfileId: nativePreset.id,
        allowTextFallback: true
      })).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/preset/i) });
    });
    await expect(createPostgresChronicleConfigurationRepository(pool).setEmbeddingConfig({
      ownerUserId: nativeOwner.ownerUserId,
      campaignId: nativeOwner.campaignId
    }, {
      enabled: true,
      providerProfileId: nativePreset.id,
      model: "stale/concrete-model",
      batchSize: 16
    })).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/preset/i) });

    const dedicated = await inTransaction((client) =>
      createPostgresProviderRepositories(client).profiles.createProfile({
        ...profileCommand(nativeOwner.ownerUserId, `Dedicated embedding ${crypto.randomUUID()}`, "embedding"),
        isDefault: true
      })
    );
    await inTransaction(async (client) => {
      await expect(createPostgresProviderRepositories(client).resolution.resolveEmbedding({
        ownerUserId: nativeOwner.ownerUserId,
        allowTextFallback: true
      })).resolves.toMatchObject({
        status: "resolved",
        source: "dedicated_embedding",
        providerProfileId: dedicated.id,
        model: "embedding-model"
      });
    });

    const configuration = createPostgresChronicleConfigurationRepository(pool);
    await expect(configuration.setEmbeddingConfig({
      ownerUserId: nativeOwner.ownerUserId,
      campaignId: nativeOwner.campaignId
    }, {
      enabled: false,
      providerProfileId: dedicated.id,
      model: "embedding-model",
      batchSize: 16
    })).resolves.toMatchObject({
      enabled: false,
      providerProfileId: dedicated.id,
      model: "embedding-model"
    });
    const persistedState = async () => {
      const [config, jobs] = await Promise.all([
        pool.query(
          `SELECT embedding_enabled,embedding_provider_profile_id,embedding_model,embedding_batch_size,
                  embedding_document_prefix,embedding_query_prefix,retrieval_implementation,retrieval_shadow_enabled
             FROM campaign_memory_configs WHERE owner_user_id=$1 AND campaign_id=$2`,
          [nativeOwner.ownerUserId, nativeOwner.campaignId]
        ),
        pool.query(
          `SELECT 'embedding' AS kind,id::text,status::text,work_version::text
             FROM chronicle_jobs WHERE owner_user_id=$1 AND campaign_id=$2
           UNION ALL
           SELECT 'chunk' AS kind,id::text,status::text,work_version::text
             FROM chronicle_chunk_jobs WHERE owner_user_id=$1 AND campaign_id=$2
           ORDER BY kind,id`,
          [nativeOwner.ownerUserId, nativeOwner.campaignId]
        )
      ]);
      return { config: config.rows, jobs: jobs.rows };
    };
    const beforeRejectedAlias = await persistedState();
    await expect(configuration.setEmbeddingConfig({
      ownerUserId: nativeOwner.ownerUserId,
      campaignId: nativeOwner.campaignId
    }, {
      enabled: true,
      providerProfileId: dedicated.id,
      model: "@preset/nexus-nsfw",
      batchSize: 32
    })).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/preset/i) });
    await expect(persistedState()).resolves.toEqual(beforeRejectedAlias);

    const legacyOwner = await fixture("legacy-preset-embedding-fallback");
    const legacyPreset = await inTransaction((client) =>
      createPostgresProviderRepositories(client).profiles.createProfile({
        ...profileCommand(legacyOwner.ownerUserId, `Legacy preset ${crypto.randomUUID()}`),
        providerType: "openrouter",
        defaultModel: "@preset/nexus-nsfw",
        isDefault: true
      })
    );
    await inTransaction(async (client) => {
      const resolution = createPostgresProviderRepositories(client).resolution;
      await expect(resolution.resolveEmbedding({
        ownerUserId: legacyOwner.ownerUserId,
        allowTextFallback: true
      })).resolves.toEqual({
        status: "unconfigured",
        requestedRole: "embedding",
        resolvedRole: null,
        source: "none"
      });
      await expect(resolution.resolveEmbedding({
        ownerUserId: legacyOwner.ownerUserId,
        selectedProviderProfileId: legacyPreset.id,
        allowTextFallback: true
      })).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/preset/i) });
    });
  });

  it("keeps endpoint, credential, inventory, model, state, health, timeout, and retry policy independent across every role", async () => {
    const roles = ["text", "image", "embedding", "intent"] as const satisfies readonly ProviderRole[];
    const credentialSecret = "provider-role-parity-encryption-secret";
    const expectedByRole = Object.fromEntries(roles.map((role, index) => [role, {
      baseUrl: `https://${role}.provider-parity.test/v1`,
      credential: `${role}-credential-never-public`,
      defaultModel: `${role}-default-model`,
      selectedModel: `${role}-selected-model`,
      inventoryModel: `${role}-inventory-model`,
      requestTimeoutMs: 61_000 + index * 1_000,
      maximumAttempts: index + 2
    }])) as Record<(typeof roles)[number], {
      baseUrl: string;
      credential: string;
      defaultModel: string;
      selectedModel: string;
      inventoryModel: string;
      requestTimeoutMs: number;
      maximumAttempts: number;
    }>;
    const profiles = await inTransaction(async (client) => {
      const repository = createPostgresProviderRepositories(client).profiles;
      const entries = [];
      for (const role of roles) {
        const expected = expectedByRole[role];
        const profile = await repository.createProfile({
          ...profileCommand(first.ownerUserId, `Parity ${role} ${crypto.randomUUID()}`, role),
          baseUrl: expected.baseUrl,
          defaultModel: expected.defaultModel,
          requestTimeoutMs: expected.requestTimeoutMs,
          configuration: toSafeProviderConfiguration({ maximumAttempts: expected.maximumAttempts }),
          isDefault: true
        });
        await writeEncryptedProviderCredential(
          client,
          first.ownerUserId,
          profile.id,
          encryptCredential(expected.credential, credentialSecret)
        );
        entries.push([role, profile] as const);
      }
      return Object.fromEntries(entries);
    }) as Record<(typeof roles)[number], ProviderProfileView>;

    const transportCalls: Array<{ role: ProviderRole; credential: string | undefined; url: string }> = [];
    const transport = {
      async fetch(profile: { baseUrl: string; apiKey?: string }, _operation: string, url: string) {
        const role = roles.find((candidate) => profile.baseUrl === expectedByRole[candidate].baseUrl)!;
        transportCalls.push({ role, credential: profile.apiKey, url });
        const model = {
          id: expectedByRole[role].inventoryModel,
          name: `${role} inventory model`,
          context_length: 8_192,
          ...(role === "image" ? { output_modalities: ["image"] } : {})
        };
        return new Response(JSON.stringify({ data: [model] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      },
      async validateSdkEndpoint() {},
      async close() {}
    };

    await inTransaction(async (client) => {
      const repositories = createPostgresProviderRepositories(client);
      const runtime = createRuntimeProviderAdapter({
        database: client,
        credentialSecret,
        transport,
        health: repositories.health
      });
      for (const role of roles) {
        const profile = profiles[role];
        const expected = expectedByRole[role];
        const resolution = role === "embedding"
          ? await repositories.resolution.resolveEmbedding({
              ownerUserId: first.ownerUserId,
              selectedProviderProfileId: profile.id,
              model: expected.selectedModel,
              allowTextFallback: false
            })
          : await repositories.resolution.resolveDirect({
              ownerUserId: first.ownerUserId,
              providerRole: role,
              selectedProviderProfileId: profile.id,
              model: expected.selectedModel
            });
        expect(resolution).toMatchObject({
          status: "resolved",
          resolvedRole: role,
          providerProfileId: profile.id,
          model: expected.selectedModel
        });
        const lease = await runtime.leases.leaseResolved(
          { ownerUserId: first.ownerUserId },
          profile.id,
          role,
          expected.selectedModel
        );
        expect(lease).toMatchObject({
          providerProfileId: profile.id,
          providerRole: role,
          baseUrl: expected.baseUrl,
          model: expected.selectedModel,
          requestTimeoutMs: expected.requestTimeoutMs,
          configuration: { maximumAttempts: expected.maximumAttempts }
        });
        const inventory = await runtime.inventory.listModels({
          ownerUserId: first.ownerUserId,
          providerProfileId: profile.id,
          providerRole: role
        });
        expect(inventory).toMatchObject({
          providerProfileId: profile.id,
          providerRole: role,
          models: [{ id: expected.inventoryModel }]
        });
      }

      const visible = await repositories.profiles.listProfiles({ ownerUserId: first.ownerUserId });
      for (const role of roles) {
        expect(visible.find((profile) => profile.id === profiles[role].id)).toMatchObject({
          providerRole: role,
          baseUrl: expectedByRole[role].baseUrl,
          defaultModel: expectedByRole[role].defaultModel,
          requestTimeoutMs: expectedByRole[role].requestTimeoutMs,
          configuration: { maximumAttempts: expectedByRole[role].maximumAttempts },
          enabled: true,
          isDefault: true,
          hasCredential: true,
          health: { status: "healthy", consecutiveFailures: 0 }
        });
      }

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await repositories.health.recordHealth({
          ownerUserId: first.ownerUserId,
          providerProfileId: profiles.image.id,
          outcome: "failed",
          diagnosticCode: "provider_unavailable"
        });
      }
      await repositories.profiles.updateProfile({
        ownerUserId: first.ownerUserId,
        providerProfileId: profiles.text.id,
        changes: {
          baseUrl: "https://changed-text.provider-parity.test/v1",
          enabled: false,
          isDefault: false,
          requestTimeoutMs: 99_000,
          configuration: toSafeProviderConfiguration({ maximumAttempts: 9 })
        }
      });
      const imageAfterTextChange = (await repositories.profiles.listProfiles({ ownerUserId: first.ownerUserId }))
        .find((profile) => profile.id === profiles.image.id);
      expect(imageAfterTextChange).toMatchObject({
        providerRole: "image",
        baseUrl: expectedByRole.image.baseUrl,
        defaultModel: expectedByRole.image.defaultModel,
        requestTimeoutMs: expectedByRole.image.requestTimeoutMs,
        configuration: { maximumAttempts: expectedByRole.image.maximumAttempts },
        enabled: true,
        isDefault: true,
        health: { status: "unavailable", consecutiveFailures: 3 }
      });
      await repositories.profiles.deleteProfile({
        ownerUserId: first.ownerUserId,
        providerProfileId: profiles.text.id
      });
      await expect(repositories.resolution.resolveDirect({
        ownerUserId: first.ownerUserId,
        providerRole: "text",
        selectedProviderProfileId: profiles.text.id
      })).rejects.toMatchObject({ statusCode: 400 });
      expect(await repositories.profiles.listProfiles({ ownerUserId: first.ownerUserId }))
        .not.toContainEqual(expect.objectContaining({ id: profiles.text.id }));
      expect(await repositories.resolution.resolveDirect({
        ownerUserId: first.ownerUserId,
        providerRole: "image"
      })).toMatchObject({
        status: "resolved",
        resolvedRole: "image",
        providerProfileId: profiles.image.id
      });
    });

    expect(transportCalls).toEqual(roles.map((role) => ({
      role,
      credential: expectedByRole[role].credential,
      url: `${expectedByRole[role].baseUrl}/models`
    })));
    const publicState = JSON.stringify({ profiles, transportCalls: transportCalls.map(({ role, url }) => ({ role, url })) });
    for (const role of roles) expect(publicState).not.toContain(expectedByRole[role].credential);
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
      await createPostgresProviderRepositories(firstClient).profiles.updateProfile({
        ownerUserId: first.ownerUserId,
        providerProfileId: one.id,
        changes: { isDefault: true }
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

  it("resolves image and intent roles without text fallback and rejects wrong-role or disabled selections", async () => {
    const scoped = await fixture("direct-role-resolution");
    const text = await inTransaction((client) =>
      createPostgresProviderRepositories(client).profiles.createProfile(
        profileCommand(scoped.ownerUserId, `Text only ${crypto.randomUUID()}`)
      )
    );

    await inTransaction(async (client) => {
      const resolution = createPostgresProviderRepositories(client).resolution;
      expect(await resolution.resolveDirect({ ownerUserId: scoped.ownerUserId, providerRole: "image" })).toEqual({
        status: "unconfigured",
        requestedRole: "image",
        resolvedRole: null
      });
      expect(await resolution.resolveDirect({ ownerUserId: scoped.ownerUserId, providerRole: "intent" })).toEqual({
        status: "unconfigured",
        requestedRole: "intent",
        resolvedRole: null
      });
    });

    const { image, intent, disabledImage } = await inTransaction(async (client) => {
      const profiles = createPostgresProviderRepositories(client).profiles;
      const image = await profiles.createProfile(profileCommand(scoped.ownerUserId, `Image ${crypto.randomUUID()}`, "image"));
      const intent = await profiles.createProfile(profileCommand(scoped.ownerUserId, `Intent ${crypto.randomUUID()}`, "intent"));
      const disabledImage = await profiles.createProfile({
        ...profileCommand(scoped.ownerUserId, `Disabled image ${crypto.randomUUID()}`, "image"),
        enabled: false
      });
      return { image, intent, disabledImage };
    });

    await inTransaction(async (client) => {
      const resolution = createPostgresProviderRepositories(client).resolution;
      expect(await resolution.resolveDirect({ ownerUserId: scoped.ownerUserId, providerRole: "image" })).toMatchObject({
        status: "resolved",
        resolvedRole: "image",
        providerProfileId: image.id
      });
      expect(await resolution.resolveDirect({ ownerUserId: scoped.ownerUserId, providerRole: "intent" })).toMatchObject({
        status: "resolved",
        resolvedRole: "intent",
        providerProfileId: intent.id
      });
      await expect(resolution.resolveDirect({
        ownerUserId: scoped.ownerUserId,
        providerRole: "intent",
        selectedProviderProfileId: text.id
      })).rejects.toMatchObject({ statusCode: 400 });
      await expect(resolution.resolveDirect({
        ownerUserId: scoped.ownerUserId,
        providerRole: "image",
        selectedProviderProfileId: disabledImage.id
      })).rejects.toMatchObject({ statusCode: 400 });
    });
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
    const storyContent = "Owner-scoped changed story protocol.";
    const requiredCompatibility = promptCompatibilityRequirement("story_system")!;
    const [ownedProfile, foreignProfile] = await inTransaction(async (client) => {
      const profiles = createPostgresProviderRepositories(client).profiles;
      return Promise.all([
        profiles.createProfile(profileCommand(first.ownerUserId, `Owned prompt chain ${crypto.randomUUID()}`)),
        profiles.createProfile(profileCommand(second.ownerUserId, `Foreign prompt chain ${crypto.randomUUID()}`))
      ]);
    });
    const ownedCampaign = await pool.query<{ world_version_id: string }>(
      "SELECT world_version_id FROM campaigns WHERE id=$1 AND owner_user_id=$2",
      [first.campaignId, first.ownerUserId]
    );
    const foreignCampaign = await pool.query<{ world_version_id: string }>(
      "SELECT world_version_id FROM campaigns WHERE id=$1 AND owner_user_id=$2",
      [second.campaignId, second.ownerUserId]
    );
    const [ownedChain, foreignChain] = await Promise.all([
      pool.query<{ id: string }>(
        `INSERT INTO model_chains (
           owner_user_id,campaign_id,world_version_id,provider_profile_id,model,
           endpoint_identity,prompt_protocol_version,context_fingerprint,previous_response_id
         ) VALUES ($1,$2,$3,$4,'owned-model','owned-endpoint','owned-protocol','owned-context','owned-response')
         RETURNING id`,
        [first.ownerUserId, first.campaignId, ownedCampaign.rows[0]!.world_version_id, ownedProfile.id]
      ),
      pool.query<{ id: string }>(
        `INSERT INTO model_chains (
           owner_user_id,campaign_id,world_version_id,provider_profile_id,model,
           endpoint_identity,prompt_protocol_version,context_fingerprint,previous_response_id
         ) VALUES ($1,$2,$3,$4,'foreign-model','foreign-endpoint','foreign-protocol','foreign-context','foreign-response')
         RETURNING id`,
        [second.ownerUserId, second.campaignId, foreignCampaign.rows[0]!.world_version_id, foreignProfile.id]
      )
    ]);
    const chainActivity = async () => (await pool.query<{ id: string; active: boolean }>(
      "SELECT id,active FROM model_chains WHERE id=ANY($1::uuid[]) ORDER BY id",
      [[ownedChain.rows[0]!.id, foreignChain.rows[0]!.id]]
    )).rows;

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
        content: storyContent,
        compatibilityAcknowledgement: {
          requiredShapeVersion: requiredCompatibility.requiredShapeVersion,
          protocolIdentity: requiredCompatibility.protocolIdentity,
          contentHash: createHash("sha256").update(storyContent).digest("hex")
        }
      });
      return prompts.loadPromptSnapshot({ ownerUserId: first.ownerUserId, scope: "campaign", campaignId: first.campaignId });
    });
    const repeated = await inTransaction((client) => createPromptRepository(client).loadPromptSnapshot({
      ownerUserId: first.ownerUserId, scope: "campaign", campaignId: first.campaignId
    }));
    expect(changed.protocolVersion).not.toBe(before.protocolVersion);
    expect(repeated).toEqual(changed);
    expect(await chainActivity()).toEqual([
      { id: ownedChain.rows[0]!.id, active: false },
      { id: foreignChain.rows[0]!.id, active: true }
    ].sort((left, right) => left.id.localeCompare(right.id)));

    await pool.query("UPDATE model_chains SET active=true WHERE id=$1", [ownedChain.rows[0]!.id]);
    await inTransaction((client) => createPromptRepository(client).resetPromptOverride({
      ownerUserId: first.ownerUserId,
      scope: "campaign",
      campaignId: first.campaignId,
      key: "story_system"
    }));
    expect(await chainActivity()).toEqual([
      { id: ownedChain.rows[0]!.id, active: false },
      { id: foreignChain.rows[0]!.id, active: true }
    ].sort((left, right) => left.id.localeCompare(right.id)));

    await inTransaction(async (client) => {
      await expect(createPromptRepository(client).loadPromptSnapshot({
        ownerUserId: second.ownerUserId, scope: "campaign", campaignId: first.campaignId
      })).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  it("persists native text selections with compatibility IDs and required defaults", async () => {
    const scoped = await fixture("native-preset-selection");
    const preset = await inTransaction((client) => createPostgresProviderRepositories(client).profiles.createProfile({
      ...profileCommand(scoped.ownerUserId, `Preset ${crypto.randomUUID()}`),
      providerType: "openrouter",
      defaultModel: "",
      textSelection: { kind: "openrouter_preset", slug: "nexus-nsfw" },
      configuration: toSafeProviderConfiguration({})
    }));
    expect(preset).toMatchObject({
      defaultModel: "@preset/nexus-nsfw",
      textSelection: { kind: "openrouter_preset", slug: "nexus-nsfw" },
      configuration: { textResponseFormatPolicy: "required" }
    });

    await expect(inTransaction((client) => createPostgresProviderRepositories(client).profiles.updateProfile({
      ownerUserId: second.ownerUserId,
      providerProfileId: preset.id,
      changes: { name: "Foreign rename" }
    }))).rejects.toMatchObject({ statusCode: 404 });

    await expect(inTransaction((client) => createPostgresProviderRepositories(client).resolution.resolveEmbedding({
      ownerUserId: scoped.ownerUserId,
      selectedProviderProfileId: preset.id,
      allowTextFallback: true
    }))).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/preset/i) });

    const legacy = await inTransaction(async (client) => {
      const profile = await createPostgresProviderRepositories(client).profiles.createProfile({
        ...profileCommand(scoped.ownerUserId, `Legacy ${crypto.randomUUID()}`),
        providerType: "openrouter",
        configuration: toSafeProviderConfiguration({ textResponseFormatPolicy: "legacy" })
      });
      return createPostgresProviderRepositories(client).profiles.updateProfile({
        ownerUserId: scoped.ownerUserId, providerProfileId: profile.id, changes: { name: "Legacy renamed" }
      });
    });
    expect(legacy.configuration).toMatchObject({ textResponseFormatPolicy: "legacy" });

    for (const [policy, changes] of [
      ["legacy", { defaultModel: "openai/gpt-4o" }],
      ["auto", { textSelection: { kind: "openrouter_preset" as const, slug: "nexus-nsfw" } }]
    ] as const) {
      const updated = await inTransaction(async (client) => {
        const profiles = createPostgresProviderRepositories(client).profiles;
        const profile = await profiles.createProfile({
          ...profileCommand(scoped.ownerUserId, `Policy ${policy} ${crypto.randomUUID()}`),
          providerType: "openrouter",
          configuration: toSafeProviderConfiguration({ textResponseFormatPolicy: policy })
        });
        return profiles.updateProfile({ ownerUserId: scoped.ownerUserId, providerProfileId: profile.id, changes });
      });
      expect(updated.configuration).toMatchObject({ textResponseFormatPolicy: "required" });
    }

    const explicitAuto = await inTransaction(async (client) => {
      const profiles = createPostgresProviderRepositories(client).profiles;
      const profile = await profiles.createProfile({
        ...profileCommand(scoped.ownerUserId, `Explicit auto ${crypto.randomUUID()}`),
        providerType: "openrouter",
        configuration: toSafeProviderConfiguration({ textResponseFormatPolicy: "legacy" })
      });
      return profiles.updateProfile({
        ownerUserId: scoped.ownerUserId, providerProfileId: profile.id,
        changes: { defaultModel: "openai/gpt-4o", configuration: toSafeProviderConfiguration({ textResponseFormatPolicy: "auto" }) }
      });
    });
    expect(explicitAuto.configuration).toMatchObject({ textResponseFormatPolicy: "auto" });

    const historical = await inTransaction(async (client) => {
      const profile = await createPostgresProviderRepositories(client).profiles.createProfile({
        ...profileCommand(scoped.ownerUserId, `Historical ${crypto.randomUUID()}`), providerType: "openrouter"
      });
      await client.query("UPDATE provider_profiles SET configuration='{}'::jsonb WHERE id=$1", [profile.id]);
      return createPostgresProviderRepositories(client).profiles.updateProfile({
        ownerUserId: scoped.ownerUserId, providerProfileId: profile.id, changes: { defaultModel: "openai/gpt-4o" }
      });
    });
    expect(historical).toMatchObject({
      defaultModel: "openai/gpt-4o", textSelection: { kind: "model", modelId: "openai/gpt-4o" },
      configuration: { textResponseFormatPolicy: "required" }
    });
  });

  it("persists, preserves, clears, and selection-scopes explicit text execution overrides", async () => {
    const scoped = await fixture("text-execution-overrides");
    const initialOverrides = {
      parameters: { temperature: 0.23, max_tokens: 777 },
      conservativeContextWindowTokens: 12_345
    };
    const created = await inTransaction((client) => createPostgresProviderRepositories(client).profiles.createProfile({
      ...profileCommand(scoped.ownerUserId, `Overrides ${crypto.randomUUID()}`),
      providerType: "openrouter",
      defaultModel: "@preset/night-shift",
      textSelection: { kind: "openrouter_preset", slug: "night-shift" },
      configuration: toSafeProviderConfiguration({ textExecutionOverrides: initialOverrides })
    }));
    expect(created.configuration).toMatchObject({
      textResponseFormatPolicy: "required",
      textExecutionOverrides: initialOverrides
    });

    const preserved = await inTransaction((client) => createPostgresProviderRepositories(client).profiles.updateProfile({
      ownerUserId: scoped.ownerUserId,
      providerProfileId: created.id,
      changes: { configuration: toSafeProviderConfiguration({ httpReferer: "https://nexus.example.test" }) }
    }));
    expect(preserved.configuration).toMatchObject({
      httpReferer: "https://nexus.example.test",
      textExecutionOverrides: initialOverrides
    });

    const equivalentSelection = await inTransaction((client) => createPostgresProviderRepositories(client).profiles.updateProfile({
      ownerUserId: scoped.ownerUserId,
      providerProfileId: created.id,
      changes: { defaultModel: "@preset/night-shift" }
    }));
    expect(equivalentSelection.configuration.textExecutionOverrides).toEqual(initialOverrides);

    const switched = await inTransaction((client) => createPostgresProviderRepositories(client).profiles.updateProfile({
      ownerUserId: scoped.ownerUserId,
      providerProfileId: created.id,
      changes: { textSelection: { kind: "model", modelId: "openai/new-model" } }
    }));
    expect(switched.configuration).not.toHaveProperty("textExecutionOverrides");

    const explicitlyReplaced = await inTransaction((client) => createPostgresProviderRepositories(client).profiles.updateProfile({
      ownerUserId: scoped.ownerUserId,
      providerProfileId: created.id,
      changes: {
        textSelection: { kind: "openrouter_preset", slug: "night-shift" },
        configuration: toSafeProviderConfiguration({ httpReferer: "https://nexus.example.test", textExecutionOverrides: { parameters: { top_p: 0.4 } } }),
        textExecutionOverrides: { parameters: { top_p: 0.4 } }
      }
    }));
    expect(explicitlyReplaced.configuration.textExecutionOverrides).toEqual({ parameters: { top_p: 0.4 } });

    const cleared = await inTransaction((client) => createPostgresProviderRepositories(client).profiles.updateProfile({
      ownerUserId: scoped.ownerUserId,
      providerProfileId: created.id,
      changes: { textExecutionOverrides: null }
    }));
    expect(cleared.configuration).not.toHaveProperty("textExecutionOverrides");

    await expect(inTransaction((client) => createPostgresProviderRepositories(client).profiles.createProfile({
      ...profileCommand(scoped.ownerUserId, `Image overrides ${crypto.randomUUID()}`, "image"),
      configuration: toSafeProviderConfiguration({ textExecutionOverrides: { parameters: { temperature: 0.2 } } })
    }))).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/text execution overrides/i) });
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
    expect(turnCosts.get(first.turnId)).toMatchObject({ currency: "USD", byCategory: { story: "1.250", image: "0", memory: "0" } });
    expect(await costs.getTurnCosts({ ownerUserId: second.ownerUserId, campaignId: first.campaignId, turnIds: [first.turnId] })).toEqual(new Map());
    await expect(costs.getCampaignCostSummary({ ownerUserId: second.ownerUserId, campaignId: first.campaignId })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("uses stable events over legacy attempts and scopes response identity to the provider type", async () => {
    const scoped = await fixture("durable-cost-precedence");
    const profile = await inTransaction((client) =>
      createPostgresProviderRepositories(client).profiles.createProfile(profileCommand(scoped.ownerUserId, `Physical duplicate ${crypto.randomUUID()}`))
    );
    const otherProviderProfile = await inTransaction((client) =>
      createPostgresProviderRepositories(client).profiles.createProfile({
        ...profileCommand(scoped.ownerUserId, `Other provider ${crypto.randomUUID()}`),
        providerType: "openrouter"
      })
    );
    const job = await pool.query<{ id: string }>(
      `INSERT INTO generation_jobs (owner_user_id,campaign_id,provider_profile_id,idempotency_key,expected_turn_number,action,status)
       VALUES ($1,$2,$3,$4,2,'Exercise durable accounting','failed') RETURNING id`,
      [scoped.ownerUserId, scoped.campaignId, profile.id, crypto.randomUUID()]
    );
    const responseId = `legacy-provider-response-${crypto.randomUUID()}`;
    const attempt = await pool.query<{ id: string }>(
      `INSERT INTO prepared_text_physical_attempts (
         owner_user_id,logical_kind,reservation_key,logical_reservation,plan_hash,
         candidate_ordinal,requested_model,provider_policy,request_payload_hash,request_body,
         status,outcome,provider_response_id,usage,reported_cost,dispatched_at,completed_at
       ) VALUES ($1,'story',$2,$3::jsonb,$4,0,'legacy-model','{}'::jsonb,$5,'{}','completed','succeeded',$6,
                 '{"inputTokens":3}'::jsonb,'{"amount":"0.5000000000001","currency":"USD"}'::jsonb,now(),now()) RETURNING id`,
      [scoped.ownerUserId, `legacy-cost:${job.rows[0]!.id}`, JSON.stringify({ generationJobId: job.rows[0]!.id }), "a".repeat(64), "b".repeat(64), responseId]
    );
    await pool.query(
      `INSERT INTO provider_cost_events (
         owner_user_id,campaign_id,turn_id,provider_profile_id,local_call_id,provider_type,provider_response_id,
         category,operation,requested_model,resolved_model,amount,currency,usage_metadata
       ) VALUES ($1,$2,$3,$4,$5,'openai_compatible',$6,'story','story_generation','legacy-model','legacy-model',
                 '0.2500000000001','USD','{"inputTokens":3}'::jsonb)`,
      [scoped.ownerUserId, scoped.campaignId, scoped.turnId, profile.id, attempt.rows[0]!.id, responseId]
    );
    await pool.query(
      `INSERT INTO provider_cost_events (
         owner_user_id,campaign_id,turn_id,provider_profile_id,local_call_id,provider_type,provider_response_id,
         category,operation,requested_model,resolved_model,amount,currency,usage_metadata
       ) VALUES ($1,$2,$3,$4,$5,'openrouter',$6,'story','story_generation','legacy-model','legacy-model',
                 '0.1000000000000','USD','{"inputTokens":1}'::jsonb)`,
      [scoped.ownerUserId, scoped.campaignId, scoped.turnId, otherProviderProfile.id, crypto.randomUUID(), responseId]
    );

    const costs = createProviderCostRepository(pool);
    await expect(costs.getCampaignCostSummary({ ownerUserId: scoped.ownerUserId, campaignId: scoped.campaignId }))
      .resolves.toEqual(expect.objectContaining({ totals: [expect.objectContaining({
        currency: "USD", amount: "0.3500000000001", turnAttributed: "0.3500000000001",
        byCategory: { story: "0.3500000000001", image: "0", memory: "0" }
      })] }));
  });

  it("locks the campaign before the active Story claim and leaves rewind invalid while the claim remains active", async () => {
    const scoped = await fixture("completion-rewind-lock-order");
    const profile = await inTransaction((client) =>
      createPostgresProviderRepositories(client).profiles.createProfile(profileCommand(scoped.ownerUserId, `Lock order ${crypto.randomUUID()}`))
    );
    const workerId = `task3-completion-${crypto.randomUUID()}`;
    const invocationId = crypto.randomUUID();
    const job = await pool.query<{ id: string }>(
      `INSERT INTO generation_jobs (
         owner_user_id,campaign_id,provider_profile_id,idempotency_key,expected_turn_number,action,status,
         lease_owner,lease_expires_at,orchestration_private
       ) VALUES ($1,$2,$3,$4,2,'Exercise completion and rewind lock order','generating',$5,now()+interval '5 minutes',
                 jsonb_build_object('responseContractInvocations',jsonb_build_array(jsonb_build_object('id',$6::text,'operation','story_generation','status','dispatched'))))
       RETURNING id`,
      [scoped.ownerUserId, scoped.campaignId, profile.id, crypto.randomUUID(), workerId, invocationId]
    );
    const reservation = {
      kind: "story" as const,
      ownerUserId: scoped.ownerUserId,
      generationJobId: job.rows[0]!.id,
      invocationId,
      workerId
    };
    const attempt = await pool.query<{ id: string }>(
      `INSERT INTO prepared_text_physical_attempts (
         owner_user_id,logical_kind,reservation_key,logical_reservation,plan_hash,candidate_ordinal,
         requested_model,provider_policy,request_payload_hash,request_body,status,dispatched_at
       ) VALUES ($1,'story',$2,$3::jsonb,$4,0,'lock-order-model','{}'::jsonb,$5,'{}','dispatched',now()) RETURNING id`,
      [scoped.ownerUserId, `${job.rows[0]!.id}:${invocationId}`, JSON.stringify(reservation), "a".repeat(64), "b".repeat(64)]
    );
    const campaignLock = await pool.connect();
    try {
      await campaignLock.query("BEGIN");
      await campaignLock.query("SELECT id FROM campaigns WHERE id=$1 FOR UPDATE", [scoped.campaignId]);
      const completion = createPostgresPreparedTextAttemptRepository(pool).complete(reservation, attempt.rows[0]!.id, {
        outcome: "failed", failureReason: "unknown", providerResponseId: null, returnedModel: "lock-order-model",
        returnedProviderRoute: null, usage: null, reportedCost: { amount: "0.01", currency: "USD" }, emittedOutput: false
      });
      let completionIsWaitingForCampaign = false;
      for (let attemptNumber = 0; attemptNumber < 100; attemptNumber += 1) {
        const waiting = await pool.query<{ waiting: boolean }>(
          `SELECT EXISTS(
             SELECT 1 FROM pg_stat_activity
              WHERE datname=current_database() AND wait_event_type='Lock'
                AND query LIKE '%FROM campaigns WHERE id=$1 AND owner_user_id=$2 FOR KEY SHARE%'
           ) AS waiting`
        );
        if (waiting.rows[0]?.waiting) {
          completionIsWaitingForCampaign = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(completionIsWaitingForCampaign).toBe(true);
      await campaignLock.query("SET LOCAL lock_timeout='250ms'");
      await expect(campaignLock.query("SELECT id FROM generation_jobs WHERE id=$1 FOR UPDATE", [job.rows[0]!.id]))
        .resolves.toMatchObject({ rowCount: 1 });
      await campaignLock.query("COMMIT");
      expect(await completion).toMatchObject({ id: attempt.rows[0]!.id, status: "completed" });
    } finally {
      try {
        await campaignLock.query("ROLLBACK");
      } finally {
        campaignLock.release();
      }
    }
    // The completed physical attempt does not alter the active generation claim.
    // A rewind therefore still resolves through the existing invalid-transition path.
    const activeClaim = await pool.query<{ status: string; lease_owner: string | null }>(
      "SELECT status,lease_owner FROM generation_jobs WHERE id=$1", [job.rows[0]!.id]
    );
    expect(activeClaim.rows).toEqual([{ status: "generating", lease_owner: workerId }]);
  });
});
