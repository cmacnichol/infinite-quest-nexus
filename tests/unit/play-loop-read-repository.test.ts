import { describe, expect, it } from "vitest";
import type { DatabasePool } from "../../packages/database/src/pool.js";
import { readTurnPage } from "../../packages/database/src/play-loop-read-repository.js";

const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";
const FIRST_ID = "22222222-2222-4222-8222-222222222222";
const LATEST_ID = "33333333-3333-4333-8333-333333333333";
const REPLACED_LATEST_ID = "44444444-4444-4444-8444-444444444444";

function turn(id: string, turnNumber: number) {
  return {
    id,
    turnNumber,
    action: "Act",
    inputMode: "action",
    inputModeSource: "explicit",
    narration: "Narration",
    choices: [],
    customActionSuggestion: "Continue",
    imagePrompt: "",
    imageUrl: null,
    acceptedAt: "2026-08-03T00:00:00.000Z"
  };
}

describe("play-loop turn pages", () => {
  it("fingerprints long histories without aggregating every turn id", async () => {
    const statements: string[] = [];
    const query = async (statement: unknown) => {
      const sql = String(statement);
      statements.push(sql);
      if (sql.includes("historyVersion")) return { rows: [{ historyVersion: `2:2:${LATEST_ID}` }] };
      return { rows: [turn(LATEST_ID, 2), turn(FIRST_ID, 1)] };
    };
    const pool = {
      connect: async () => ({ query, release: () => undefined })
    } as unknown as DatabasePool;

    await readTurnPage(pool, OWNER_ID, CAMPAIGN_ID, undefined, 50);

    const fingerprint = statements.find((statement) => statement.includes("historyVersion"));
    expect(fingerprint).toContain("ORDER BY latest_turn.turn_number DESC, latest_turn.id DESC");
    expect(fingerprint).toContain("LIMIT 1");
    expect(fingerprint).not.toContain("ARRAY_AGG");
    expect(fingerprint).toContain("turn_narration_corrections");
    const pageQuery = statements.find((statement) => statement.includes("effective_turn_narrations"));
    expect(pageQuery).toContain("effective.effective_narration AS narration");
  });

  it("rejects a cursor after retry-latest replaces the current history boundary", async () => {
    let latestId = LATEST_ID;
    const query = async (statement: unknown) => {
      const sql = String(statement);
      if (sql.includes("historyVersion")) {
        return { rows: [{ historyVersion: `2:2:${latestId}` }] };
      }
      return { rows: [turn(LATEST_ID, 2), turn(FIRST_ID, 1)] };
    };
    const pool = {
      connect: async () => ({ query, release: () => undefined })
    } as unknown as DatabasePool;

    const firstPage = await readTurnPage(pool, OWNER_ID, CAMPAIGN_ID, undefined, 1);
    expect(firstPage.nextCursor).not.toBeNull();

    latestId = REPLACED_LATEST_ID;
    await expect(readTurnPage(pool, OWNER_ID, CAMPAIGN_ID, firstPage.nextCursor || undefined, 1))
      .rejects.toMatchObject({ statusCode: 409 });
  });
});
