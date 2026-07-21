import type { DatabaseClient, DatabasePool } from "../../../packages/database/src/pool.js";
import { initialOwnerId, withTransaction } from "../../../packages/database/src/pool.js";
import {
  canonicalizeWorldContent,
  WORLD_CONTENT_SCHEMA_VERSION,
  worldContentSchema,
  type CampaignCreateRequest,
  type CampaignUpdateRequest,
  type CampaignWorldMigrationRequest,
  type ResourceDeleteRequest,
  type WorldContent,
  type WorldCreateRequest,
  type WorldDraftUpdateRequest,
  type WorldForkRequest,
  type WorldImportRequest,
  type WorldPublishRequest,
  type WorldVersionDeleteRequest,
  type WorldStatusUpdateRequest
} from "../../../packages/contracts/src/world-library.js";
import { removeProviderSecrets, sha256, stableStringify } from "../../../packages/domain/src/text.js";
import {
  assessWorldCampaignReadiness,
  campaignCharacterSeed,
  characterSnapshot,
  characterTextFromSnapshot,
  resolvePlayableCharacters
} from "../../../packages/domain/src/world-characters.js";
import { resolveEffectiveProviderId } from "./provider-service.js";
import { autoEnableCampaignEmbeddingIfAvailable } from "./memory-service.js";
import { turnReportedCosts } from "./cost-service.js";

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function httpError(statusCode: number, message: string, details?: unknown): Error {
  return Object.assign(new Error(message), { statusCode, ...(details === undefined ? {} : { details }) });
}

function portableModelMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  return Object.fromEntries(["providerType", "model", "promptProtocolVersion"].flatMap((key) => (
    typeof source[key] === "string" && source[key] ? [[key, source[key]]] : []
  )));
}

function portableCampaignSettings(value: Record<string, unknown> | undefined): Record<string, unknown> {
  const settings = removeProviderSecrets(value);
  for (const key of Object.keys(settings)) {
    const normalized = key.replaceAll(/[^a-z]/gi, "").toLowerCase();
    if (/(?:apikey|password|authorization|credential|secret)/.test(normalized)
      || /^(?:token|accesstoken|refreshtoken)$/.test(normalized)
      || /^(?:baseurl|endpoint|customendpoint|lmstudioendpoint|imageendpoint|providerurl)$/.test(normalized)
      || /^nexus(?:provider|imageprovider|embeddingprovider)/.test(normalized)) delete settings[key];
  }
  return settings;
}

const SENSITIVE_WORLD_KEYS = new Set([
  "apikey",
  "customapikey",
  "lmstudioapikey",
  "imageapikey",
  "token",
  "accesstoken",
  "password",
  "authorization",
  "encryptedapikey",
  "credentialnonce",
  "credentialauthtag"
]);

function sanitizeWorldValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeWorldValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !SENSITIVE_WORLD_KEYS.has(key.replaceAll(/[^a-z]/gi, "").toLowerCase()))
    .map(([key, entry]) => [key, sanitizeWorldValue(entry)]));
}

function normalizeWorldContent(title: string, content?: WorldContent): WorldContent {
  return canonicalizeWorldContent(content ?? {
    schemaVersion: WORLD_CONTENT_SCHEMA_VERSION,
    world: {
      title,
      genre: "",
      tone: "",
      premise: "",
      backgroundStory: "",
      firstAction: "",
      rules: ""
    }
  });
}

function contentWithTitle(content: WorldContent, title: string): WorldContent {
  return canonicalizeWorldContent(sanitizeWorldValue({
    ...content,
    world: { ...content.world, title }
  }));
}

function assertPortableWorldDoesNotDependOnLegacyCharacter(content: WorldContent): void {
  const legacyCharacter = typeof content.world.character === "string" ? content.world.character.trim() : "";
  if (legacyCharacter && content.playableCharacters.length === 0) {
    throw httpError(400, "This portable world uses retired character guidance and has no structured playable-character roster.");
  }
}

export async function listWorlds(pool: DatabasePool) {
  const ownerUserId = await initialOwnerId(pool);
  const result = await pool.query(
    `SELECT w.id, w.title, w.status,
            w.forked_from_world_id AS "forkedFromWorldId",
            w.forked_from_world_version_id AS "forkedFromWorldVersionId",
            w.created_at AS "createdAt", w.updated_at AS "updatedAt",
            wd.revision AS "draftRevision", wd.updated_at AS "draftUpdatedAt",
            latest.id AS "latestVersionId", latest.version_number AS "latestVersionNumber",
            latest.published_at AS "latestPublishedAt",
            COALESCE(counts.campaign_count, 0) AS "campaignCount"
       FROM worlds w
       LEFT JOIN world_drafts wd ON wd.world_id = w.id AND wd.owner_user_id = w.owner_user_id
       LEFT JOIN LATERAL (
         SELECT id, version_number, published_at
           FROM world_versions
          WHERE world_id = w.id AND owner_user_id = w.owner_user_id
          ORDER BY version_number DESC LIMIT 1
       ) latest ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS campaign_count
           FROM campaigns c
           JOIN world_versions cv ON cv.id = c.world_version_id AND cv.owner_user_id = c.owner_user_id
          WHERE cv.world_id = w.id AND c.owner_user_id = w.owner_user_id
       ) counts ON true
      WHERE w.owner_user_id = $1
      ORDER BY (w.status = 'archived'), w.updated_at DESC`,
    [ownerUserId]
  );
  return result.rows;
}

