import { afterEach, describe, expect, it, vi } from "vitest";
import { createStoryResumeStore, isAppEntryPath, resumeStoredStoryCampaign, resolveAppLanding } from "../../apps/web-next/src/navigation/story-resume.js";

const STORAGE_KEY = "infinite-quest.story-resume.v1";

class MemoryStorage {
  readonly values = new Map<string, string>();
  failReads = false;
  failWrites = false;
  failRemovals = false;

  getItem(key: string): string | null {
    if (this.failReads) throw new Error("storage denied");
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error("storage denied");
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    if (this.failRemovals) throw new Error("storage denied");
    this.values.delete(key);
  }
}

describe("Story resume navigation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resumes only a remembered active campaign returned by this server", () => {
    expect(resolveAppLanding("a", [{ id: "a", status: "active" }])).toBe("/app/story/a");
    expect(resolveAppLanding("a", [{ id: "a", status: "archived" }])).toBe("/app/worlds");
    expect(resolveAppLanding("foreign", [{ id: "a", status: "active" }])).toBe("/app/worlds");
    expect(resolveAppLanding(null, [{ id: "a", status: "active" }])).toBe("/app/worlds");
  });

  it("limits return routing to the bare app entry so direct library links stay direct", () => {
    expect(isAppEntryPath("/app")).toBe(true);
    expect(isAppEntryPath("/app/")).toBe(true);
    expect(isAppEntryPath("/app/worlds")).toBe(false);
    expect(isAppEntryPath("/app/worlds/world-a")).toBe(false);
    expect(isAppEntryPath("/app/story/campaign-a")).toBe(false);
  });

  it("uses a versioned campaign-id marker rather than a stored route", () => {
    const storage = new MemoryStorage();
    const store = createStoryResumeStore(storage);

    store.remember("campaign 1");

    expect(storage.values.get(STORAGE_KEY)).toBe(JSON.stringify({ version: 1, campaignId: "campaign 1" }));
    expect(store.read()).toBe("campaign 1");
  });

  it.each([
    ["malformed JSON", "{"],
    ["a wrong version", JSON.stringify({ version: 2, campaignId: "campaign-a" })],
    ["a stored URL", JSON.stringify({ version: 1, campaignId: "/app/story/campaign-a" })],
    ["an empty campaign id", JSON.stringify({ version: 1, campaignId: "" })],
    ["an oversized campaign id", JSON.stringify({ version: 1, campaignId: "a".repeat(513) })]
  ])("rejects %s", (_label, marker) => {
    const storage = new MemoryStorage();
    storage.values.set(STORAGE_KEY, marker);

    expect(createStoryResumeStore(storage).read()).toBeNull();
  });

  it("does not leak storage errors into navigation", () => {
    const storage = new MemoryStorage();
    storage.failReads = true;
    storage.failWrites = true;
    storage.failRemovals = true;
    const store = createStoryResumeStore(storage);

    expect(store.read()).toBeNull();
    expect(() => store.remember("campaign-a")).not.toThrow();
    expect(() => store.forget()).not.toThrow();
  });

  it("replaces the app entry with a verified active Story route", async () => {
    const storage = new MemoryStorage();
    const store = createStoryResumeStore(storage);
    const replace = vi.fn();
    store.remember("campaign-a");

    await expect(resumeStoredStoryCampaign({
      store,
      list: vi.fn().mockResolvedValue({ campaigns: [{ id: "campaign-a", status: "active" }] }),
      replace
    })).resolves.toBe("resumed");

    expect(replace).toHaveBeenCalledWith("/app/story/campaign-a");
  });

  it("forgets a marker only after the server confirms it is no longer active", async () => {
    const storage = new MemoryStorage();
    const store = createStoryResumeStore(storage);
    store.remember("campaign-a");

    await expect(resumeStoredStoryCampaign({
      store,
      list: vi.fn().mockResolvedValue({ campaigns: [{ id: "campaign-a", status: "archived" }] }),
      replace: vi.fn()
    })).resolves.toBe("library");

    expect(store.read()).toBeNull();
  });

  it("does not fetch or redirect a first-time entry with no marker", async () => {
    const list = vi.fn().mockResolvedValue({ campaigns: [{ id: "campaign-a", status: "active" }] });
    const replace = vi.fn();

    await expect(resumeStoredStoryCampaign({
      store: createStoryResumeStore(new MemoryStorage()),
      list,
      replace
    })).resolves.toBe("library");

    expect(list).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("abandons a timed-out lookup without losing the marker", async () => {
    vi.useFakeTimers();
    const storage = new MemoryStorage();
    const store = createStoryResumeStore(storage);
    let lookupSignal: AbortSignal | null = null;
    const list = vi.fn((signal: AbortSignal) => {
      lookupSignal = signal;
      return new Promise<never>(() => undefined);
    });
    store.remember("campaign-a");

    const landing = resumeStoredStoryCampaign({ store, list, replace: vi.fn(), timeoutMs: 3_000 });
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(landing).resolves.toBe("library");
    expect(lookupSignal?.aborted).toBe(true);
    expect(store.read()).toBe("campaign-a");
  });

  it("preserves the marker when the resume lookup fails", async () => {
    const storage = new MemoryStorage();
    const store = createStoryResumeStore(storage);
    store.remember("campaign-a");

    await expect(resumeStoredStoryCampaign({
      store,
      list: vi.fn().mockRejectedValue(new Error("offline")),
      replace: vi.fn()
    })).resolves.toBe("library");

    expect(store.read()).toBe("campaign-a");
  });

  it("stops a pending lookup on page disposal without replacing or forgetting", async () => {
    const storage = new MemoryStorage();
    const store = createStoryResumeStore(storage);
    const pagehide = new AbortController();
    const replace = vi.fn();
    store.remember("campaign-a");

    const landing = resumeStoredStoryCampaign({
      store,
      list: vi.fn(() => new Promise<never>(() => undefined)),
      replace,
      signal: pagehide.signal
    });
    pagehide.abort();

    const settled = await Promise.race([
      landing.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 0))
    ]);
    expect(settled).toBe(true);
    await expect(landing).resolves.toBe("library");
    expect(replace).not.toHaveBeenCalled();
    expect(store.read()).toBe("campaign-a");
  });
});
