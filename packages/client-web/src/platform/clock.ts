import type { Clock } from "@infinite-quest/client-core";

export function createBrowserClock(): Clock {
  return { now: () => Date.now() };
}
