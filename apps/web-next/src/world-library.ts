export interface WorldPreview {
  title?: unknown;
  premise?: unknown;
  backgroundStory?: unknown;
}

export interface WorldSummary {
  id: string;
  title: string;
  status: "draft" | "active" | "archived";
  imageUrl: string;
  campaignCount: number;
  latestPreview: WorldPreview | null;
  draftPreview: WorldPreview | null;
}

export interface WorldListResponse {
  worlds: WorldSummary[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalPreview(value: unknown): WorldPreview | null {
  if (!isRecord(value)) return null;
  return {
    title: value.title,
    premise: value.premise,
    backgroundStory: value.backgroundStory
  };
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseWorldListResponse(value: unknown): WorldListResponse {
  if (!isRecord(value) || !Array.isArray(value.worlds)) {
    throw new Error("The World Library returned an unexpected response.");
  }

  const worlds = value.worlds.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error("A World Library entry was invalid.");
    }

    const id = readText(entry.id);
    const title = readText(entry.title);
    const status = entry.status;
    const campaignCount = entry.campaignCount;

    if (!id || !title || !["draft", "active", "archived"].includes(String(status))) {
      throw new Error("A World Library entry was missing required information.");
    }
    if (!Number.isInteger(campaignCount) || Number(campaignCount) < 0) {
      throw new Error("A World Library entry had an invalid campaign count.");
    }

    return {
      id,
      title,
      status: status as WorldSummary["status"],
      imageUrl: readText(entry.imageUrl),
      campaignCount: Number(campaignCount),
      latestPreview: optionalPreview(entry.latestPreview),
      draftPreview: optionalPreview(entry.draftPreview)
    };
  });

  return { worlds };
}

export function worldDescription(world: WorldSummary): string {
  const preview = world.latestPreview ?? world.draftPreview;
  return readText(preview?.premise) || readText(preview?.backgroundStory) || "Description not available.";
}

export function filterWorlds(worlds: WorldSummary[], query: string): WorldSummary[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return worlds
    .filter((world) => world.status !== "archived")
    .filter((world) => {
      if (!normalizedQuery) return true;
      return `${world.title} ${worldDescription(world)}`.toLocaleLowerCase().includes(normalizedQuery);
    });
}

export function safeArtworkUrl(candidate: string, origin: string): string {
  if (!candidate.trim()) return "";
  try {
    const url = new URL(candidate, origin);
    if (url.origin === origin || url.protocol === "https:" || url.protocol === "http:") return url.href;
  } catch {
    return "";
  }
  return "";
}

export function installArtworkFallback(image: HTMLElement, createFallback: () => Node): void {
  image.addEventListener("error", () => image.replaceWith(createFallback()), { once: true });
}
