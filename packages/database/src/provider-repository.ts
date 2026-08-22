import {
  providerProfileResolvedWriteSchema,
  sogniIllustrationProviderConfigSchema,
  sogniSdkIllustrationProviderConfigSchema,
  type ProviderType
} from "../../contracts/src/generation.js";
import {
  toSafeProviderConfiguration,
  type CreateProviderProfileCommand,
  type DirectProviderResolution,
  type DirectProviderRole,
  type EmbeddingProviderResolution,
  type ProviderHealthPort,
  type ProviderModelSelection,
  type ProviderProfilePort,
  type ProviderProfileView,
  type ProviderResolutionPort,
  type ProviderRole,
  type SafeProviderConfiguration
} from "../../application/src/providers/index.js";
import type { EncryptedCredential } from "../../story-engine/src/credentials.js";
import type { DatabaseClient } from "./pool.js";

type ProviderRow = {
  id: string;
  name: string;
  provider_type: ProviderType;
  provider_role: ProviderRole;
  base_url: string;
  default_model: string;
  fallback_models?: string[];
  routing_source?: "models" | "openrouter_preset";
  preset_slug?: string | null;
  preset_designated_version_id?: string | null;
  preset_version?: number | null;
  preset_config_hash?: string | null;
  preset_provider_policy?: unknown;
  context_window_tokens: number;
  max_output_tokens: number;
  temperature: number;
  request_timeout_ms: number;
  configuration: unknown;
  encrypted_api_key: string | null;
  credential_nonce: string | null;
  credential_auth_tag: string | null;
  credential_key_version: number | null;
  enabled: boolean;
  is_default: boolean;
  health_status: "unknown" | "healthy" | "degraded" | "unavailable";
  consecutive_failures: number;
  last_health_check_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const SELECT_COLUMNS = `id, name, provider_type, provider_role, base_url, default_model,
  fallback_models, routing_source, preset_slug, preset_designated_version_id, preset_version,
  preset_config_hash, preset_provider_policy,
  context_window_tokens, max_output_tokens, temperature, request_timeout_ms, configuration,
  encrypted_api_key, credential_nonce, credential_auth_tag, credential_key_version, enabled,
  is_default, health_status, consecutive_failures, last_health_check_at, created_at, updated_at`;

function httpError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function capability(role: ProviderRole): ProviderProfileView["capability"] {
  if (role === "text") return "text_generation";
  if (role === "image") return "image_generation";
  if (role === "embedding") return "embedding_generation";
  return "intent_classification";
}

function modelSelection(row: ProviderRow): ProviderModelSelection {
  const parsed = providerProfileResolvedWriteSchema.parse({
    name: row.name,
    providerType: row.provider_type,
    providerRole: row.provider_role,
    baseUrl: row.base_url,
    defaultModel: row.default_model,
    contextWindowTokens: row.context_window_tokens,
    maxOutputTokens: row.max_output_tokens,
    temperature: row.temperature,
    requestTimeoutMs: row.request_timeout_ms,
    configuration: toSafeProviderConfiguration(row.configuration),
    enabled: row.enabled,
    isDefault: row.is_default,
    routingSource: row.routing_source ?? "models",
    fallbackModels: row.fallback_models ?? [],
    presetSlug: row.preset_slug ?? null,
    presetDesignatedVersionId: row.preset_designated_version_id ?? null,
    presetVersion: row.preset_version ?? null,
    presetConfigHash: row.preset_config_hash ?? null,
    presetProviderPolicy: row.preset_provider_policy ?? {}
  });
  return {
    routingSource: parsed.routingSource,
    model: parsed.defaultModel,
    fallbackModels: parsed.fallbackModels,
    preset: parsed.presetSlug === null ? null : {
      slug: parsed.presetSlug,
      designatedVersionId: parsed.presetDesignatedVersionId!,
      version: parsed.presetVersion!,
      configHash: parsed.presetConfigHash!
    },
    providerPolicy: parsed.presetProviderPolicy
  };
}

function profileView(row: ProviderRow): ProviderProfileView {
  const profile = {
    id: row.id,
    name: row.name,
    providerType: row.provider_type,
    providerRole: row.provider_role,
    capability: capability(row.provider_role),
    baseUrl: row.base_url,
    defaultModel: row.default_model,
    contextWindowTokens: row.context_window_tokens,
    maxOutputTokens: row.max_output_tokens,
    temperature: row.temperature,
    requestTimeoutMs: row.request_timeout_ms,
    configuration: toSafeProviderConfiguration(row.configuration),
    enabled: row.enabled,
    isDefault: row.is_default,
    hasCredential: Boolean(row.encrypted_api_key),
    health: {
      status: row.health_status,
      consecutiveFailures: row.consecutive_failures,
      lastCheckedAt: row.last_health_check_at ? iso(row.last_health_check_at) : null
    },
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
  if (row.provider_role === "text" || row.provider_role === "intent") {
    const selection = modelSelection(row);
    return {
      ...profile,
      routingSource: selection.routingSource,
      fallbackModels: selection.fallbackModels,
      preset: selection.preset,
      providerPolicy: selection.providerPolicy
    } as ProviderProfileView;
  }
  return profile as ProviderProfileView;
}

export function validateProviderConfiguration(
  providerType: ProviderType,
  configuration: unknown,
): SafeProviderConfiguration {
  const validated = providerType === "sogni"
    ? sogniIllustrationProviderConfigSchema.parse(configuration)
    : providerType === "sogni_sdk"
      ? sogniSdkIllustrationProviderConfigSchema.parse(configuration)
      : configuration;
  return toSafeProviderConfiguration(validated);
}

function validateCreate(command: CreateProviderProfileCommand): CreateProviderProfileCommand {
  const configuration = validateProviderConfiguration(command.providerType, command.configuration);
  const parsed = providerProfileResolvedWriteSchema.parse({
    ...command,
    configuration,
    routingSource: command.routingSource ?? "models",
    fallbackModels: command.fallbackModels ?? [],
    presetSlug: command.preset?.slug ?? null,
    presetDesignatedVersionId: command.preset?.designatedVersionId ?? null,
    presetVersion: command.preset?.version ?? null,
    presetConfigHash: command.preset?.configHash ?? null,
    presetProviderPolicy: command.providerPolicy ?? {}
  });
  if (parsed.isDefault && !parsed.enabled) throw httpError("A disabled provider cannot be the default.", 400);
  return {
    ...command,
    name: parsed.name,
    providerType: parsed.providerType,
    providerRole: parsed.providerRole,
    baseUrl: parsed.baseUrl.replace(/\/+$/, ""),
    defaultModel: parsed.defaultModel,
    contextWindowTokens: parsed.contextWindowTokens,
    maxOutputTokens: parsed.maxOutputTokens,
    temperature: parsed.temperature,
    requestTimeoutMs: parsed.requestTimeoutMs,
    configuration,
    enabled: parsed.enabled,
    isDefault: parsed.isDefault,
    routingSource: parsed.routingSource,
    fallbackModels: parsed.fallbackModels,
    preset: parsed.presetSlug === null ? null : {
      slug: parsed.presetSlug,
      designatedVersionId: parsed.presetDesignatedVersionId!,
      version: parsed.presetVersion!,
      configHash: parsed.presetConfigHash!
    },
    providerPolicy: parsed.presetProviderPolicy
  } as CreateProviderProfileCommand;
}

function mergedModelSelection(row: ProviderRow, changes: Parameters<ProviderProfilePort["updateProfile"]>[0]["changes"]): ProviderModelSelection {
  const stored = modelSelection(row);
  const hasPartialRoutingFields = changes.fallbackModels !== undefined
    || changes.preset !== undefined || changes.providerPolicy !== undefined;
  if (changes.routingSource === undefined) {
    if (hasPartialRoutingFields) throw httpError("Routing changes must declare their routing source.", 400);
    if (stored.routingSource === "openrouter_preset" && changes.defaultModel !== undefined) {
      throw httpError("Preset routing cannot update models without a validated preset selection.", 400);
    }
    return {
      ...stored,
      model: changes.defaultModel ?? stored.model
    };
  }
  if (changes.routingSource === "models") {
    if (changes.defaultModel === undefined || changes.fallbackModels === undefined) {
      throw httpError("Models routing changes require primary and fallback models together.", 400);
    }
    return {
      routingSource: "models",
      model: changes.defaultModel,
      fallbackModels: changes.fallbackModels,
      preset: null,
      providerPolicy: {}
    };
  }
  if (changes.defaultModel === undefined || changes.fallbackModels === undefined
    || changes.preset === undefined || changes.preset === null || changes.providerPolicy === undefined) {
    throw httpError("Preset routing changes require a complete validated preset snapshot.", 400);
  }
  return {
    routingSource: "openrouter_preset",
    model: changes.defaultModel,
    fallbackModels: changes.fallbackModels,
    preset: changes.preset,
    providerPolicy: changes.providerPolicy
  };
}

async function lockRole(client: DatabaseClient, ownerUserId: string, role: ProviderRole): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`provider-default:${ownerUserId}:${role}`]);
}

