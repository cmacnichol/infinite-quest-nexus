import { describe, expect, it, vi } from "vitest";
import { createWorldShareLinkService } from "../../packages/database/src/world-share-repository.js";

describe("world share links", () => {
  it("returns the bearer token once while persisting only its hash", async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const pool = {
      async query(text: string, values?: readonly unknown[]) {
        queries.push({ text, ...(values === undefined ? {} : { values }) });
        if (text.includes("FROM world_versions")) return { rowCount: 1, rows: [{ title: "Shared World" }] };
        return { rowCount: 1, rows: [{ id: "11111111-1111-4111-8111-111111111111", expires_at: "2030-01-02T00:00:00.000Z" }] };
      }
    };

    const service = createWorldShareLinkService(pool as never, { randomBytes: () => Buffer.alloc(32, 7) });
    const created = await service.create({
      ownerUserId: "22222222-2222-4222-8222-222222222222",
      worldId: "33333333-3333-4333-8333-333333333333",
      worldVersionId: "44444444-4444-4444-8444-444444444444",
      expiresAt: new Date("2030-01-02T00:00:00.000Z")
    });

    expect(created).not.toBeNull();
    expect(created!.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const insert = queries.find((query) => query.text.includes("INSERT INTO world_share_links"));
    expect(insert?.values).not.toContain(created!.token);
    expect(String(insert?.values?.[4])).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("redeems only the hashed token into a portable published world", async () => {
    const calls: Array<readonly unknown[] | undefined> = [];
    const query = vi.fn(async (_text: string, values?: readonly unknown[]) => {
      calls.push(values);
      return { rows: [{
      id: "11111111-1111-4111-8111-111111111111",
      title: "Shared World",
      content: { schemaVersion: 1, world: { title: "Shared World", premise: "", genre: "", tone: "", setting: "", rules: "" }, entities: [], relationships: [], playableCharacters: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], locationTemplates: [], customFields: [], defaults: {} }
      }], rowCount: 1 };
    });
    const service = createWorldShareLinkService({ query } as never);

    const redeemed = await service.redeem("a".repeat(43));

    expect(calls[0]?.[0]).toMatch(/^[a-f0-9]{64}$/u);
    expect(calls[0]?.[0]).not.toBe("a".repeat(43));
    expect(redeemed?.worldExport).toMatchObject({ format: "infinite-quest-world", formatVersion: 1, title: "Shared World" });
  });
});