export async function getWorld(pool: DatabasePool, worldId: string) {
  const ownerUserId = await initialOwnerId(pool);
  const worldResult = await pool.query(
    `SELECT w.id, w.title, w.status,
            w.forked_from_world_id AS "forkedFromWorldId",
            w.forked_from_world_version_id AS "forkedFromWorldVersionId",
            w.created_at AS "createdAt", w.updated_at AS "updatedAt",
            wd.revision AS "draftRevision", wd.content AS "draftContent",
            wd.based_on_world_version_id AS "draftBasedOnWorldVersionId",
            wd.updated_at AS "draftUpdatedAt"
       FROM worlds w
       LEFT JOIN world_drafts wd ON wd.world_id = w.id AND wd.owner_user_id = w.owner_user_id
      WHERE w.id = $1 AND w.owner_user_id = $2`,
    [worldId, ownerUserId]
  );
  const world = worldResult.rows[0];
  if (!world) throw httpError(404, "World not found.");
  if (world.draftContent) world.draftContent = canonicalizeWorldContent(world.draftContent);
  const versions = await pool.query(
    `SELECT id, version_number AS "versionNumber", source_hash AS "sourceHash",
            release_notes AS "releaseNotes", created_from_revision AS "createdFromRevision",
            published_at AS "publishedAt", created_at AS "createdAt",
            dependencies.current_campaigns AS "currentCampaigns",
            dependencies.campaign_migrations AS "campaignMigrations",
            dependencies.chronicle_memories AS "chronicleMemories",
            dependencies.model_chains AS "modelChains",
            detachments.drafts, detachments.forks, detachments.imports
       FROM world_versions wv
       CROSS JOIN LATERAL (
         SELECT
           (SELECT count(*)::int FROM campaigns c
             WHERE c.owner_user_id = wv.owner_user_id AND c.world_version_id = wv.id) AS current_campaigns,
           (SELECT count(*)::int FROM campaign_world_migrations cwm
             WHERE cwm.owner_user_id = wv.owner_user_id
               AND (cwm.from_world_version_id = wv.id OR cwm.to_world_version_id = wv.id)) AS campaign_migrations,
           (SELECT count(*)::int FROM chronicle_memories cm
             WHERE cm.owner_user_id = wv.owner_user_id AND cm.world_version_id = wv.id) AS chronicle_memories,
           (SELECT count(*)::int FROM model_chains mc
             WHERE mc.owner_user_id = wv.owner_user_id AND mc.world_version_id = wv.id) AS model_chains
       ) dependencies
       CROSS JOIN LATERAL (
         SELECT
           (SELECT count(*)::int FROM world_drafts wd
             WHERE wd.owner_user_id = wv.owner_user_id AND wd.based_on_world_version_id = wv.id) AS drafts,
           (SELECT count(*)::int FROM worlds fw
             WHERE fw.owner_user_id = wv.owner_user_id AND fw.forked_from_world_version_id = wv.id) AS forks,
           (SELECT count(*)::int FROM imports i
             WHERE i.owner_user_id = wv.owner_user_id AND i.world_version_id = wv.id) AS imports
       ) detachments
      WHERE wv.world_id = $1 AND wv.owner_user_id = $2
      ORDER BY wv.version_number DESC`,
    [worldId, ownerUserId]
  );
  const campaigns = await pool.query(
    `SELECT c.id, c.title, c.status, c.active_turn_number AS "activeTurnNumber",
            c.world_version_id AS "worldVersionId", wv.version_number AS "worldVersionNumber",
            c.selected_character_id AS "selectedCharacterId",
            c.character_snapshot->>'name' AS "selectedCharacterName",
            c.updated_at AS "updatedAt"
       FROM campaigns c
       JOIN world_versions wv ON wv.id = c.world_version_id AND wv.owner_user_id = c.owner_user_id
      WHERE wv.world_id = $1 AND c.owner_user_id = $2
      ORDER BY c.updated_at DESC`,
    [worldId, ownerUserId]
  );
  return {
    ...world,
    versions: versions.rows.map((version) => {
      const {
        currentCampaigns,
        campaignMigrations,
        chronicleMemories,
        modelChains,
        drafts,
        forks,
        imports,
        ...publishedVersion
      } = version;
      const deletionBlockers = {
        currentCampaigns: Number(currentCampaigns || 0),
        campaignMigrations: Number(campaignMigrations || 0),
        chronicleMemories: Number(chronicleMemories || 0),
        modelChains: Number(modelChains || 0)
      };
      return {
        ...publishedVersion,
        deletable: Object.values(deletionBlockers).every((count) => count === 0),
        deletionBlockers,
        detachments: {
          drafts: Number(drafts || 0),
          forks: Number(forks || 0),
          imports: Number(imports || 0)
        }
      };
    }),
    campaigns: campaigns.rows
  };
}