async function invalidateEmbeddingProfile(client: DatabaseClient, ownerUserId: string, providerProfileId: string) {
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
  await client.query(
    `UPDATE chronicle_memory_chunks SET embedding = NULL, embedding_status = 'pending',
            embedding_skip_reason = NULL, embedding_provider_profile_id = NULL,
            embedding_model = NULL, embedding_dimensions = NULL,
            embedding_protocol_version = NULL, embedding_provider_fingerprint = NULL,
            embedding_content_hash = NULL, embedding_updated_at = NULL, updated_at = now()
      WHERE owner_user_id = $1 AND embedding_provider_profile_id = $2`,
    [ownerUserId, providerProfileId]
  );
  await client.query(
    `INSERT INTO chronicle_chunk_jobs
       (owner_user_id,campaign_id,job_type,progress,work_signature)
     SELECT config.owner_user_id,config.campaign_id,'index_memory_chunks_v2','{}'::jsonb,
            encode(digest(
              campaigns.world_version_id::text || E'\\x1f' || COALESCE((
                SELECT string_agg(
                  memories.ordinal::text || ':' || memories.id::text || ':' || memories.content_hash,
                  E'\\x1e' ORDER BY memories.ordinal,memories.id
                )
                  FROM chronicle_memories memories
                 WHERE memories.owner_user_id=config.owner_user_id
                   AND memories.campaign_id=config.campaign_id
                   AND memories.world_version_id=campaigns.world_version_id
              ), ''),
              'sha256'
            ), 'hex')
       FROM campaign_memory_configs config
       JOIN campaigns
         ON campaigns.id=config.campaign_id AND campaigns.owner_user_id=config.owner_user_id
      WHERE config.owner_user_id = $1 AND config.embedding_provider_profile_id = $2
        AND (config.embedding_enabled = true OR config.retrieval_shadow_enabled = true)
     ON CONFLICT (campaign_id) WHERE status IN ('queued', 'running')
     DO UPDATE SET work_version = chronicle_chunk_jobs.work_version + 1,
                   work_signature = EXCLUDED.work_signature,
                   progress = '{}'::jsonb, updated_at = now(), error_message = NULL`,
    [ownerUserId, providerProfileId]
  );
  await client.query(
    "DELETE FROM chronicle_query_embedding_cache WHERE owner_user_id=$1 AND provider_profile_id=$2",
    [ownerUserId, providerProfileId]
  );
}

