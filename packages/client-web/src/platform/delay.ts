import type { DelayScheduler } from "@infinite-quest/client-core";

export function createBrowserDelayScheduler(): DelayScheduler {
  return {
    wait(milliseconds, signal) {
      if (signal.aborted) return Promise.resolve();
      return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => finish();
        const timeout = setTimeout(finish, milliseconds);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) finish();
      });
    }
  };
}
