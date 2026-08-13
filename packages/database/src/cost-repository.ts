import type {
  CampaignCostSummaryView,
  CostCategory,
  ProviderCostPort,
  ProviderCostTransactionContext,
  ReportedCostView
} from "../../application/src/providers/index.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";

type Database = DatabaseClient | DatabasePool;

const transactionClients = new WeakMap<object, DatabaseClient>();

export function createProviderCostTransactionContext(
  client: DatabaseClient,
): ProviderCostTransactionContext {
  const context = Object.freeze({});
  transactionClients.set(context, client);
  return context;
}

function transactionClient(context: ProviderCostTransactionContext): DatabaseClient {
  const client = transactionClients.get(context);
  if (!client) throw new Error("Invalid provider cost transaction context.");
  return client;
}

function zeroCategories(): Record<CostCategory, string> {
  return { story: "0", image: "0", memory: "0" };
}

function assertCurrency(currency: string): string {
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Provider cost currency must be a three-letter uppercase code.");
  return currency;
}

function assertAmount(amount: string): string {
  if (!/^\d+(?:\.\d+)?$/.test(amount) || Number(amount) < 0) {
    throw new Error("Provider cost amount must be a non-negative decimal.");
  }
  return amount;
}

export function createProviderCostRepository(readDatabase: Database): ProviderCostPort {
  return {
    async recordCost(context, command) {
      if (!command.reportedCost) return null;
      const result = await transactionClient(context).query<{ id: string }>(
        `INSERT INTO provider_cost_events (
           owner_user_id, campaign_id, turn_id, provider_profile_id, generation_job_id, image_job_id,
           chronicle_job_id, local_call_id, provider_type, provider_response_id, category, operation,
           requested_model, resolved_model, amount, currency, usage_metadata
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,coalesce($8::uuid,gen_random_uuid()),$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          command.ownerUserId,
          command.campaignId,
          command.turnId ?? null,
          command.providerProfileId,
          command.generationJobId ?? null,
          command.imageJobId ?? null,
          command.chronicleJobId ?? null,
          command.localCallId ?? null,
          command.providerType,
          command.providerResponseId ?? null,
          command.category,
          command.operation,
          command.requestedModel,
          command.resolvedModel ?? command.requestedModel,
          assertAmount(command.reportedCost.amount),
          assertCurrency(command.reportedCost.currency),
          JSON.stringify(command.usage)
        ]
      );
      return result.rows[0]?.id ?? null;
    },

    async attributeGenerationCostsToTurn(context, scope) {
      await transactionClient(context).query(
        `UPDATE provider_cost_events cost
            SET turn_id = $4
          WHERE cost.owner_user_id = $1 AND cost.campaign_id = $2
            AND cost.generation_job_id = $3 AND cost.turn_id IS NULL
            AND EXISTS (
              SELECT 1 FROM turns turn_row
               WHERE turn_row.id = $4 AND turn_row.campaign_id = $2 AND turn_row.owner_user_id = $1
            )`,
        [scope.ownerUserId, scope.campaignId, scope.generationJobId, scope.turnId]
      );
    },

    async getTurnCosts(scope) {
      if (!scope.turnIds.length) return new Map();
      const result = await readDatabase.query<{
        turn_id: string;
        currency: string;
        category: CostCategory;
        amount: string;
        total_amount: string;
      }>(
        `WITH category_totals AS (
           SELECT cost.turn_id, cost.currency, cost.category, sum(cost.amount) AS amount
             FROM provider_cost_events cost
             JOIN turns turn_row ON turn_row.id = cost.turn_id
               AND turn_row.campaign_id = cost.campaign_id AND turn_row.owner_user_id = cost.owner_user_id
            WHERE cost.owner_user_id = $1 AND cost.campaign_id = $2
              AND cost.turn_id = ANY($3::uuid[])
            GROUP BY cost.turn_id, cost.currency, cost.category
         )
         SELECT turn_id, currency, category, amount::text,
                sum(amount) OVER (PARTITION BY turn_id, currency)::text AS total_amount
           FROM category_totals ORDER BY turn_id, currency, category`,
        [scope.ownerUserId, scope.campaignId, [...scope.turnIds]]
      );
      const grouped = new Map<string, Map<string, ReportedCostView>>();
      for (const row of result.rows) {
        const currencies = grouped.get(row.turn_id) ?? new Map<string, ReportedCostView>();
        const previous = currencies.get(row.currency);
        const byCategory = { ...(previous?.byCategory ?? zeroCategories()), [row.category]: row.amount };
        currencies.set(row.currency, { amount: row.total_amount, currency: row.currency, byCategory });
        grouped.set(row.turn_id, currencies);
      }
      const output = new Map<string, ReportedCostView>();
      for (const [turnId, currencies] of grouped) {
        if (currencies.size === 1) output.set(turnId, [...currencies.values()][0]!);
      }
      return output;
    },

    async getCampaignCostSummary(scope) {
      const campaign = await readDatabase.query(
        "SELECT 1 FROM campaigns WHERE id = $1 AND owner_user_id = $2",
        [scope.campaignId, scope.ownerUserId]
      );
      if (!campaign.rows[0]) throw Object.assign(new Error("Campaign not found."), { statusCode: 404 });
      const result = await readDatabase.query<{
        currency: string;
        category: CostCategory;
        amount: string;
        attributed_amount: string;
        other_amount: string;
        total_amount: string;
        total_attributed_amount: string;
        total_other_amount: string;
        last_reported_at: Date | string;
      }>(
        `WITH category_totals AS (
           SELECT currency, category, sum(amount) AS amount,
                  coalesce(sum(amount) FILTER (WHERE turn_id IS NOT NULL),0) AS attributed_amount,
                  coalesce(sum(amount) FILTER (WHERE turn_id IS NULL),0) AS other_amount,
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
           FROM category_totals ORDER BY currency, category`,
        [scope.ownerUserId, scope.campaignId]
      );
      const totals = new Map<string, CampaignCostSummaryView["totals"][number]>();
      for (const row of result.rows) {
        const previous = totals.get(row.currency);
        const lastReportedAt = new Date(row.last_reported_at).toISOString();
        totals.set(row.currency, {
          currency: row.currency,
          amount: row.total_amount,
          turnAttributed: row.total_attributed_amount,
          historicalAndUnattributedOperations: row.total_other_amount,
          otherCampaignOperations: row.total_other_amount,
          byCategory: { ...(previous?.byCategory ?? zeroCategories()), [row.category]: row.amount },
          lastReportedAt: previous && previous.lastReportedAt > lastReportedAt
            ? previous.lastReportedAt
            : lastReportedAt
        });
      }
      return {
        campaignId: scope.campaignId,
        hasReportedCosts: totals.size > 0,
        totals: [...totals.values()]
      };
    }
  };
}
