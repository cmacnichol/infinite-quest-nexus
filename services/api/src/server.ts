import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import type { RuntimeConfig } from "../../../packages/database/src/config.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { initialOwnerId } from "../../../packages/database/src/pool.js";
import { createLoggerOptions } from "../../../packages/logger/src/index.js";
import { infiniteWorldsImportRequestSchema, storyImportPreviewRequestSchema, storyImportRequestSchema } from "../../../packages/contracts/src/imports.js";
import { campaignEmbeddingConfigSchema, memoryContextQuerySchema } from "../../../packages/contracts/src/memory.js";
import {
  campaignBranchSchema,
  campaignRuntimeStateUpdateSchema,
  campaignRewindSchema,
  generationRequestSchema,
  generationRetryLatestRequestSchema,
  illustrationConfigSchema,
  illustrationRequestSchema,
  assetSelectionSchema,
  worldCoverRequestSchema,
  playerCampaignConfigSchema,
  providerProfileInputSchema,
  providerProfileUpdateSchema,
  providerTextRequestSchema,
  turnInputClassificationRequestSchema
} from "../../../packages/contracts/src/generation.js";
import {
  campaignCreateSchema,
  campaignUpdateSchema,
  campaignWorldMigrationSchema,
  playableCharacterGenerationRequestSchema,
  resourceDeleteSchema,
  worldCreateSchema,
  worldDraftUpdateSchema,
  worldForkSchema,
  worldImportRequestSchema,
  worldPublishSchema,
  worldVersionDeleteSchema,
  worldStatusUpdateSchema
} from "../../../packages/contracts/src/world-library.js";
import { providerTransportErrorDetails } from "../../../packages/story-engine/src/providers.js";
import { formatNarrationParagraphs } from "../../../packages/story-engine/src/narration-formatting.js";
import { userProfileUpdateSchema } from "../../../packages/contracts/src/users.js";
import { assetListQuerySchema, assetMetadataUpdateSchema } from "../../../packages/contracts/src/assets.js";
import {
  campaignTransferCommitRequestSchema,
  campaignTransferPreviewRequestSchema
} from "../../../packages/contracts/src/campaign-transfer.js";
import { importLegacyStory, previewLegacyStoryImport } from "./import-service.js";
import { getImportProgress, importInfiniteWorlds, previewInfiniteWorldsImport } from "./infinite-worlds-import-service.js";
import { getSessionUserProfile, updateSessionUserProfile } from "./user-service.js";
import {
  buildContextPreview,
  enqueueChronicleReindex,
  enqueueEmbeddingReindex,
  getCampaignEmbeddingConfig,
  getChronicleMetrics,
  setCampaignEmbeddingConfig
} from "./memory-service.js";
import { queryAssets, readAsset, readAssetDerivative, selectTurnIllustration, selectWorldCover, updateAssetMetadata, type FilesystemAssetStore } from "./asset-service.js";
import { createProvider, deleteProvider, discoverUnsavedProviderModels, generateProviderText, listProviders, providerModels, setDefaultProvider, updateProvider } from "./provider-service.js";
import { branchCampaign, discardGeneration, enqueueGeneration, enqueueLatestReplacement, getGenerationJob, getGenerationResult, retryGeneration, rewindCampaign, syncPlayerCampaignConfig } from "./generation-service.js";
import { getCampaignRuntimeState, updateCampaignRuntimeState } from "./campaign-state-service.js";
import {
  enqueueIllustration,
  enqueueWorldCover,
  getIllustrationConfig,
  getImageJob,
  listCampaignImageJobs,
  retryImageJob,
  setIllustrationConfig
} from "./image-service.js";
import {
  createCampaign,
  createWorld,
  deleteCampaign,
  deleteWorld,
  deleteWorldVersion,
  exportCampaign,
  exportWorld,
  forkWorld,
  getWorldVersionPlayableCharacterSummary,
  getWorld,
  importWorld,
  listCampaigns,
  listWorlds,
  migrateCampaignWorld,
  previewWorldImport,
  publishWorld,
  updateCampaign,
  updateWorld,
  updateWorldDraft
} from "./world-service.js";
import { generatePlayableCharacter } from "./world-generator-service.js";
import { getCampaignCostSummary, turnReportedCosts } from "./cost-service.js";
import { classifyTurnInput } from "./turn-intent-service.js";
import { previewCampaignWorldTransfer, transferCampaignWorld } from "./campaign-transfer-service.js";
import { applicationMetadata } from "./app-metadata.js";
import { getDashboardStats } from "./dashboard-service.js";
import { getTurnIllustrationResolution, rematchTurnIllustration } from "./illustration-resolution-service.js";

