import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import type { DatabasePool } from "./pool.js";
import { worldContentSchema } from "../../contracts/src/world-library.js";

type CreateWorldShareRequest = Readonly<{
  ownerUserId: string;
  worldId: string;
  worldVersionId: string;
  expiresAt: Date;
}>;

type WorldShareDependencies = Readonly<{
  randomBytes?: (size: number) => Buffer;
}>;

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function portableContent(value: unknown, title: string) {
  const content = worldContentSchema.parse(value);
  return { ...content, world: { ...content.world, title } };
}

export function createWorldShareLinkService(pool: DatabasePool, dependencies: WorldShareDependencies = {}) {
  const randomBytes = dependencies.randomBytes ?? nodeRandomBytes;
  return {
    async create(request: CreateWorldShareRequest) {
      const version = await pool.query<{ title: string }>(
        `SELECT world.title
           FROM worlds world
           JOIN world_versions version
             ON version.world_id = world.id AND version.owner_user_id = world.owner_user_id
          WHERE world.id = $1 AND version.id = $2 AND world.owner_user_id = $3`,
        [request.worldId, request.worldVersionId, request.ownerUserId]
      );
      if (version.rowCount !== 1) return null;
      const token = randomBytes(32).toString("base64url");
      const inserted = await pool.query<{ id: string; expires_at: string | Date }>(
        `INSERT INTO world_share_links (owner_user_id,world_id,world_version_id,expires_at,token_hash)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id,expires_at`,
        [request.ownerUserId, request.worldId, request.worldVersionId, request.expiresAt, tokenHash(token)]
      );
      const row = inserted.rows[0]!;
      return { id: row.id, token, expiresAt: new Date(row.expires_at).toISOString() };
    },

    async list(ownerUserId: string, worldId: string) {
      const result = await pool.query<{
        id: string;
        world_version_id: string;
        expires_at: string | Date;
        revoked_at: string | Date | null;
        redeemed_count: string | number;
        created_at: string | Date;
      }>(
        `SELECT id,world_version_id,expires_at,revoked_at,redeemed_count,created_at
           FROM world_share_links
          WHERE owner_user_id = $1 AND world_id = $2
          ORDER BY created_at DESC`,
        [ownerUserId, worldId]
      );
      return result.rows.map((row) => ({
        id: row.id,
        worldVersionId: row.world_version_id,
        expiresAt: new Date(row.expires_at).toISOString(),
        revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
        redeemedCount: Number(row.redeemed_count),
        createdAt: new Date(row.created_at).toISOString()
      }));
    },

    async revoke(ownerUserId: string, worldId: string, shareId: string): Promise<boolean> {
      const result = await pool.query(
        `UPDATE world_share_links SET revoked_at = COALESCE(revoked_at,now())
          WHERE id = $1 AND owner_user_id = $2 AND world_id = $3`,
        [shareId, ownerUserId, worldId]
      );
      return result.rowCount === 1;
    },

    async redeem(token: string) {
      if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return null;
      const result = await pool.query<{ id: string; title: string; content: unknown }>(
        `UPDATE world_share_links share
            SET redeemed_count = redeemed_count + 1,last_redeemed_at = now()
           FROM worlds world,world_versions version
          WHERE share.token_hash = $1 AND share.revoked_at IS NULL AND share.expires_at > now()
            AND world.id = share.world_id AND world.owner_user_id = share.owner_user_id
            AND version.id = share.world_version_id AND version.world_id = world.id
            AND version.owner_user_id = share.owner_user_id
          RETURNING share.id,world.title,version.content`,
        [tokenHash(token)]
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        shareId: row.id,
        worldExport: {
          format: "infinite-quest-world" as const,
          formatVersion: 1 as const,
          title: row.title,
          content: portableContent(row.content, row.title)
        }
      };
    }
  };
}
