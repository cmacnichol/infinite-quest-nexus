import { describe, expect, it } from "vitest";
import type { DatabasePool } from "../../packages/database/src/pool.js";
import { loadCampaignArchiveExportSnapshot } from "../../packages/database/src/campaign-archive-export-repository.js";

describe("campaign archive export repository", () => {
  it("serializes snapshot queries on its single transactional client", async () => {
    let activeQueries = 0;
    let maximumConcurrentQueries = 0;

    const client = {
      async query(sql: string) {
        activeQueries += 1;
        maximumConcurrentQueries = Math.max(maximumConcurrentQueries, activeQueries);
        try {
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (sql.includes("FROM campaigns c JOIN world_versions")) {
            return {
              rows: [{
                id: "campaign-1",
                world_id: "world-1",
                world_version_id: "world-version-1",
                active_turn_number: 0,
                state_revision: 0,
                revision: 0,
                version_number: 1,
                content: {},
              }],
            };
          }
          return { rows: [] };
        } finally {
          activeQueries -= 1;
        }
      },
      release() {},
    };
    const pool = {
      async connect() {
        return client;
      },
    } as unknown as DatabasePool;

    const snapshot = await loadCampaignArchiveExportSnapshot(pool, "owner-1", "campaign-1");

    expect(snapshot.assets.records).toEqual([]);
    expect(maximumConcurrentQueries).toBe(1);
  });
});
