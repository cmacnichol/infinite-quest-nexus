import type {
  CampaignMigrationSource,
  CampaignRepositoryPort,
  WorldCampaignErrorDetails,
  WorldCampaignRepositoryResult,
  WorldCampaignTransitionFailureReason,
  WorldCreateRequest,
  WorldCreateSource,
  WorldDraftUpdateSource,
  WorldForkView,
  WorldPublicationSource,
  WorldStatusSource,
  WorldAggregateSource,
  WorldListSource,
  WorldRepositoryPort
} from "../../application/src/world-campaign/index.js";
import { WorldCampaignApplicationError } from "../../application/src/world-campaign/index.js";
import type { OwnerScope } from "../../application/src/generation/types.js";
import {
  canonicalizeWorldContent,
  WORLD_CONTENT_SCHEMA_VERSION,
  type WorldContent
} from "../../contracts/src/world-library.js";
import { sha256, stableStringify } from "../../domain/src/text.js";
import type { DatabasePool } from "./pool.js";
import {
  createPostgresWorldCampaignTransactionPort,
  worldCampaignDatabaseClient
} from "./world-campaign-transaction.js";

type PostgresWorldRepository = Pick<
  WorldRepositoryPort,
  | "listWorlds"
  | "getWorld"
  | "createWorld"
  | "updateWorldDraft"
  | "publishWorld"
  | "updateWorldStatus"
  | "forkWorld"
  | "deleteWorld"
  | "deleteWorldVersion"
>;

type PostgresCampaignMigrationRepository = Pick<CampaignRepositoryPort, "migrateCampaignWorldVersion">;

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
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
  return canonicalizeWorldContent({
    ...content,
    world: { ...content.world, title }
  });
}

function success<T>(value: T): WorldCampaignRepositoryResult<T> {
  return { ok: true, value };
}

function failure(
  reason: WorldCampaignTransitionFailureReason,
  details?: WorldCampaignErrorDetails,
): WorldCampaignRepositoryResult<never> {
  return details === undefined
    ? { ok: false, failure: { reason } }
    : { ok: false, failure: { reason, details } };
}

function notFound(reason: "world_not_found" | "world_version_not_found", details: { worldId?: string; worldVersionId?: string }): never {
  throw new WorldCampaignApplicationError("not_found", reason, details);
}