type BuildServerOptions = {
  config: RuntimeConfig;
  pool: DatabasePool;
};

const uuidSchema = z.uuid();

function statusCode(error: unknown): number {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const value = Number((error as { statusCode: unknown }).statusCode);
    if (Number.isInteger(value) && value >= 400 && value <= 599) return value;
  }
  if (typeof error === "object" && error !== null && "issues" in error) return 400;
  if (typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === "22P02") return 400;
  return 500;
}

function errorDetails(error: unknown): { name: string; message: string; issues?: unknown; details?: unknown } {
  if (typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === "22P02") {
    return { name: "InvalidUuidError", message: "The provided ID is not a valid UUID." };
  }
  if (error instanceof Error) {
    const issues = "issues" in error ? (error as Error & { issues?: unknown }).issues : undefined;
    const details = "details" in error ? (error as Error & { details?: unknown }).details : undefined;
    return {
      name: error.name || "Error",
      message: error.message,
      ...(issues === undefined ? {} : { issues }),
      ...(details === undefined ? {} : { details })
    };
  }
  return { name: "Error", message: String(error) };
}

function exposeError(error: unknown, code: number): boolean {
  return code < 500 || (typeof error === "object" && error !== null && "expose" in error && (error as { expose?: unknown }).expose === true);
}

