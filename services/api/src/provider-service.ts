import type { DatabaseClient, DatabasePool } from "../../../packages/database/src/pool.js";
import { initialOwnerId, withTransaction } from "../../../packages/database/src/pool.js";
import { sogniIllustrationProviderConfigSchema, type ProviderProfileInput, type ProviderProfileUpdate, type ProviderTextRequest } from "../../../packages/contracts/src/generation.js";
import { callTextProvider, decryptCredential, encryptCredential, discoverEmbeddingModels, discoverImageModels, discoverModels, logProviderTransportError, type TextProviderProfile } from "../../../packages/story-engine/src/index.js";

type ProviderRow = {
  id: string;
  name: string;
  provider_type: ProviderProfileInput["providerType"];
  provider_role: ProviderProfileInput["providerRole"];
  base_url: string;
  default_model: string;
  context_window_tokens: number;
  max_output_tokens: number;
  temperature: number;
  request_timeout_ms: number;
  configuration: Record<string, unknown>;
  encrypted_api_key: string | null;
  credential_nonce: string | null;
  credential_auth_tag: string | null;
  credential_key_version: number | null;
  enabled: boolean;
  is_default: boolean;
  health_status: "unknown" | "healthy" | "degraded" | "unavailable";
  consecutive_failures: number;
  last_health_check_at: Date | null;
  last_health_error: string | null;
  created_at: Date;
  updated_at: Date;
};

