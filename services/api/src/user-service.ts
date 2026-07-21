import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { initialOwnerId } from "../../../packages/database/src/pool.js";
import type { UserProfile, UserProfileUpdate } from "../../../packages/contracts/src/users.js";
import { userProfileSchema } from "../../../packages/contracts/src/users.js";

export async function getSessionUserProfile(pool: DatabasePool): Promise<UserProfile> {
  const userId = await initialOwnerId(pool);
  const result = await pool.query(
    `SELECT id, system_key AS "systemKey", display_name AS "displayName", settings FROM users WHERE id = $1`,
    [userId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Initial user not found in database.");
  }
  const settings = typeof row.settings === "string" ? JSON.parse(row.settings) : (row.settings || {});
  return userProfileSchema.parse({
    id: row.id,
    systemKey: row.systemKey || "initial-owner",
    displayName: row.displayName || "Initial Owner",
    settings
  });
}

export async function updateSessionUserProfile(pool: DatabasePool, update: UserProfileUpdate): Promise<UserProfile> {
  const userId = await initialOwnerId(pool);

  if (update.displayName !== undefined && update.settings !== undefined) {
    const settingsJson = JSON.stringify(update.settings);
    await pool.query(
      `UPDATE users SET display_name = $1, settings = COALESCE(settings, '{}'::jsonb) || $2::jsonb, updated_at = now() WHERE id = $3`,
      [update.displayName, settingsJson, userId]
    );
  } else if (update.displayName !== undefined) {
    await pool.query(
      `UPDATE users SET display_name = $1, updated_at = now() WHERE id = $2`,
      [update.displayName, userId]
    );
  } else if (update.settings !== undefined) {
    const settingsJson = JSON.stringify(update.settings);
    await pool.query(
      `UPDATE users SET settings = COALESCE(settings, '{}'::jsonb) || $1::jsonb, updated_at = now() WHERE id = $2`,
      [settingsJson, userId]
    );
  }

  return getSessionUserProfile(pool);
}