export async function buildServer({ config, pool }: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: createLoggerOptions(),
    bodyLimit: 64 * 1024 * 1024,
    requestIdHeader: "x-correlation-id",
    genReqId: () => crypto.randomUUID()
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Content-Security-Policy", "default-src 'self' 'unsafe-inline' data: blob:; img-src * data: blob:; connect-src *");
    reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    if (request.url.startsWith("/api/v1/")) reply.header("Cache-Control", "no-store");

    const origin = request.headers.origin;
    if (origin) {
      if (config.corsAllowedOrigins.includes("*") || config.corsAllowedOrigins.length === 0) {
        reply.header("Access-Control-Allow-Origin", origin);
        reply.header("Vary", "Origin");
      } else if (config.corsAllowedOrigins.includes(origin)) {
        reply.header("Access-Control-Allow-Origin", origin);
        reply.header("Vary", "Origin");
      }
      reply.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-User-Id, X-Correlation-Id");
      reply.header("Access-Control-Allow-Credentials", "true");
    }
  });

  app.options("*", async (_request, reply) => {
    return reply.code(204).send();
  });

  await mkdir(config.assetStorageRoot, { recursive: true });
  const assetStore: FilesystemAssetStore = { root: config.assetStorageRoot };
  await app.register(fastifyStatic, {
    root: config.webRoot,
    prefix: "/nexus/",
    index: ["index.html"],
    decorateReply: true
  });
  await app.register(fastifyStatic, {
    root: resolve(process.cwd(), "node_modules/photoswipe/dist"),
    prefix: "/vendor/photoswipe/",
    decorateReply: false,
    cacheControl: true,
    maxAge: "30d"
  });

  app.setErrorHandler((error, request, reply) => {
    const code = statusCode(error);
    const details = errorDetails(error);
    const exposed = exposeError(error, code);
    const transport = providerTransportErrorDetails(error);
    request.log.error({ err: error, code }, "request_failed");
    void reply.code(code).send({
      error: exposed ? details.name || "Provider request failed" : "Internal server error",
      message: exposed ? `${details.message} Correlation ID: ${request.id}.` : "The request failed. Use the correlation ID to locate server diagnostics.",
      correlationId: request.id,
      ...(!exposed || details.details === undefined ? {} : { details: details.details }),
      ...(transport ? { details: { code: transport.timedOut ? "provider_request_timeout" : "provider_transport_error", transport } } : {}),
      ...(details.issues === undefined ? {} : { issues: details.issues })
    });
  });

  app.get("/", async (_request, reply) => reply.redirect("/nexus/", 308));
  app.get("/index.html", async (_request, reply) => reply.redirect("/nexus/", 308));

  // Story Player — clean URL for campaign gameplay
  const storyHtml = async () => {
    return readFile(resolve(config.webRoot, "story.html"), "utf8");
  };
  let storyHtmlCache: string | null = null;
  const cachedStoryHtml = async () => {
    storyHtmlCache ??= await storyHtml();
    return storyHtmlCache;
  };
  app.get("/story", async (_request, reply) => reply.type("text/html; charset=utf-8").send(await cachedStoryHtml()));
  app.get("/story/:campaignId", async (_request, reply) => reply.type("text/html; charset=utf-8").send(await cachedStoryHtml()));
  app.get("/health/live", async () => ({ status: "ok", role: config.role }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      const result = await pool.query<{ database_version: string; vector_version: string | null }>(
        `SELECT current_setting('server_version') AS database_version,
                (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS vector_version`
      );
      const row = result.rows[0];
      if (!row?.vector_version) return reply.code(503).send({ status: "not_ready", reason: "pgvector extension is unavailable" });
      return { status: "ready", databaseVersion: row.database_version, pgvectorVersion: row.vector_version };
    } catch (error) {
      requestLogError(reply, error);
      return reply.code(503).send({ status: "not_ready", reason: "database unavailable" });
    }
  });

  app.get("/api/v1/meta", async () => ({ application: applicationMetadata() }));

  app.get("/api/v1/dashboard/stats", async () => getDashboardStats(pool));

  app.get("/api/v1/session", async () => {
    const user = await getSessionUserProfile(pool);
    return { user, authentication: "deferred" };
  });

  app.get("/api/v1/users/me", async () => ({ user: await getSessionUserProfile(pool) }));
  app.get("/api/v1/user/profile", async () => ({ user: await getSessionUserProfile(pool) }));

  app.patch("/api/v1/users/me/profile", async (request) => ({
    user: await updateSessionUserProfile(pool, userProfileUpdateSchema.parse(request.body))
  }));
  app.put("/api/v1/users/me/profile", async (request) => ({
    user: await updateSessionUserProfile(pool, userProfileUpdateSchema.parse(request.body))
  }));
  app.patch("/api/v1/user/profile", async (request) => ({
    user: await updateSessionUserProfile(pool, userProfileUpdateSchema.parse(request.body))
  }));
  app.put("/api/v1/user/profile", async (request) => ({
    user: await updateSessionUserProfile(pool, userProfileUpdateSchema.parse(request.body))
  }));

  app.get("/api/v1/providers", async () => ({ providers: await listProviders(pool) }));

  app.post("/api/v1/providers", async (request, reply) => {
    const input = providerProfileInputSchema.parse(request.body);
    const provider = await createProvider(pool, input, config.credentialEncryptionKey);
    return reply.code(201).send(provider);
  });

  app.get<{ Params: { providerId: string } }>("/api/v1/providers/:providerId/models", async (request) => ({
    models: await providerModels(pool, uuidSchema.parse(request.params.providerId), config.credentialEncryptionKey)
  }));

  app.put<{ Params: { providerId: string } }>("/api/v1/providers/:providerId/default", async (request) => (
    setDefaultProvider(pool, uuidSchema.parse(request.params.providerId))
  ));

  app.patch<{ Params: { providerId: string } }>("/api/v1/providers/:providerId", async (request) => (
    updateProvider(pool, uuidSchema.parse(request.params.providerId), providerProfileUpdateSchema.parse(request.body), config.credentialEncryptionKey)
  ));

  app.post("/api/v1/provider-text/generate", async (request) => (
    generateProviderText(pool, providerTextRequestSchema.parse(request.body), config.credentialEncryptionKey)
  ));

  app.post("/api/v1/providers/discover-models", async (request) => ({
    models: await discoverUnsavedProviderModels(providerProfileInputSchema.parse(request.body))
  }));

  app.delete<{ Params: { providerId: string } }>("/api/v1/providers/:providerId", async (request) => (
    deleteProvider(pool, uuidSchema.parse(request.params.providerId))
  ));

  app.post("/api/v1/imports/legacy-story", async (request, reply) => {
    const body = storyImportRequestSchema.parse(request.body);
    const result = await importLegacyStory(pool, body, assetStore);
    return reply.code(result.duplicate ? 200 : 201).send(result);
  });

  app.post("/api/v1/imports/legacy-story/preview", async (request) => (
    previewLegacyStoryImport(pool, storyImportPreviewRequestSchema.parse(request.body))
  ));

  app.post("/api/v1/imports/world/preview", async (request) => (
    previewWorldImport(pool, worldImportRequestSchema.parse(request.body))
  ));

  app.post("/api/v1/imports/world", async (request, reply) => {
    const result = await importWorld(pool, worldImportRequestSchema.parse(request.body));
    return reply.code(result.duplicate ? 200 : 201).send(result);
  });

  app.post("/api/v1/imports/infinite-worlds/preview", async (request) => (
    previewInfiniteWorldsImport(pool, infiniteWorldsImportRequestSchema.parse(request.body))
  ));

  app.post("/api/v1/imports/infinite-worlds", async (request, reply) => {
    const result = await importInfiniteWorlds(
      pool,
      infiniteWorldsImportRequestSchema.parse(request.body),
      config.credentialEncryptionKey,
      assetStore
    );
    return reply.code(result.duplicate ? 200 : 201).send(result);
  });

  app.get<{ Querystring: { key?: string } }>("/api/v1/imports/progress", async (request, reply) => {
    const key = String(request.query.key || "").trim();
    const progress = getImportProgress(key);
    if (!progress) return reply.code(404).send({ error: "No active import found for the provided key." });
    return progress;
  });

  app.get("/api/v1/worlds", async () => ({ worlds: await listWorlds(pool) }));

  app.post("/api/v1/worlds", async (request, reply) => (
    reply.code(201).send(await createWorld(pool, worldCreateSchema.parse(request.body)))
  ));

  app.get<{ Params: { worldId: string } }>("/api/v1/worlds/:worldId", async (request) => (
    getWorld(pool, uuidSchema.parse(request.params.worldId))
  ));

  app.put<{ Params: { worldId: string } }>("/api/v1/worlds/:worldId/draft", async (request) => (
    updateWorldDraft(pool, uuidSchema.parse(request.params.worldId), worldDraftUpdateSchema.parse(request.body))
  ));

  app.post<{ Params: { worldId: string } }>("/api/v1/worlds/:worldId/draft/playable-characters/generate", async (request) => (
    generatePlayableCharacter(
      pool,
      uuidSchema.parse(request.params.worldId),
      playableCharacterGenerationRequestSchema.parse(request.body),
      config.credentialEncryptionKey
    )
  ));

  app.post<{ Params: { worldId: string } }>("/api/v1/worlds/:worldId/publish", async (request, reply) => (
    reply.code(201).send(await publishWorld(pool, uuidSchema.parse(request.params.worldId), worldPublishSchema.parse(request.body)))
  ));

  app.patch<{ Params: { worldId: string } }>("/api/v1/worlds/:worldId", async (request) => (
    updateWorld(pool, uuidSchema.parse(request.params.worldId), worldStatusUpdateSchema.parse(request.body))
  ));

  app.delete<{ Params: { worldId: string } }>("/api/v1/worlds/:worldId", async (request) => (
    deleteWorld(pool, uuidSchema.parse(request.params.worldId), resourceDeleteSchema.parse(request.body))
  ));

  app.delete<{ Params: { worldId: string; worldVersionId: string } }>("/api/v1/worlds/:worldId/versions/:worldVersionId", async (request) => (
    deleteWorldVersion(
      pool,
      uuidSchema.parse(request.params.worldId),
      uuidSchema.parse(request.params.worldVersionId),
      worldVersionDeleteSchema.parse(request.body)
    )
  ));

  app.post<{ Params: { worldId: string } }>("/api/v1/worlds/:worldId/fork", async (request, reply) => (
    reply.code(201).send(await forkWorld(pool, uuidSchema.parse(request.params.worldId), worldForkSchema.parse(request.body)))
  ));

  app.get<{ Params: { worldId: string }; Querystring: { worldVersionId?: string } }>("/api/v1/worlds/:worldId/export", async (request, reply) => {
    const versionId = request.query.worldVersionId ? uuidSchema.parse(request.query.worldVersionId) : undefined;
    return reply
      .header("content-disposition", 'attachment; filename="infinite-quest-world.json"')
      .send(await exportWorld(pool, uuidSchema.parse(request.params.worldId), versionId));
  });

  app.get("/api/v1/campaigns", async () => {
    return { campaigns: await listCampaigns(pool) };
  });

  app.get<{ Params: { worldVersionId: string } }>("/api/v1/world-versions/:worldVersionId/playable-characters", async (request) => (
    getWorldVersionPlayableCharacterSummary(pool, uuidSchema.parse(request.params.worldVersionId))
  ));

  app.post("/api/v1/campaigns", async (request, reply) => (
    reply.code(201).send(await createCampaign(pool, campaignCreateSchema.parse(request.body)))
  ));

  app.patch<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId", async (request) => (
    updateCampaign(pool, uuidSchema.parse(request.params.campaignId), campaignUpdateSchema.parse(request.body))
  ));

  app.delete<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId", async (request) => (
    deleteCampaign(pool, uuidSchema.parse(request.params.campaignId), resourceDeleteSchema.parse(request.body))
  ));

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/migrate-world", async (request) => (
    migrateCampaignWorld(pool, uuidSchema.parse(request.params.campaignId), campaignWorldMigrationSchema.parse(request.body))
  ));

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/transfer-world/preview", async (request) => (
    previewCampaignWorldTransfer(
      pool,
      uuidSchema.parse(request.params.campaignId),
      campaignTransferPreviewRequestSchema.parse(request.body)
    )
  ));

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/transfer-world", async (request, reply) => {
    const result = await transferCampaignWorld(
      pool,
      uuidSchema.parse(request.params.campaignId),
      campaignTransferCommitRequestSchema.parse(request.body)
    );
    return reply.code(result.reused ? 200 : 201).send(result);
  });

  app.get<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/export", async (request, reply) => (
    reply
      .header("content-disposition", 'attachment; filename="infinite-quest-campaign.json"')
      .send(await exportCampaign(pool, uuidSchema.parse(request.params.campaignId)))
  ));

  app.get<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/turns", async (request) => {
    const ownerUserId = await initialOwnerId(pool);
    const campaignId = uuidSchema.parse(request.params.campaignId);
    const result = await pool.query(
      `SELECT id, turn_number AS "turnNumber", action, COALESCE(input_mode, 'action') AS "inputMode",
              COALESCE(input_mode_source, 'explicit') AS "inputModeSource", narration, choices,
              custom_action_suggestion AS "customActionSuggestion", image_prompt AS "imagePrompt",
              image_url AS "imageUrl", accepted_at AS "acceptedAt"
         FROM turns
        WHERE owner_user_id = $1 AND campaign_id = $2
        ORDER BY turn_number`,
      [ownerUserId, campaignId]
    );
    const costs = await turnReportedCosts(pool, ownerUserId, result.rows.map((turn: { id: string }) => turn.id));
    return {
      turns: result.rows.map((turn: { id: string; narration: string }) => ({
        ...turn,
        narration: formatNarrationParagraphs(turn.narration),
        reportedCost: costs.get(turn.id) || null
      }))
    };
  });

  app.get<{ Params: { campaignId: string }; Querystring: { turnNumber?: string } }>("/api/v1/campaigns/:campaignId/state", async (request) => (
    getCampaignRuntimeState(
      pool,
      uuidSchema.parse(request.params.campaignId),
      request.query.turnNumber === undefined ? undefined : z.coerce.number().int().min(0).parse(request.query.turnNumber)
    )
  ));

  app.patch<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/state", async (request) => (
    updateCampaignRuntimeState(
      pool,
      uuidSchema.parse(request.params.campaignId),
      campaignRuntimeStateUpdateSchema.parse(request.body)
    )
  ));

  app.get<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/cost-summary", async (request) => (
    getCampaignCostSummary(pool, uuidSchema.parse(request.params.campaignId))
  ));

  app.get<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/sync-status", async (request, reply) => {
    const ownerUserId = await initialOwnerId(pool);
    const result = await pool.query(
      `SELECT c.id, c.title, c.active_turn_number AS "activeTurnNumber", c.world_version_id AS "worldVersionId",
              c.story_length_profile AS "storyLengthProfile", c.updated_at AS "updatedAt",
              c.turn_control_style AS "turnControlStyle",
              c.selected_character_id AS "selectedCharacterId", c.character_snapshot AS "characterSnapshot",
              c.legacy_settings AS "legacySettings", c.status,
              w.id AS "worldId", w.title AS "worldTitle", wv.version_number AS "worldVersionNumber",
              wv.content AS "worldContent",
              cs.rpg_stats AS "rpgStats", cs.event_triggers AS "eventTriggers", cs.trackers AS "trackers",
              pending.id AS "pendingGenerationId", pending.status AS "pendingGenerationStatus",
              pending.action AS "pendingGenerationAction", pending.operation_kind AS "pendingGenerationOperationKind",
              pending.requested_input_mode AS "pendingRequestedInputMode",
              pending.resolved_input_mode AS "pendingResolvedInputMode", pending.input_mode_source AS "pendingInputModeSource",
              pending.expected_turn_number AS "pendingGenerationExpectedTurnNumber",
              pending.created_at AS "pendingGenerationCreatedAt", pending.updated_at AS "pendingGenerationUpdatedAt"
         FROM campaigns c
         JOIN world_versions wv ON wv.id = c.world_version_id AND wv.owner_user_id = c.owner_user_id
         JOIN worlds w ON w.id = wv.world_id AND w.owner_user_id = c.owner_user_id
         LEFT JOIN campaign_state cs ON cs.campaign_id = c.id AND cs.owner_user_id = c.owner_user_id
         LEFT JOIN LATERAL (
           SELECT id, status, action, operation_kind, requested_input_mode, resolved_input_mode, input_mode_source,
                  expected_turn_number, created_at, updated_at
             FROM generation_jobs
            WHERE campaign_id = c.id AND owner_user_id = c.owner_user_id
              AND status IN ('queued','replacement_queued','assessing','generating','validating','committing','recoverable')
            ORDER BY created_at DESC LIMIT 1
         ) pending ON true
        WHERE c.id = $1 AND c.owner_user_id = $2`,
      [uuidSchema.parse(request.params.campaignId), ownerUserId]
    );
    const row = result.rows[0];
    if (!row) return reply.code(404).send({ error: "Not found", message: "Campaign not found." });
    const content = typeof row.worldContent === "string" ? JSON.parse(row.worldContent) : (row.worldContent || {});
    const worldOverview = content.world || {};
    const campaign = {
      id: row.id,
      title: row.title,
      activeTurnNumber: row.activeTurnNumber,
      worldVersionId: row.worldVersionId,
      storyLengthProfile: row.storyLengthProfile,
      updatedAt: row.updatedAt,
      selectedCharacterId: row.selectedCharacterId,
      characterSnapshot: row.characterSnapshot,
      status: row.status
    };
    const world = {
      id: row.worldId,
      title: row.worldTitle || worldOverview.title || "",
      versionNumber: row.worldVersionNumber,
      genre: worldOverview.genre || "",
      tone: worldOverview.tone || "",
      premise: worldOverview.premise || "",
      backgroundStory: worldOverview.backgroundStory || "",
      character: row.characterSnapshot?.characterText || row.characterSnapshot?.name || "",
      firstAction: worldOverview.firstAction || "",
      rules: worldOverview.rules || "",
      playableCharacters: content.playableCharacters || []
    };
    const playerConfig = {
      selectedCharacterId: row.selectedCharacterId,
      characterSnapshot: row.characterSnapshot,
      rpgStats: row.rpgStats || [],
      trackers: row.trackers || [],
      eventTriggers: row.eventTriggers || [],
      useRpgStats: Boolean(row.legacySettings?.useRpgStats),
      suppressEventTriggers: Boolean(row.legacySettings?.suppressEventTriggers)
    };
    const pendingGeneration = row.pendingGenerationId ? {
      id: row.pendingGenerationId,
      status: row.pendingGenerationStatus,
      action: row.pendingGenerationAction,
      operationKind: row.pendingGenerationOperationKind,
      expectedTurnNumber: row.pendingGenerationExpectedTurnNumber,
      createdAt: row.pendingGenerationCreatedAt,
      updatedAt: row.pendingGenerationUpdatedAt
    } : null;
    return { ...campaign, campaign, world, playerConfig, pendingGeneration };
  });

  app.put<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/player-config", async (request) => (
    syncPlayerCampaignConfig(
      pool,
      uuidSchema.parse(request.params.campaignId),
      playerCampaignConfigSchema.parse(request.body)
    )
  ));

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/rewind", async (request) => (
    rewindCampaign(
      pool,
      uuidSchema.parse(request.params.campaignId),
      campaignRewindSchema.parse(request.body)
    )
  ));

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/branch", async (request, reply) => (
    reply.code(201).send(
      await branchCampaign(
        pool,
        uuidSchema.parse(request.params.campaignId),
        campaignBranchSchema.parse(request.body)
      )
    )
  ));

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/turn-input/classify", async (request) => (
    classifyTurnInput(
      pool,
      uuidSchema.parse(request.params.campaignId),
      turnInputClassificationRequestSchema.parse(request.body),
      config.credentialEncryptionKey
    )
  ));

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/generations", async (request, reply) => {
    const body = generationRequestSchema.parse(request.body);
    const job = await enqueueGeneration(pool, uuidSchema.parse(request.params.campaignId), body);
    return reply.code(job.duplicate ? 200 : 202).send(job);
  });

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/generations/retry-latest", async (request, reply) => {
    const body = generationRetryLatestRequestSchema.parse(request.body);
    const job = await enqueueLatestReplacement(pool, uuidSchema.parse(request.params.campaignId), body);
    return reply.code(job.duplicate ? 200 : 202).send(job);
  });

  app.get<{ Params: { jobId: string } }>("/api/v1/generation-jobs/:jobId", async (request) => (
    getGenerationJob(pool, uuidSchema.parse(request.params.jobId))
  ));

  app.get<{ Params: { jobId: string } }>("/api/v1/generation-jobs/:jobId/stream", async (request, reply) => {
    const jobId = uuidSchema.parse(request.params.jobId);
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    if (typeof reply.raw.flushHeaders === "function") reply.raw.flushHeaders();

    let isClosed = false;
    request.raw.on("close", () => { isClosed = true; });

    let lastSentJson = "";
    while (!isClosed) {
      try {
        const job = await getGenerationJob(pool, jobId);
        const currentJson = JSON.stringify({
          id: job.id,
          status: job.status,
          action: job.action,
          partialOutput: job.partialOutput || null,
          partialNarration: job.partialNarration || null,
          errorMessage: job.errorMessage || null,
          errorCode: job.errorCode || null
        });
        if (currentJson !== lastSentJson) {
          lastSentJson = currentJson;
          reply.raw.write(`data: ${currentJson}\n\n`);
        }
        if (["completed", "failed", "recoverable", "discarded"].includes(job.status)) {
          break;
        }
      } catch (error) {
        if (!isClosed) {
          reply.raw.write(`data: ${JSON.stringify({ status: "failed", errorMessage: error instanceof Error ? error.message : String(error) })}\n\n`);
        }
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    if (!isClosed) reply.raw.end();
  });

  app.get<{ Params: { jobId: string } }>("/api/v1/generation-jobs/:jobId/result", async (request) => (
    getGenerationResult(pool, uuidSchema.parse(request.params.jobId))
  ));

  app.post<{ Params: { jobId: string } }>("/api/v1/generation-jobs/:jobId/retry", async (request, reply) => (
    reply.code(202).send(await retryGeneration(pool, uuidSchema.parse(request.params.jobId)))
  ));

  app.post<{ Params: { jobId: string } }>("/api/v1/generation-jobs/:jobId/discard", async (request) => (
    discardGeneration(pool, uuidSchema.parse(request.params.jobId))
  ));

  app.get<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/illustration-config", async (request) => (
    getIllustrationConfig(pool, uuidSchema.parse(request.params.campaignId))
  ));

  app.post<{ Params: { worldId: string } }>("/api/v1/worlds/:worldId/cover", async (request, reply) => {
    const job = await enqueueWorldCover(pool, uuidSchema.parse(request.params.worldId), worldCoverRequestSchema.parse(request.body));
    return reply.code(job.duplicate ? 200 : 202).send(job);
  });

  app.put<{ Params: { worldId: string } }>("/api/v1/worlds/:worldId/cover-asset", async (request) => {
    const ownerUserId = await initialOwnerId(pool);
    const body = assetSelectionSchema.parse(request.body);
    return selectWorldCover(pool, ownerUserId, uuidSchema.parse(request.params.worldId), body.assetId);
  });

  app.put<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/illustration-config", async (request) => (
    setIllustrationConfig(
      pool,
      uuidSchema.parse(request.params.campaignId),
      illustrationConfigSchema.parse(request.body)
    )
  ));

  app.get<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/image-jobs", async (request) => ({
    jobs: await listCampaignImageJobs(pool, uuidSchema.parse(request.params.campaignId))
  }));

  app.post<{ Params: { turnId: string } }>("/api/v1/turns/:turnId/illustrations", async (request, reply) => {
    const job = await enqueueIllustration(pool, uuidSchema.parse(request.params.turnId), illustrationRequestSchema.parse(request.body));
    return reply.code(job.duplicate ? 200 : 202).send(job);
  });

  app.put<{ Params: { turnId: string } }>("/api/v1/turns/:turnId/illustration-asset", async (request) => {
    const ownerUserId = await initialOwnerId(pool);
    const body = assetSelectionSchema.parse(request.body);
    return selectTurnIllustration(pool, ownerUserId, uuidSchema.parse(request.params.turnId), body.assetId);
  });

  app.get<{ Params: { turnId: string } }>("/api/v1/turns/:turnId/illustration-resolution", async (request) => (
    getTurnIllustrationResolution(pool, uuidSchema.parse(request.params.turnId))
  ));

  app.post<{ Params: { turnId: string } }>("/api/v1/turns/:turnId/illustration-match", async (request, reply) => (
    reply.code(202).send(await rematchTurnIllustration(pool, uuidSchema.parse(request.params.turnId)))
  ));

  app.get<{ Params: { jobId: string } }>("/api/v1/image-jobs/:jobId", async (request) => (
    getImageJob(pool, uuidSchema.parse(request.params.jobId))
  ));

  app.post<{ Params: { jobId: string } }>("/api/v1/image-jobs/:jobId/retry", async (request, reply) => (
    reply.code(202).send(await retryImageJob(pool, uuidSchema.parse(request.params.jobId)))
  ));

  app.get<{ Params: { assetId: string } }>("/api/v1/assets/:assetId", async (request, reply) => {
    const ownerUserId = await initialOwnerId(pool);
    const asset = await readAsset(pool, assetStore, ownerUserId, uuidSchema.parse(request.params.assetId));
    return reply
      .type(asset.mimeType)
      .header("cache-control", "private, max-age=31536000, immutable")
      .header("etag", `\"${asset.contentHash}\"`)
      .send(asset.bytes);
  });

  app.get<{ Params: { assetId: string } }>("/api/v1/assets/:assetId/thumbnail", async (request, reply) => {
    const ownerUserId = await initialOwnerId(pool);
    const asset = await readAssetDerivative(pool, assetStore, ownerUserId, uuidSchema.parse(request.params.assetId), "thumbnail");
    return reply
      .type(asset.mimeType)
      .header("cache-control", "private, max-age=31536000, immutable")
      .header("etag", `\"${asset.contentHash}\"`)
      .send(asset.bytes);
  });

  app.get<{ Querystring: Record<string, unknown> }>("/api/v1/assets", async (request) => {
    const ownerUserId = await initialOwnerId(pool);
    return queryAssets(pool, ownerUserId, assetListQuerySchema.parse(request.query));
  });

  app.get<{ Querystring: Record<string, unknown> }>("/api/v1/assets/facets", async (request) => {
    const ownerUserId = await initialOwnerId(pool);
    const result = await queryAssets(pool, ownerUserId, assetListQuerySchema.parse({ ...request.query, cursor: undefined, limit: 1 }));
    return { total: result.total, facets: result.facets };
  });

  app.patch<{ Params: { assetId: string } }>("/api/v1/assets/:assetId/library-metadata", async (request) => {
    const ownerUserId = await initialOwnerId(pool);
    return updateAssetMetadata(
      pool,
      ownerUserId,
      uuidSchema.parse(request.params.assetId),
      assetMetadataUpdateSchema.parse(request.body)
    );
  });

  app.get<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/memory/metrics", async (request) => {
    return getChronicleMetrics(pool, uuidSchema.parse(request.params.campaignId));
  });

  app.get<{ Params: { campaignId: string }; Querystring: Record<string, unknown> }>(
    "/api/v1/campaigns/:campaignId/memory/context-preview",
    async (request) => {
      const query = memoryContextQuerySchema.parse(request.query);
      return buildContextPreview(pool, uuidSchema.parse(request.params.campaignId), query, config.credentialEncryptionKey);
    }
  );

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/memory/reindex", async (request, reply) => {
    const jobId = await enqueueChronicleReindex(pool, uuidSchema.parse(request.params.campaignId));
    return reply.code(202).send({ jobId, status: "queued" });
  });

  app.get<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/memory/embedding-config", async (request) => (
    getCampaignEmbeddingConfig(pool, uuidSchema.parse(request.params.campaignId))
  ));

  app.put<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/memory/embedding-config", async (request) => {
    const campaignId = uuidSchema.parse(request.params.campaignId);
    const saved = await setCampaignEmbeddingConfig(pool, campaignId, campaignEmbeddingConfigSchema.parse(request.body));
    const jobId = saved.enabled ? await enqueueEmbeddingReindex(pool, campaignId) : null;
    return { ...saved, jobId };
  });

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/memory/embeddings/reindex", async (request, reply) => {
    const jobId = await enqueueEmbeddingReindex(pool, uuidSchema.parse(request.params.campaignId));
    if (!jobId) return reply.code(409).send({ error: "Not configured", message: "Enable semantic memory and select an embedding provider first." });
    return reply.code(202).send({ jobId, status: "queued" });
  });

  app.get<{ Params: { jobId: string } }>("/api/v1/jobs/:jobId", async (request, reply) => {
    const ownerUserId = await initialOwnerId(pool);
    const result = await pool.query(
      `SELECT id, campaign_id AS "campaignId", job_type AS "jobType", status, attempts,
              progress, error_message AS "errorMessage", created_at AS "createdAt", updated_at AS "updatedAt",
              completed_at AS "completedAt"
         FROM chronicle_jobs WHERE id = $1 AND owner_user_id = $2`,
      [uuidSchema.parse(request.params.jobId), ownerUserId]
    );
    const job = result.rows[0];
    return job ? job : reply.code(404).send({ error: "Not found", message: "Job not found." });
  });

  return app;
}

function requestLogError(reply: { log: { error: (value: unknown, message?: string) => void } }, error: unknown): void {
  reply.log.error({ err: error }, "readiness_check_failed");
}
