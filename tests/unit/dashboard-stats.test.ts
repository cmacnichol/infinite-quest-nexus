import { describe, expect, it } from "vitest";
import type { DatabasePool } from "../../packages/database/src/pool.js";
import { getDashboardStats } from "../../services/api/src/dashboard-service.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";

describe("dashboard statistics", () => {
  it("returns owner-scoped resource counts and explicit provider-reported costs", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const reportedAt = new Date("2026-07-22T12:00:00.000Z");
    const mockPool = {
      query: async (sql: string, values: unknown[] = []) => {
        calls.push({ sql, values });
        if (sql.includes("system_key = 'initial-owner'")) return { rows: [{ id: ownerUserId }] };
        if (sql.includes("FROM provider_cost_events costs")) {
          return {
            rows: [{
              provider_profile_id: "22222222-2222-4222-8222-222222222222",
              provider_name: "OpenRouter Primary",
              provider_type: "openrouter",
              currency: "USD",
              amount: "1.375000000000",
              event_count: 4,
              last_reported_at: reportedAt
            }]
          };
        }
        return {
          rows: [{
            available_worlds: 3,
            total_worlds: 5,
            draft_worlds: 1,
            archived_worlds: 1,
            published_worlds: 4,
            open_campaigns: 2,
            total_campaigns: 3,
            archived_campaigns: 1,
            accepted_turns: 27
          }]
        };
      }
    } as unknown as DatabasePool;

    await expect(getDashboardStats(mockPool)).resolves.toEqual({
      worlds: { available: 3, total: 5, published: 4, drafts: 1, archived: 1 },
      campaigns: { open: 2, total: 3, archived: 1 },
      turns: { accepted: 27 },
      providerCosts: {
        hasReportedCosts: true,
        totals: [{
          providerProfileId: "22222222-2222-4222-8222-222222222222",
          providerName: "OpenRouter Primary",
          providerType: "openrouter",
          currency: "USD",
          amount: "1.375000000000",
          eventCount: 4,
          lastReportedAt: reportedAt
        }]
      }
    });
    expect(calls).toHaveLength(3);
    expect(calls.slice(1).every((call) => call.values[0] === ownerUserId)).toBe(true);
    expect(calls[1]?.sql).toContain("WHERE owner_user_id = $1 AND status = 'active'");
    expect(calls[2]?.sql).toContain("WHERE costs.owner_user_id = $1");
  });

  it("does not represent missing provider cost reports as zero", async () => {
    const mockPool = {
      query: async (sql: string) => {
        if (sql.includes("system_key = 'initial-owner'")) return { rows: [{ id: ownerUserId }] };
        if (sql.includes("FROM provider_cost_events costs")) return { rows: [] };
        return {
          rows: [{
            available_worlds: 0,
            total_worlds: 0,
            draft_worlds: 0,
            archived_worlds: 0,
            published_worlds: 0,
            open_campaigns: 0,
            total_campaigns: 0,
            archived_campaigns: 0,
            accepted_turns: 0
          }]
        };
      }
    } as unknown as DatabasePool;

    const stats = await getDashboardStats(mockPool);

    expect(stats.providerCosts).toEqual({ hasReportedCosts: false, totals: [] });
    expect(JSON.stringify(stats.providerCosts)).not.toContain('"amount":"0"');
  });
});
