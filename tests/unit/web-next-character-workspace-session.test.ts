import { describe, expect, it } from "vitest";
import type { PlayableCharacter } from "../../packages/contracts/src/world-library.js";
import type { EditableWorldDraft } from "../../apps/web-next/src/world-editor-model.js";
import {
  characterSessionKeyFromPath,
  characterWorkspacePath,
  createCharacterWorkspaceSessionStore
} from "../../apps/web-next/src/character-workspace-session.js";

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  readonly failingRemovals = new Set<string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    if (this.failingRemovals.has(key)) throw new Error("remove failed");
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const NOW = 1_000_000;
const draft = (): EditableWorldDraft => ({
  schemaVersion: 1,
  world: {
    title: "Glass Harbor",
    genre: "Fantasy",
    tone: "Hopeful",
    premise: "A city learns to float.",
    backgroundStory: "Old foundations are failing.",
    firstAction: "Inspect the tide engines.",
    rules: "Promises have weight."
  },
  playableCharacters: [],
  entities: [],
  relationships: [],
  rpgStats: [],
  defaultTriggers: [],
  eventTriggers: [],
  assets: [],
  defaults: {}
});
const candidate = (extra: Record<string, unknown> = {}): PlayableCharacter => ({
  id: "mara",
  name: "Mara",
  characterText: "A patient observer.",
  rpgStats: [],
  defaultTriggers: [],
  source: {},
  ...extra
});

function jsonWithExactUtf8Bytes(
  value: Record<string, unknown>,
  paddingTarget: Record<string, unknown>,
  bytes: number
): string {
  paddingTarget.multibyteLore = "";
  const baseBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const remaining = bytes - baseBytes;
  if (remaining < 0) throw new Error("Fixture exceeds requested size.");
  paddingTarget.multibyteLore = `${remaining % 2 === 0 ? "" : "x"}${"é".repeat(Math.floor(remaining / 2))}`;
  const serialized = JSON.stringify(value);
  expect(new TextEncoder().encode(serialized)).toHaveLength(bytes);
  return serialized;
}

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    origin: "world-creation" as const,
    mode: "create" as const,
    workflowId: "workflow-1",
    parentRoute: "/app/worlds/new",
    expectedWorldRevision: null,
    parentDraft: draft(),
    worldContext: draft(),
    rosterSummaries: [{ id: "existing", name: "Existing" }],
    candidate: null,
    ...overrides
  };
}

