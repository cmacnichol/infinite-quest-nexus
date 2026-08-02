import { describe, expect, it } from "vitest";
import type { StoredGenerationSubmission } from "../../../packages/client-core/src/index.js";
import { createGenerationSubmissionCoordinator } from "../../../packages/client-core/src/generation/submission.js";
import {
  createPendingSubmissionStore
} from "../../../packages/client-web/src/storage/pending-submissions.js";
import type {
  PendingSubmissionStorage
} from "../../../packages/client-web/src/storage/pending-submissions.js";

const campaignId = "11111111-1111-4111-8111-111111111111";
const otherCampaignId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";
const classificationId = "44444444-4444-4444-8444-444444444444";
const providerProfileId = "55555555-5555-4555-8555-555555555555";

const append: StoredGenerationSubmission = {
  operationKind: "append",
  expectedTurnNumber: 3,
  createdAt: 123_456,
  request: {
    action: "Open the gate",
    requestedInputMode: "action",
    resolvedInputMode: "action",
    inputModeSource: "explicit",
    idempotencyKey: "append-key",
    context: { budgetTokens: 32000, compression: "auto", recentTurns: 8 }
  }
};

const replacement: StoredGenerationSubmission = {
  operationKind: "replace_latest",
  expectedTurnNumber: 7,
  createdAt: 234_567,
  jobId,
  request: {
    action: "Take the other path",
    requestedInputMode: "auto",
    resolvedInputMode: "scene",
    inputModeSource: "auto",
    classificationId,
    providerProfileId,
    model: "story-model",
    idempotencyKey: "replacement-key",
    expectedCurrentTurnNumber: 7,
    context: {
      budgetTokens: 64000,
      compression: "balanced",
      recentTurns: 12,
      modelContextWindowTokens: 131072
    }
  }
};

const { jobId: _replacementJobId, ...replacementWithoutJob } = replacement;
void _replacementJobId;

class MemoryStorage implements PendingSubmissionStorage {
  readonly values = new Map<string, string>();
  readonly removals: string[] = [];
  getError: Error | null = null;
  setError: Error | null = null;
  removeError: Error | null = null;
  setCalls = 0;

  getItem(key: string): string | null {
    if (this.getError) throw this.getError;
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.setCalls += 1;
    if (this.setError) throw this.setError;
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.removals.push(key);
    if (this.removeError) throw this.removeError;
    this.values.delete(key);
  }
}

function v2Key(id = campaignId): string {
  return `infiniteQuestPendingGeneration:v2:${encodeURIComponent(id)}`;
}

function legacyKey(id = campaignId): string {
  return `infiniteQuestPendingGeneration:${id}`;
}

