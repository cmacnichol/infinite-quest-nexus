import type {
  Clock,
  DelayScheduler,
  IdFactory,
  PendingSubmissionStore
} from "../../../../../packages/client-core/src/index.js";

export const clock: Clock = { now: () => Date.now() };
export const ids: IdFactory = { create: () => crypto.randomUUID() };

export const delays: DelayScheduler = {
  wait: (milliseconds, signal) => new Promise<void>((resolve) => {
    const timeout = window.setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timeout);
      resolve();
    }, { once: true });
  })
};

export const pending: PendingSubmissionStore = {
  load: () => null,
  save: (campaignId, submission) => localStorage.setItem(campaignId, submission.request.idempotencyKey),
  clear: (campaignId) => localStorage.removeItem(campaignId)
};

export const browserState = document.visibilityState;
export const events = (url: string) => new EventSource(url);
export const request = (url: string) => fetch(url);
