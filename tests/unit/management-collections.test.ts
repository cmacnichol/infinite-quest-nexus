import { describe, expect, it } from "vitest";
import type { CampaignSummary, WorldSummary } from "@infinite-quest/contracts";
import {
  filterSortCampaigns,
  filterSortWorlds
} from "../../packages/client-core/src/management-collections.js";

const campaign = (
  id: string,
  title: string,
  updatedAt: string,
  options: Partial<Pick<CampaignSummary, "status" | "worldTitle" | "selectedCharacterName">> = {}
): CampaignSummary => ({
  id,
  title,
  status: options.status ?? "active",
  activeTurnNumber: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt,
  storyLengthProfile: "standard",
  storyContextBudgetTokens: 32_000,
  turnControlStyle: "flexible_action",
  selectedCharacterId: null,
  selectedCharacterName: options.selectedCharacterName ?? null,
  worldId: "00000000-0000-4000-8000-000000000101",
  worldTitle: options.worldTitle ?? "",
  worldVersionId: "00000000-0000-4000-8000-000000000102",
  textProviderProfileId: null,
  imageProviderProfileId: null,
  worldVersionNumber: 1,
  latestWorldVersionNumber: 1,
  worldUpdateAvailable: false,
  costInformation: []
});

const world = (
  id: string,
  title: string,
  status: WorldSummary["status"],
  updatedAt: string,
  previewText: string
): WorldSummary => ({
  id,
  title,
  status,
  imageUrl: "",
  forkedFromWorldId: null,
  forkedFromWorldVersionId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt,
  draftRevision: status === "draft" ? 1 : null,
  draftUpdatedAt: status === "draft" ? updatedAt : null,
  draftPreview: status === "draft"
    ? { title, genre: "", tone: "", premise: previewText, backgroundStory: "", firstAction: "" }
    : null,
  latestVersionId: status === "active" ? "00000000-0000-4000-8000-000000000202" : null,
  latestVersionNumber: status === "active" ? 1 : null,
  latestPublishedAt: status === "active" ? updatedAt : null,
  latestPreview: status === "active"
    ? { title, genre: "", tone: "", premise: previewText, backgroundStory: "", firstAction: "" }
    : null,
  campaignCount: 0
});

describe("management collection policies", () => {
  it("defaults campaigns to active while keeping archived records discoverable", () => {
    const active = campaign("00000000-0000-4000-8000-000000000001", "Active", "2026-01-01T00:00:00Z");
    const archived = campaign("00000000-0000-4000-8000-000000000002", "Archived", "2026-01-02T00:00:00Z", { status: "archived" });

    expect(filterSortCampaigns([archived, active])).toEqual([active]);
    expect(filterSortCampaigns([active, archived], { status: "archived" })).toEqual([archived]);
    expect(filterSortCampaigns([active, archived], { status: "all" })).toEqual([archived, active]);
  });

  it("trims and case-folds campaign search across its title, world, and selected character", () => {
    const byTitle = campaign("00000000-0000-4000-8000-000000000001", "The Silver Key", "2026-01-01T00:00:00Z");
    const byWorld = campaign("00000000-0000-4000-8000-000000000002", "Other", "2026-01-02T00:00:00Z", { worldTitle: "Silver Coast" });
    const byCharacter = campaign("00000000-0000-4000-8000-000000000003", "Another", "2026-01-03T00:00:00Z", { selectedCharacterName: "Silver Fox" });
    const archived = campaign("00000000-0000-4000-8000-000000000004", "Archived Silver", "2026-01-04T00:00:00Z", { status: "archived" });

    expect(filterSortCampaigns([byTitle, byWorld, byCharacter, archived], { query: "  SiLvEr  " }).map(({ id }) => id)).toEqual([
      byCharacter.id,
      byWorld.id,
      byTitle.id
    ]);
  });

  it("sorts campaigns by normalized title or updated time with deterministic ID ties and invalid dates last", () => {
    const newerHighId = campaign("00000000-0000-4000-8000-000000000009", " beta ", "2026-02-01T00:00:00Z");
    const newerLowId = campaign("00000000-0000-4000-8000-000000000003", "Beta", "2026-02-01T00:00:00Z");
    const alphaHighId = campaign("00000000-0000-4000-8000-000000000008", "ALPHA", "2026-01-01T00:00:00Z");
    const alphaLowId = campaign("00000000-0000-4000-8000-000000000002", " alpha ", "2026-01-01T00:00:00Z");
    const invalid = campaign("00000000-0000-4000-8000-000000000004", "Invalid", "not-a-timestamp");
    const offset = campaign("00000000-0000-4000-8000-000000000006", "Offset", "2026-02-15T00:00:00+00:00");
    const missing = ((record: CampaignSummary): Omit<CampaignSummary, "updatedAt"> => {
      const { updatedAt: removedUpdatedAt, ...summary } = record;
      void removedUpdatedAt;
      return summary;
    })(campaign("00000000-0000-4000-8000-000000000001", "Missing", "2026-01-01T00:00:00Z"));
    const records: Array<CampaignSummary | Omit<CampaignSummary, "updatedAt">> = [
      alphaHighId,
      missing,
      newerHighId,
      invalid,
      alphaLowId,
      newerLowId,
      offset
    ];
    const originalOrder = [...records];

    expect(filterSortCampaigns(records).map(({ id }) => id)).toEqual([
      newerLowId.id,
      newerHighId.id,
      alphaLowId.id,
      alphaHighId.id,
      invalid.id,
      offset.id,
      missing.id
    ]);
    expect(records).toEqual(originalOrder);
    expect(filterSortCampaigns(records, { sort: "title" }).map(({ id }) => id)).toEqual([
      alphaLowId.id,
      alphaHighId.id,
      newerLowId.id,
      newerHighId.id,
      invalid.id,
      missing.id,
      offset.id
    ]);
  });

  it("combines world status and preview search without mutating the source array", () => {
    const draft = world("00000000-0000-4000-8000-000000000001", "Salt Road", "draft", "2026-01-01T00:00:00Z", "silver desert");
    const active = world("00000000-0000-4000-8000-000000000002", "Silver Harbor", "active", "2026-01-02T00:00:00Z", "coastal city");
    const archived = world("00000000-0000-4000-8000-000000000003", "Silver Keep", "archived", "2026-01-03T00:00:00Z", "old walls");
    const records = [archived, draft, active];
    const originalOrder = [...records];

    expect(filterSortWorlds(records, { query: "  SILVER ", status: "active" })).toEqual([active]);
    expect(filterSortWorlds(records, { query: "silver", status: "all", sort: "title" })).toEqual([draft, active, archived]);
    expect(records).toEqual(originalOrder);
  });
});
