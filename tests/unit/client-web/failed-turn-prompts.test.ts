import { describe, expect, it } from "vitest";
import { createFailedTurnPromptStore } from "../../../packages/client-web/src/index.js";

function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  };
}

describe("failed append prompt storage", () => {
  it("keeps an append prompt available across recovery reloads until completion clears its campaign scope", () => {
    const storage = memory();
    const store = createFailedTurnPromptStore(storage);
    store.save({ campaignId: "campaign-a", expectedTurnNumber: 4, action: "Return the lantern." });

    expect(store.load("campaign-a")).toEqual({ campaignId: "campaign-a", expectedTurnNumber: 4, action: "Return the lantern." });
    expect(store.load("campaign-b")).toBeNull();

    store.clear("campaign-a");
    expect(store.load("campaign-a")).toBeNull();
  });

  it("treats inaccessible browser storage as unavailable without throwing", () => {
    const store = createFailedTurnPromptStore({
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); }
    });

    expect(store.load("campaign-a")).toBeNull();
    expect(() => store.save({ campaignId: "campaign-a", expectedTurnNumber: 1, action: "Wait." })).not.toThrow();
    expect(() => store.clear("campaign-a")).not.toThrow();
  });
});