export type PostgresProviderRepositories = Readonly<{
  profiles: ProviderProfilePort;
  health: ProviderHealthPort;
  resolution: ProviderResolutionPort;
}>;

export function createPostgresProviderRepositories(client: DatabaseClient): PostgresProviderRepositories {
  const profiles: ProviderProfilePort = {
    async listProfiles(scope) {
      const result = await client.query<ProviderRow>(
        `SELECT ${SELECT_COLUMNS} FROM provider_profiles
          WHERE owner_user_id = $1 ORDER BY provider_role, name, id`,
        [scope.ownerUserId]
      );
      return result.rows.map(profileView);
    },

    async createProfile(rawCommand) {
      const command = validateCreate(rawCommand);
      if (command.isDefault) {
        await lockRole(client, command.ownerUserId, command.providerRole);
        await client.query(
          "UPDATE provider_profiles SET is_default = false, updated_at = now() WHERE owner_user_id = $1 AND provider_role = $2 AND is_default",
          [command.ownerUserId, command.providerRole]
        );
      }
      const result = await client.query<ProviderRow>(
        `INSERT INTO provider_profiles (
           owner_user_id, name, provider_type, provider_role, base_url, default_model,
           fallback_models, routing_source, preset_slug, preset_designated_version_id, preset_version,
           preset_config_hash, preset_provider_policy,
           context_window_tokens, max_output_tokens, temperature, request_timeout_ms,
           configuration, enabled, is_default
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18::jsonb,$19,$20)
         RETURNING ${SELECT_COLUMNS}`,
        [command.ownerUserId, command.name, command.providerType, command.providerRole,
          command.baseUrl, command.defaultModel.trim(), command.fallbackModels,
          command.routingSource, command.preset?.slug ?? null,
          command.preset?.designatedVersionId ?? null, command.preset?.version ?? null,
          command.preset?.configHash ?? null, JSON.stringify(command.providerPolicy ?? {}),
          command.contextWindowTokens, command.maxOutputTokens, command.temperature,
          command.requestTimeoutMs, JSON.stringify(command.configuration), command.enabled, command.isDefault]
      );
      return profileView(result.rows[0]!);
    },

    async updateProfile(command) {
      if (command.changes.isDefault === true) {
        const role = await client.query<Pick<ProviderRow, "provider_role">>(
          "SELECT provider_role FROM provider_profiles WHERE id=$1 AND owner_user_id=$2",
          [command.providerProfileId, command.ownerUserId]
        );
        if (!role.rows[0]) throw httpError("Provider profile not found.", 404);
        await lockRole(client, command.ownerUserId, role.rows[0].provider_role);
      }
      const current = await client.query<ProviderRow>(
        `SELECT ${SELECT_COLUMNS} FROM provider_profiles
          WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
        [command.providerProfileId, command.ownerUserId]
      );
      const row = current.rows[0];
      if (!row) throw httpError("Provider profile not found.", 404);
      const changes = command.changes;
      const selection = mergedModelSelection(row, changes);
      const merged = validateCreate({
        ownerUserId: command.ownerUserId,
        name: changes.name ?? row.name,
        providerType: row.provider_type,
        providerRole: row.provider_role,
        baseUrl: changes.baseUrl ?? row.base_url,
        defaultModel: selection.model,
        routingSource: selection.routingSource,
        fallbackModels: selection.fallbackModels,
        preset: selection.preset,
        providerPolicy: selection.providerPolicy,
        contextWindowTokens: changes.contextWindowTokens ?? row.context_window_tokens,
        maxOutputTokens: changes.maxOutputTokens ?? row.max_output_tokens,
        temperature: changes.temperature ?? row.temperature,
        requestTimeoutMs: changes.requestTimeoutMs ?? row.request_timeout_ms,
        configuration: changes.configuration === undefined
          ? toSafeProviderConfiguration(row.configuration)
          : validateProviderConfiguration(row.provider_type, changes.configuration),
        enabled: changes.enabled ?? row.enabled,
        isDefault: changes.isDefault ?? row.is_default
      });
      if (changes.isDefault === true) {
        await client.query(
          "UPDATE provider_profiles SET is_default = false, updated_at = now() WHERE owner_user_id = $1 AND provider_role = $2 AND id <> $3 AND is_default",
          [command.ownerUserId, row.provider_role, row.id]
        );
      }
      const result = await client.query<ProviderRow>(
        `UPDATE provider_profiles SET name=$3, base_url=$4, default_model=$5,
           fallback_models=$6::text[], routing_source=$7, preset_slug=$8,
           preset_designated_version_id=$9, preset_version=$10, preset_config_hash=$11,
           preset_provider_policy=$12::jsonb, context_window_tokens=$13, max_output_tokens=$14,
           temperature=$15, request_timeout_ms=$16, configuration=$17::jsonb, enabled=$18,
           is_default=$19, updated_at=now()
         WHERE id=$1 AND owner_user_id=$2 RETURNING ${SELECT_COLUMNS}`,
        [row.id, command.ownerUserId, merged.name, merged.baseUrl, merged.defaultModel.trim(),
          merged.fallbackModels, merged.routingSource, merged.preset?.slug ?? null,
          merged.preset?.designatedVersionId ?? null, merged.preset?.version ?? null,
          merged.preset?.configHash ?? null, JSON.stringify(merged.providerPolicy ?? {}),
          merged.contextWindowTokens, merged.maxOutputTokens, merged.temperature,
          merged.requestTimeoutMs, JSON.stringify(merged.configuration), merged.enabled, merged.isDefault]
      );
      await invalidateEmbeddingProfile(client, command.ownerUserId, row.id);
      return profileView(result.rows[0]!);
    },

    async setDefaultProfile(command) {
      await lockRole(client, command.ownerUserId, command.providerRole);
      const selected = await client.query<ProviderRow>(
        `SELECT ${SELECT_COLUMNS} FROM provider_profiles
          WHERE id=$1 AND owner_user_id=$2 AND provider_role=$3 AND enabled=true FOR UPDATE`,
        [command.providerProfileId, command.ownerUserId, command.providerRole]
      );
      if (!selected.rows[0]) throw httpError(`Enabled ${command.providerRole} provider profile not found.`, 404);
      await client.query(
        "UPDATE provider_profiles SET is_default=false, updated_at=now() WHERE owner_user_id=$1 AND provider_role=$2 AND id<>$3 AND is_default",
        [command.ownerUserId, command.providerRole, command.providerProfileId]
      );
      const result = await client.query<ProviderRow>(
        `UPDATE provider_profiles SET is_default=true, updated_at=now()
          WHERE id=$1 AND owner_user_id=$2 RETURNING ${SELECT_COLUMNS}`,
        [command.providerProfileId, command.ownerUserId]
      );
      return profileView(result.rows[0]!);
    },

    async deleteProfile(command) {
      const selected = await client.query<Pick<ProviderRow, "id" | "name" | "provider_role">>(
        "SELECT id,name,provider_role FROM provider_profiles WHERE id=$1 AND owner_user_id=$2 FOR UPDATE",
        [command.providerProfileId, command.ownerUserId]
      );
      const row = selected.rows[0];
      if (!row) throw httpError("Provider profile not found.", 404);
      if (row.provider_role === "text") {
        await client.query("UPDATE campaigns SET text_provider_profile_id=NULL WHERE owner_user_id=$1 AND text_provider_profile_id=$2", [command.ownerUserId, row.id]);
        await client.query("DELETE FROM model_chains WHERE owner_user_id=$1 AND provider_profile_id=$2", [command.ownerUserId, row.id]);
        await client.query("DELETE FROM generation_jobs WHERE owner_user_id=$1 AND provider_profile_id=$2", [command.ownerUserId, row.id]);
      }
      if (row.provider_role === "image") {
        await client.query("UPDATE campaigns SET image_provider_profile_id=NULL WHERE owner_user_id=$1 AND image_provider_profile_id=$2", [command.ownerUserId, row.id]);
        await client.query("UPDATE campaign_illustration_configs SET provider_profile_id=NULL,updated_at=now() WHERE owner_user_id=$1 AND provider_profile_id=$2", [command.ownerUserId, row.id]);
        await client.query("DELETE FROM image_jobs WHERE owner_user_id=$1 AND provider_profile_id=$2", [command.ownerUserId, row.id]);
      }
      if (row.provider_role === "text" || row.provider_role === "embedding") {
        await client.query("UPDATE campaign_memory_configs SET embedding_enabled=false,embedding_provider_profile_id=NULL WHERE owner_user_id=$1 AND embedding_provider_profile_id=$2", [command.ownerUserId, row.id]);
        await client.query(`UPDATE chronicle_memories SET embedding=NULL,embedding_provider_profile_id=NULL,embedding_model=NULL,embedding_dimensions=NULL,embedding_content_hash=NULL,embedding_updated_at=NULL,embedding_provider_fingerprint=NULL WHERE owner_user_id=$1 AND embedding_provider_profile_id=$2`, [command.ownerUserId, row.id]);
        await client.query(
          `UPDATE chronicle_memory_chunks SET embedding=NULL,embedding_status='pending',embedding_skip_reason=NULL,
             embedding_provider_profile_id=NULL,embedding_model=NULL,embedding_dimensions=NULL,
             embedding_protocol_version=NULL,embedding_provider_fingerprint=NULL,
             embedding_content_hash=NULL,embedding_updated_at=NULL,updated_at=now()
           WHERE owner_user_id=$1 AND embedding_provider_profile_id=$2`,
          [command.ownerUserId, row.id]
        );
      }
      await client.query("DELETE FROM provider_profiles WHERE id=$1 AND owner_user_id=$2", [row.id, command.ownerUserId]);
      return { id: row.id, name: row.name, providerRole: row.provider_role, deleted: true };
    }
  };

  async function resolve<R extends DirectProviderRole>(
    ownerUserId: string,
    role: R,
    selectedProviderProfileId: string | null | undefined,
    requestedModel: string | undefined,
  ): Promise<DirectProviderResolution<R>> {
    const result = selectedProviderProfileId
      ? await client.query<ProviderRow>(
          `SELECT ${SELECT_COLUMNS} FROM provider_profiles
            WHERE id=$1 AND owner_user_id=$2 AND provider_role=$3 AND enabled=true`,
          [selectedProviderProfileId, ownerUserId, role]
        )
      : await client.query<ProviderRow>(
          `SELECT ${SELECT_COLUMNS} FROM provider_profiles
            WHERE owner_user_id=$1 AND provider_role=$2 AND enabled=true
            ORDER BY is_default DESC,name,id LIMIT 2`,
          [ownerUserId, role]
        );
    if (selectedProviderProfileId && !result.rows[0]) throw httpError(`Enabled ${role} provider profile not found.`, 400);
    const row = selectedProviderProfileId
      ? result.rows[0]
      : result.rows.length === 1 || result.rows[0]?.is_default
        ? result.rows[0]
        : undefined;
    if (!row) return { status: "unconfigured", requestedRole: role, resolvedRole: null };
    const model = requestedModel?.trim() || row.default_model.trim();
    if (!model) throw httpError(`Select a model for this ${role} provider profile.`, 400);
    if (role === "text" || role === "intent") {
      if (requestedModel?.trim()) {
        return {
          status: "resolved", requestedRole: role, resolvedRole: role, providerProfileId: row.id,
          providerType: row.provider_type, routingSource: "models", model,
          fallbackModels: [], preset: null, providerPolicy: {}
        } as DirectProviderResolution<R>;
      }
      const selection = modelSelection(row);
      return {
        status: "resolved", requestedRole: role, resolvedRole: role, providerProfileId: row.id,
        providerType: row.provider_type, ...selection
      } as DirectProviderResolution<R>;
    }
    return { status: "resolved", requestedRole: role, resolvedRole: role, providerProfileId: row.id, providerType: row.provider_type, model } as DirectProviderResolution<R>;
  }

  const resolution: ProviderResolutionPort = {
    resolveDirect: (request) => resolve(request.ownerUserId, request.providerRole, request.selectedProviderProfileId, request.model),
    async resolveEmbedding(request): Promise<EmbeddingProviderResolution> {
      const dedicated = await client.query<Pick<ProviderRow, "id" | "provider_type" | "default_model" | "is_default">>(
        `SELECT id,provider_type,default_model,is_default FROM provider_profiles
          WHERE owner_user_id=$1 AND provider_role='embedding' AND enabled=true
          ORDER BY is_default DESC,name,id`,
        [request.ownerUserId]
      );
      let row = request.selectedProviderProfileId
        ? dedicated.rows.find((value) => value.id === request.selectedProviderProfileId)
        : dedicated.rows.length === 1 || dedicated.rows[0]?.is_default ? dedicated.rows[0] : undefined;
      if (row) {
        const model = request.model?.trim() || row.default_model.trim();
        if (!model) throw httpError("Select an embedding model for this provider profile.", 400);
        return { status: "resolved", requestedRole: "embedding", resolvedRole: "embedding", source: "dedicated_embedding", providerProfileId: row.id, providerType: row.provider_type, model };
      }
      const selectedTextFallbackAllowed = Boolean(
        request.selectedProviderProfileId && request.allowTextFallback && dedicated.rows.length === 0
      );
      if (request.selectedProviderProfileId && !selectedTextFallbackAllowed) {
        throw httpError("Enabled embedding provider profile not found.", 400);
      }
      if (request.allowTextFallback) {
        const fallback = await resolve(
          request.ownerUserId,
          "text",
          selectedTextFallbackAllowed ? request.selectedProviderProfileId : undefined,
          request.model,
        );
        if (fallback.status === "resolved") {
          return {
            status: "resolved",
            requestedRole: "embedding",
            resolvedRole: "text",
            source: "text_fallback",
            providerProfileId: fallback.providerProfileId,
            providerType: fallback.providerType,
            model: fallback.model
          };
        }
      }
      return { status: "unconfigured", requestedRole: "embedding", resolvedRole: null, source: "none" };
    }
  };

  const health: ProviderHealthPort = {
    async recordHealth(record) {
      const result = record.outcome === "healthy"
        ? await client.query(
            `UPDATE provider_profiles SET health_status='healthy',consecutive_failures=0,
               last_health_check_at=now(),last_health_error=NULL,updated_at=now()
             WHERE id=$1 AND owner_user_id=$2`,
            [record.providerProfileId, record.ownerUserId]
          )
        : await client.query(
            `UPDATE provider_profiles SET consecutive_failures=consecutive_failures+1,
               health_status=CASE WHEN consecutive_failures+1>=3 THEN 'unavailable' ELSE 'degraded' END,
               last_health_check_at=now(),last_health_error=$3,updated_at=now()
             WHERE id=$1 AND owner_user_id=$2`,
            [record.providerProfileId, record.ownerUserId, record.diagnosticCode ?? "unknown_failure"]
          );
      if (!result.rowCount) throw httpError("Provider profile not found.", 404);
    }
  };

  return { profiles, health, resolution };
}

export type PrivateProviderCredentialRow = Readonly<{
  ownerUserId: string;
  providerProfileId: string;
  name: string;
  providerRole: ProviderRole;
  providerType: ProviderType;
  baseUrl: string;
  defaultModel: string;
  routingSource: "models" | "openrouter_preset";
  fallbackModels: readonly string[];
  preset: ProviderModelSelection["preset"];
  providerPolicy: ProviderModelSelection["providerPolicy"];
  contextWindowTokens: number;
  maxOutputTokens: number;
  temperature: number;
  requestTimeoutMs: number;
  configuration: SafeProviderConfiguration;
  encryptedCredential: EncryptedCredential | null;
}>;

function privateProviderCredentialRow(ownerUserId: string, row: ProviderRow): PrivateProviderCredentialRow {
  const complete = row.encrypted_api_key && row.credential_nonce && row.credential_auth_tag && row.credential_key_version;
  const selection = row.provider_role === "text" || row.provider_role === "intent"
    ? modelSelection(row)
    : { routingSource: "models" as const, model: row.default_model, fallbackModels: [], preset: null, providerPolicy: {} };
  return {
    ownerUserId,
    providerProfileId: row.id,
    name: row.name,
    providerRole: row.provider_role,
    providerType: row.provider_type,
    baseUrl: row.base_url,
    defaultModel: row.default_model,
    routingSource: selection.routingSource,
    fallbackModels: selection.fallbackModels,
    preset: selection.preset,
    providerPolicy: selection.providerPolicy,
    contextWindowTokens: row.context_window_tokens,
    maxOutputTokens: row.max_output_tokens,
    temperature: row.temperature,
    requestTimeoutMs: row.request_timeout_ms,
    configuration: toSafeProviderConfiguration(row.configuration),
    encryptedCredential: complete ? {
      ciphertext: row.encrypted_api_key!, nonce: row.credential_nonce!, authTag: row.credential_auth_tag!, keyVersion: row.credential_key_version!
    } : null
  };
}

export async function loadPrivateProviderCredentialRow(
  database: DatabaseClient,
  ownerUserId: string,
  providerProfileId: string,
): Promise<PrivateProviderCredentialRow | null> {
  const result = await database.query<ProviderRow>(
    `SELECT ${SELECT_COLUMNS} FROM provider_profiles WHERE id=$1 AND owner_user_id=$2 AND enabled=true`,
    [providerProfileId, ownerUserId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return privateProviderCredentialRow(ownerUserId, row);
}

/**
 * Management-only credential load for read-only discovery. Runtime execution
 * remains on the enabled-only loader above.
 */
export async function loadPrivateProviderManagementCredentialRow(
  database: DatabaseClient,
  ownerUserId: string,
  providerProfileId: string,
): Promise<PrivateProviderCredentialRow | null> {
  const result = await database.query<ProviderRow>(
    `SELECT ${SELECT_COLUMNS} FROM provider_profiles WHERE id=$1 AND owner_user_id=$2`,
    [providerProfileId, ownerUserId]
  );
  const row = result.rows[0];
  return row ? privateProviderCredentialRow(ownerUserId, row) : null;
}

export async function writeEncryptedProviderCredential(
  database: DatabaseClient,
  ownerUserId: string,
  providerProfileId: string,
  encrypted: EncryptedCredential | null,
): Promise<void> {
  const result = await database.query(
    `UPDATE provider_profiles SET encrypted_api_key=$3,credential_nonce=$4,
       credential_auth_tag=$5,credential_key_version=$6,updated_at=now()
     WHERE id=$1 AND owner_user_id=$2`,
    [providerProfileId, ownerUserId, encrypted?.ciphertext ?? null, encrypted?.nonce ?? null,
      encrypted?.authTag ?? null, encrypted?.keyVersion ?? null]
  );
  if (!result.rowCount) throw httpError("Provider profile not found.", 404);
}
