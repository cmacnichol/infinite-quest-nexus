import { z } from "zod";
import type { SettingsOperatorRepositoryPort, SettingsOperatorSession } from "../../application/src/settings/index.js";
import { withTransaction, type DatabaseClient, type DatabasePool } from "./pool.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
async function prune(client: DatabaseClient): Promise<void> {
  await client.query("DELETE FROM settings_operator_sessions WHERE id IN (SELECT id FROM settings_operator_sessions WHERE expires_at<=clock_timestamp() LIMIT 1000)");
  await client.query("DELETE FROM settings_unlock_attempts WHERE bucket IN (SELECT bucket FROM settings_unlock_attempts WHERE window_start<=clock_timestamp()-interval '15 minutes' LIMIT 1001)");
}
type SessionRow = { id: string; actor_user_id: string; token_digest: string; csrf_digest: string; key_fingerprint: string; expires_at: Date };
function session(row: SessionRow): SettingsOperatorSession {
  return { id: row.id, actorUserId: row.actor_user_id, tokenDigest: row.token_digest, csrfDigest: row.csrf_digest, keyFingerprint: row.key_fingerprint, expiresAt: row.expires_at };
}
export function createSettingsOperatorRepository(pool: DatabasePool): SettingsOperatorRepositoryPort {
  return {
    async createSession(input) {
      digest.parse(input.tokenDigest); digest.parse(input.csrfDigest); digest.parse(input.keyFingerprint); z.string().uuid().parse(input.actorUserId);
      if (!(input.expiresAt instanceof Date) || !Number.isFinite(input.expiresAt.getTime()) || input.expiresAt.getTime()<=Date.now() || input.expiresAt.getTime()>Date.now()+900000) throw new Error("settings_session_expiry_invalid");
      return withTransaction(pool, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(1936942452)"); await prune(client);
        const { rows: [count] } = await client.query("SELECT count(*)::int AS n FROM settings_operator_sessions");
        if (count.n>=1000) throw new Error("settings_session_capacity");
        const { rows: [row] } = await client.query<SessionRow>(`INSERT INTO settings_operator_sessions(actor_user_id,token_digest,csrf_digest,key_fingerprint,expires_at) VALUES($1,$2,$3,$4,$5) RETURNING *`, [input.actorUserId,input.tokenDigest,input.csrfDigest,input.keyFingerprint,input.expiresAt]);
        return session(row!);
      });
    },
    async findSession(input) {
      digest.parse(input.tokenDigest); digest.parse(input.keyFingerprint); z.string().uuid().parse(input.actorUserId);
      const { rows: [row] } = await pool.query<SessionRow>("SELECT * FROM settings_operator_sessions WHERE token_digest=$1 AND actor_user_id=$2 AND key_fingerprint=$3 AND expires_at>clock_timestamp()", [input.tokenDigest,input.actorUserId,input.keyFingerprint]);
      return row ? session(row) : null;
    },
    async revokeSession(id) { z.string().uuid().parse(id); await pool.query("DELETE FROM settings_operator_sessions WHERE id=$1", [id]); },
    recordUnlockAttempt(clientDigest, outcome) {
      digest.parse(clientDigest);
      z.enum(["success", "failure"]).parse(outcome);
      return withTransaction(pool, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(1936942452)");
        await prune(client);
        const { rows } = await client.query<{ bucket: string; attempts: number }>(
          "SELECT bucket,attempts FROM settings_unlock_attempts WHERE bucket=ANY($1::text[])", [["global", clientDigest]]
        );
        const counts = new Map(rows.map((row) => [row.bucket, row.attempts]));
        if ((counts.get("global") ?? 0) >= 50 || (counts.get(clientDigest) ?? 0) >= 5) return false;
        // A successful comparison consumes no failure budget, but cannot bypass a lockout.
        if (outcome === "failure") {
          await client.query(`INSERT INTO settings_unlock_attempts(bucket,window_start,attempts)
            SELECT bucket,clock_timestamp(),1 FROM unnest($1::text[]) AS bucket
            ON CONFLICT(bucket) DO UPDATE SET attempts=settings_unlock_attempts.attempts+1`, [["global", clientDigest]]);
        }
        return true;
      });
    },
    cleanup: () => withTransaction(pool, async (client) => { await client.query("SELECT pg_advisory_xact_lock(1936942452)"); await prune(client); })
  };
}
