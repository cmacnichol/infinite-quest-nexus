import type { AbortSignalLike } from "@infinite-quest/client-core";

export function toAbortSignal(signal: AbortSignalLike): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  let disposed = false;
  return {
    signal: controller.signal,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      signal.removeEventListener("abort", onAbort);
    }
  };
}
