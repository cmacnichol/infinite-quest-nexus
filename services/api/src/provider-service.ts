import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { initialOwnerId } from "../../../packages/database/src/pool.js";
import type { ProviderProfileInput } from "../../../packages/contracts/src/generation.js";
import { decryptCredential, encryptCredential, discoverImageModels, discoverModels, type TextProviderProfile } from "../../../packages/story-engine/src/index.js";

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
  configuration: Record<string, unknown>;
  encrypted_api_key: string | null;
  credential_nonce: string | null;
  credential_auth_tag: string | null;
  credential_key_version: number | null;
  enabled: boolean;
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
    configuration: row.configuration,
    enabled: row.enabled,
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
  context_window_tokens, max_output_tokens, temperature, configuration, encrypted_api_key,
  credential_nonce, credential_auth_tag, credential_key_version, enabled, health_status,
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

export async function createProvider(pool: DatabasePool, input: ProviderProfileInput, credentialSecret: string) {
  const ownerUserId = await initialOwnerId(pool);
  const encrypted = input.apiKey ? encryptCredential(input.apiKey, credentialSecret) : null;
  const result = await pool.query<ProviderRow>(
    `INSERT INTO provider_profiles (
       owner_user_id, name, provider_type, provider_role, base_url, default_model,
       context_window_tokens, max_output_tokens, temperature, configuration,
       encrypted_api_key, credential_nonce, credential_auth_tag, credential_key_version, enabled
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING ${selectColumns}`,
    [ownerUserId, input.name, input.providerType, input.providerRole, input.baseUrl.replace(/\/+$/, ""), input.defaultModel,
      input.contextWindowTokens, input.maxOutputTokens, input.temperature, JSON.stringify(input.configuration),
      encrypted?.ciphertext ?? null, encrypted?.nonce ?? null, encrypted?.authTag ?? null, encrypted?.keyVersion ?? null, input.enabled]
  );
  const row = result.rows[0];
  if (!row) throw new Error("Provider profile was not created.");
  return publicProvider(row);
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
    configuration: row.configuration,
    ...(apiKey ? { apiKey } : {})
  };
}

export async function loadEmbeddingProvider(pool: DatabasePool, ownerUserId: string, providerProfileId: string, credentialSecret: string, model = ""): Promise<TextProviderProfile & { id: string; name: string }> {
  return loadProviderByRole(pool, ownerUserId, providerProfileId, credentialSecret, "embedding", model);
}

export async function loadImageProvider(pool: DatabasePool, ownerUserId: string, providerProfileId: string, credentialSecret: string, model = ""): Promise<TextProviderProfile & { id: string; name: string }> {
  return loadProviderByRole(pool, ownerUserId, providerProfileId, credentialSecret, "image", model);
}

async function loadProviderByRole(
  pool: DatabasePool,
  ownerUserId: string,
  providerProfileId: string,
  credentialSecret: string,
  role: "text" | "embedding" | "image",
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
    configuration: row.configuration,
    ...(apiKey ? { apiKey } : {})
  };
}

export async function providerModels(pool: DatabasePool, providerProfileId: string, credentialSecret: string) {
  const ownerUserId = await initialOwnerId(pool);
  const { profile, role } = await loadProviderForInventory(pool, ownerUserId, providerProfileId, credentialSecret);
  try {
    const models = await (role === "image" ? discoverImageModels(profile) : discoverModels(profile));
    await recordProviderHealth(pool, ownerUserId, providerProfileId, true);
    return models;
  } catch (error) {
    await recordProviderHealth(pool, ownerUserId, providerProfileId, false, error instanceof Error ? error.message : String(error));
    throw error;
  }
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
