export type StoryRoute = {
  campaignId: string | null;
  turnNumber: number | null;
};

function validTurnNumber(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

function parseTurnNumber(search: string): number | null | undefined {
  const query = search.startsWith("?") ? search.slice(1) : search;
  if (!query) return null;
  const params = new URLSearchParams(query);
  if (params.size !== 1 || !params.has("turn") || params.getAll("turn").length !== 1) return undefined;
  const value = params.get("turn");
  if (value === null || !/^[1-9]\d*$/u.test(value)) return undefined;
  const turnNumber = Number(value);
  return validTurnNumber(turnNumber) ? turnNumber : undefined;
}

export function storyPlayerPath(campaignId?: string, turnNumber?: number): string {
  if (!campaignId) return "/app/story";
  const path = `/app/story/${encodeURIComponent(campaignId)}`;
  return validTurnNumber(turnNumber) ? `${path}?turn=${turnNumber}` : path;
}

export function storyRouteFromLocation(pathname: string, search = ""): StoryRoute | null {
  const parts = pathname.split("/");
  if (parts[0] !== "" || parts[1] !== "app" || parts[2] !== "story") return null;
  if (parts.length === 3 || (parts.length === 4 && parts[3] === "")) {
    return parseTurnNumber(search) === null ? { campaignId: null, turnNumber: null } : null;
  }
  if (parts.length !== 4 || !parts[3]) return null;

  let campaignId: string;
  try {
    campaignId = decodeURIComponent(parts[3]);
  } catch {
    return null;
  }
  if (!campaignId) return null;
  const turnNumber = parseTurnNumber(search);
  return turnNumber === undefined ? null : { campaignId, turnNumber };
}
