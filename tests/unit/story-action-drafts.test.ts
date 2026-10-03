import { beforeEach, describe, expect, it } from "vitest";
import {
  createStoryActionDraftStore,
  type Draft,
  type DraftDatabasePort,
  type DraftDatabaseTransaction,
  type DraftScope
} from "../../packages/client-web/src/storage/story-action-drafts.js";

const USER_A = "4d7c311a-ecf2-4eeb-8c27-1aaaf13af931";
const USER_B = "9bd62729-9640-42be-9bdc-c2f48a26ad0b";
const CAMPAIGN_A = "53675828-1fb0-42ef-aaf1-33e5e4885586";
const CAMPAIGN_B = "c7cd5f73-e73c-44f4-806b-faa237e971a0";
const DAY_MS = 24 * 60 * 60 * 1000;

class MemoryDraftDatabase implements DraftDatabasePort {
  private records = new Map<string, unknown>();
  private queue: Promise<void> = Promise.resolve();
  failNext: unknown = null;

  async transaction<T>(operation: (transaction: DraftDatabaseTransaction) => T): Promise<T> {
    const previous = this.queue;
    let release = () => {};
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (this.failNext !== null) {
        const failure = this.failNext;
        this.failNext = null;
        throw failure;
      }
      const staged = new Map(this.records);
      const result = operation({
        entries: () => [...staged.entries()],
        get: (key) => staged.get(key),
        put: (key, value) => { staged.set(key, value); },
        delete: (key) => { staged.delete(key); }
      });
      this.records = staged;
      return result;
    } finally {
      release();
    }
  }
}

let nowMs: number;
let database: MemoryDraftDatabase;
let store: ReturnType<typeof createStoryActionDraftStore>;
let id = 0;

function scope(userId = USER_A, campaignId = CAMPAIGN_A): DraftScope {
  return { userId, campaignId };
}

async function seedDraft(draftScope: DraftScope, draft: Draft): Promise<void> {
  const key = `draft:${draftScope.userId}:${draftScope.campaignId}`;
  await database.transaction((transaction) => transaction.put(key, JSON.stringify({
    schemaVersion: 1,
    userId: draftScope.userId,
    campaignId: draftScope.campaignId,
    draft
  })));
}

function input(text: string, updatedAt = new Date(nowMs).toISOString()): Draft {
  return {
    schemaVersion: 1,
    draftRevision: "00000000-0000-4000-8000-999999999999",
    text,
    inputMode: "action",
    baseTurnId: null,
    baseTurnNumber: 0,
    updatedAt
  };
}