export async function createWorld(pool: DatabasePool, request: WorldCreateRequest) {
  return withTransaction(pool, async (client) => {
    const ownerUserId = await initialOwnerId(client);
    const content = contentWithTitle(normalizeWorldContent(request.title, request.content), request.title);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO worlds (owner_user_id, title, status)
       VALUES ($1, $2, 'draft') RETURNING id`,
      [ownerUserId, request.title]
    );
    const worldId = inserted.rows[0]?.id;
    if (!worldId) throw new Error("Could not create world.");
    await client.query(
      `INSERT INTO world_drafts (world_id, owner_user_id, revision, content)
       VALUES ($1, $2, 1, $3)`,
      [worldId, ownerUserId, json(content)]
    );
    return getWorldFromClient(client, ownerUserId, worldId);
  });
}

async function getWorldFromClient(client: DatabaseClient, ownerUserId: string, worldId: string) {
  const result = await client.query(
    `SELECT w.id, w.title, w.status, wd.revision AS "draftRevision",
            wd.content AS "draftContent", wd.based_on_world_version_id AS "draftBasedOnWorldVersionId",
            w.created_at AS "createdAt", w.updated_at AS "updatedAt"
       FROM worlds w
       JOIN world_drafts wd ON wd.world_id = w.id AND wd.owner_user_id = w.owner_user_id
      WHERE w.id = $1 AND w.owner_user_id = $2`,
    [worldId, ownerUserId]
  );
  const world = result.rows[0];
  if (!world) throw httpError(404, "World not found.");
  if (world.draftContent) world.draftContent = canonicalizeWorldContent(world.draftContent);
  return world;
}

export async function updateWorldDraft(pool: DatabasePool, worldId: string, request: WorldDraftUpdateRequest) {
  return withTransaction(pool, async (client) => {
    const ownerUserId = await initialOwnerId(client);
    const locked = await client.query<{ title: string; status: string; revision: number }>(
      `SELECT w.title, w.status, wd.revision
         FROM worlds w JOIN world_drafts wd ON wd.world_id = w.id AND wd.owner_user_id = w.owner_user_id
        WHERE w.id = $1 AND w.owner_user_id = $2 FOR UPDATE OF w, wd`,
      [worldId, ownerUserId]
    );
    const current = locked.rows[0];
    if (!current) throw httpError(404, "World draft not found.");
    if (current.status === "archived") throw httpError(409, "Restore the world before editing its draft.");
    if (current.revision !== request.expectedRevision) throw httpError(409, "The world draft changed. Reload it before saving.");
    const nextTitle = request.title ?? current.title;
    const content = contentWithTitle(request.content, nextTitle);
    const updated = await client.query<{ revision: number; updated_at: Date }>(
      `UPDATE world_drafts SET content = $3, revision = revision + 1, updated_at = now()
        WHERE world_id = $1 AND owner_user_id = $2
        RETURNING revision, updated_at`,
      [worldId, ownerUserId, json(content)]
    );
    await client.query("UPDATE worlds SET title = $3, updated_at = now() WHERE id = $1 AND owner_user_id = $2", [worldId, ownerUserId, nextTitle]);
    return { worldId, title: nextTitle, revision: updated.rows[0]?.revision, content, updatedAt: updated.rows[0]?.updated_at };
  });
}

export async function publishWorld(pool: DatabasePool, worldId: string, request: WorldPublishRequest) {
  return withTransaction(pool, async (client) => {
    const ownerUserId = await initialOwnerId(client);
    const locked = await client.query<{ title: string; status: string; revision: number; content: WorldContent }>(
      `SELECT w.title, w.status, wd.revision, wd.content
         FROM worlds w JOIN world_drafts wd ON wd.world_id = w.id AND wd.owner_user_id = w.owner_user_id
        WHERE w.id = $1 AND w.owner_user_id = $2 FOR UPDATE OF w, wd`,
      [worldId, ownerUserId]
    );
    const draft = locked.rows[0];
    if (!draft) throw httpError(404, "World draft not found.");
    if (draft.status === "archived") throw httpError(409, "Restore the world before publishing.");
    if (draft.revision !== request.expectedRevision) throw httpError(409, "The world draft changed. Reload it before publishing.");
    const content = contentWithTitle(draft.content, draft.title);
    const sourceHash = sha256(stableStringify(content));
    const latest = await client.query<{ id: string; version_number: number; source_hash: string | null }>(
      `SELECT id, version_number, source_hash FROM world_versions
        WHERE world_id = $1 AND owner_user_id = $2 ORDER BY version_number DESC LIMIT 1`,
      [worldId, ownerUserId]
    );
    if (latest.rows[0]?.source_hash === sourceHash) throw httpError(409, "The draft is identical to the latest published version.");
    const allocation = await client.query<{ version_number: number }>(
      `UPDATE worlds SET next_version_number = next_version_number + 1
        WHERE id = $1 AND owner_user_id = $2
        RETURNING next_version_number - 1 AS version_number`,
      [worldId, ownerUserId]
    );
    const versionNumber = allocation.rows[0]?.version_number;
    if (!versionNumber) throw new Error("Could not allocate a world version number.");
    const version = await client.query<{ id: string; published_at: Date }>(
      `INSERT INTO world_versions (
         world_id, owner_user_id, version_number, content, source_hash, release_notes, created_from_revision
       ) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, published_at`,
      [worldId, ownerUserId, versionNumber, json(content), sourceHash, request.releaseNotes, draft.revision]
    );
    const worldVersionId = version.rows[0]?.id;
    if (!worldVersionId) throw new Error("Could not publish world version.");
    await client.query(
      `UPDATE world_drafts SET based_on_world_version_id = $3, updated_at = now()
        WHERE world_id = $1 AND owner_user_id = $2`,
      [worldId, ownerUserId, worldVersionId]
    );
    await client.query("UPDATE worlds SET status = 'active', updated_at = now() WHERE id = $1 AND owner_user_id = $2", [worldId, ownerUserId]);
    await client.query(
      `INSERT INTO activity_events (owner_user_id, event_type, correlation_id, details)
       VALUES ($1, 'world_version_published', $2, $3)`,
      [ownerUserId, worldVersionId, json({ worldId, worldVersionId, versionNumber, draftRevision: draft.revision })]
    );
    return { worldId, worldVersionId, versionNumber, draftRevision: draft.revision, publishedAt: version.rows[0]?.published_at };
  });
}

export async function updateWorld(pool: DatabasePool, worldId: string, request: WorldStatusUpdateRequest) {
  return withTransaction(pool, async (client) => {
    const ownerUserId = await initialOwnerId(client);
    const locked = await client.query<{ title: string; content: WorldContent }>(
      `SELECT w.title, wd.content FROM worlds w
         JOIN world_drafts wd ON wd.world_id = w.id AND wd.owner_user_id = w.owner_user_id
        WHERE w.id = $1 AND w.owner_user_id = $2 FOR UPDATE OF w, wd`,
      [worldId, ownerUserId]
    );
    const current = locked.rows[0];
    if (!current) throw httpError(404, "World not found.");
    const nextTitle = request.title ?? current.title;
    const result = await client.query(
      `UPDATE worlds
          SET title = $3, status = COALESCE($4, status), updated_at = now()
        WHERE id = $1 AND owner_user_id = $2
        RETURNING id, title, status, updated_at AS "updatedAt"`,
      [worldId, ownerUserId, nextTitle, request.status ?? null]
    );
    if (request.title) {
      await client.query(
        `UPDATE world_drafts SET content = $3, revision = revision + 1, updated_at = now()
          WHERE world_id = $1 AND owner_user_id = $2`,
        [worldId, ownerUserId, json(contentWithTitle(current.content, nextTitle))]
      );
    }
    return result.rows[0];
  });
}

export async function forkWorld(pool: DatabasePool, worldId: string, request: WorldForkRequest) {
  return withTransaction(pool, async (client) => {
    const ownerUserId = await initialOwnerId(client);
    const source = await client.query<{ id: string; content: WorldContent }>(
      `SELECT id, content FROM world_versions
        WHERE world_id = $1 AND owner_user_id = $2
          AND ($3::uuid IS NULL OR id = $3)
        ORDER BY version_number DESC LIMIT 1`,
      [worldId, ownerUserId, request.sourceWorldVersionId ?? null]
    );
    const version = source.rows[0];
    if (!version) throw httpError(404, "Published source world version not found.");
    const content = contentWithTitle(version.content, request.title);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO worlds (
         owner_user_id, title, status, forked_from_world_id, forked_from_world_version_id
       ) VALUES ($1,$2,'draft',$3,$4) RETURNING id`,
      [ownerUserId, request.title, worldId, version.id]
    );
    const forkId = inserted.rows[0]?.id;
    if (!forkId) throw new Error("Could not fork world.");
    await client.query(
      `INSERT INTO world_drafts (world_id, owner_user_id, based_on_world_version_id, revision, content)
       VALUES ($1,$2,$3,1,$4)`,
      [forkId, ownerUserId, version.id, json(content)]
    );
    return { worldId: forkId, sourceWorldId: worldId, sourceWorldVersionId: version.id, title: request.title, revision: 1 };
  });
}

