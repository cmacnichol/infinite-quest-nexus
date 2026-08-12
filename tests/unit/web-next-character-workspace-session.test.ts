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

  it("rejects records larger than 512 KiB without leaving partial storage", () => {
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

  it("strips owner-shaped keys throughout stored handoff content", () => {
    const storage = new MemoryStorage();
    const store = createCharacterWorkspaceSessionStore(storage, {
      now: () => NOW,
      keyFactory: () => "owner-safe"
    });
    const unsafeDraft = {
      ...draft(),
      ownerUserId: "root-owner",
      world: { ...draft().world, owner_user_id: "nested-owner" },
      playableCharacters: [candidate({ user_id: "character-owner" })]
    } as EditableWorldDraft;

    const session = store.create(createInput({
      parentDraft: unsafeDraft,
      worldContext: unsafeDraft,
      candidate: candidate({ userId: "candidate-owner", safeExtension: { keep: true } }),
      rosterSummaries: [{ id: "existing", name: "Existing", owner_user_id: "summary-owner" }]
    }));
    const serialized = JSON.stringify(session);

    expect(serialized).not.toMatch(/ownerUserId|owner_user_id|userId|user_id/);
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
    expect(store.consume(session.key, "world-editor", session.workflowId)).toBeNull();
    expect(store.consume(session.key, "world-creation", "wrong-workflow")).toBeNull();

    expect(store.consume(session.key, "world-creation", session.workflowId)).toEqual({
      session,
      result: accepted
    });
    expect(store.consume(session.key, "world-creation", session.workflowId)).toBeNull();
    expect(storage.length).toBe(0);
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

    storage.setItem(resultKey, JSON.stringify({ version: 1, key: session.key, workflowId: session.workflowId }));
    expect(store.consume(session.key, "world-creation", session.workflowId)).toBeNull();
    storage.setItem(resultKey, JSON.stringify({
      version: 1,
      key: session.key,
      workflowId: session.workflowId,
      expiresAt: session.expiresAt,
      credential: "must-not-hitchhike",
      result: { status: "cancelled" }
    }));
    expect(store.consume(session.key, "world-creation", session.workflowId)).toBeNull();

    storage.setItem(resultKey, JSON.stringify({
      version: 1,
      key: session.key,
      workflowId: session.workflowId,
      expiresAt: session.expiresAt,
      result: {
        status: "accepted",
        candidate: candidate({ ownerUserId: "tampered-owner", safeExtension: true })
      }
    }));
    expect(store.consume(session.key, "world-creation", session.workflowId)?.result).toEqual({
      status: "accepted",
      candidate: candidate({ safeExtension: true })
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