export function publicProvider(row: ProviderRow) {
  return {
    id: row.id,
    name: row.name,
    providerType: row.provider_type,
    providerRole: row.provider_role,
    baseUrl: row.base_url,
    defaultModel: row.default_model,
    contextWindowTokens: row.context_window_tokens,
    maxOutputTokens: row.max_output_tokens,
    temperature: row.temperature,
    requestTimeoutMs: row.request_timeout_ms,
    configuration: row.configuration,
    enabled: row.enabled,
    isDefault: row.is_default,
    healthStatus: row.health_status,
    consecutiveFailures: row.consecutive_failures,
    lastHealthCheckAt: row.last_health_check_at,
    lastHealthError: row.last_health_error,
    hasApiKey: Boolean(row.encrypted_api_key),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const selectColumns = `id, name, provider_type, provider_role, base_url, default_model,
  context_window_tokens, max_output_tokens, temperature, request_timeout_ms, configuration, encrypted_api_key,
  credential_nonce, credential_auth_tag, credential_key_version, enabled, is_default, health_status,
  consecutive_failures, last_health_check_at, last_health_error, created_at, updated_at`;

export async function recordProviderHealth(
  pool: DatabasePool,
  ownerUserId: string,
  providerProfileId: string,
  healthy: boolean,
  errorMessage = ""
) {
  if (healthy) {
    await pool.query(
      `UPDATE provider_profiles SET health_status = 'healthy', consecutive_failures = 0,
         last_health_check_at = now(), last_health_error = NULL, updated_at = now()
       WHERE id = $1 AND owner_user_id = $2`,
      [providerProfileId, ownerUserId]
    );
    return;
  }
  await pool.query(
    `UPDATE provider_profiles SET consecutive_failures = consecutive_failures + 1,
       health_status = CASE WHEN consecutive_failures + 1 >= 3 THEN 'unavailable' ELSE 'degraded' END,
       last_health_check_at = now(), last_health_error = $3, updated_at = now()
     WHERE id = $1 AND owner_user_id = $2`,
    [providerProfileId, ownerUserId, errorMessage.slice(0, 2000)]
  );
}

export async function listProviders(pool: DatabasePool) {
  const ownerUserId = await initialOwnerId(pool);
  const result = await pool.query<ProviderRow>(
    `SELECT ${selectColumns} FROM provider_profiles WHERE owner_user_id = $1 ORDER BY provider_role, name`,
    [ownerUserId]
  );
  return result.rows.map(publicProvider);
}

export async function createProvider(pool: DatabasePool, input: Omit<ProviderProfileInput, "isDefault" | "requestTimeoutMs"> & { isDefault?: boolean; requestTimeoutMs?: number }, credentialSecret: string) {
  const encrypted = input.apiKey ? encryptCredential(input.apiKey, credentialSecret) : null;
  return withTransaction(pool, async (client) => {
    const ownerUserId = await initialOwnerId(client);
    if (input.isDefault) {
      await client.query("UPDATE provider_profiles SET is_default = false, updated_at = now() WHERE owner_user_id = $1 AND provider_role = $2", [ownerUserId, input.providerRole]);
    }
    const result = await client.query<ProviderRow>(
      `INSERT INTO provider_profiles (
         owner_user_id, name, provider_type, provider_role, base_url, default_model,
         context_window_tokens, max_output_tokens, temperature, request_timeout_ms, configuration,
         encrypted_api_key, credential_nonce, credential_auth_tag, credential_key_version, enabled, is_default
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING ${selectColumns}`,
      [ownerUserId, input.name, input.providerType, input.providerRole, input.baseUrl.replace(/\/+$/, ""), input.defaultModel,
        input.contextWindowTokens, input.maxOutputTokens, input.temperature, input.requestTimeoutMs ?? 300_000, JSON.stringify(input.configuration),
        encrypted?.ciphertext ?? null, encrypted?.nonce ?? null, encrypted?.authTag ?? null, encrypted?.keyVersion ?? null, input.enabled, Boolean(input.isDefault)]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Provider profile was not created.");
    return publicProvider(row);
  });
}

export async function setDefaultProvider(pool: DatabasePool, providerProfileId: string) {
  return withTransaction(pool, async (client) => {
    const ownerUserId = await initialOwnerId(client);
    const selected = await client.query<Pick<ProviderRow, "provider_role">>(
      "SELECT provider_role FROM provider_profiles WHERE id = $1 AND owner_user_id = $2 AND enabled = true FOR UPDATE",
      [providerProfileId, ownerUserId]
    );
    const role = selected.rows[0]?.provider_role;
    if (!role) throw Object.assign(new Error("Enabled provider profile not found."), { statusCode: 404 });
    await client.query("UPDATE provider_profiles SET is_default = false, updated_at = now() WHERE owner_user_id = $1 AND provider_role = $2 AND is_default = true", [ownerUserId, role]);
    await client.query("UPDATE provider_profiles SET is_default = true, updated_at = now() WHERE id = $1 AND owner_user_id = $2", [providerProfileId, ownerUserId]);
    const result = await client.query<ProviderRow>(`SELECT ${selectColumns} FROM provider_profiles WHERE id = $1 AND owner_user_id = $2`, [providerProfileId, ownerUserId]);
    return publicProvider(result.rows[0]!);
  });
}

export async function updateProvider(pool: DatabasePool, providerProfileId: string, input: ProviderProfileUpdate, credentialSecret: string) {
  return withTransaction(pool, async (client) => {
    const ownerUserId = await initialOwnerId(client);
    const current = await client.query<ProviderRow>(`SELECT ${selectColumns} FROM provider_profiles WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`, [providerProfileId, ownerUserId]);
    const row = current.rows[0];
    if (!row) throw Object.assign(new Error("Provider profile not found."), { statusCode: 404 });
    if (row.provider_type === "sogni" && input.configuration !== undefined) {
      const parsed = sogniIllustrationProviderConfigSchema.safeParse(input.configuration);
      if (!parsed.success) throw Object.assign(new Error(parsed.error.issues[0]?.message || "Invalid Sogni provider configuration."), { statusCode: 400 });
    }
    if (input.isDefault) {
      await client.query("UPDATE provider_profiles SET is_default = false, updated_at = now() WHERE owner_user_id = $1 AND provider_role = $2 AND is_default = true", [ownerUserId, row.provider_role]);
    }
    const encrypted = input.apiKey ? encryptCredential(input.apiKey, credentialSecret) : null;
    const result = await client.query<ProviderRow>(
      `UPDATE provider_profiles SET
         name = COALESCE($3, name), base_url = COALESCE($4, base_url), default_model = COALESCE($5, default_model),
         context_window_tokens = COALESCE($6, context_window_tokens), max_output_tokens = COALESCE($7, max_output_tokens),
         temperature = COALESCE($8, temperature), request_timeout_ms = COALESCE($9, request_timeout_ms),
         enabled = COALESCE($10, enabled),
         is_default = CASE WHEN $11 THEN $12 ELSE is_default END,
         encrypted_api_key = CASE WHEN $13 THEN $14 ELSE encrypted_api_key END,
         credential_nonce = CASE WHEN $13 THEN $15 ELSE credential_nonce END,
         credential_auth_tag = CASE WHEN $13 THEN $16 ELSE credential_auth_tag END,
         credential_key_version = CASE WHEN $13 THEN $17 ELSE credential_key_version END,
         configuration = CASE WHEN $18::boolean THEN $19::jsonb ELSE configuration END,
         updated_at = now()
       WHERE id = $1 AND owner_user_id = $2 RETURNING ${selectColumns}`,
      [providerProfileId, ownerUserId, input.name ?? null, input.baseUrl?.replace(/\/+$/, "") ?? null,
        input.defaultModel ?? null, input.contextWindowTokens ?? null, input.maxOutputTokens ?? null,
        input.temperature ?? null, input.requestTimeoutMs ?? null, input.enabled ?? null, input.isDefault !== undefined, input.isDefault ?? false,
        input.apiKey !== undefined, encrypted?.ciphertext ?? null, encrypted?.nonce ?? null,
        encrypted?.authTag ?? null, encrypted?.keyVersion ?? null,
        input.configuration !== undefined, input.configuration !== undefined ? JSON.stringify(input.configuration) : null]
    );
    const updated = result.rows[0];
    if (!updated) throw new Error("Provider profile was not updated.");
    if (updated.provider_role === "text" && updated.max_output_tokens + 512 >= updated.context_window_tokens) {
      throw Object.assign(new Error("Text output reserve must leave at least 512 tokens for input context."), { statusCode: 400 });
    }
    await client.query(
      `UPDATE chronicle_memories SET embedding = NULL, embedding_provider_profile_id = NULL,
              embedding_model = NULL, embedding_dimensions = NULL, embedding_content_hash = NULL,
              embedding_updated_at = NULL, embedding_provider_fingerprint = NULL
        WHERE owner_user_id = $1 AND embedding_provider_profile_id = $2`,
      [ownerUserId, providerProfileId]
    );
    await client.query(
      `INSERT INTO chronicle_jobs (owner_user_id, campaign_id, job_type)
       SELECT owner_user_id, campaign_id, 'embed_campaign' FROM campaign_memory_configs
        WHERE owner_user_id = $1 AND embedding_provider_profile_id = $2 AND embedding_enabled = true
       ON CONFLICT (campaign_id, job_type) WHERE status IN ('queued', 'running')
       DO UPDATE SET work_version = chronicle_jobs.work_version + 1, updated_at = now()`,
      [ownerUserId, providerProfileId]
    );
    return publicProvider(updated);
  });
}

export async function resolveEffectiveProviderId(pool: DatabasePool | DatabaseClient, ownerUserId: string, role: "text" | "image" | "embedding" | "intent", selectedId?: string | null) {
  if (selectedId) {
    const selected = await pool.query<{ id: string }>("SELECT id FROM provider_profiles WHERE id = $1 AND owner_user_id = $2 AND provider_role = $3 AND enabled = true", [selectedId, ownerUserId, role]);
    if (!selected.rows[0]) throw Object.assign(new Error(`Enabled ${role} provider profile not found.`), { statusCode: 400 });
    return selectedId;
  }
  const result = await pool.query<{ id: string; is_default: boolean }>(
    "SELECT id, is_default FROM provider_profiles WHERE owner_user_id = $1 AND provider_role = $2 AND enabled = true ORDER BY is_default DESC, name",
    [ownerUserId, role]
  );
  if (result.rows.length === 1 || result.rows[0]?.is_default) return result.rows[0]?.id || null;
  return null;
}

export async function resolveDefaultIntentProviderId(pool: DatabasePool | DatabaseClient, ownerUserId: string) {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM provider_profiles
      WHERE owner_user_id = $1 AND provider_role = 'intent' AND enabled = true AND is_default = true
      LIMIT 1`,
    [ownerUserId]
  );
  return result.rows[0]?.id || null;
}

export async function generateProviderText(pool: DatabasePool, request: ProviderTextRequest, credentialSecret: string) {
  const ownerUserId = await initialOwnerId(pool);
  const providerId = await resolveEffectiveProviderId(pool, ownerUserId, "text", request.providerProfileId);
  if (!providerId) throw Object.assign(new Error("Add a text provider or mark one as default in Provider Management."), { statusCode: 409 });
  const profile = await loadTextProvider(pool, ownerUserId, providerId, credentialSecret, request.model);
  const systemPrompt = request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n") || "Return only the requested result.";
  const input = request.messages.filter((message) => message.role !== "system").map((message) => `${message.role}: ${message.content}`).join("\n\n");
  const result = await callTextProvider(profile, { systemPrompt, input });
  return {
    content: result.content,
    finishReason: result.finishReason,
    model: result.modelInstanceId || profile.model,
    usage: result.usage
  };
}

export async function loadTextProvider(pool: DatabasePool, ownerUserId: string, providerProfileId: string, credentialSecret: string, model = ""): Promise<TextProviderProfile & { id: string; name: string }> {
  const result = await pool.query<ProviderRow>(
    `SELECT ${selectColumns} FROM provider_profiles
      WHERE id = $1 AND owner_user_id = $2 AND provider_role = 'text' AND enabled = true`,
    [providerProfileId, ownerUserId]
  );
  const row = result.rows[0];
  if (!row) throw Object.assign(new Error("Enabled text provider profile not found."), { statusCode: 404 });
  const apiKey = row.encrypted_api_key && row.credential_nonce && row.credential_auth_tag && row.credential_key_version
    ? decryptCredential({ ciphertext: row.encrypted_api_key, nonce: row.credential_nonce, authTag: row.credential_auth_tag, keyVersion: row.credential_key_version }, credentialSecret)
    : undefined;
  const selectedModel = model.trim() || row.default_model.trim();
  if (!selectedModel) throw Object.assign(new Error("Select a model for this provider profile."), { statusCode: 400 });
  return {
    id: row.id,
    name: row.name,
    providerType: row.provider_type,
    baseUrl: row.base_url,
    model: selectedModel,
    contextWindowTokens: row.context_window_tokens,
    maxOutputTokens: row.max_output_tokens,
    temperature: row.temperature,
    requestTimeoutMs: row.request_timeout_ms,
    configuration: row.configuration,
    ...(apiKey ? { apiKey } : {})
  };
}

export async function loadIntentProvider(pool: DatabasePool, ownerUserId: string, providerProfileId: string, credentialSecret: string, model = ""): Promise<TextProviderProfile & { id: string; name: string }> {
  return loadProviderByRole(pool, ownerUserId, providerProfileId, credentialSecret, "intent", model);
}

export async function loadEmbeddingProvider(pool: DatabasePool, ownerUserId: string, providerProfileId: string, credentialSecret: string, model = ""): Promise<TextProviderProfile & { id: string; name: string }> {
  const result = await pool.query<ProviderRow>(
    `SELECT ${selectColumns} FROM provider_profiles
      WHERE id = $1 AND owner_user_id = $2 AND provider_role IN ('embedding', 'text') AND enabled = true`,
    [providerProfileId, ownerUserId]
  );
  const row = result.rows[0];
  if (!row) throw Object.assign(new Error("Enabled embedding or fallback text provider profile not found."), { statusCode: 404 });
  const apiKey = row.encrypted_api_key && row.credential_nonce && row.credential_auth_tag && row.credential_key_version
    ? decryptCredential({ ciphertext: row.encrypted_api_key, nonce: row.credential_nonce, authTag: row.credential_auth_tag, keyVersion: row.credential_key_version }, credentialSecret)
    : undefined;
  const selectedModel = model.trim() || row.default_model.trim();
  if (!selectedModel) throw Object.assign(new Error("Select an embedding model for this provider profile."), { statusCode: 400 });
  return {
    id: row.id,
    name: row.name,
    providerType: row.provider_type,
    baseUrl: row.base_url,
    model: selectedModel,
    contextWindowTokens: row.context_window_tokens,
    maxOutputTokens: row.max_output_tokens,
    temperature: row.temperature,
    requestTimeoutMs: row.request_timeout_ms,
    configuration: row.configuration,
    ...(apiKey ? { apiKey } : {})
  };
}

export async function loadImageProvider(pool: DatabasePool, ownerUserId: string, providerProfileId: string, credentialSecret: string, model = ""): Promise<TextProviderProfile & { id: string; name: string }> {
  return loadProviderByRole(pool, ownerUserId, providerProfileId, credentialSecret, "image", model);
}

async function loadProviderByRole(
  pool: DatabasePool,
  ownerUserId: string,
  providerProfileId: string,
  credentialSecret: string,
  role: "text" | "embedding" | "image" | "intent",
  model = ""
): Promise<TextProviderProfile & { id: string; name: string }> {
  const result = await pool.query<ProviderRow>(
    `SELECT ${selectColumns} FROM provider_profiles
      WHERE id = $1 AND owner_user_id = $2 AND provider_role = $3 AND enabled = true`,
    [providerProfileId, ownerUserId, role]
  );
  const row = result.rows[0];
  if (!row) throw Object.assign(new Error(`Enabled ${role} provider profile not found.`), { statusCode: 404 });
  const apiKey = row.encrypted_api_key && row.credential_nonce && row.credential_auth_tag && row.credential_key_version
    ? decryptCredential({ ciphertext: row.encrypted_api_key, nonce: row.credential_nonce, authTag: row.credential_auth_tag, keyVersion: row.credential_key_version }, credentialSecret)
    : undefined;
  const selectedModel = model.trim() || row.default_model.trim();
  if (!selectedModel) throw Object.assign(new Error(`Select a model for this ${role} provider profile.`), { statusCode: 400 });
  return {
    id: row.id,
    name: row.name,
    providerType: row.provider_type,
    baseUrl: row.base_url,
    model: selectedModel,
    contextWindowTokens: row.context_window_tokens,
    maxOutputTokens: row.max_output_tokens,
    temperature: row.temperature,
    requestTimeoutMs: row.request_timeout_ms,
    configuration: row.configuration,
    ...(apiKey ? { apiKey } : {})
  };
}

export async function providerModels(pool: DatabasePool, providerProfileId: string, credentialSecret: string) {
  const ownerUserId = await initialOwnerId(pool);
  const { profile, role } = await loadProviderForInventory(pool, ownerUserId, providerProfileId, credentialSecret);
  try {
    const models = await (role === "image"
      ? discoverImageModels(profile)
      : role === "embedding"
        ? discoverEmbeddingModels(profile)
        : discoverModels(profile));
    await recordProviderHealth(pool, ownerUserId, providerProfileId, true);
    return models;
  } catch (error) {
    logProviderTransportError(error, { providerProfileId, ownerUserId, providerRole: role, operation: "provider_model_inventory" });
    await recordProviderHealth(pool, ownerUserId, providerProfileId, false, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export async function discoverUnsavedProviderModels(input: Omit<ProviderProfileInput, "isDefault"> & { isDefault?: boolean }) {
  const profile: TextProviderProfile = {
    providerType: input.providerType,
    baseUrl: input.baseUrl.replace(/\/+$/, ""),
    model: input.defaultModel,
    contextWindowTokens: input.contextWindowTokens,
    maxOutputTokens: input.maxOutputTokens,
    temperature: input.temperature,
    requestTimeoutMs: input.requestTimeoutMs,
    configuration: input.configuration,
    ...(input.apiKey ? { apiKey: input.apiKey } : {})
  };
  return input.providerRole === "image"
    ? discoverImageModels(profile)
    : input.providerRole === "embedding"
      ? discoverEmbeddingModels(profile)
      : discoverModels(profile);
}

export async function deleteProvider(pool: DatabasePool, providerProfileId: string) {
  return withTransaction(pool, async (client) => {
    const ownerUserId = await initialOwnerId(client);
    const current = await client.query<{ id: string; name: string; provider_role: ProviderRow["provider_role"] }>("SELECT id, name, provider_role FROM provider_profiles WHERE id = $1 AND owner_user_id = $2 FOR UPDATE", [providerProfileId, ownerUserId]);
    const provider = current.rows[0];
    if (!provider) throw Object.assign(new Error("Provider profile not found."), { statusCode: 404 });
    if (provider.provider_role === "text") {
      await client.query("UPDATE campaigns SET text_provider_profile_id = NULL WHERE owner_user_id = $1 AND text_provider_profile_id = $2", [ownerUserId, providerProfileId]);
      await client.query("UPDATE campaign_memory_configs SET embedding_enabled = false, embedding_provider_profile_id = NULL WHERE owner_user_id = $1 AND embedding_provider_profile_id = $2", [ownerUserId, providerProfileId]);
      await client.query("UPDATE chronicle_memories SET embedding = NULL, embedding_provider_profile_id = NULL, embedding_model = NULL, embedding_dimensions = NULL, embedding_content_hash = NULL, embedding_updated_at = NULL, embedding_provider_fingerprint = NULL WHERE owner_user_id = $1 AND embedding_provider_profile_id = $2", [ownerUserId, providerProfileId]);
      await client.query("DELETE FROM model_chains WHERE owner_user_id = $1 AND provider_profile_id = $2", [ownerUserId, providerProfileId]);
      await client.query("DELETE FROM generation_jobs WHERE owner_user_id = $1 AND provider_profile_id = $2", [ownerUserId, providerProfileId]);
    } else if (provider.provider_role === "image") {
      await client.query("UPDATE campaigns SET image_provider_profile_id = NULL WHERE owner_user_id = $1 AND image_provider_profile_id = $2", [ownerUserId, providerProfileId]);
      await client.query("UPDATE campaign_illustration_configs SET provider_profile_id = NULL, updated_at = now() WHERE owner_user_id = $1 AND provider_profile_id = $2", [ownerUserId, providerProfileId]);
      await client.query("DELETE FROM image_jobs WHERE owner_user_id = $1 AND provider_profile_id = $2", [ownerUserId, providerProfileId]);
    } else if (provider.provider_role === "embedding") {
      await client.query("UPDATE campaign_memory_configs SET embedding_enabled = false, embedding_provider_profile_id = NULL WHERE owner_user_id = $1 AND embedding_provider_profile_id = $2", [ownerUserId, providerProfileId]);
      await client.query("UPDATE chronicle_memories SET embedding = NULL, embedding_provider_profile_id = NULL, embedding_model = NULL, embedding_dimensions = NULL, embedding_content_hash = NULL, embedding_updated_at = NULL, embedding_provider_fingerprint = NULL WHERE owner_user_id = $1 AND embedding_provider_profile_id = $2", [ownerUserId, providerProfileId]);
    }
    await client.query("DELETE FROM provider_profiles WHERE id = $1 AND owner_user_id = $2", [providerProfileId, ownerUserId]);
    return { deleted: true, ...provider };
  });
}

async function loadProviderForInventory(pool: DatabasePool, ownerUserId: string, id: string, secret: string): Promise<{ profile: TextProviderProfile; role: ProviderRow["provider_role"] }> {
  const result = await pool.query<ProviderRow>(`SELECT ${selectColumns} FROM provider_profiles WHERE id = $1 AND owner_user_id = $2`, [id, ownerUserId]);
  const row = result.rows[0];
  if (!row) throw Object.assign(new Error("Provider profile not found."), { statusCode: 404 });
  const apiKey = row.encrypted_api_key && row.credential_nonce && row.credential_auth_tag && row.credential_key_version
    ? decryptCredential({ ciphertext: row.encrypted_api_key, nonce: row.credential_nonce, authTag: row.credential_auth_tag, keyVersion: row.credential_key_version }, secret) : undefined;
  return { role: row.provider_role, profile: {
    providerType: row.provider_type,
    baseUrl: row.base_url,
    model: row.default_model,
    contextWindowTokens: row.context_window_tokens,
    maxOutputTokens: row.max_output_tokens,
    temperature: row.temperature,
    configuration: row.configuration,
    ...(apiKey ? { apiKey } : {})
  } };
}