function blockerNames(counts: Record<string, number>): string[] {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name}:${count}`);
}

function createPostgresWorldRepository(): PostgresWorldRepository {
  return {
    async listWorlds(transaction, scope): Promise<WorldListSource> {
      const client = worldCampaignDatabaseClient(transaction);
      const result = await client.query<WorldListSource["worlds"][number]>(
        `SELECT w.id, w.title, w.status,
                CASE WHEN w.cover_asset_id IS NOT NULL THEN '/api/v1/assets/' || w.cover_asset_id::text ELSE '' END AS "imageUrl",
                w.forked_from_world_id AS "forkedFromWorldId",
                w.forked_from_world_version_id AS "forkedFromWorldVersionId",
                w.created_at AS "createdAt", w.updated_at AS "updatedAt",
                wd.revision AS "draftRevision", wd.updated_at AS "draftUpdatedAt",
                CASE WHEN wd.content IS NULL THEN NULL ELSE jsonb_build_object(
                  'title', COALESCE(wd.content -> 'world' ->> 'title', ''),
                  'genre', COALESCE(wd.content -> 'world' ->> 'genre', ''),
                  'tone', COALESCE(wd.content -> 'world' ->> 'tone', ''),
                  'premise', COALESCE(wd.content -> 'world' ->> 'premise', ''),
                  'backgroundStory', COALESCE(wd.content -> 'world' ->> 'backgroundStory', ''),
                  'firstAction', COALESCE(wd.content -> 'world' ->> 'firstAction', '')
                ) END AS "draftPreview",
                latest.id AS "latestVersionId", latest.version_number AS "latestVersionNumber",
                latest.published_at AS "latestPublishedAt", latest.content -> 'world' AS "latestPreview",
                COALESCE(counts.campaign_count, 0) AS "campaignCount"
           FROM worlds w
           LEFT JOIN world_drafts wd ON wd.world_id = w.id AND wd.owner_user_id = w.owner_user_id
           LEFT JOIN LATERAL (
             SELECT id, version_number, published_at, content
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
        [scope.ownerUserId]
      );
      return { worlds: result.rows };
    },
    async getWorld(transaction, scope): Promise<WorldAggregateSource> {
      const client = worldCampaignDatabaseClient(transaction);
      const worldResult = await client.query<Omit<WorldAggregateSource, "versions" | "campaigns">>(
        `SELECT w.id, w.title, w.status,
                CASE WHEN w.cover_asset_id IS NOT NULL THEN '/api/v1/assets/' || w.cover_asset_id::text ELSE '' END AS "imageUrl",
                w.forked_from_world_id AS "forkedFromWorldId",
                w.forked_from_world_version_id AS "forkedFromWorldVersionId",
                w.created_at AS "createdAt", w.updated_at AS "updatedAt",
                wd.revision AS "draftRevision", wd.content AS "draftContent",
                wd.based_on_world_version_id AS "draftBasedOnWorldVersionId",
                wd.updated_at AS "draftUpdatedAt"
           FROM worlds w
           LEFT JOIN world_drafts wd ON wd.world_id = w.id AND wd.owner_user_id = w.owner_user_id
          WHERE w.id = $1 AND w.owner_user_id = $2`,
        [scope.worldId, scope.ownerUserId]
      );
      const world = worldResult.rows[0];
      if (!world) notFound("world_not_found", { worldId: scope.worldId });
      const versions = await client.query<WorldAggregateSource["versions"][number] & {
        currentCampaigns: number;
        campaignMigrations: number;
        campaignTransfers: number;
        chronicleMemories: number;
        modelChains: number;
        drafts: number;
        forks: number;
        imports: number;
      }>(
        `SELECT wv.id, wv.version_number AS "versionNumber", wv.source_hash AS "sourceHash",
                wv.release_notes AS "releaseNotes", wv.created_from_revision AS "createdFromRevision",
                wv.published_at AS "publishedAt", wv.created_at AS "createdAt",
                dependencies.current_campaigns AS "currentCampaigns",
                dependencies.campaign_migrations AS "campaignMigrations",
                dependencies.campaign_transfers AS "campaignTransfers",
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
               (SELECT count(*)::int FROM campaign_world_transfers cwt
                 WHERE cwt.owner_user_id = wv.owner_user_id
                   AND (cwt.from_world_version_id = wv.id OR cwt.to_world_version_id = wv.id)) AS campaign_transfers,
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
        [scope.worldId, scope.ownerUserId]
      );
      const campaigns = await client.query<WorldAggregateSource["campaigns"][number]>(
        `SELECT c.id, c.title, c.status, c.active_turn_number AS "activeTurnNumber",
                c.world_version_id AS "worldVersionId", wv.version_number AS "worldVersionNumber",
                c.selected_character_id AS "selectedCharacterId",
                COALESCE(c.character_profile->>'name', c.character_snapshot->>'name') AS "selectedCharacterName",
                c.turn_control_style AS "turnControlStyle", c.updated_at AS "updatedAt"
           FROM campaigns c
           JOIN world_versions wv ON wv.id = c.world_version_id AND wv.owner_user_id = c.owner_user_id
          WHERE wv.world_id = $1 AND c.owner_user_id = $2
          ORDER BY c.updated_at DESC`,
        [scope.worldId, scope.ownerUserId]
      );
      return {
        ...world,
        draftContent: world.draftContent === null ? null : canonicalizeWorldContent(world.draftContent),
        versions: versions.rows.map((version) => {
          const {
            currentCampaigns,
            campaignMigrations,
            campaignTransfers,
            chronicleMemories,
            modelChains,
            drafts,
            forks,
            imports,
            ...publishedVersion
          } = version;
          const deletionBlockers = {
            currentCampaigns: Number(currentCampaigns),
            campaignMigrations: Number(campaignMigrations),
            campaignTransfers: Number(campaignTransfers),
            chronicleMemories: Number(chronicleMemories),
            modelChains: Number(modelChains)
          };
          return {
            ...publishedVersion,
            deletable: Object.values(deletionBlockers).every((count) => count === 0),
            deletionBlockers,
            detachments: { drafts: Number(drafts), forks: Number(forks), imports: Number(imports) }
          };
        }),
        campaigns: campaigns.rows
      };
    },
    async createWorld(transaction, scope: OwnerScope, request: WorldCreateRequest) {
      const client = worldCampaignDatabaseClient(transaction);
      const content = contentWithTitle(normalizeWorldContent(request.title, request.content), request.title);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO worlds (owner_user_id, title, status)
         VALUES ($1, $2, 'draft') RETURNING id`,
        [scope.ownerUserId, request.title]
      );
      const worldId = inserted.rows[0]?.id;
      if (!worldId) throw new Error("Could not create world.");
      await client.query(
        `INSERT INTO world_drafts (world_id, owner_user_id, revision, content)
         VALUES ($1, $2, 1, $3)`,
        [worldId, scope.ownerUserId, json(content)]
      );
      const created = await client.query<WorldCreateSource>(
        `SELECT w.id, w.title, w.status,
                CASE WHEN w.cover_asset_id IS NOT NULL THEN '/api/v1/assets/' || w.cover_asset_id::text ELSE '' END AS "imageUrl",
                wd.revision AS "draftRevision", wd.content AS "draftContent",
                wd.based_on_world_version_id AS "draftBasedOnWorldVersionId",
                w.created_at AS "createdAt", w.updated_at AS "updatedAt"
           FROM worlds w
           JOIN world_drafts wd ON wd.world_id = w.id AND wd.owner_user_id = w.owner_user_id
          WHERE w.id = $1 AND w.owner_user_id = $2`,
        [worldId, scope.ownerUserId]
      );
      const row = created.rows[0];
      if (!row) throw new Error("Could not load the created world.");
      return success({ ...row, draftContent: canonicalizeWorldContent(row.draftContent) });
    },
    async updateWorldDraft(transaction, scope, request) {
      const client = worldCampaignDatabaseClient(transaction);
      const locked = await client.query<{ title: string; status: string; revision: number }>(
        `SELECT w.title, w.status, wd.revision
           FROM worlds w
           JOIN world_drafts wd ON wd.world_id = w.id AND wd.owner_user_id = w.owner_user_id
          WHERE w.id = $1 AND w.owner_user_id = $2
          FOR UPDATE OF w, wd`,
        [scope.worldId, scope.ownerUserId]
      );
      const current = locked.rows[0];
      if (!current) return failure("world_not_found", { worldId: scope.worldId });
      if (current.status === "archived") return failure("invalid_transition", { worldId: scope.worldId });
      if (current.revision !== request.expectedRevision) {
        return failure("draft_revision_changed", {
          worldId: scope.worldId,
          expectedDraftRevision: request.expectedRevision,
          actualDraftRevision: current.revision
        });
      }
      const nextTitle = request.title ?? current.title;
      const content = contentWithTitle(request.content, nextTitle);
      const updated = await client.query<{ revision: number; updatedAt: Date }>(
        `UPDATE world_drafts
            SET content = $3, revision = revision + 1, updated_at = now()
          WHERE world_id = $1 AND owner_user_id = $2
          RETURNING revision, updated_at AS "updatedAt"`,
        [scope.worldId, scope.ownerUserId, json(content)]
      );
      await client.query(
        "UPDATE worlds SET title = $3, updated_at = now() WHERE id = $1 AND owner_user_id = $2",
        [scope.worldId, scope.ownerUserId, nextTitle]
      );
      const row = updated.rows[0];
      if (!row) throw new Error("Could not update world draft.");
      return success<WorldDraftUpdateSource>({
        worldId: scope.worldId,
        title: nextTitle,
        revision: row.revision,
        content,
        updatedAt: row.updatedAt
      });
    },
    async publishWorld(transaction, scope, request) {
      const client = worldCampaignDatabaseClient(transaction);
      const locked = await client.query<{ title: string; status: string; revision: number; content: WorldContent }>(
        `SELECT w.title, w.status, wd.revision, wd.content
           FROM worlds w
           JOIN world_drafts wd ON wd.world_id = w.id AND wd.owner_user_id = w.owner_user_id
          WHERE w.id = $1 AND w.owner_user_id = $2
          FOR UPDATE OF w, wd`,
        [scope.worldId, scope.ownerUserId]
      );
      const draft = locked.rows[0];
      if (!draft) return failure("world_not_found", { worldId: scope.worldId });
      if (draft.status === "archived") return failure("invalid_transition", { worldId: scope.worldId });
      if (draft.revision !== request.expectedRevision) {
        return failure("draft_revision_changed", {
          worldId: scope.worldId,
          expectedDraftRevision: request.expectedRevision,
          actualDraftRevision: draft.revision
        });
      }
      const content = contentWithTitle(draft.content, draft.title);
      const sourceHash = sha256(stableStringify(content));
      const latest = await client.query<{ source_hash: string | null }>(
        `SELECT source_hash FROM world_versions
          WHERE world_id = $1 AND owner_user_id = $2
          ORDER BY version_number DESC LIMIT 1`,
        [scope.worldId, scope.ownerUserId]
      );
      if (latest.rows[0]?.source_hash === sourceHash) {
        return failure("invalid_transition", { worldId: scope.worldId });
      }
      const allocation = await client.query<{ version_number: number }>(
        `UPDATE worlds SET next_version_number = next_version_number + 1
          WHERE id = $1 AND owner_user_id = $2
          RETURNING next_version_number - 1 AS version_number`,
        [scope.worldId, scope.ownerUserId]
      );
      const versionNumber = allocation.rows[0]?.version_number;
      if (!versionNumber) throw new Error("Could not allocate a world version number.");
      const version = await client.query<{ id: string; published_at: Date }>(
        `INSERT INTO world_versions (
           world_id, owner_user_id, version_number, content, source_hash, release_notes, created_from_revision
         ) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, published_at`,
        [scope.worldId, scope.ownerUserId, versionNumber, json(content), sourceHash, request.releaseNotes, draft.revision]
      );
      const worldVersionId = version.rows[0]?.id;
      const publishedAt = version.rows[0]?.published_at;
      if (!worldVersionId || !publishedAt) throw new Error("Could not publish world version.");
      await client.query(
        `UPDATE world_drafts SET based_on_world_version_id = $3, updated_at = now()
          WHERE world_id = $1 AND owner_user_id = $2`,
        [scope.worldId, scope.ownerUserId, worldVersionId]
      );
      await client.query(
        "UPDATE worlds SET status = 'active', updated_at = now() WHERE id = $1 AND owner_user_id = $2",
        [scope.worldId, scope.ownerUserId]
      );
      await client.query(
        `INSERT INTO activity_events (owner_user_id, event_type, correlation_id, details)
         VALUES ($1, 'world_version_published', $2, $3)`,
        [scope.ownerUserId, worldVersionId, json({
          worldId: scope.worldId,
          worldVersionId,
          versionNumber,
          draftRevision: draft.revision
        })]
      );
      return success<WorldPublicationSource>({
        worldId: scope.worldId,
        worldVersionId,
        versionNumber,
        draftRevision: draft.revision,
        publishedAt
      });
    },
    async updateWorldStatus(transaction, scope, request) {
      const client = worldCampaignDatabaseClient(transaction);
      const locked = await client.query<{ title: string; content: WorldContent }>(
        `SELECT w.title, wd.content
           FROM worlds w
           JOIN world_drafts wd ON wd.world_id = w.id AND wd.owner_user_id = w.owner_user_id
          WHERE w.id = $1 AND w.owner_user_id = $2
          FOR UPDATE OF w, wd`,
        [scope.worldId, scope.ownerUserId]
      );
      const current = locked.rows[0];
      if (!current) return failure("world_not_found", { worldId: scope.worldId });
      const nextTitle = request.title ?? current.title;
      const result = await client.query<WorldStatusSource>(
        `UPDATE worlds
            SET title = $3, status = COALESCE($4, status), updated_at = now()
          WHERE id = $1 AND owner_user_id = $2
          RETURNING id, title, status, updated_at AS "updatedAt"`,
        [scope.worldId, scope.ownerUserId, nextTitle, request.status ?? null]
      );
      if (request.title !== undefined) {
        await client.query(
          `UPDATE world_drafts SET content = $3, revision = revision + 1, updated_at = now()
            WHERE world_id = $1 AND owner_user_id = $2`,
          [scope.worldId, scope.ownerUserId, json(contentWithTitle(current.content, nextTitle))]
        );
      }
      const row = result.rows[0];
      if (!row) throw new Error("Could not update world status.");
      return success(row);
    },
    async forkWorld(transaction, scope, request) {
      const client = worldCampaignDatabaseClient(transaction);
      const source = await client.query<{ id: string; content: WorldContent }>(
        `SELECT id, content FROM world_versions
          WHERE world_id = $1 AND owner_user_id = $2
            AND ($3::uuid IS NULL OR id = $3)
          ORDER BY version_number DESC LIMIT 1`,
        [scope.worldId, scope.ownerUserId, request.sourceWorldVersionId ?? null]
      );
      const version = source.rows[0];
      if (!version) return failure("world_version_not_found", { worldId: scope.worldId });
      const content = contentWithTitle(version.content, request.title);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO worlds (
           owner_user_id, title, status, forked_from_world_id, forked_from_world_version_id
         ) VALUES ($1,$2,'draft',$3,$4) RETURNING id`,
        [scope.ownerUserId, request.title, scope.worldId, version.id]
      );
      const forkId = inserted.rows[0]?.id;
      if (!forkId) throw new Error("Could not fork world.");
      await client.query(
        `INSERT INTO world_drafts (world_id, owner_user_id, based_on_world_version_id, revision, content)
         VALUES ($1,$2,$3,1,$4)`,
        [forkId, scope.ownerUserId, version.id, json(content)]
      );
      return success<WorldForkView>({
        worldId: forkId,
        sourceWorldId: scope.worldId,
        sourceWorldVersionId: version.id,
        title: request.title,
        revision: 1
      });
    },
    async deleteWorld(transaction, scope, request) {
      const client = worldCampaignDatabaseClient(transaction);
      const world = await client.query<{ title: string }>(
        "SELECT title FROM worlds WHERE id = $1 AND owner_user_id = $2 FOR UPDATE",
        [scope.worldId, scope.ownerUserId]
      );
      const row = world.rows[0];
      if (!row) return failure("world_not_found", { worldId: scope.worldId });
      if (row.title !== request.expectedTitle) return failure("invalid_transition", { worldId: scope.worldId });
      const dependencies = await client.query<{
        campaigns: number;
        campaign_migrations: number;
        campaign_transfers: number;
        chronicle_memories: number;
        model_chains: number;
        active_cover_jobs: number;
      }>(
        `SELECT
           (SELECT count(*)::int FROM campaigns c
             JOIN world_versions wv ON wv.id = c.world_version_id AND wv.owner_user_id = c.owner_user_id
            WHERE wv.world_id = $1 AND c.owner_user_id = $2) AS campaigns,
           (SELECT count(*)::int FROM campaign_world_migrations cwm
            WHERE cwm.owner_user_id = $2 AND (
              cwm.from_world_version_id IN (SELECT id FROM world_versions WHERE world_id = $1 AND owner_user_id = $2)
              OR cwm.to_world_version_id IN (SELECT id FROM world_versions WHERE world_id = $1 AND owner_user_id = $2)
            )) AS campaign_migrations,
           (SELECT count(*)::int FROM campaign_world_transfers cwt
            WHERE cwt.owner_user_id = $2 AND (
              cwt.from_world_version_id IN (SELECT id FROM world_versions WHERE world_id = $1 AND owner_user_id = $2)
              OR cwt.to_world_version_id IN (SELECT id FROM world_versions WHERE world_id = $1 AND owner_user_id = $2)
            )) AS campaign_transfers,
           (SELECT count(*)::int FROM chronicle_memories cm
            WHERE cm.owner_user_id = $2
              AND cm.world_version_id IN (SELECT id FROM world_versions WHERE world_id = $1 AND owner_user_id = $2)) AS chronicle_memories,
           (SELECT count(*)::int FROM model_chains mc
            WHERE mc.owner_user_id = $2
              AND mc.world_version_id IN (SELECT id FROM world_versions WHERE world_id = $1 AND owner_user_id = $2)) AS model_chains,
           (SELECT count(*)::int FROM image_jobs ij
            WHERE ij.world_id = $1 AND ij.owner_user_id = $2
              AND ij.status IN ('queued','generating','provider_pending','downloading')) AS active_cover_jobs`,
        [scope.worldId, scope.ownerUserId]
      );
      const counts = dependencies.rows[0];
      const blockers = blockerNames({
        campaigns: Number(counts?.campaigns ?? 0),
        campaign_migrations: Number(counts?.campaign_migrations ?? 0),
        campaign_transfers: Number(counts?.campaign_transfers ?? 0),
        chronicle_memories: Number(counts?.chronicle_memories ?? 0),
        model_chains: Number(counts?.model_chains ?? 0),
        active_cover_jobs: Number(counts?.active_cover_jobs ?? 0)
      });
      if (blockers.length > 0) return failure("deletion_blocked", { worldId: scope.worldId, blockers });
      await client.query(
        `DELETE FROM imports
          WHERE owner_user_id = $2
            AND (world_id = $1 OR world_version_id IN (
              SELECT id FROM world_versions WHERE world_id = $1 AND owner_user_id = $2
            ))`,
        [scope.worldId, scope.ownerUserId]
      );
      await client.query(
        `UPDATE worlds SET forked_from_world_id = NULL, forked_from_world_version_id = NULL, updated_at = now()
          WHERE owner_user_id = $2 AND (
            forked_from_world_id = $1 OR forked_from_world_version_id IN (
              SELECT id FROM world_versions WHERE world_id = $1 AND owner_user_id = $2
            )
          )`,
        [scope.worldId, scope.ownerUserId]
      );
      await client.query(
        `UPDATE world_drafts SET based_on_world_version_id = NULL, updated_at = now()
          WHERE owner_user_id = $2 AND based_on_world_version_id IN (
            SELECT id FROM world_versions WHERE world_id = $1 AND owner_user_id = $2
          )`,
        [scope.worldId, scope.ownerUserId]
      );
      await client.query("DELETE FROM world_drafts WHERE world_id = $1 AND owner_user_id = $2", [scope.worldId, scope.ownerUserId]);
      await client.query("DELETE FROM world_versions WHERE world_id = $1 AND owner_user_id = $2", [scope.worldId, scope.ownerUserId]);
      await client.query("DELETE FROM worlds WHERE id = $1 AND owner_user_id = $2", [scope.worldId, scope.ownerUserId]);
      return success(undefined);
    },
    async deleteWorldVersion(transaction, scope, request) {
      const client = worldCampaignDatabaseClient(transaction);
      const world = await client.query<{ status: "draft" | "active" | "archived" }>(
        "SELECT status FROM worlds WHERE id = $1 AND owner_user_id = $2 FOR UPDATE",
        [scope.worldId, scope.ownerUserId]
      );
      if (!world.rows[0]) return failure("world_not_found", { worldId: scope.worldId });
      const version = await client.query<{ world_id: string; version_number: number }>(
        `SELECT world_id, version_number FROM world_versions
          WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
        [scope.worldVersionId, scope.ownerUserId]
      );
      const selected = version.rows[0];
      if (!selected) return failure("world_version_not_found", { worldVersionId: scope.worldVersionId });
      if (selected.world_id !== scope.worldId) return failure("invalid_transition", { worldId: scope.worldId, worldVersionId: scope.worldVersionId });
      if (selected.version_number !== request.expectedVersionNumber) {
        return failure("version_number_conflict", {
          worldVersionId: scope.worldVersionId,
          versionNumber: selected.version_number
        });
      }
      const dependencies = await client.query<{
        current_campaigns: number;
        campaign_migrations: number;
        campaign_transfers: number;
        chronicle_memories: number;
        model_chains: number;
      }>(
        `SELECT
           (SELECT count(*)::int FROM campaigns
             WHERE owner_user_id = $2 AND world_version_id = $1) AS current_campaigns,
           (SELECT count(*)::int FROM campaign_world_migrations
             WHERE owner_user_id = $2
               AND (from_world_version_id = $1 OR to_world_version_id = $1)) AS campaign_migrations,
           (SELECT count(*)::int FROM campaign_world_transfers
             WHERE owner_user_id = $2
               AND (from_world_version_id = $1 OR to_world_version_id = $1)) AS campaign_transfers,
           (SELECT count(*)::int FROM chronicle_memories
             WHERE owner_user_id = $2 AND world_version_id = $1) AS chronicle_memories,
           (SELECT count(*)::int FROM model_chains
             WHERE owner_user_id = $2 AND world_version_id = $1) AS model_chains`,
        [scope.worldVersionId, scope.ownerUserId]
      );
      const counts = dependencies.rows[0];
      const blockers = blockerNames({
        current_campaigns: Number(counts?.current_campaigns ?? 0),
        campaign_migrations: Number(counts?.campaign_migrations ?? 0),
        campaign_transfers: Number(counts?.campaign_transfers ?? 0),
        chronicle_memories: Number(counts?.chronicle_memories ?? 0),
        model_chains: Number(counts?.model_chains ?? 0)
      });
      if (blockers.length > 0) {
        return failure("deletion_blocked", { worldId: scope.worldId, worldVersionId: scope.worldVersionId, blockers });
      }
      const detachedDrafts = await client.query(
        `UPDATE world_drafts SET based_on_world_version_id = NULL, updated_at = now()
          WHERE owner_user_id = $2 AND based_on_world_version_id = $1`,
        [scope.worldVersionId, scope.ownerUserId]
      );
      const detachedForks = await client.query(
        `UPDATE worlds SET forked_from_world_version_id = NULL, updated_at = now()
          WHERE owner_user_id = $2 AND forked_from_world_version_id = $1`,
        [scope.worldVersionId, scope.ownerUserId]
      );
      const detachedImports = await client.query(
        "UPDATE imports SET world_version_id = NULL WHERE owner_user_id = $2 AND world_version_id = $1",
        [scope.worldVersionId, scope.ownerUserId]
      );
      await client.query(
        "DELETE FROM world_versions WHERE id = $1 AND world_id = $2 AND owner_user_id = $3",
        [scope.worldVersionId, scope.worldId, scope.ownerUserId]
      );
      const remaining = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM world_versions WHERE world_id = $1 AND owner_user_id = $2",
        [scope.worldId, scope.ownerUserId]
      );
      const remainingVersionCount = Number(remaining.rows[0]?.count ?? 0);
      const nextStatus = remainingVersionCount === 0 ? "draft" : world.rows[0]!.status;
      await client.query(
        "UPDATE worlds SET status = $3, updated_at = now() WHERE id = $1 AND owner_user_id = $2",
        [scope.worldId, scope.ownerUserId, nextStatus]
      );
      await client.query(
        `INSERT INTO activity_events (owner_user_id, event_type, correlation_id, details)
         VALUES ($1, 'world_version_deleted', $2, $3)`,
        [scope.ownerUserId, scope.worldVersionId, json({
          worldId: scope.worldId,
          worldVersionId: scope.worldVersionId,
          versionNumber: selected.version_number,
          remainingVersionCount,
          worldStatus: nextStatus,
          detachments: {
            drafts: detachedDrafts.rowCount ?? 0,
            forks: detachedForks.rowCount ?? 0,
            imports: detachedImports.rowCount ?? 0
          }
        })]
      );
      return success(undefined);
    }
  };
}

