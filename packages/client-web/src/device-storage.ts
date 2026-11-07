import type { UserProfile } from "@infinite-quest/contracts";

type StoragePort = Pick<Storage, "getItem" | "setItem"> & Partial<Pick<Storage,"removeItem">>;
type Identity = Pick<UserProfile, "id" | "systemKey">;
const legacyKeys = ["infinite-quest.theme", "infinite-quest.display-preferences.v1", "infinite-quest.story.reading-width", "infinite-quest.story-resume.v1", "infiniteQuestLastCampaignId"];

/** Only server-returned identities activate a partition. Unavailable storage falls back to this mount. */
export function createDeviceStorage(storage: StoragePort | null) {
  let owner: string | null = null;
  const fallback = new Map<string, string | null>();
  const key = (name: string) => owner ? `infinite-quest.user.${owner}.${name}` : null;
  const read = (name: string) => {
    if (fallback.has(name)) return fallback.get(name)!;
    try { return storage?.getItem(name) ?? null; } catch { return null; }
  };
  const write = (name: string, value: string) => {
    try {
      if (!storage) throw new Error("Storage unavailable");
      storage.setItem(name, value);
      fallback.delete(name);
    } catch { fallback.set(name, value); }
  };
  return {
    key,
    activate(user: Identity | null) {
      if (user?.id !== owner) fallback.clear();
      owner = user?.id ?? null;
      if (user?.systemKey !== "initial-owner" || read(key("migration.v1")!)) return;
      for (const name of legacyKeys) {
        const scoped = key(name)!;
        const legacy = read(name);
        if (legacy !== null && read(scoped) === null) write(scoped, legacy);
      }
      write(key("migration.v1")!, "1");
    },
    removeItem(name: string) {
      const scoped = key(name);
      if (!scoped) return;
      try {
        if (!storage?.removeItem) throw new Error("Storage unavailable");
        storage.removeItem(scoped); fallback.delete(scoped);
      } catch { fallback.set(scoped, null); }
    },
    getItem(name: string) { const scoped = key(name); return scoped ? read(scoped) : null; },
    setItem(name: string, value: string) { const scoped = key(name); if (scoped) write(scoped, value); }
  };
}

export function browserDeviceStorage(view: Window | null) {
  try { return createDeviceStorage(view?.localStorage ?? null); }
  catch { return createDeviceStorage(null); }
}
