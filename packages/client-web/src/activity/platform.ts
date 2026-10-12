import type { ActivityBooleanSource, ActivityInvalidations } from "@infinite-quest/client-core";
/** Namespace is an explicit deployment base, not an identity hint. */
export function canonicalActivityApiBase(basePath: string, origin: string): string {
  const url = new URL(basePath, origin);
  if (!/^https?:$/u.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid activity API base");
  return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
}
export function createActivityVisibilitySource(documentImpl: Document = document): ActivityBooleanSource {
  return { current: () => documentImpl.visibilityState !== "hidden", subscribe(listener) { documentImpl.addEventListener("visibilitychange", listener); return () => documentImpl.removeEventListener("visibilitychange", listener); } };
}
export function createActivityConnectivitySource(windowImpl: Window = window): ActivityBooleanSource {
  return { current: () => windowImpl.navigator.onLine, subscribe(listener) { windowImpl.addEventListener("online", listener); windowImpl.addEventListener("offline", listener); return () => { windowImpl.removeEventListener("online", listener); windowImpl.removeEventListener("offline", listener); }; } };
}
export function createActivityTabNotifications(factory: ((name: string) => BroadcastChannel) | null = name => new BroadcastChannel(name)): ActivityInvalidations & { dispose(): void } {
  const listeners = new Set<(scope: string) => void>();
  let channel: BroadcastChannel | null = null;
  try { channel = factory?.("infinite-quest-activity-v1") ?? null; } catch { /* Polling remains available. */ }
  if (channel) channel.onmessage = ({ data }: MessageEvent<unknown>) => {
    if (!data || typeof data !== "object" || !("scopeKey" in data) || !("type" in data) || data.type !== "invalidate" || typeof data.scopeKey !== "string" || data.scopeKey.length > 2048) return;
    for (const listener of listeners) listener(data.scopeKey);
  };
  return { publish(scopeKey) { try { channel?.postMessage({ type: "invalidate", scopeKey }); } catch { /* Optional invalidation only. */ } }, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }, dispose() { channel?.close(); listeners.clear(); } };
}
