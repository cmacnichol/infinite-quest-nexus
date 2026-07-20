import { randomUUID } from "node:crypto";
import type { DatabaseClient, DatabasePool } from "../../../packages/database/src/pool.js";
import type { ReportedProviderCost, TextProviderProfile } from "../../../packages/story-engine/src/providers.js";
import { initialOwnerId } from "../../../packages/database/src/pool.js";

export type CostCategory = "story" | "image" | "memory";

export type CostAttribution = {
  ownerUserId: string;
  campaignId: string;
  turnId?: string | null;
  providerProfileId: string;
  providerType: string;
  requestedModel: string;
  resolvedModel?: string;
  providerResponseId?: string;
  generationJobId?: string | null;
  imageJobId?: string | null;
  chronicleJobId?: string | null;
  category: CostCategory;
  operation: string;
  usage?: unknown;
  localCallId?: string;
};

export type CostBearingResult = {
  reportedCost: ReportedProviderCost | null;
  responseId: string;
  usage: unknown;
  modelInstanceId?: string;
  model?: string;
};

export type ReportedCost = {
  amount: string;
  currency: string;
  byCategory: Record<CostCategory, string>;
};

function json(value: unknown): string { return JSON.stringify(value ?? {}); }

export async function recordProviderCost(
  client: DatabaseClient | DatabasePool,
  attribution: CostAttribution,
  result: CostBearingResult
): Promise<string | null> {
  if (!result.reportedCost) return null;
  const localCallId = attribution.localCallId || randomUUID();
  const providerResponseId = attribution.providerResponseId || result.responseId || null;
  const resolvedModel = attribution.resolvedModel || result.modelInstanceId || result.model || attribution.requestedModel;
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO provider_cost_events (
       owner_user_id, campaign_id, turn_id, provider_profile_id, generation_job_id, image_job_id,
       chronicle_job_id, local_call_id, provider_type, provider_response_id, category, operation,
       requested_model, resolved_model, amount, currency, usage_metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [attribution.ownerUserId, attribution.campaignId, attribution.turnId || null, attribution.providerProfileId,
      attribution.generationJobId || null, attribution.imageJobId || null, attribution.chronicleJobId || null,
      localCallId, attribution.providerType, providerResponseId, attribution.category, attribution.operation,
      attribution.requestedModel, resolvedModel, result.reportedCost.amount, result.reportedCost.currency,
      json(attribution.usage ?? result.usage)]
  );
  return inserted.rows[0]?.id || null;
}

export async function recordProfileCost(
  client: DatabaseClient | DatabasePool,
  profile: TextProviderProfile & { id: string },
  attribution: Omit<CostAttribution, "providerProfileId" | "providerType" | "requestedModel">,
  result: CostBearingResult
): Promise<string | null> {
  return recordProviderCost(client, {
    ...attribution,
    providerProfileId: profile.id,
    providerType: profile.providerType,
    requestedModel: profile.model
  }, result);
}

export async function attributeGenerationCostsToTurn(
  client: DatabaseClient,
  ownerUserId: string,
  campaignId: string,
  generationJobId: string,
  turnId: string
): Promise<void> {
  await client.query(
    `UPDATE provider_cost_events SET turn_id = $4
      WHERE owner_user_id = $1 AND campaign_id = $2 AND generation_job_id = $3 AND turn_id IS NULL`,
    [ownerUserId, campaignId, generationJobId, turnId]
  );
}

function zeroCategories(): Record<CostCategory, string> {
  return { story: "0", image: "0", memory: "0" };
}

