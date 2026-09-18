import { sha256Hex } from "./hash.js";

/** Versioned identity for capability routing using non-secret settings only. */
export function capabilityRouteConfigHash(configuration: Readonly<Record<string, unknown>>): string {
  const normalized = {
    version: 1,
    ...(typeof configuration.streaming === "boolean" ? { streaming: configuration.streaming } : {}),
    ...(typeof configuration.streamingSupport === "boolean" ? { streamingSupport: configuration.streamingSupport } : {}),
    ...(configuration.textResponseFormatPolicy === "legacy" || configuration.textResponseFormatPolicy === "auto" || configuration.textResponseFormatPolicy === "required"
      ? { textResponseFormatPolicy: configuration.textResponseFormatPolicy }
      : {})
  };
  return sha256Hex(JSON.stringify(normalized));
}

/** Shared by capability projection and runtime dispatch identity checks. */
export function providerEndpointIdentity(baseUrl: string): string {
  return sha256Hex(baseUrl.replace(/\/+$/, ""));
}