function createPostgresCampaignMigrationRepository(): PostgresCampaignMigrationRepository {
  return {
    async migrateCampaignWorldVersion(transaction, scope, request) {
      const client = worldCampaignDatabaseClient(transaction);
      const campaign = await client.query<{ world_version_id: string; world_id: string; version_number: number }>(
        `SELECT c.world_version_id, wv.world_id, wv.version_number
           FROM campaigns c
           JOIN world_versions wv ON wv.id = c.world_version_id AND wv.owner_user_id = c.owner_user_id
          WHERE c.id = $1 AND c.owner_user_id = $2 FOR UPDATE OF c`,
        [scope.campaignId, scope.ownerUserId]
      );
      const current = campaign.rows[0];
      if (!current) return failure("campaign_not_found", { campaignId: scope.campaignId });
      const target = await client.query<{ id: string; world_id: string; version_number: number }>(
        "SELECT id, world_id, version_number FROM world_versions WHERE id = $1 AND owner_user_id = $2",
        [request.worldVersionId, scope.ownerUserId]
      );
      const next = target.rows[0];
      if (!next) return failure("world_version_not_found", { worldVersionId: request.worldVersionId });
      if (next.world_id !== current.world_id) {
        return failure("world_transfer_required", { targetWorldId: next.world_id });
      }
      if (next.version_number <= current.version_number) {
        return failure("invalid_transition", { worldVersionId: next.id, versionNumber: next.version_number });
      }
      const active = await client.query(
        `SELECT 1 FROM generation_jobs
          WHERE campaign_id = $1 AND owner_user_id = $2
            AND status IN ('queued','replacement_queued','assessing','generating','validating','committing','recoverable')
          LIMIT 1`,
        [scope.campaignId, scope.ownerUserId]
      );
      if (active.rowCount) return failure("invalid_transition", { campaignId: scope.campaignId });
      const migration = await client.query<{ id: string; created_at: Date }>(
        `INSERT INTO campaign_world_migrations (
           owner_user_id, campaign_id, from_world_version_id, to_world_version_id, note
         ) VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
        [scope.ownerUserId, scope.campaignId, current.world_version_id, next.id, request.note]
      );
      const migrationId = migration.rows[0]?.id;
      const migratedAt = migration.rows[0]?.created_at;
      if (!migrationId || !migratedAt) throw new Error("Could not record campaign world migration.");
      await client.query(
        "UPDATE campaigns SET world_version_id = $3, updated_at = now() WHERE id = $1 AND owner_user_id = $2",
        [scope.campaignId, scope.ownerUserId, next.id]
      );
      await client.query(
        "UPDATE model_chains SET active = false, updated_at = now() WHERE campaign_id = $1 AND owner_user_id = $2",
        [scope.campaignId, scope.ownerUserId]
      );
      await client.query(
        `INSERT INTO activity_events (owner_user_id, campaign_id, event_type, correlation_id, details)
         VALUES ($1,$2,'campaign_world_migrated',$3,$4)`,
        [scope.ownerUserId, scope.campaignId, migrationId, json({
          fromWorldVersionId: current.world_version_id,
          toWorldVersionId: next.id,
          fromVersionNumber: current.version_number,
          toVersionNumber: next.version_number,
          characterSelectionRetained: true
        })]
      );
      return success<CampaignMigrationSource>({
        migrationId,
        campaignId: scope.campaignId,
        fromWorldVersionId: current.world_version_id,
        toWorldVersionId: next.id,
        worldVersionNumber: next.version_number,
        migratedAt
      });
    }
  };
}

export function createPostgresWorldRepositoryAdapters(pool: DatabasePool) {
  return Object.freeze({
    transaction: createPostgresWorldCampaignTransactionPort(pool),
    worlds: createPostgresWorldRepository(),
    campaigns: createPostgresCampaignMigrationRepository()
  });
}