describe("character workspace session store", () => {
  it("encodes and decodes one opaque route segment", () => {
    expect(characterWorkspacePath("opaque / key")).toBe("/app/characters/opaque%20%2F%20key");
    expect(characterSessionKeyFromPath("/app/characters/opaque%20%2F%20key")).toBe("opaque / key");
    expect(characterSessionKeyFromPath("/app/characters/opaque/key")).toBeNull();
    expect(characterSessionKeyFromPath("/app/characters/%E0%A4%A")).toBeNull();
    expect(characterSessionKeyFromPath("/app/characters/")).toBeNull();
  });

  it("creates an opaque session with an exact 30-minute lifetime", () => {
    const storage = new MemoryStorage();
    const store = createCharacterWorkspaceSessionStore(storage, {
      now: () => NOW,
      keyFactory: () => "opaque-key"
    });

    const session = store.create(createInput());

    expect(session).toMatchObject({
      version: 1,
      key: "opaque-key",
      workflowId: "workflow-1",
      expiresAt: NOW + 30 * 60 * 1000
    });
    expect([...storage.values.keys()].sort()).toEqual([
      "iqn:character-workspace:return:opaque-key",
      "iqn:character-workspace:session:opaque-key"
    ]);
    expect(store.load("opaque-key")).toEqual(session);
  });

  it("accepts an exact 512 KiB multibyte session and rejects one byte beyond it before parsing", () => {
    const storage = new MemoryStorage();
    const store = createCharacterWorkspaceSessionStore(storage, {
      now: () => NOW,
      keyFactory: () => "bounded"
    });
    const session = store.create(createInput());
    const sessionKey = `iqn:character-workspace:session:${session.key}`;
    const exactParentDraft = { ...session.parentDraft };
    const exactRecord = { ...session, parentDraft: exactParentDraft };
    const exact = jsonWithExactUtf8Bytes(exactRecord, exactParentDraft, 512 * 1024);

    storage.setItem(sessionKey, exact);
    expect(store.load(session.key)?.parentDraft).toMatchObject({ multibyteLore: expect.stringContaining("é") });

    storage.setItem(sessionKey, `${exact} `);
    expect(store.load(session.key)).toBeNull();
    expect(storage.getItem(sessionKey)).toBeNull();
  });

  it("rejects oversized raw session, result, and tombstone records injected directly into storage", () => {
    const storage = new MemoryStorage();
    const store = createCharacterWorkspaceSessionStore(storage, {
      now: () => NOW,
      keyFactory: () => "raw-bounds"
    });
    const session = store.create(createInput());
    const oversizedPadding = " ".repeat(512 * 1024);
    const sessionKey = `iqn:character-workspace:session:${session.key}`;
    const resultKey = `iqn:character-workspace:result:${session.key}`;
    const returnKey = `iqn:character-workspace:return:${session.key}`;

    storage.setItem(resultKey, `${JSON.stringify({
      version: 1,
      key: session.key,
      workflowId: session.workflowId,
      expiresAt: session.expiresAt,
      result: { status: "cancelled" }
    })}${oversizedPadding}`);
    expect(store.consume(session.key, session.origin, session.workflowId)).toBeNull();

    storage.setItem(returnKey, `${storage.getItem(returnKey)}${oversizedPadding}`);
    expect(store.returnPath(session.key)).toBeNull();

    storage.setItem(sessionKey, `${JSON.stringify(session)}${oversizedPadding}`);
    expect(store.load(session.key)).toBeNull();
  });

  it("rejects oversized created records without leaving partial storage", () => {
    const storage = new MemoryStorage();
    const store = createCharacterWorkspaceSessionStore(storage, {
      now: () => NOW,
      keyFactory: () => "oversized"
    });

    expect(() => store.create(createInput({
      parentDraft: { ...draft(), largeLore: "x".repeat(512 * 1024) }
    }))).toThrow(/512 KiB/);
    expect(storage.length).toBe(0);
  });

  it("expires sessions and rejects malformed decoded records", () => {
    let now = NOW;
    const storage = new MemoryStorage();
    const store = createCharacterWorkspaceSessionStore(storage, {
      now: () => now,
      keyFactory: () => "expiring"
    });
    const session = store.create(createInput());

    storage.setItem("iqn:character-workspace:session:malformed", JSON.stringify({
      ...session,
      key: "different-key"
    }));
    expect(store.load("malformed")).toBeNull();

    storage.setItem("iqn:character-workspace:session:expiring", JSON.stringify({
      ...session,
      credential: "must-not-hitchhike"
    }));
    expect(store.load("expiring")).toBeNull();
    storage.setItem("iqn:character-workspace:session:expiring", JSON.stringify(session));

    now = session.expiresAt;
    expect(store.load(session.key)).toBeNull();
    expect(store.complete(session.key, session.workflowId, { status: "cancelled" })).toBe(false);
  });

  it("recovers a safe return path from a tombstone when the session is genuinely missing", () => {
    const storage = new MemoryStorage();
    const store = createCharacterWorkspaceSessionStore(storage, {
      now: () => NOW,
      keyFactory: () => "missing"
    });
    const session = store.create(createInput());

    storage.removeItem(`iqn:character-workspace:session:${session.key}`);

    expect(store.load(session.key)).toBeNull();
    expect(store.returnPath(session.key)).toBe("/app/worlds/new");
  });

  it("retains only a validated same-origin return tombstone when the session is malformed", () => {
    const storage = new MemoryStorage();
    const store = createCharacterWorkspaceSessionStore(storage, {
      now: () => NOW,
      keyFactory: () => "recoverable"
    });
    store.create(createInput());
    storage.setItem("iqn:character-workspace:session:recoverable", "{");

    expect(store.load("recoverable")).toBeNull();
    expect(store.returnPath("recoverable")).toBe("/app/worlds/new");

    storage.setItem("iqn:character-workspace:return:recoverable", JSON.stringify({
      version: 1,
      key: "recoverable",
      parentRoute: "https://attacker.example/steal",
      expiresAt: NOW + 10_000
    }));
    expect(store.returnPath("recoverable")).toBeNull();
  });

  it("recursively strips identity and secret-shaped fields while retaining safe unknown lore", () => {
    const storage = new MemoryStorage();
    const store = createCharacterWorkspaceSessionStore(storage, {
      now: () => NOW,
      keyFactory: () => "owner-safe"
    });
    const unsafeDraft = {
      ...draft(),
      ownerUserId: "root-owner",
      credential: "root-credential",
      world: {
        ...draft().world,
        owner_user_id: "nested-owner",
        loreExtension: {
          keep: "safe lore",
          secretary: "records the council's safe lore",
          tokenizer: "splits ancient runes",
          passwordlessSociety: "trusts spoken oaths",
          accessToken: "token",
          client_secret: "secret",
          databasePassword: "password",
          "api-key": "api key",
          credentials: ["credential"]
        }
      },
      playableCharacters: [candidate({ user_id: "character-owner", credentials: ["credential"] })]
    } as EditableWorldDraft;

    const session = store.create(createInput({
      parentDraft: unsafeDraft,
      worldContext: unsafeDraft,
      candidate: candidate({
        userId: "candidate-owner",
        auth_token: "candidate-token",
        safeExtension: { keep: true, apiKey: "nested-api-key" }
      }),
      rosterSummaries: [{ id: "existing", name: "Existing", owner_user_id: "summary-owner" }]
    }));
    const serialized = JSON.stringify(session);

    expect(serialized).not.toMatch(
      /ownerUserId|owner_user_id|userId|user_id|credential|accessToken|client_secret|databasePassword|api-key|auth_token|apiKey/u
    );
    expect(session.parentDraft).toMatchObject({
      world: {
        loreExtension: {
          keep: "safe lore",
          secretary: "records the council's safe lore",
          tokenizer: "splits ancient runes",
          passwordlessSociety: "trusts spoken oaths"
        }
      }
    });
    expect(session.candidate).toMatchObject({ safeExtension: { keep: true } });
  });

  it("isolates completion and consumption by workflow and origin", () => {
    const storage = new MemoryStorage();
    const store = createCharacterWorkspaceSessionStore(storage, {
      now: () => NOW,
      keyFactory: () => "isolated"
    });
    const session = store.create(createInput());
    const accepted = { status: "accepted" as const, candidate: candidate() };

    expect(store.complete(session.key, "wrong-workflow", accepted)).toBe(false);
    expect(store.complete(session.key, session.workflowId, accepted)).toBe(true);
    expect(store.complete(session.key, session.workflowId, { status: "cancelled" })).toBe(false);
    expect(store.peek(session.key, "world-editor", session.workflowId)).toBeNull();
    expect(store.peek(session.key, "world-creation", "wrong-workflow")).toBeNull();
    expect(store.peek(session.key, "world-creation", session.workflowId)).toEqual({
      status: "ready",
      session,
      result: accepted
    });
    expect(store.peek(session.key, "world-creation", session.workflowId)).toEqual({
      status: "ready",
      session,
      result: accepted
    });

    expect(store.consume(session.key, "world-creation", session.workflowId)).toEqual({
      session,
      result: accepted
    });
    expect(store.consume(session.key, "world-creation", session.workflowId)).toBeNull();
    expect(storage.length).toBe(0);
  });

  it("resets only an invalid matching result and accepts one valid replacement exactly once", () => {
    const storage = new MemoryStorage();
    const store = createCharacterWorkspaceSessionStore(storage, {
      now: () => NOW,
      keyFactory: () => "invalid-reset"
    });
    const session = store.create(createInput());
    const sessionKey = `iqn:character-workspace:session:${session.key}`;
    const returnKey = `iqn:character-workspace:return:${session.key}`;
    const resultKey = `iqn:character-workspace:result:${session.key}`;
    storage.setItem(resultKey, "{");

    expect(store.resetInvalidResult(session.key, session.origin, session.workflowId)).toBe(true);
    expect(storage.getItem(resultKey)).toBeNull();
    expect(storage.getItem(sessionKey)).not.toBeNull();
    expect(storage.getItem(returnKey)).not.toBeNull();
    expect(store.resetInvalidResult(session.key, session.origin, session.workflowId)).toBe(false);

    const accepted = { status: "accepted" as const, candidate: candidate({ name: "Mara Restored" }) };
    expect(store.complete(session.key, session.workflowId, accepted)).toBe(true);
    expect(store.consume(session.key, session.origin, session.workflowId)).toEqual({ session, result: accepted });
    expect(store.consume(session.key, session.origin, session.workflowId)).toBeNull();
  });

  it("denies invalid-result reset for mismatched identity and valid results", () => {
    const storage = new MemoryStorage();
    const store = createCharacterWorkspaceSessionStore(storage, {
      now: () => NOW,
      keyFactory: () => "reset-denied"
    });
    const session = store.create(createInput());
    const resultKey = `iqn:character-workspace:result:${session.key}`;
    storage.setItem(resultKey, "{");

    expect(store.resetInvalidResult(session.key, "world-editor", session.workflowId)).toBe(false);
    expect(store.resetInvalidResult(session.key, session.origin, "wrong-workflow")).toBe(false);
    expect(storage.getItem(resultKey)).toBe("{");

    storage.removeItem(resultKey);
    expect(store.complete(session.key, session.workflowId, { status: "cancelled" })).toBe(true);
    const validResult = storage.getItem(resultKey);
    expect(store.resetInvalidResult(session.key, session.origin, session.workflowId)).toBe(false);
    expect(storage.getItem(resultKey)).toBe(validResult);
  });

  it("fails closed when invalid-result removal fails", () => {
    const storage = new MemoryStorage();
    const store = createCharacterWorkspaceSessionStore(storage, {
      now: () => NOW,
      keyFactory: () => "reset-remove-failure"
    });
    const session = store.create(createInput());
    const resultKey = `iqn:character-workspace:result:${session.key}`;
    storage.setItem(resultKey, "{");
    storage.failingRemovals.add(resultKey);

    expect(store.resetInvalidResult(session.key, session.origin, session.workflowId)).toBe(false);
    expect(storage.getItem(resultKey)).toBe("{");
    expect(store.complete(session.key, session.workflowId, { status: "cancelled" })).toBe(false);
    expect(store.load(session.key)).toEqual(session);
    expect(store.returnPath(session.key)).toBe(session.parentRoute);
  });

  it("fails closed and cannot return a result later when any record removal fails", () => {
    for (const recordType of ["session", "return", "result"]) {
      const storage = new MemoryStorage();
      const store = createCharacterWorkspaceSessionStore(storage, {
        now: () => NOW,
        keyFactory: () => `remove-failure-${recordType}`
      });
      const session = store.create(createInput());
      expect(store.complete(session.key, session.workflowId, {
        status: "accepted",
        candidate: candidate()
      })).toBe(true);
      storage.failingRemovals.add(`iqn:character-workspace:${recordType}:${session.key}`);

      expect(store.consume(session.key, session.origin, session.workflowId)).toBeNull();
      expect(store.consume(session.key, session.origin, session.workflowId)).toBeNull();
    }
  });

  it("returns cancellation exactly once", () => {
    const storage = new MemoryStorage();
    const store = createCharacterWorkspaceSessionStore(storage, {
      now: () => NOW,
      keyFactory: () => "cancelled"
    });
    const session = store.create(createInput({ origin: "world-editor", mode: "edit", candidate: candidate() }));

    expect(store.complete(session.key, session.workflowId, { status: "cancelled" })).toBe(true);
    expect(store.consume(session.key, "world-editor", session.workflowId)?.result).toEqual({ status: "cancelled" });
    expect(store.consume(session.key, "world-editor", session.workflowId)).toBeNull();
  });

  it("rejects malformed results and accepted candidates with owner keys are sanitized", () => {
    const storage = new MemoryStorage();
    const store = createCharacterWorkspaceSessionStore(storage, {
      now: () => NOW,
      keyFactory: () => "result-safe"
    });
    const session = store.create(createInput());
    const resultKey = `iqn:character-workspace:result:${session.key}`;

    const malformedResult = JSON.stringify({ version: 1, key: session.key, workflowId: session.workflowId });
    storage.setItem(resultKey, malformedResult);
    expect(store.peek(session.key, "world-creation", session.workflowId)).toEqual({
      status: "invalid",
      session
    });
    expect(store.consume(session.key, "world-creation", session.workflowId)).toBeNull();
    expect(storage.getItem(resultKey)).toBe(malformedResult);

    const resultWithUnexpectedCredential = JSON.stringify({
      version: 1,
      key: session.key,
      workflowId: session.workflowId,
      expiresAt: session.expiresAt,
      credential: "must-not-hitchhike",
      result: { status: "cancelled" }
    });
    storage.setItem(resultKey, resultWithUnexpectedCredential);
    expect(store.peek(session.key, "world-creation", session.workflowId)).toEqual({
      status: "invalid",
      session
    });
    expect(store.consume(session.key, "world-creation", session.workflowId)).toBeNull();
    expect(storage.getItem(resultKey)).toBe(resultWithUnexpectedCredential);

    storage.setItem(resultKey, JSON.stringify({
      version: 1,
      key: session.key,
      workflowId: session.workflowId,
      expiresAt: session.expiresAt,
      result: {
        status: "accepted",
        candidate: candidate({
          ownerUserId: "tampered-owner",
          accessToken: "tampered-token",
          safeExtension: { keep: true, database_password: "tampered-password" }
        })
      }
    }));
    expect(store.consume(session.key, "world-creation", session.workflowId)?.result).toEqual({
      status: "accepted",
      candidate: candidate({ safeExtension: { keep: true } })
    });

    const recreated = store.create(createInput());
    expect(store.complete(recreated.key, recreated.workflowId, {
      status: "accepted",
      candidate: candidate({ ownerUserId: "spoofed", safeExtension: true })
    })).toBe(true);
    expect(store.consume(recreated.key, "world-creation", recreated.workflowId)?.result).toEqual({
      status: "accepted",
      candidate: candidate({ safeExtension: true })
    });
  });
});
