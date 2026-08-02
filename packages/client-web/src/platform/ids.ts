import type { IdFactory } from "@infinite-quest/client-core";

export function createBrowserIdFactory(): IdFactory {
  return {
    create() {
      if (typeof globalThis.crypto?.randomUUID !== "function") {
        throw new Error("Secure UUID generation is unavailable.");
      }
      return globalThis.crypto.randomUUID();
    }
  };
}