export async function exportWorld(pool: DatabasePool, worldId: string, worldVersionId?: string) {
  const ownerUserId = await initialOwnerId(pool);
  const result = await pool.query<{ title: string; id: string; version_number: number; content: WorldContent }>(
    `SELECT w.title, wv.id, wv.version_number, wv.content
       FROM worlds w JOIN world_versions wv ON wv.world_id = w.id AND wv.owner_user_id = w.owner_user_id
      WHERE w.id = $1 AND w.owner_user_id = $2
        AND ($3::uuid IS NULL OR wv.id = $3)
      ORDER BY wv.version_number DESC LIMIT 1`,
    [worldId, ownerUserId, worldVersionId ?? null]
  );
  const row = result.rows[0];
  if (!row) throw httpError(404, "Published world version not found.");
  return { format: "infinite-quest-world" as const, formatVersion: 1 as const, title: row.title, content: contentWithTitle(row.content, row.title) };
}

export async function previewWorldImport(pool: DatabasePool, request: WorldImportRequest) {
  const ownerUserId = await initialOwnerId(pool);
  assertPortableWorldDoesNotDependOnLegacyCharacter(request.worldExport.content);
  const scrubbedContent = sanitizeWorldValue(request.worldExport.content);
  const sanitizedContent = contentWithTitle(request.worldExport.content, request.worldExport.title);
  const sourceHash = `world:${sha256(stableStringify(sanitizedContent))}`;
  const prior = await pool.query<{ world_id: string | null }>(
    "SELECT world_id FROM imports WHERE owner_user_id = $1 AND source_hash = $2 AND status = 'completed'",
    [ownerUserId, sourceHash]
  );
  return {
    kind: "world" as const,
    title: request.worldExport.title,
    duplicate: Boolean(prior.rows[0]?.world_id),
    existingWorldId: prior.rows[0]?.world_id ?? null,
    counts: {
      entities: request.worldExport.content.entities.length,
      relationships: request.worldExport.content.relationships.length,
      triggers: request.worldExport.content.defaultTriggers.length + request.worldExport.content.eventTriggers.length
    },
    warnings: stableStringify(scrubbedContent) === stableStringify(request.worldExport.content)
      ? [] as string[]
      : ["Credential-shaped fields will be removed before import."]
  };
}

