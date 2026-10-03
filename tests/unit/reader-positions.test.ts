import { describe, expect, it } from "vitest";
import {
  createReaderPositionStore,
  type ReaderPositionDatabasePort,
  type ReaderPositionScope
} from "../../packages/client-web/src/storage/reader-positions.js";

const userId = "11111111-1111-4111-8111-111111111111";
const otherUserId = "22222222-2222-4222-8222-222222222222";
const campaignId = "33333333-3333-4333-8333-333333333333";
const otherCampaignId = "44444444-4444-4444-8444-444444444444";
const turnId = "55555555-5555-4555-8555-555555555555";
const scope: ReaderPositionScope = { userId, campaignId };

function memoryDatabase(): ReaderPositionDatabasePort & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    read: async (key) => values.get(key),
    write: async (key, value) => { values.set(key, value); }
  };
}

describe("reader position storage", () => {
  it("stores an accepted turn identity and clamps the normalized offset", async () => {
    const database = memoryDatabase();
    const store = createReaderPositionStore(database, () => new Date("2026-10-03T12:00:00.000Z"));

    await expect(store.write(scope, { turnId, turnNumber: 12, offsetRatio: 1.7 })).resolves.toBe("saved");
    await expect(store.read(scope)).resolves.toEqual({
      schemaVersion: 1,
      turnId,
      turnNumber: 12,
      offsetRatio: 1,
      updatedAt: "2026-10-03T12:00:00.000Z"
    });

    await store.write(scope, { turnId, turnNumber: 12, offsetRatio: -0.2 });
    await expect(store.read(scope)).resolves.toMatchObject({ offsetRatio: 0 });
  });

  it("isolates records by both server-resolved user and campaign", async () => {
    const database = memoryDatabase();
    const store = createReaderPositionStore(database);
    await store.write(scope, { turnId, turnNumber: 12, offsetRatio: 0.5 });

    await expect(store.read({ userId, campaignId: otherCampaignId })).resolves.toBeNull();
    await expect(store.read({ userId: otherUserId, campaignId })).resolves.toBeNull();
    expect(database.values.size).toBe(1);
  });

  it("ignores corrupt, unknown-version, and mismatched-scope records", async () => {
    const database = memoryDatabase();
    const store = createReaderPositionStore(database);
    const key = `${userId}:${campaignId}`;
    const validPosition = {
      schemaVersion: 1,
      turnId,
      turnNumber: 12,
      offsetRatio: 0.5,
      updatedAt: "2026-10-03T12:00:00.000Z"
    };
    database.values.set(key, { schemaVersion: 1, userId: otherUserId, campaignId, position: validPosition });
    await expect(store.read(scope)).resolves.toBeNull();
    database.values.set(key, { schemaVersion: 1, userId, campaignId, position: {} });
    await expect(store.read(scope)).resolves.toBeNull();
    database.values.set(key, { schemaVersion: 2, userId, campaignId, position: validPosition });
    await expect(store.read(scope)).resolves.toBeNull();
    database.values.set(key, "not-json");
    await expect(store.read(scope)).resolves.toBeNull();
  });

  it("treats storage failure as unavailable without throwing", async () => {
    const database: ReaderPositionDatabasePort = {
      read: async () => { throw new Error("blocked"); },
      write: async () => { throw new Error("quota"); }
    };
    const store = createReaderPositionStore(database);

    await expect(store.read(scope)).resolves.toBeNull();
    await expect(store.write(scope, { turnId, turnNumber: 12, offsetRatio: 0.5 })).resolves.toBe("unavailable");
  });

  it("rejects non-finite offsets and invalid accepted-turn identities", async () => {
    const database = memoryDatabase();
    const store = createReaderPositionStore(database);

    await expect(store.write(scope, { turnId: "not-a-uuid", turnNumber: 12, offsetRatio: 0.5 })).resolves.toBe("invalid");
    await expect(store.write(scope, { turnId, turnNumber: 0, offsetRatio: 0.5 })).resolves.toBe("invalid");
    await expect(store.write(scope, { turnId, turnNumber: 12, offsetRatio: Number.NaN })).resolves.toBe("invalid");
    expect(database.values.size).toBe(0);
    expect(database.values.has(`${userId}:${campaignId}`)).toBe(false);
    expect(database.values.has(`${userId}:${otherCampaignId}`)).toBe(false);
  });
});
