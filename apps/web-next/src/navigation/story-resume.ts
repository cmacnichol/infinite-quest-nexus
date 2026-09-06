import { storyPlayerPath } from "../story-route.js";

export interface ResumeCandidate {
  readonly id: string;
  readonly status: string;
}

export interface StoryResumeStore {
  read(): string | null;
  remember(campaignId: string): void;
  forget(): void;
}

export interface StoryResumeEntryOptions {
  readonly store: StoryResumeStore;
  readonly list: (signal: AbortSignal) => Promise<Readonly<{ campaigns: readonly ResumeCandidate[] }>>;
  /** Use Location.replace so Back/Forward does not trap a returning user at /app. */
  readonly replace: (path: string) => void;
  readonly timeoutMs?: number;
  /** The owning page aborts this lookup during teardown. */
  readonly signal?: AbortSignal;
}

export const STORY_RESUME_STORAGE_KEY = "infinite-quest.story-resume.v1";

const MAX_CAMPAIGN_ID_LENGTH = 512;

export function isAppEntryPath(pathname: string): boolean {
  return pathname === "/app" || pathname === "/app/";
}

function isCampaignId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_CAMPAIGN_ID_LENGTH
    && !/[\\/\\?#\u0000-\u001f\u007f]/u.test(value);
}

function parseMarker(value: string | null): string | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const marker = parsed as Record<string, unknown>;
    return marker.version === 1 && isCampaignId(marker.campaignId) ? marker.campaignId : null;
  } catch {
    return null;
  }
}

export function createStoryResumeStore(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null
): StoryResumeStore {
  return {
    read() {
      try {
        return parseMarker(storage?.getItem(STORY_RESUME_STORAGE_KEY) ?? null);
      } catch {
        return null;
      }
    },
    remember(campaignId) {
      if (!isCampaignId(campaignId)) return;
      try {
        storage?.setItem(STORY_RESUME_STORAGE_KEY, JSON.stringify({ version: 1, campaignId }));
      } catch {
        // Resume navigation remains optional when browser storage is unavailable.
      }
    },
    forget() {
      try {
        storage?.removeItem(STORY_RESUME_STORAGE_KEY);
      } catch {
        // A stale marker is harmless because each resume route verifies it with the server.
      }
    }
  };
}

export function resolveAppLanding(lastCampaignId: string | null, campaigns: readonly ResumeCandidate[]): string {
  const candidate = campaigns.find((item) => item.id === lastCampaignId && item.status === "active");
  return candidate ? storyPlayerPath(candidate.id) : "/app/worlds";
}

/**
 * Resolves only a stored, server-verified Story target.  The caller mounts the
 * World Library for every non-resume outcome, including a failed lookup.
 */
export async function resumeStoredStoryCampaign(options: StoryResumeEntryOptions): Promise<"resumed" | "library"> {
  if (options.signal?.aborted) return "library";
  const campaignId = options.store.read();
  if (campaignId === null) return "library";

  const controller = new AbortController();
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs! >= 0 ? options.timeoutMs! : 3_000;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const lookup = options.list(controller.signal)
    .then((response) => ({ kind: "response" as const, campaigns: response.campaigns }))
    .catch(() => ({ kind: "unavailable" as const }));
  const timedOut = new Promise<{ kind: "unavailable" }>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve({ kind: "unavailable" });
    }, timeoutMs);
  });
  let resolvePageDisposed!: (result: { kind: "unavailable" }) => void;
  const pageDisposed = new Promise<{ kind: "unavailable" }>((resolve) => { resolvePageDisposed = resolve; });
  const onPageDisposed = () => {
    controller.abort();
    resolvePageDisposed({ kind: "unavailable" });
  };
  options.signal?.addEventListener("abort", onPageDisposed, { once: true });

  try {
    const result = await Promise.race([lookup, timedOut, pageDisposed]);
    if (options.signal?.aborted || result.kind !== "response") return "library";

    const landing = resolveAppLanding(campaignId, result.campaigns);
    if (landing === "/app/worlds") {
      options.store.forget();
      return "library";
    }
    options.replace(landing);
    return "resumed";
  } finally {
    if (timeout !== null) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onPageDisposed);
    controller.abort();
  }
}