export async function importWorld(pool: DatabasePool, request: WorldImportRequest) {
  assertPortableWorldDoesNotDependOnLegacyCharacter(request.worldExport.content);
  const sanitizedContent = contentWithTitle(request.worldExport.content, request.worldExport.title);
  const sourceHash = `world:${sha256(stableStringify(sanitizedContent))}`;
  return withTransaction(pool, async (client) => {
    const ownerUserId = await initialOwnerId(client);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${ownerUserId}:${sourceHash}`]);
    const prior = await client.query<{ id: string; world_id: string | null; world_version_id: string | null }>(
      "SELECT id, world_id, world_version_id FROM imports WHERE owner_user_id = $1 AND source_hash = $2 AND status = 'completed'",
      [ownerUserId, sourceHash]
    );
    if (prior.rows[0]?.world_id && prior.rows[0].world_version_id) {
      return { importId: prior.rows[0].id, worldId: prior.rows[0].world_id, worldVersionId: prior.rows[0].world_version_id, duplicate: true };
    }
    const content = sanitizedContent;
    const world = await client.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id, title, status) VALUES ($1,$2,'active') RETURNING id",
      [ownerUserId, request.worldExport.title]
    );
    const worldId = world.rows[0]?.id;
    if (!worldId) throw new Error("Could not import world.");
    const version = await client.query<{ id: string }>(
      `INSERT INTO world_versions (world_id, owner_user_id, version_number, content, source_hash, release_notes, created_from_revision)
       VALUES ($1,$2,1,$3,$4,'Imported portable world.',1) RETURNING id`,
      [worldId, ownerUserId, json(content), sha256(stableStringify(content))]
    );
    const worldVersionId = version.rows[0]?.id;
    if (!worldVersionId) throw new Error("Could not publish imported world.");
    await client.query(
      `INSERT INTO world_drafts (world_id, owner_user_id, based_on_world_version_id, revision, content)
       VALUES ($1,$2,$3,1,$4)`,
      [worldId, ownerUserId, worldVersionId, json(content)]
    );
    const importRow = await client.query<{ id: string }>(
      `INSERT INTO imports (owner_user_id, source_type, source_name, source_hash, status, world_id, world_version_id, stats, completed_at)
       VALUES ($1,'world_json',$2,$3,'completed',$4,$5,$6,now()) RETURNING id`,
      [ownerUserId, request.sourceName, sourceHash, worldId, worldVersionId, json({ versionNumber: 1 })]
    );
    return { importId: importRow.rows[0]?.id, worldId, worldVersionId, duplicate: false };
  });
}

export async function listCampaigns(pool: DatabasePool) {
  const ownerUserId = await initialOwnerId(pool);
  const result = await pool.query(
    `SELECT c.id, c.title, c.status, c.active_turn_number AS "activeTurnNumber",
            c.created_at AS "createdAt", c.updated_at AS "updatedAt",
            c.story_length_profile AS "storyLengthProfile",
            c.selected_character_id AS "selectedCharacterId",
            c.character_snapshot->>'name' AS "selectedCharacterName",
            w.id AS "worldId", w.title AS "worldTitle", c.world_version_id AS "worldVersionId",
            c.text_provider_profile_id AS "textProviderProfileId",
            c.image_provider_profile_id AS "imageProviderProfileId",
            wv.version_number AS "worldVersionNumber", latest.version_number AS "latestWorldVersionNumber",
            (latest.version_number > wv.version_number) AS "worldUpdateAvailable"
       FROM campaigns c
       JOIN world_versions wv ON wv.id = c.world_version_id AND wv.owner_user_id = c.owner_user_id
       JOIN worlds w ON w.id = wv.world_id AND w.owner_user_id = c.owner_user_id
       JOIN LATERAL (
         SELECT version_number FROM world_versions
          WHERE world_id = w.id AND owner_user_id = c.owner_user_id
          ORDER BY version_number DESC LIMIT 1
       ) latest ON true
      WHERE c.owner_user_id = $1
      ORDER BY (c.status = 'archived'), c.updated_at DESC`,
    [ownerUserId]
  );
  return result.rows;
}

export async function createCampaign(pool: DatabasePool, request: CampaignCreateRequest) {
  return withTransaction(pool, async (client) => {
    const ownerUserId = await initialOwnerId(client);
    const version = await client.query<{ content: WorldContent; world_id: string; version_number: number }>(
      "SELECT content, world_id, version_number FROM world_versions WHERE id = $1 AND owner_user_id = $2",
      [request.worldVersionId, ownerUserId]
    );
    const source = version.rows[0];
    if (!source) throw httpError(404, "Published world version not found.");
    const content = worldContentSchema.parse(source.content);
    const readiness = assessWorldCampaignReadiness(content);
    if (!readiness.ready) throw httpError(400, readiness.issues[0]?.message || "This world version is not ready for a campaign.");
    const seed = campaignCharacterSeed(content, request.selectedCharacterId);
    const snapshot = characterSnapshot(seed.character);
    const campaign = await client.query<{ id: string }>(
      `INSERT INTO campaigns (
         owner_user_id, world_version_id, title, story_length_profile,
         selected_character_id, character_snapshot, legacy_settings
       ) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [ownerUserId, request.worldVersionId, request.title, request.storyLengthProfile,
        seed.character.id, json(snapshot), json({ useRpgStats: seed.rpgStats.length > 0 })]
    );
    const campaignId = campaign.rows[0]?.id;
    if (!campaignId) throw new Error("Could not create campaign.");
    const initialTrackers = Array.isArray(content.defaults?.trackers) && content.defaults.trackers.length
      ? content.defaults.trackers : seed.defaultTriggers;
    await client.query(
      `INSERT INTO campaign_state (
         campaign_id, owner_user_id, trackers, default_triggers, event_triggers, rpg_stats, import_provenance, initial_state_snapshot
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        campaignId,
        ownerUserId,
        json(initialTrackers),
        json(seed.defaultTriggers),
        json(content.eventTriggers),
        json(seed.rpgStats),
        json({ sourceType: "world_library", worldId: source.world_id, worldVersionId: request.worldVersionId, selectedCharacterId: seed.character.id }),
        json({ scratchpad: "", trackers: initialTrackers, eventTriggers: content.eventTriggers, pendingEventTriggers: [], rpgStats: seed.rpgStats })
      ]
    );
    await autoEnableCampaignEmbeddingIfAvailable(client, ownerUserId, campaignId);
    return { id: campaignId, title: request.title, status: "active", activeTurnNumber: 0, storyLengthProfile: request.storyLengthProfile, worldId: source.world_id, worldVersionId: request.worldVersionId, worldVersionNumber: source.version_number, selectedCharacterId: seed.character.id, selectedCharacterName: seed.character.name, textProviderProfileId: null, imageProviderProfileId: null };
  });
}

export async function getWorldVersionPlayableCharacterSummary(pool: DatabasePool, worldVersionId: string) {
  const ownerUserId = await initialOwnerId(pool);
  const result = await pool.query<{ content: WorldContent }>(
    "SELECT content FROM world_versions WHERE id = $1 AND owner_user_id = $2",
    [worldVersionId, ownerUserId]
  );
  const row = result.rows[0];
  if (!row) throw httpError(404, "Published world version not found.");
  const content = worldContentSchema.parse(row.content);
  const readiness = assessWorldCampaignReadiness(content);
  const characters = resolvePlayableCharacters(content).map((character) => ({
    id: character.id,
    name: character.name,
    rpgStatCount: character.rpgStats.length,
    defaultTriggerCount: character.defaultTriggers.length
  }));
  return { characters, readiness };
}

export async function listWorldVersionPlayableCharacters(pool: DatabasePool, worldVersionId: string) {
  return (await getWorldVersionPlayableCharacterSummary(pool, worldVersionId)).characters;
}

export async function updateCampaign(pool: DatabasePool, campaignId: string, request: CampaignUpdateRequest) {
  return withTransaction(pool, async (client) => {
    const ownerUserId = await initialOwnerId(client);
    if (request.textProviderProfileId) await resolveEffectiveProviderId(client, ownerUserId, "text", request.textProviderProfileId);
    if (request.imageProviderProfileId) await resolveEffectiveProviderId(client, ownerUserId, "image", request.imageProviderProfileId);
    const result = await client.query(
      `UPDATE campaigns SET title = COALESCE($3, title), status = COALESCE($4, status),
         text_provider_profile_id = CASE WHEN $5 THEN $6 ELSE text_provider_profile_id END,
         image_provider_profile_id = CASE WHEN $7 THEN $8 ELSE image_provider_profile_id END,
         story_length_profile = COALESCE($9, story_length_profile),
         updated_at = now()
        WHERE id = $1 AND owner_user_id = $2
        RETURNING id, title, status, active_turn_number AS "activeTurnNumber",
          text_provider_profile_id AS "textProviderProfileId", image_provider_profile_id AS "imageProviderProfileId",
          story_length_profile AS "storyLengthProfile", updated_at AS "updatedAt"`,
      [campaignId, ownerUserId, request.title ?? null, request.status ?? null,
        request.textProviderProfileId !== undefined, request.textProviderProfileId ?? null,
        request.imageProviderProfileId !== undefined, request.imageProviderProfileId ?? null,
        request.storyLengthProfile ?? null]
    );
    if (!result.rows[0]) throw httpError(404, "Campaign not found.");
    if (request.imageProviderProfileId !== undefined) {
      const effectiveImageId = await resolveEffectiveProviderId(client, ownerUserId, "image", request.imageProviderProfileId);
      await client.query(
        `UPDATE campaign_illustration_configs c SET provider_profile_id = $3,
           model = COALESCE(NULLIF(p.default_model, ''), c.model), updated_at = now()
          FROM provider_profiles p WHERE c.campaign_id = $1 AND c.owner_user_id = $2 AND p.id = $3`,
        [campaignId, ownerUserId, effectiveImageId]
      );
    }
    return result.rows[0];
  });
}

export async function deleteCampaign(pool: DatabasePool, campaignId: string, request: ResourceDeleteRequest) {
  return withTransaction(pool, async (client) => {
    const ownerUserId = await initialOwnerId(client);
    const campaign = await client.query<{ title: string }>(
      "SELECT title FROM campaigns WHERE id = $1 AND owner_user_id = $2 FOR UPDATE",
      [campaignId, ownerUserId]
    );
    const row = campaign.rows[0];
    if (!row) throw httpError(404, "Campaign not found.");
    if (row.title !== request.expectedTitle) throw httpError(409, "Campaign title changed. Refresh before deleting it.");

    const activeWork = await client.query(
      `SELECT 'generation' AS kind FROM generation_jobs
        WHERE campaign_id = $1 AND owner_user_id = $2
          AND status IN ('queued','assessing','generating','validating','committing')
       UNION ALL
       SELECT 'illustration' AS kind FROM image_jobs
        WHERE campaign_id = $1 AND owner_user_id = $2 AND status IN ('queued','generating')
       UNION ALL
       SELECT 'memory' AS kind FROM chronicle_jobs
        WHERE campaign_id = $1 AND owner_user_id = $2 AND status IN ('queued','running')
       LIMIT 1`,
      [campaignId, ownerUserId]
    );
    if (activeWork.rowCount) throw httpError(409, "Wait for active generation, illustration, or memory work before deleting this campaign.");

    await client.query("DELETE FROM imports WHERE campaign_id = $1 AND owner_user_id = $2", [campaignId, ownerUserId]);
    await client.query("DELETE FROM campaigns WHERE id = $1 AND owner_user_id = $2", [campaignId, ownerUserId]);
    return { deleted: true, id: campaignId, title: row.title };
  });
}

export async function deleteWorld(pool: DatabasePool, worldId: string, request: ResourceDeleteRequest) {
  return withTransaction(pool, async (client) => {
    const ownerUserId = await initialOwnerId(client);
    const world = await client.query<{ title: string }>(
      "SELECT title FROM worlds WHERE id = $1 AND owner_user_id = $2 FOR UPDATE",
      [worldId, ownerUserId]
    );
    const row = world.rows[0];
    if (!row) throw httpError(404, "World not found.");
    if (row.title !== request.expectedTitle) throw httpError(409, "World title changed. Refresh before deleting it.");

    const campaigns = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM campaigns c
         JOIN world_versions wv ON wv.id = c.world_version_id AND wv.owner_user_id = c.owner_user_id
        WHERE wv.world_id = $1 AND c.owner_user_id = $2`,
      [worldId, ownerUserId]
    );
    const campaignCount = Number(campaigns.rows[0]?.count || 0);
    if (campaignCount) {
      throw httpError(409, `Delete the ${campaignCount} campaign${campaignCount === 1 ? "" : "s"} using this world before deleting the world.`);
    }

    await client.query(
      `DELETE FROM imports
        WHERE owner_user_id = $2
          AND (world_id = $1 OR world_version_id IN (
            SELECT id FROM world_versions WHERE world_id = $1 AND owner_user_id = $2
          ))`,
      [worldId, ownerUserId]
    );
    await client.query(
      `UPDATE worlds SET forked_from_world_id = NULL, forked_from_world_version_id = NULL, updated_at = now()
        WHERE owner_user_id = $2 AND (
          forked_from_world_id = $1 OR forked_from_world_version_id IN (
            SELECT id FROM world_versions WHERE world_id = $1 AND owner_user_id = $2
          )
        )`,
      [worldId, ownerUserId]
    );
    await client.query(
      `UPDATE world_drafts SET based_on_world_version_id = NULL, updated_at = now()
        WHERE owner_user_id = $2 AND based_on_world_version_id IN (
          SELECT id FROM world_versions WHERE world_id = $1 AND owner_user_id = $2
        )`,
      [worldId, ownerUserId]
    );
    await client.query("DELETE FROM world_drafts WHERE world_id = $1 AND owner_user_id = $2", [worldId, ownerUserId]);
    await client.query("DELETE FROM world_versions WHERE world_id = $1 AND owner_user_id = $2", [worldId, ownerUserId]);
    await client.query("DELETE FROM worlds WHERE id = $1 AND owner_user_id = $2", [worldId, ownerUserId]);
    return { deleted: true, id: worldId, title: row.title };
  });
}