describe("pending generation submission storage", () => {
  it.each([
    ["without a job ID", append],
    ["with a job ID", replacement]
  ])("round-trips a strict version-2 envelope %s", (_label, submission) => {
    const storage = new MemoryStorage();
    const store = createPendingSubmissionStore(storage);

    store.save(campaignId, submission);

    expect(JSON.parse(storage.values.get(v2Key()) ?? "null")).toEqual({ version: 2, submission });
    expect(store.load(campaignId)).toEqual(submission);
  });

  it("accepts and upgrades an unversioned nested record created before job IDs", () => {
    const storage = new MemoryStorage();
    storage.values.set(v2Key(), JSON.stringify(append));
    const store = createPendingSubmissionStore(storage);

    expect(store.load(campaignId)).toEqual(append);
    expect(JSON.parse(storage.values.get(v2Key()) ?? "null")).toEqual({ version: 2, submission: append });
  });

  it.each([
    ["append", append],
    ["replace_latest", replacementWithoutJob]
  ] as const)("migrates the flat legacy %s record without changing its idempotency key", (_kind, expected) => {
    const storage = new MemoryStorage();
    const legacy = {
      action: expected.request.action,
      requestedInputMode: expected.request.requestedInputMode,
      resolvedInputMode: expected.request.resolvedInputMode,
      inputModeSource: expected.request.inputModeSource,
      ...(expected.request.classificationId ? { classificationId: expected.request.classificationId } : {}),
      ...(expected.request.providerProfileId ? { providerProfileId: expected.request.providerProfileId } : {}),
      ...(expected.request.model ? { model: expected.request.model } : {}),
      idempotencyKey: expected.request.idempotencyKey,
      context: expected.request.context,
      operationKind: expected.operationKind,
      expectedTurnNumber: expected.expectedTurnNumber,
      createdAt: expected.createdAt
    };
    storage.values.set(legacyKey(), JSON.stringify(legacy));
    const store = createPendingSubmissionStore(storage);

    const loaded = store.load(campaignId);

    expect(loaded).toEqual(expected);
    expect(loaded?.request.idempotencyKey).toBe(expected.request.idempotencyKey);
    expect(JSON.parse(storage.values.get(v2Key()) ?? "null")).toEqual({ version: 2, submission: expected });
    expect(storage.values.has(legacyKey())).toBe(false);
  });

  it.each([
    ["invalid JSON", "{"],
    ["wrong version", JSON.stringify({ version: 3, submission: append })],
    ["schema failure", JSON.stringify({ version: 2, submission: { ...append, createdAt: -1 } })],
    ["inconsistent replacement turns", JSON.stringify({
      version: 2,
      submission: { ...replacement, expectedTurnNumber: 6 }
    })]
  ])("returns null and cleans up a v2 record with %s", (_label, raw) => {
    const storage = new MemoryStorage();
    storage.values.set(v2Key(), raw);
    const store = createPendingSubmissionStore(storage);

    expect(store.load(campaignId)).toBeNull();
    expect(storage.values.has(v2Key())).toBe(false);
  });

  it("rejects and cleans a malformed flat legacy record", () => {
    const storage = new MemoryStorage();
    storage.values.set(legacyKey(), JSON.stringify({
      action: "Open the gate",
      operationKind: "replace_latest",
      expectedTurnNumber: 0,
      idempotencyKey: "legacy-key",
      createdAt: 100
    }));
    const store = createPendingSubmissionStore(storage);

    expect(store.load(campaignId)).toBeNull();
    expect(storage.values.has(legacyKey())).toBe(false);
  });

  it("isolates campaign keys including reserved URL characters", () => {
    const storage = new MemoryStorage();
    const store = createPendingSubmissionStore(storage);
    store.save("campaign/one?", append);
    store.save(otherCampaignId, replacement);

    expect(storage.values.has(v2Key("campaign/one?"))).toBe(true);
    expect(store.load("campaign/one?")).toEqual(append);
    expect(store.load(otherCampaignId)).toEqual(replacement);
    expect(store.load(campaignId)).toBeNull();
  });

  it("propagates save failure so enqueue never starts", async () => {
    const storage = new MemoryStorage();
    const quotaError = new DOMException("Quota exceeded", "QuotaExceededError");
    storage.setError = quotaError;
    const store = createPendingSubmissionStore(storage);
    let enqueueCalls = 0;
    const coordinator = createGenerationSubmissionCoordinator({
      api: {
        enqueue: async () => {
          enqueueCalls += 1;
          return { id: jobId, status: "queued", duplicate: false };
        },
        enqueueReplacement: async () => {
          throw new Error("Unexpected replacement enqueue.");
        }
      },
      clock: { now: () => append.createdAt },
      store
    });

    await expect(coordinator.submit(campaignId, {
      operationKind: "append",
      expectedTurnNumber: append.expectedTurnNumber,
      request: append.request
    })).rejects.toBe(quotaError);
    expect(enqueueCalls).toBe(0);
  });

  it("leaves the first exact envelope replayable when the job-ID save fails", async () => {
    const storage = new MemoryStorage();
    const quotaError = new DOMException("Quota exceeded", "QuotaExceededError");
    const originalSet = storage.setItem.bind(storage);
    storage.setItem = (key, value) => {
      if (storage.setCalls === 1) throw quotaError;
      originalSet(key, value);
    };
    const store = createPendingSubmissionStore(storage);
    const coordinator = createGenerationSubmissionCoordinator({
      api: {
        enqueue: async () => ({ id: jobId, status: "queued", duplicate: false }),
        enqueueReplacement: async () => {
          throw new Error("Unexpected replacement enqueue.");
        }
      },
      clock: { now: () => append.createdAt },
      store
    });

    await expect(coordinator.submit(campaignId, {
      operationKind: "append",
      expectedTurnNumber: append.expectedTurnNumber,
      request: append.request
    })).rejects.toBe(quotaError);
    expect(store.load(campaignId)).toEqual(append);
  });

  it("treats inaccessible reads as absent and makes cleanup non-throwing", () => {
    const storage = new MemoryStorage();
    storage.getError = new DOMException("Blocked", "SecurityError");
    storage.removeError = new DOMException("Blocked", "SecurityError");
    const store = createPendingSubmissionStore(storage);

    expect(store.load(campaignId)).toBeNull();
    expect(() => store.clear(campaignId)).not.toThrow();
    expect(storage.removals).toEqual([v2Key(), legacyKey()]);
  });

  it("swallows corrupt cleanup and migration-write failures while returning safe data", () => {
    const corruptStorage = new MemoryStorage();
    corruptStorage.values.set(v2Key(), "{");
    corruptStorage.removeError = new DOMException("Blocked", "SecurityError");
    expect(createPendingSubmissionStore(corruptStorage).load(campaignId)).toBeNull();

    const migrationStorage = new MemoryStorage();
    migrationStorage.values.set(legacyKey(), JSON.stringify({
      action: append.request.action,
      requestedInputMode: append.request.requestedInputMode,
      resolvedInputMode: append.request.resolvedInputMode,
      inputModeSource: append.request.inputModeSource,
      idempotencyKey: append.request.idempotencyKey,
      context: append.request.context,
      operationKind: append.operationKind,
      expectedTurnNumber: append.expectedTurnNumber,
      createdAt: append.createdAt
    }));
    migrationStorage.setError = new DOMException("Quota exceeded", "QuotaExceededError");
    expect(createPendingSubmissionStore(migrationStorage).load(campaignId)).toEqual(append);
  });
});
