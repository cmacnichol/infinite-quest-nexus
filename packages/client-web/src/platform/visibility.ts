import type { AbortSignalLike } from "@infinite-quest/client-core";
import type { VisibilitySource } from "../generation/types.js";

export function createDocumentVisibilitySource(document: Document): VisibilitySource {
  return {
    isHidden: () => document.hidden,
    waitUntilVisible(signal: AbortSignalLike): Promise<void> {
      if (!document.hidden || signal.aborted) return Promise.resolve();
      return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          document.removeEventListener("visibilitychange", onVisibilityChange);
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        const onVisibilityChange = () => {
          if (!document.hidden) finish();
        };
        const onAbort = () => finish();
        document.addEventListener("visibilitychange", onVisibilityChange);
        signal.addEventListener("abort", onAbort, { once: true });
        if (!document.hidden || signal.aborted) finish();
      });
    }
  };
}