export async function deleteWorldVersion(
  pool: DatabasePool,
  worldId: string,
  worldVersionId: string,
  request: WorldVersionDeleteRequest
) {
  return withTransaction(pool, async (client) => {
    const ownerUserId = await initialOwnerId(client);
    const world = await client.query<{ status: string }>(
      "SELECT status FROM worlds WHERE id = $1 AND owner_user_id = $2 FOR UPDATE",
      [worldId, ownerUserId]
    );
    if (!world.rows[0]) throw httpError(404, "World not found.");

    const version = await client.query<{ world_id: string; version_number: number }>(
      `SELECT world_id, version_number
         FROM world_versions
        WHERE id = $1 AND owner_user_id = $2
        FOR UPDATE`,
      [worldVersionId, ownerUserId]
    );
    const selected = version.rows[0];
    if (!selected) throw httpError(404, "Published world version not found.");
    if (selected.world_id !== worldId) throw httpError(409, "The selected version does not belong to this world.");
    if (selected.version_number !== request.expectedVersionNumber) {
      throw httpError(409, "The selected world version changed. Refresh before deleting it.");
    }

    const dependencies = await client.query<{
      current_campaigns: number;
      campaign_migrations: number;
      chronicle_memories: number;
      model_chains: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM campaigns
           WHERE owner_user_id = $2 AND world_version_id = $1) AS current_campaigns,
         (SELECT count(*)::int FROM campaign_world_migrations
           WHERE owner_user_id = $2
             AND (from_world_version_id = $1 OR to_world_version_id = $1)) AS campaign_migrations,
         (SELECT count(*)::int FROM chronicle_memories
           WHERE owner_user_id = $2 AND world_version_id = $1) AS chronicle_memories,
         (SELECT count(*)::int FROM model_chains
           WHERE owner_user_id = $2 AND world_version_id = $1) AS model_chains`,
      [worldVersionId, ownerUserId]
    );
    const counts = dependencies.rows[0];
    const blockers = {
      currentCampaigns: Number(counts?.current_campaigns || 0),
      campaignMigrations: Number(counts?.campaign_migrations || 0),
      chronicleMemories: Number(counts?.chronicle_memories || 0),
      modelChains: Number(counts?.model_chains || 0)
    };
    if (Object.values(blockers).some((count) => count > 0)) {
      throw httpError(409, `World version ${selected.version_number} is linked to campaign history.`, {
        code: "world_version_in_use",
        blockers
      });
    }

    const detachedDrafts = await client.query(
      `UPDATE world_drafts SET based_on_world_version_id = NULL, updated_at = now()
        WHERE owner_user_id = $2 AND based_on_world_version_id = $1`,
      [worldVersionId, ownerUserId]
    );
    const detachedForks = await client.query(
      `UPDATE worlds SET forked_from_world_version_id = NULL, updated_at = now()
        WHERE owner_user_id = $2 AND forked_from_world_version_id = $1`,
      [worldVersionId, ownerUserId]
    );
    const detachedImports = await client.query(
      `UPDATE imports SET world_version_id = NULL
        WHERE owner_user_id = $2 AND world_version_id = $1`,
      [worldVersionId, ownerUserId]
    );
    const detachments = {
      drafts: detachedDrafts.rowCount || 0,
      forks: detachedForks.rowCount || 0,
      imports: detachedImports.rowCount || 0
    };

    const deleted = await client.query(
      "DELETE FROM world_versions WHERE id = $1 AND world_id = $2 AND owner_user_id = $3",
      [worldVersionId, worldId, ownerUserId]
    );
    if (!deleted.rowCount) throw httpError(409, "The selected world version was not deleted. Refresh and try again.");

    const remaining = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM world_versions
        WHERE world_id = $1 AND owner_user_id = $2`,
      [worldId, ownerUserId]
    );
    const remainingVersionCount = Number(remaining.rows[0]?.count || 0);
    const nextStatus = remainingVersionCount === 0 ? "draft" : world.rows[0].status;
    await client.query(
      `UPDATE worlds SET status = $3, updated_at = now()
        WHERE id = $1 AND owner_user_id = $2`,
      [worldId, ownerUserId, nextStatus]
    );
    await client.query(
      `INSERT INTO activity_events (owner_user_id, event_type, correlation_id, details)
       VALUES ($1, 'world_version_deleted', $2, $3)`,
      [ownerUserId, worldVersionId, json({
        worldId,
        worldVersionId,
        versionNumber: selected.version_number,
        remainingVersionCount,
        worldStatus: nextStatus,
        detachments
      })]
    );

    return {
      deleted: true,
      worldId,
      worldVersionId,
      versionNumber: selected.version_number,
      remainingVersionCount,
      worldStatus: nextStatus,
      detachments
    };
  });
}

