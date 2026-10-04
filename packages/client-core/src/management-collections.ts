import type { CampaignSummary, WorldSummary } from "@infinite-quest/contracts";
import { compareUtcTimestamps } from "./resume-campaign.js";

export type CampaignCollectionOptions = {
  readonly query?: string;
  readonly status?: "active" | "archived" | "all";
  readonly sort?: "updated-desc" | "title";
};

export type WorldCollectionOptions = {
  readonly query?: string;
  readonly status?: WorldSummary["status"] | "all";
  readonly sort?: "updated-desc" | "title";
};

type CollectionSummary = Readonly<{
  id: string;
  title: string;
  updatedAt?: unknown;
}>;

type CampaignCollectionRecord = Omit<CampaignSummary, "updatedAt"> & Readonly<{ updatedAt?: unknown }>;
type WorldCollectionRecord = Omit<WorldSummary, "updatedAt"> & Readonly<{ updatedAt?: unknown }>;

function normalizeText(value: string): string {
  return value.trim().normalize("NFC").toLowerCase().normalize("NFC");
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function timestampValue(record: CollectionSummary): string | null {
  const value = record.updatedAt;
  if (typeof value !== "string" || compareUtcTimestamps(value, "0000-01-01T00:00:00Z") < 0) {
    return null;
  }
  return value;
}

function timestampRank(record: CollectionSummary): number {
  if (record.updatedAt === undefined || record.updatedAt === null) return 2;
  return timestampValue(record) === null ? 1 : 0;
}

function compareUpdatedAtDescending(left: CollectionSummary, right: CollectionSummary): number {
  const leftRank = timestampRank(left);
  const rightRank = timestampRank(right);
  if (leftRank !== rightRank) return leftRank - rightRank;
  if (leftRank === 0) {
    const timestampComparison = compareUtcTimestamps(timestampValue(right)!, timestampValue(left)!);
    if (timestampComparison !== 0) return timestampComparison;
  }
  return compareText(left.id, right.id);
}

function compareTitle(left: CollectionSummary, right: CollectionSummary): number {
  return compareText(normalizeText(left.title), normalizeText(right.title)) || compareText(left.id, right.id);
}

function compareCollection<T extends CollectionSummary>(
  left: T,
  right: T,
  sort: "updated-desc" | "title"
): number {
  return sort === "title" ? compareTitle(left, right) : compareUpdatedAtDescending(left, right);
}

function queryMatches(query: string, fields: readonly string[]): boolean {
  return fields.some((field) => normalizeText(field).includes(query));
}

export function filterSortCampaigns<T extends CampaignCollectionRecord>(
  campaigns: readonly T[],
  options: CampaignCollectionOptions = {}
): T[] {
  const query = normalizeText(options.query ?? "");
  const status = options.status ?? "active";
  const sort = options.sort ?? "updated-desc";
  return campaigns
    .filter((campaign) => status === "all" || campaign.status === status)
    .filter((campaign) => query.length === 0 || queryMatches(query, [
      campaign.title,
      campaign.worldTitle,
      campaign.selectedCharacterName ?? ""
    ]))
    .toSorted((left, right) => compareCollection(left, right, sort));
}

export function filterSortWorlds<T extends WorldCollectionRecord>(
  worlds: readonly T[],
  options: WorldCollectionOptions = {}
): T[] {
  const query = normalizeText(options.query ?? "");
  const status = options.status ?? "all";
  const sort = options.sort ?? "updated-desc";
  return worlds
    .filter((world) => status === "all" || world.status === status)
    .filter((world) => query.length === 0 || queryMatches(query, [
      world.title,
      ...[world.draftPreview, world.latestPreview].flatMap((preview) => preview
        ? [preview.title, preview.genre, preview.tone, preview.premise, preview.backgroundStory, preview.firstAction, preview.rules ?? ""]
        : [])
    ]))
    .toSorted((left, right) => compareCollection(left, right, sort));
}