function makeStore(): void {
  store = createStoryActionDraftStore(database, () => new Date(nowMs), () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`);
}

beforeEach(() => {
  nowMs = Date.parse("2026-10-03T12:00:00.000Z");
  database = new MemoryDraftDatabase();
  id = 0;
  makeStore();
});

describe("story action draft storage", () => {
  it("isolates user and campaign scopes", async () => {
    await store.write(scope(), input("First"), { expectedRevision: null });
    await store.write(scope(USER_A, CAMPAIGN_B), input("Second"), { expectedRevision: null });
    await store.write(scope(USER_B, CAMPAIGN_A), input("Third"), { expectedRevision: null });

    expect((await store.read(scope()))?.text).toBe("First");
    expect((await store.read(scope(USER_A, CAMPAIGN_B)))?.text).toBe("Second");
    expect((await store.read(scope(USER_B, CAMPAIGN_A)))?.text).toBe("Third");
  });

  it("serializes revision comparison and write so a stale tab cannot overwrite the newer draft", async () => {
    const initial = await store.write(scope(), input("First"), { expectedRevision: null });
    if (initial.outcome !== "saved" || initial.currentRevision === undefined) throw new Error("Initial save failed.");
    const [left, right] = await Promise.all([
      store.write(scope(), input("Left"), { expectedRevision: initial.currentRevision }),
      store.write(scope(), input("Right"), { expectedRevision: initial.currentRevision })
    ]);

    expect([left.outcome, right.outcome].sort()).toEqual(["conflict", "saved"]);
    const saved = left.outcome === "saved" ? left : right.outcome === "saved" ? right : null;
    const conflict = left.outcome === "conflict" ? left : right.outcome === "conflict" ? right : null;
    expect(saved?.currentRevision).toBeTruthy();
    expect(conflict?.currentRevision).toBe(saved?.currentRevision);
    expect(["Left", "Right"]).toContain((await store.read(scope()))?.text);
  });

  it("conditionally clears only the matching revision even when text is unchanged", async () => {
    const first = await store.write(scope(), input("Same text"), { expectedRevision: null });
    if (first.outcome !== "saved" || first.currentRevision === undefined) throw new Error("Initial save failed.");
    const second = await store.write(scope(), input("Same text"), { expectedRevision: first.currentRevision });
    if (second.outcome !== "saved" || second.currentRevision === undefined) throw new Error("Replacement save failed.");

    expect(second.currentRevision).not.toBe(first.currentRevision);
    expect(await store.removeIfRevision(scope(), first.currentRevision)).toEqual({ outcome: "conflict" });
    expect((await store.read(scope()))?.text).toBe("Same text");
  });

  it("ignores corrupt JSON without throwing and removes only that corrupt slot", async () => {
    await database.transaction((transaction) => transaction.put("draft:" + USER_A + ":" + CAMPAIGN_A, "{"));

    await expect(store.read(scope())).resolves.toBeNull();
    expect(await store.write(scope(), input("Recovered"), { expectedRevision: null })).toMatchObject({ outcome: "saved" });
  });

  it("ignores unknown versions without overwriting the forward-compatible record", async () => {
    const key = "draft:" + USER_A + ":" + CAMPAIGN_A;
    const futureRecord = JSON.stringify({ schemaVersion: 9, text: "future data" });
    await database.transaction((transaction) => transaction.put(key, futureRecord));

    await expect(store.read(scope())).resolves.toBeNull();
    expect(await store.write(scope(), input("Current data"), { expectedRevision: null })).toMatchObject({ outcome: "conflict" });
    const retained = await database.transaction((transaction) => transaction.get(key));
    expect(retained).toBe(futureRecord);
  });

  it("maps quota failures and leaves the current record intact", async () => {
    const initial = await store.write(scope(), input("Keep me"), { expectedRevision: null });
    if (initial.outcome !== "saved" || initial.currentRevision === undefined) throw new Error("Initial save failed.");
    database.failNext = new DOMException("Quota exceeded", "QuotaExceededError");

    expect(await store.write(scope(), input("Replacement"), { expectedRevision: initial.currentRevision })).toMatchObject({ outcome: "quota" });
    expect((await store.read(scope()))?.text).toBe("Keep me");
  });

  it("prunes expired prose and exposes a scoped expiry notice without the expired text", async () => {
    const old = new Date(nowMs - 31 * DAY_MS).toISOString();
    await seedDraft(scope(), { ...input("expired secret prose", old), updatedAt: old });
    nowMs += 1;

    expect(await store.read(scope())).toBeNull();
    expect(await store.readExpiryNotice(scope())).toBe(true);
    expect(await store.readExpiryNotice(scope(USER_A, CAMPAIGN_B))).toBe(false);
    const values = await database.transaction((transaction) => transaction.entries().map(([, value]) => String(value)));
    expect(values.join(" ")).not.toContain("expired secret prose");
  });

  it("protects the active write target while pruning other expired records", async () => {
    const old = new Date(nowMs - 31 * DAY_MS).toISOString();
    const protectedScope = scope(USER_A, "20000000-0000-4000-8000-000000000001");
    const protectedDraft = { ...input("active unsent text", old), draftRevision: "20000000-0000-4000-8000-000000000001", updatedAt: old };
    const expiredOtherScope = scope(USER_A, "20000000-0000-4000-8000-000000000002");
    await seedDraft(protectedScope, protectedDraft);
    await seedDraft(expiredOtherScope, { ...input("expired other text", old), draftRevision: "20000000-0000-4000-8000-000000000002", updatedAt: old });

    const result = await store.write(protectedScope, input("refreshed unsent text"), { expectedRevision: protectedDraft.draftRevision });

    expect(result.outcome).toBe("saved");
    expect((await store.read(protectedScope))?.text).toBe("refreshed unsent text");
    expect(await store.readExpiryNotice(protectedScope)).toBe(false);
    expect(await store.readExpiryNotice(expiredOtherScope)).toBe(true);
  });
  it("does not evict unexpired drafts when the per-user capacity is full", async () => {
    for (let index = 0; index < 50; index += 1) {
      const campaignId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
      expect((await store.write(scope(USER_A, campaignId), input(`draft ${index}`), { expectedRevision: null })).outcome).toBe("saved");
    }
    const result = await store.write(scope(USER_A, "00000000-0000-4000-8000-000000000051"), input("must remain unsaved"), { expectedRevision: null });

    expect(result).toEqual({ outcome: "capacity" });
    expect(await store.read(scope(USER_A, "00000000-0000-4000-8000-000000000001"))).not.toBeNull();
  });

  it("enforces the 12,000 character limit and rejects malformed scopes", async () => {
    expect((await store.write(scope(), input("x".repeat(12_001)), { expectedRevision: null })).outcome).toBe("invalid");
    expect((await store.write({ ...scope(), campaignId: "not-a-uuid" }, input("valid scope fails"), { expectedRevision: null })).outcome).toBe("invalid");
  });

  it("bounds expiry notices to 50 globally and 30 days", async () => {
    for (let index = 0; index < 51; index += 1) {
      const campaignId = `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
      const old = new Date(nowMs - 31 * DAY_MS).toISOString();
      await seedDraft(scope(USER_A, campaignId), { ...input(`expired ${index}`, old), updatedAt: old });
      await store.read(scope(USER_A, campaignId));
    }
    expect(await store.readExpiryNotice(scope(USER_A, "10000000-0000-4000-8000-000000000001"))).toBe(false);
    expect(await store.readExpiryNotice(scope(USER_A, "10000000-0000-4000-8000-000000000051"))).toBe(true);
    nowMs += 31 * DAY_MS;
    expect(await store.readExpiryNotice(scope(USER_A, "10000000-0000-4000-8000-000000000051"))).toBe(false);
  });

  it("reports IndexedDB unavailability without a storage fallback", async () => {
    database.failNext = new DOMException("Denied", "SecurityError");

    expect(await store.write(scope(), input("unsaved"), { expectedRevision: null })).toEqual({ outcome: "unavailable" });
    expect(await store.read(scope())).toBeNull();
  });
});
