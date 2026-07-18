import type { DatabaseClient, DatabasePool } from "../../../packages/database/src/pool.js";
import { initialOwnerId, withTransaction } from "../../../packages/database/src/pool.js";
import {
  worldContentSchema,
  type CampaignCreateRequest,
  type CampaignUpdateRequest,
  type CampaignWorldMigrationRequest,
  type WorldContent,
  type WorldCreateRequest,
  type WorldDraftUpdateRequest,
  type WorldForkRequest,
  type WorldImportRequest,
  type WorldPublishRequest,
  type WorldStatusUpdateRequest
} from "../../../packages/contracts/src/world-library.js";
import { sha256, stableStringify } from "../../../packages/domain/src/text.js";

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

function portableModelMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  return Object.fromEntries(["providerType", "model", "promptProtocolVersion"].flatMap((key) => (
    typeof source[key] === "string" && source[key] ? [[key, source[key]]] : []
  )));
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
  return worldContentSchema.parse(content ?? {
    schemaVersion: 2,
    world: {
      title,
      genre: "",
      tone: "",
      premise: "",
      backgroundStory: "",
      character: "",
      firstAction: "",
      rules: ""
    }
  });
}

function contentWithTitle(content: WorldContent, title: string): WorldContent {
  return worldContentSchema.parse(sanitizeWorldValue({
    ...content,
    world: { ...content.world, title }
  }));
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
  const versions = await pool.query(
    `SELECT id, version_number AS "versionNumber", source_hash AS "sourceHash",
            release_notes AS "releaseNotes", created_from_revision AS "createdFromRevision",
            published_at AS "publishedAt", created_at AS "createdAt"
       FROM world_versions
      WHERE world_id = $1 AND owner_user_id = $2
      ORDER BY version_number DESC`,
    [worldId, ownerUserId]
  );
  const campaigns = await pool.query(
    `SELECT c.id, c.title, c.status, c.active_turn_number AS "activeTurnNumber",
            c.world_version_id AS "worldVersionId", wv.version_number AS "worldVersionNumber",
            c.updated_at AS "updatedAt"
       FROM campaigns c
       JOIN world_versions wv ON wv.id = c.world_version_id AND wv.owner_user_id = c.owner_user_id
      WHERE wv.world_id = $1 AND c.owner_user_id = $2
      ORDER BY c.updated_at DESC`,
    [worldId, ownerUserId]
  );
  return { ...world, versions: versions.rows, campaigns: campaigns.rows };
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
    const sourceHash = sha256(stableStringify(draft.content));
    const latest = await client.query<{ id: string; version_number: number; source_hash: string | null }>(
      `SELECT id, version_number, source_hash FROM world_versions
        WHERE world_id = $1 AND owner_user_id = $2 ORDER BY version_number DESC LIMIT 1`,
      [worldId, ownerUserId]
    );
    if (latest.rows[0]?.source_hash === sourceHash) throw httpError(409, "The draft is identical to the latest published version.");
    const versionNumber = (latest.rows[0]?.version_number ?? 0) + 1;
    const version = await client.query<{ id: string; published_at: Date }>(
      `INSERT INTO world_versions (
         world_id, owner_user_id, version_number, content, source_hash, release_notes, created_from_revision
       ) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, published_at`,
      [worldId, ownerUserId, versionNumber, json(draft.content), sourceHash, request.releaseNotes, draft.revision]
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
            w.id AS "worldId", w.title AS "worldTitle", c.world_version_id AS "worldVersionId",
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
    const campaign = await client.query<{ id: string }>(
      `INSERT INTO campaigns (owner_user_id, world_version_id, title)
       VALUES ($1,$2,$3) RETURNING id`,
      [ownerUserId, request.worldVersionId, request.title]
    );
    const campaignId = campaign.rows[0]?.id;
    if (!campaignId) throw new Error("Could not create campaign.");
    await client.query(
      `INSERT INTO campaign_state (
         campaign_id, owner_user_id, trackers, default_triggers, event_triggers, rpg_stats, import_provenance
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        campaignId,
        ownerUserId,
        json(source.content.defaults?.trackers ?? []),
        json(source.content.defaultTriggers),
        json(source.content.eventTriggers),
        json(source.content.rpgStats),
        json({ sourceType: "world_library", worldId: source.world_id, worldVersionId: request.worldVersionId })
      ]
    );
    return { id: campaignId, title: request.title, status: "active", activeTurnNumber: 0, worldId: source.world_id, worldVersionId: request.worldVersionId, worldVersionNumber: source.version_number };
  });
}

export async function updateCampaign(pool: DatabasePool, campaignId: string, request: CampaignUpdateRequest) {
  const ownerUserId = await initialOwnerId(pool);
  const result = await pool.query(
    `UPDATE campaigns SET title = COALESCE($3, title), status = COALESCE($4, status), updated_at = now()
      WHERE id = $1 AND owner_user_id = $2
      RETURNING id, title, status, active_turn_number AS "activeTurnNumber", updated_at AS "updatedAt"`,
    [campaignId, ownerUserId, request.title ?? null, request.status ?? null]
  );
  if (!result.rows[0]) throw httpError(404, "Campaign not found.");
  return result.rows[0];
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
        AND status IN ('queued','assessing','generating','validating','committing','indexing') LIMIT 1`,
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
      [ownerUserId, campaignId, migration.rows[0]?.id, json({ fromWorldVersionId: current.world_version_id, toWorldVersionId: next.id, fromVersionNumber: current.version_number, toVersionNumber: next.version_number })]
    );
    return { migrationId: migration.rows[0]?.id, campaignId, fromWorldVersionId: current.world_version_id, toWorldVersionId: next.id, worldVersionNumber: next.version_number, migratedAt: migration.rows[0]?.created_at };
  });
}

export async function exportCampaign(pool: DatabasePool, campaignId: string) {
  const ownerUserId = await initialOwnerId(pool);
  const campaign = await pool.query<any>(
    `SELECT c.title, c.status, c.active_turn_number, w.title AS world_title,
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
  return {
    format: "infinite-quest-campaign",
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    world: row.content.world,
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
      createdAt: turn.accepted_at
    })),
    rpgStats: row.rpg_stats,
    defaultTriggers: row.default_triggers,
    eventTriggers: row.event_triggers,
    pendingEventTriggers: row.pending_event_triggers,
    trackers: row.trackers,
    scratchpad: row.scratchpad_private,
    storyImportProvenance: {
      sourceType: "nexus_campaign_export",
      worldVersionId: row.world_version_id,
      worldVersionNumber: row.version_number
    }
  };
}
