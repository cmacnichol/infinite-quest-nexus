import { z } from "zod";
import type {
  DashboardRepositoryPort,
  DashboardSource,
  SessionProfileRepositoryPort,
  WorldCampaignErrorDetails,
  WorldCampaignRepositoryResult,
  WorldCampaignTransitionFailureReason,
  WorldGenerationProgressRepositoryPort
} from "../../application/src/world-campaign/index.js";
import { WorldCampaignApplicationError } from "../../application/src/world-campaign/index.js";
import { userProfileSchema, userProfileUpdateSchema } from "../../contracts/src/users.js";
import { worldCampaignDatabaseClient } from "./world-campaign-transaction.js";

const PROCESSING_EXPIRY = "30 minutes";
const TERMINAL_EXPIRY = "5 minutes";

const dashboardCountRowSchema = z.object({
  available_worlds: z.number().int().nonnegative(),
  total_worlds: z.number().int().nonnegative(),
  draft_worlds: z.number().int().nonnegative(),
  archived_worlds: z.number().int().nonnegative(),
  published_worlds: z.number().int().nonnegative(),
  open_campaigns: z.number().int().nonnegative(),
  total_campaigns: z.number().int().nonnegative(),
  archived_campaigns: z.number().int().nonnegative(),
  accepted_turns: z.number().int().nonnegative()
});

const dashboardProviderCostRowSchema = z.object({
  provider_profile_id: z.uuid().nullable(),
  provider_name: z.string().nullable(),
  provider_type: z.string().min(1),
  category: z.enum(["story", "image", "memory"]),
  currency: z.string().min(1),
  amount: z.string(),
  event_count: z.number().int().nonnegative(),
  last_reported_at: z.date()
});

const sessionProfileRowSchema = z.object({
  id: z.uuid(),
  systemKey: z.string().nullable(),
  displayName: z.string(),
  settings: z.unknown()
});

const progressRowSchema = z.object({
  status: z.enum(["processing", "completed", "failed"]),
  phase: z.string(),
  progress_percent: z.number().int().min(0).max(100),
  message: z.string(),
  error_message: z.string().nullable()
});

const progressUpdateSchema = z.object({
  status: z.enum(["processing", "completed", "failed"]),
  phase: z.string(),
  progressPercent: z.number().int().min(0).max(100),
  message: z.string(),
  errorMessage: z.string().optional()
}).strict();

const expiredBeforeSchema = z.iso.datetime({ offset: true });

function unavailable(): never {
  throw new WorldCampaignApplicationError("unavailable", "invalid_transition");
}

function parsePersisted<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) unavailable();
  return parsed.data;
}

function parseRequest<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new WorldCampaignApplicationError("invalid_request", "invalid_transition");
  }
  return parsed.data;
}