export async function turnReportedCosts(
  client: DatabaseClient | DatabasePool,
  ownerUserId: string,
  turnIds: string[]
): Promise<Map<string, ReportedCost>> {
  if (!turnIds.length) return new Map();
  const result = await client.query<{ turn_id: string; currency: string; category: CostCategory; amount: string; total_amount: string }>(
    `WITH category_totals AS (
       SELECT turn_id, currency, category, sum(amount) AS amount
         FROM provider_cost_events
        WHERE owner_user_id = $1 AND turn_id = ANY($2::uuid[])
        GROUP BY turn_id, currency, category
     )
     SELECT turn_id, currency, category, amount::text,
            sum(amount) OVER (PARTITION BY turn_id, currency)::text AS total_amount
       FROM category_totals
      ORDER BY turn_id, currency, category`,
    [ownerUserId, turnIds]
  );
  const grouped = new Map<string, Map<string, ReportedCost>>();
  for (const row of result.rows) {
    const currencies = grouped.get(row.turn_id) || new Map<string, ReportedCost>();
    const summary = currencies.get(row.currency) || { amount: row.total_amount, currency: row.currency, byCategory: zeroCategories() };
    summary.byCategory[row.category] = row.amount;
    currencies.set(row.currency, summary);
    grouped.set(row.turn_id, currencies);
  }
  const output = new Map<string, ReportedCost>();
  for (const [turnId, currencies] of grouped) {
    if (currencies.size !== 1) continue;
    const summary = [...currencies.values()][0];
    if (!summary) continue;
    output.set(turnId, summary);
  }
  return output;
}

export async function getCampaignCostSummary(pool: DatabasePool, campaignId: string) {
  const ownerUserId = await initialOwnerId(pool);
  const campaign = await pool.query("SELECT id FROM campaigns WHERE id = $1 AND owner_user_id = $2", [campaignId, ownerUserId]);
  if (!campaign.rows[0]) throw Object.assign(new Error("Campaign not found."), { statusCode: 404 });
  const rows = await pool.query<{
    currency: string;
    category: CostCategory;
    amount: string;
    attributed_amount: string;
    other_amount: string;
    total_amount: string;
    total_attributed_amount: string;
    total_other_amount: string;
    last_reported_at: Date;
  }>(
    `WITH category_totals AS (
       SELECT currency, category, sum(amount) AS amount,
              coalesce(sum(amount) FILTER (WHERE turn_id IS NOT NULL), 0) AS attributed_amount,
              coalesce(sum(amount) FILTER (WHERE turn_id IS NULL), 0) AS other_amount,
              max(occurred_at) AS last_reported_at
         FROM provider_cost_events
        WHERE owner_user_id = $1 AND campaign_id = $2
        GROUP BY currency, category
     )
     SELECT currency, category, amount::text, attributed_amount::text, other_amount::text,
            sum(amount) OVER (PARTITION BY currency)::text AS total_amount,
            sum(attributed_amount) OVER (PARTITION BY currency)::text AS total_attributed_amount,
            sum(other_amount) OVER (PARTITION BY currency)::text AS total_other_amount,
            last_reported_at
       FROM category_totals
      ORDER BY currency, category`,
    [ownerUserId, campaignId]
  );
  const currencies = new Map<string, {
    currency: string;
    total: string;
    turnAttributed: string;
    otherCampaignOperations: string;
    byCategory: Record<CostCategory, string>;
    lastReportedAt: Date;
  }>();
  for (const row of rows.rows) {
    const summary = currencies.get(row.currency) || {
      currency: row.currency,
      total: row.total_amount,
      turnAttributed: row.total_attributed_amount,
      otherCampaignOperations: row.total_other_amount,
      byCategory: zeroCategories(),
      lastReportedAt: row.last_reported_at
    };
    summary.total = row.total_amount;
    summary.turnAttributed = row.total_attributed_amount;
    summary.otherCampaignOperations = row.total_other_amount;
    summary.byCategory[row.category] = row.amount;
    if (row.last_reported_at > summary.lastReportedAt) summary.lastReportedAt = row.last_reported_at;
    currencies.set(row.currency, summary);
  }
  return {
    campaignId,
    hasReportedCosts: currencies.size > 0,
    totals: [...currencies.values()].map((summary) => ({
      currency: summary.currency,
      amount: summary.total,
      turnAttributed: summary.turnAttributed,
      otherCampaignOperations: summary.otherCampaignOperations,
      byCategory: summary.byCategory,
      lastReportedAt: summary.lastReportedAt
    }))
  };
}
