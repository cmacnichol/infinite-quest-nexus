import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { initialOwnerId } from "../../../packages/database/src/pool.js";
import type { ProviderProfileInput } from "../../../packages/contracts/src/generation.js";
import { decryptCredential, encryptCredential, discoverModels, type TextProviderProfile } from "../../../packages/story-engine/src/index.js";

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
    hasApiKey: Boolean(row.encrypted_api_key),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const selectColumns = `id, name, provider_type, provider_role, base_url, default_model,
  context_window_tokens, max_output_tokens, temperature, configuration, encrypted_api_key,
  credential_nonce, credential_auth_tag, credential_key_version, enabled, created_at, updated_at`;

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

async function loadProviderByRole(
  pool: DatabasePool,
  ownerUserId: string,
  providerProfileId: string,
  credentialSecret: string,
  role: "text" | "embedding",
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
  const profile = await loadTextProviderForInventory(pool, ownerUserId, providerProfileId, credentialSecret);
  return discoverModels(profile);
}

async function loadTextProviderForInventory(pool: DatabasePool, ownerUserId: string, id: string, secret: string): Promise<TextProviderProfile> {
  const result = await pool.query<ProviderRow>(`SELECT ${selectColumns} FROM provider_profiles WHERE id = $1 AND owner_user_id = $2`, [id, ownerUserId]);
  const row = result.rows[0];
  if (!row) throw Object.assign(new Error("Provider profile not found."), { statusCode: 404 });
  const apiKey = row.encrypted_api_key && row.credential_nonce && row.credential_auth_tag && row.credential_key_version
    ? decryptCredential({ ciphertext: row.encrypted_api_key, nonce: row.credential_nonce, authTag: row.credential_auth_tag, keyVersion: row.credential_key_version }, secret) : undefined;
  return {
    providerType: row.provider_type,
    baseUrl: row.base_url,
    model: row.default_model,
    contextWindowTokens: row.context_window_tokens,
    maxOutputTokens: row.max_output_tokens,
    temperature: row.temperature,
    configuration: row.configuration,
    ...(apiKey ? { apiKey } : {})
  };
}