function parseSessionProfile(value: unknown) {
  return parsePersisted(
    userProfileSchema,
    parsePersisted(sessionProfileRowSchema, value),
  );
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

export function createPostgresDashboardRepository(): DashboardRepositoryPort {
  return {
    async getDashboard(transaction, scope): Promise<DashboardSource> {
      const client = worldCampaignDatabaseClient(transaction);
      const countsResult = await client.query(
        `SELECT
           (SELECT count(*)::int FROM worlds
             WHERE owner_user_id = $1 AND status = 'active') AS available_worlds,
           (SELECT count(*)::int FROM worlds
             WHERE owner_user_id = $1) AS total_worlds,
           (SELECT count(*)::int FROM worlds
             WHERE owner_user_id = $1 AND status = 'draft') AS draft_worlds,
           (SELECT count(*)::int FROM worlds
             WHERE owner_user_id = $1 AND status = 'archived') AS archived_worlds,
           (SELECT count(*)::int FROM worlds w
             WHERE w.owner_user_id = $1
               AND EXISTS (
                 SELECT 1 FROM world_versions wv
                  WHERE wv.world_id = w.id AND wv.owner_user_id = w.owner_user_id
               )) AS published_worlds,
           (SELECT count(*)::int FROM campaigns
             WHERE owner_user_id = $1 AND status = 'active') AS open_campaigns,
           (SELECT count(*)::int FROM campaigns
             WHERE owner_user_id = $1) AS total_campaigns,
           (SELECT count(*)::int FROM campaigns
             WHERE owner_user_id = $1 AND status = 'archived') AS archived_campaigns,
           (SELECT count(*)::int FROM turns
             WHERE owner_user_id = $1) AS accepted_turns`,
        [scope.ownerUserId],
      );
      const costsResult = await client.query(
        `SELECT costs.provider_profile_id, profiles.name AS provider_name,
                costs.provider_type, costs.category, costs.currency,
                sum(costs.amount)::text AS amount, count(*)::int AS event_count,
                max(costs.occurred_at) AS last_reported_at
           FROM provider_cost_events costs
           LEFT JOIN provider_profiles profiles
             ON profiles.id = costs.provider_profile_id
            AND profiles.owner_user_id = costs.owner_user_id
          WHERE costs.owner_user_id = $1
          GROUP BY costs.provider_profile_id, profiles.name, costs.provider_type,
                   costs.category, costs.currency
          ORDER BY costs.category, profiles.name NULLS LAST,
                   costs.provider_type, costs.currency`,
        [scope.ownerUserId],
      );
      const counts = parsePersisted(dashboardCountRowSchema, countsResult.rows[0]);
      const totals = costsResult.rows.map((row) => {
        const cost = parsePersisted(dashboardProviderCostRowSchema, row);
        return {
          providerProfileId: cost.provider_profile_id,
          providerName: cost.provider_name,
          providerType: cost.provider_type,
          category: cost.category,
          currency: cost.currency,
          amount: cost.amount,
          eventCount: cost.event_count,
          lastReportedAt: cost.last_reported_at
        };
      });
      return {
        worlds: {
          available: counts.available_worlds,
          total: counts.total_worlds,
          published: counts.published_worlds,
          drafts: counts.draft_worlds,
          archived: counts.archived_worlds
        },
        campaigns: {
          open: counts.open_campaigns,
          total: counts.total_campaigns,
          archived: counts.archived_campaigns
        },
        turns: { accepted: counts.accepted_turns },
        providerCosts: {
          hasReportedCosts: totals.length > 0,
          totals
        }
      };
    }
  };
}

export function createPostgresSessionProfileRepository(): SessionProfileRepositoryPort {
  return {
    async getSessionProfile(transaction, scope) {
      const client = worldCampaignDatabaseClient(transaction);
      const result = await client.query(
        `SELECT id, system_key AS "systemKey", display_name AS "displayName", settings
           FROM users
          WHERE id = $1`,
        [scope.ownerUserId],
      );
      if (!result.rows[0]) {
        throw new WorldCampaignApplicationError("not_found", "invalid_transition");
      }
      return parseSessionProfile(result.rows[0]);
    },

    async updateSessionProfile(transaction, scope, input) {
      const client = worldCampaignDatabaseClient(transaction);
      const request = parseRequest(userProfileUpdateSchema, input);
      const result = await client.query(
        `UPDATE users
            SET display_name = COALESCE($2, display_name),
                settings = CASE
                  WHEN $3::jsonb IS NULL THEN settings
                  ELSE COALESCE(settings, '{}'::jsonb) || $3::jsonb
                END,
                updated_at = now()
          WHERE id = $1
          RETURNING id, system_key AS "systemKey",
                    display_name AS "displayName", settings`,
        [
          scope.ownerUserId,
          request.displayName ?? null,
          request.settings === undefined ? null : JSON.stringify(request.settings)
        ],
      );
      if (!result.rows[0]) return failure("invalid_transition");
      return success(parseSessionProfile(result.rows[0]));
    }
  };
}

export function createPostgresWorldGenerationProgressRepository(): WorldGenerationProgressRepositoryPort {
  return {
    async createWorldGenerationProgress(transaction, scope) {
      const client = worldCampaignDatabaseClient(transaction);
      await client.query(
        `INSERT INTO world_generation_progress (
           progress_key, owner_user_id, status, phase, progress_percent, message, expires_at
         ) VALUES ($1, $2, 'processing', 'queued', 0, '', now() + $3::interval)
         ON CONFLICT (progress_key) DO NOTHING`,
        [scope.progressKey, scope.ownerUserId, PROCESSING_EXPIRY],
      );
      return success(undefined);
    },

    async updateWorldGenerationProgress(transaction, scope, input) {
      const client = worldCampaignDatabaseClient(transaction);
      const update = parseRequest(progressUpdateSchema, input);
      const expiry = update.status === "processing" ? PROCESSING_EXPIRY : TERMINAL_EXPIRY;
      const result = await client.query(
        `UPDATE world_generation_progress
            SET status = $3,
                phase = $4,
                progress_percent = $5,
                message = $6,
                error_message = $7,
                updated_at = now(),
                expires_at = now() + $8::interval
          WHERE progress_key = $1
            AND owner_user_id = $2
            AND expires_at > now()`,
        [
          scope.progressKey,
          scope.ownerUserId,
          update.status,
          update.phase,
          update.progressPercent,
          update.message,
          update.errorMessage ?? null,
          expiry
        ],
      );
      return result.rowCount === 1 ? success(undefined) : failure("invalid_transition");
    },

    async getWorldGenerationProgress(transaction, scope) {
      const client = worldCampaignDatabaseClient(transaction);
      const result = await client.query(
        `SELECT status, phase, progress_percent, message, error_message
           FROM world_generation_progress
          WHERE progress_key = $1
            AND owner_user_id = $2
            AND expires_at > now()`,
        [scope.progressKey, scope.ownerUserId],
      );
      if (!result.rows[0]) return null;
      const row = parsePersisted(progressRowSchema, result.rows[0]);
      return {
        status: row.status,
        phase: row.phase,
        progressPercent: row.progress_percent,
        message: row.message,
        ...(row.error_message ? { errorMessage: row.error_message } : {})
      };
    },

    async deleteExpiredWorldGenerationProgress(transaction, scope, input) {
      const client = worldCampaignDatabaseClient(transaction);
      const expiredBefore = parseRequest(expiredBeforeSchema, input);
      const result = await client.query(
        `DELETE FROM world_generation_progress
          WHERE owner_user_id = $1
            AND expires_at <= $2::timestamptz`,
        [scope.ownerUserId, expiredBefore],
      );
      return success(result.rowCount ?? 0);
    }
  };
}