export async function migrateCampaignWorld(pool: DatabasePool, campaignId: string, request: CampaignWorldMigrationRequest) {
  return withTransaction(pool, async (client) => {
    const ownerUserId = await initialOwnerId(client);
    const campaign = await client.query<{ world_version_id: string; world_id: string; version_number: number }>(
      `SELECT c.world_version_id, wv.world_id, wv.version_number
         FROM campaigns c JOIN world_versions wv ON wv.id = c.world_version_id AND wv.owner_user_id = c.owner_user_id
        WHERE c.id = $1 AND c.owner_user_id = $2 FOR UPDATE OF c`,
      [campaignId, ownerUserId]
    );
    const current = campaign.rows[0];
    if (!current) throw httpError(404, "Campaign not found.");
    const target = await client.query<{ id: string; world_id: string; version_number: number }>(
      "SELECT id, world_id, version_number FROM world_versions WHERE id = $1 AND owner_user_id = $2",
      [request.worldVersionId, ownerUserId]
    );
    const next = target.rows[0];
    if (!next) throw httpError(404, "Target world version not found.");
    if (next.world_id !== current.world_id) throw httpError(409, "A campaign can migrate only within its current world.");
    if (next.version_number <= current.version_number) throw httpError(409, "Select a newer published world version.");
    const active = await client.query(
      `SELECT 1 FROM generation_jobs WHERE campaign_id = $1 AND owner_user_id = $2
        AND status IN ('queued','assessing','generating','validating','committing') LIMIT 1`,
      [campaignId, ownerUserId]
    );
    if (active.rowCount) throw httpError(409, "Wait for the active story generation job before migrating the campaign.");
    const migration = await client.query<{ id: string; created_at: Date }>(
      `INSERT INTO campaign_world_migrations (
         owner_user_id, campaign_id, from_world_version_id, to_world_version_id, note
       ) VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
      [ownerUserId, campaignId, current.world_version_id, next.id, request.note]
    );
    await client.query("UPDATE campaigns SET world_version_id = $3, updated_at = now() WHERE id = $1 AND owner_user_id = $2", [campaignId, ownerUserId, next.id]);
    await client.query("UPDATE model_chains SET active = false, updated_at = now() WHERE campaign_id = $1 AND owner_user_id = $2", [campaignId, ownerUserId]);
    await client.query(
      `INSERT INTO activity_events (owner_user_id, campaign_id, event_type, correlation_id, details)
       VALUES ($1,$2,'campaign_world_migrated',$3,$4)`,
      [ownerUserId, campaignId, migration.rows[0]?.id, json({ fromWorldVersionId: current.world_version_id, toWorldVersionId: next.id, fromVersionNumber: current.version_number, toVersionNumber: next.version_number, characterSelectionRetained: true })]
    );
    return { migrationId: migration.rows[0]?.id, campaignId, fromWorldVersionId: current.world_version_id, toWorldVersionId: next.id, worldVersionNumber: next.version_number, migratedAt: migration.rows[0]?.created_at };
  });
}

export async function exportCampaign(pool: DatabasePool, campaignId: string) {
  const ownerUserId = await initialOwnerId(pool);
  const campaign = await pool.query<any>(
    `SELECT c.title, c.status, c.active_turn_number, c.story_length_profile, c.legacy_settings,
            c.selected_character_id, c.character_snapshot, w.title AS world_title,
            wv.id AS world_version_id, wv.version_number, wv.content, cs.*
       FROM campaigns c
       JOIN world_versions wv ON wv.id = c.world_version_id AND wv.owner_user_id = c.owner_user_id
       JOIN worlds w ON w.id = wv.world_id AND w.owner_user_id = c.owner_user_id
       JOIN campaign_state cs ON cs.campaign_id = c.id AND cs.owner_user_id = c.owner_user_id
      WHERE c.id = $1 AND c.owner_user_id = $2`,
    [campaignId, ownerUserId]
  );
  const row = campaign.rows[0];
  if (!row) throw httpError(404, "Campaign not found.");
  const turns = await pool.query<any>(
    `SELECT id, turn_number, action, narration, choices, custom_action_suggestion,
            image_prompt, image_url, mechanics_private, state_snapshot_private,
            model_metadata, accepted_at
       FROM turns WHERE campaign_id = $1 AND owner_user_id = $2 ORDER BY turn_number`,
    [campaignId, ownerUserId]
  );
  const costs = await turnReportedCosts(pool, ownerUserId, turns.rows.map((turn: { id: string }) => turn.id));
  const history = await pool.query<{ content: unknown; through_turn: number }>(
    `SELECT content, through_turn
       FROM summary_checkpoints
      WHERE campaign_id = $1 AND owner_user_id = $2 AND summary_kind = 'legacy_full_history'
      ORDER BY through_turn DESC, created_at DESC LIMIT 1`,
    [campaignId, ownerUserId]
  );
  const importedHistory = history.rows[0];
  const importProvenance = row.import_provenance && typeof row.import_provenance === "object" ? row.import_provenance : {};
  const selectedCharacterText = characterTextFromSnapshot(row.character_snapshot);
  const sourceWorld = row.content.world && typeof row.content.world === "object" ? row.content.world : {};
  const { character: _storedCharacter, ...worldWithoutStoredCharacter } = sourceWorld;
  return {
    format: "infinite-quest-campaign",
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    world: { ...worldWithoutStoredCharacter, ...(selectedCharacterText !== null ? { character: selectedCharacterText } : {}) },
    settings: { ...portableCampaignSettings(row.legacy_settings), storyLength: row.story_length_profile },
    turns: turns.rows.map((turn: any) => ({
      id: turn.id,
      turnNumber: turn.turn_number,
      action: turn.action,
      narration: turn.narration,
      choices: turn.choices,
      customActionSuggestion: turn.custom_action_suggestion,
      imagePrompt: turn.image_prompt,
      imageUrl: turn.image_url,
      roll: turn.mechanics_private,
      worldStateSnapshot: turn.state_snapshot_private,
      llmModelInfo: portableModelMetadata(turn.model_metadata),
      reportedCost: costs.get(turn.id) || null,
      createdAt: turn.accepted_at
    })),
    rpgStats: row.rpg_stats,
    defaultTriggers: row.default_triggers,
    eventTriggers: row.event_triggers,
    pendingEventTriggers: row.pending_event_triggers,
    trackers: row.trackers,
    baseTrackersAtStart: row.default_triggers,
    scratchpad: row.scratchpad_private,
    ...(importedHistory ? {
      fullHistory: importedHistory.content,
      fullHistoryCompressedThroughTurn: importedHistory.through_turn
    } : {}),
    worldImportProvenance: importProvenance.world ?? null,
    storyImportProvenance: {
      ...(importProvenance.story && typeof importProvenance.story === "object" ? importProvenance.story : {}),
      sourceType: "nexus_campaign_export",
      worldVersionId: row.world_version_id,
      worldVersionNumber: row.version_number,
      selectedCharacterId: row.selected_character_id ?? null,
      selectedCharacterName: row.character_snapshot?.name ?? null
    }
  };
}
