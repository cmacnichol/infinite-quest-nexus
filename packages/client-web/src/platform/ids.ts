import type { IdFactory } from "@infinite-quest/client-core";

function uuidFromSecureRandomBytes(bytes: Uint8Array): string {
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createBrowserIdFactory(): IdFactory {
  return {
    create() {
      if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
      if (typeof globalThis.crypto?.getRandomValues !== "function") throw new Error("Secure UUID generation is unavailable.");
      return uuidFromSecureRandomBytes(globalThis.crypto.getRandomValues(new Uint8Array(16)));
    }
  };
}
