import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { initialOwnerId } from "../../../packages/database/src/pool.js";

type DashboardCountRow = {
  available_worlds: number;
  total_worlds: number;
  draft_worlds: number;
  archived_worlds: number;
  published_worlds: number;
  open_campaigns: number;
  total_campaigns: number;
  archived_campaigns: number;
  accepted_turns: number;
};

type DashboardProviderCostRow = {
  provider_profile_id: string | null;
  provider_name: string | null;
  provider_type: string;
  category: "story" | "image" | "memory";
  currency: string;
  amount: string;
  event_count: number;
  last_reported_at: Date;
};

export async function getDashboardStats(pool: DatabasePool) {
  const ownerUserId = await initialOwnerId(pool);
  const [countsResult, costsResult] = await Promise.all([
    pool.query<DashboardCountRow>(
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
      [ownerUserId]
    ),
    pool.query<DashboardProviderCostRow>(
      `SELECT costs.provider_profile_id, profiles.name AS provider_name,
              costs.provider_type, costs.category, costs.currency, sum(costs.amount)::text AS amount,
              count(*)::int AS event_count, max(costs.occurred_at) AS last_reported_at
         FROM provider_cost_events costs
         LEFT JOIN provider_profiles profiles
           ON profiles.id = costs.provider_profile_id
          AND profiles.owner_user_id = costs.owner_user_id
        WHERE costs.owner_user_id = $1
        GROUP BY costs.provider_profile_id, profiles.name, costs.provider_type, costs.category, costs.currency
        ORDER BY costs.category, profiles.name NULLS LAST, costs.provider_type, costs.currency`,
      [ownerUserId]
    )
  ]);
  const counts = countsResult.rows[0] ?? {
    available_worlds: 0,
    total_worlds: 0,
    draft_worlds: 0,
    archived_worlds: 0,
    published_worlds: 0,
    open_campaigns: 0,
    total_campaigns: 0,
    archived_campaigns: 0,
    accepted_turns: 0
  };
  const providerTotals = costsResult.rows.map((row) => ({
    providerProfileId: row.provider_profile_id,
    providerName: row.provider_name,
    providerType: row.provider_type,
    category: row.category,
    currency: row.currency,
    amount: row.amount,
    eventCount: row.event_count,
    lastReportedAt: row.last_reported_at
  }));

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
    turns: {
      accepted: counts.accepted_turns
    },
    providerCosts: {
      hasReportedCosts: providerTotals.length > 0,
      totals: providerTotals
    }
  };
}
