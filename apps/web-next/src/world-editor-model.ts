export interface WorldOverview extends Record<string, unknown> {
  title: string;
  genre: string;
  tone: string;
  premise: string;
  backgroundStory: string;
  firstAction: string;
  rules: string;
}

export interface EditableWorldDraft extends Record<string, unknown> {
  schemaVersion: number;
  world: WorldOverview;
  playableCharacters: unknown[];
  entities: unknown[];
  relationships: unknown[];
  rpgStats: unknown[];
  defaultTriggers: unknown[];
  eventTriggers: unknown[];
  assets: unknown[];
  defaults: Record<string, unknown>;
}

export interface PublishedWorldSummary {
  id: string;
  versionNumber: number;
  sourceHash: string | null;
  releaseNotes: string;
  createdFromRevision: number;
  publishedAt: string;
  createdAt: string;
  deletable: boolean;
  deletionBlockers: {
    currentCampaigns: number;
    campaignMigrations: number;
    campaignTransfers: number;
    chronicleMemories: number;
    modelChains: number;
  };
  detachments: { drafts: number; forks: number; imports: number };
}

export interface WorldCampaignSummary {
  id: string;
  title: string;
  status: "active" | "archived";
  activeTurnNumber: number;
  worldVersionId: string;
  worldVersionNumber: number;
  selectedCharacterId: string | null;
  selectedCharacterName: string | null;
  turnControlStyle: "action_only" | "flexible_auto" | "flexible_action" | "flexible_scene";
  updatedAt: string;
}

export interface WorldAggregate {
  id: string;
  title: string;
  status: "draft" | "active" | "archived";
  imageUrl: string;
  forkedFromWorldId: string | null;
  forkedFromWorldVersionId: string | null;
  createdAt: string;
  updatedAt: string;
  draftRevision: number | null;
  draftContent: EditableWorldDraft | null;
  draftBasedOnWorldVersionId: string | null;
  draftUpdatedAt: string | null;
  versions: PublishedWorldSummary[];
  campaigns: WorldCampaignSummary[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function unexpectedWorldResponse(): never {
  throw new Error("The World Editor returned an unexpected world response.");
}

export function parseEditableWorldDraft(value: unknown): EditableWorldDraft {
  if (!isRecord(value) || !isPositiveInteger(value.schemaVersion) || !isRecord(value.world)) {
    return unexpectedWorldResponse();
  }

  const world = value.world;
  const overviewFields = ["title", "genre", "tone", "premise", "backgroundStory", "firstAction", "rules"];
  const arrayFields = [
    "playableCharacters",
    "entities",
    "relationships",
    "rpgStats",
    "defaultTriggers",
    "eventTriggers",
    "assets"
  ];
  if (overviewFields.some((field) => !isString(world[field])) ||
      arrayFields.some((field) => !Array.isArray(value[field])) ||
      !isRecord(value.defaults)) {
    return unexpectedWorldResponse();
  }

  return value as EditableWorldDraft;
}

function parseVersion(value: unknown): PublishedWorldSummary {
  if (!isRecord(value) || !isRecord(value.deletionBlockers) || !isRecord(value.detachments)) {
    return unexpectedWorldResponse();
  }
  const blockers = value.deletionBlockers;
  const detachments = value.detachments;
  if (!isString(value.id) || !isPositiveInteger(value.versionNumber) || !isNullableString(value.sourceHash) ||
      !isString(value.releaseNotes) || !isPositiveInteger(value.createdFromRevision) ||
      !isString(value.publishedAt) || !isString(value.createdAt) || typeof value.deletable !== "boolean" ||
      ["currentCampaigns", "campaignMigrations", "campaignTransfers", "chronicleMemories", "modelChains"]
        .some((field) => !isNonNegativeInteger(blockers[field])) ||
      ["drafts", "forks", "imports"].some((field) => !isNonNegativeInteger(detachments[field]))) {
    return unexpectedWorldResponse();
  }
  return value as unknown as PublishedWorldSummary;
}

function parseCampaign(value: unknown): WorldCampaignSummary {
  if (!isRecord(value) || !isString(value.id) || !isString(value.title) ||
      !isString(value.status) || !["active", "archived"].includes(value.status) ||
      !isNonNegativeInteger(value.activeTurnNumber) ||
      !isString(value.worldVersionId) || !isPositiveInteger(value.worldVersionNumber) ||
      !isNullableString(value.selectedCharacterId) || !isNullableString(value.selectedCharacterName) ||
      !isString(value.turnControlStyle) ||
      !["action_only", "flexible_auto", "flexible_action", "flexible_scene"].includes(value.turnControlStyle) ||
      !isString(value.updatedAt)) {
    return unexpectedWorldResponse();
  }
  return value as unknown as WorldCampaignSummary;
}

export function parseWorldAggregate(value: unknown): WorldAggregate {
  if (!isRecord(value) || !isString(value.id) || !isString(value.title) ||
      !isString(value.status) || !["draft", "active", "archived"].includes(value.status) ||
      !isString(value.imageUrl) ||
      !isNullableString(value.forkedFromWorldId) || !isNullableString(value.forkedFromWorldVersionId) ||
      !isString(value.createdAt) || !isString(value.updatedAt) ||
      !(value.draftRevision === null || isPositiveInteger(value.draftRevision)) ||
      !isNullableString(value.draftBasedOnWorldVersionId) || !isNullableString(value.draftUpdatedAt) ||
      !Array.isArray(value.versions) || !Array.isArray(value.campaigns) ||
      !(value.draftContent === null || isRecord(value.draftContent))) {
    return unexpectedWorldResponse();
  }

  return {
    id: value.id,
    title: value.title,
    status: value.status as WorldAggregate["status"],
    imageUrl: value.imageUrl,
    forkedFromWorldId: value.forkedFromWorldId,
    forkedFromWorldVersionId: value.forkedFromWorldVersionId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    draftRevision: value.draftRevision,
    draftContent: value.draftContent === null ? null : parseEditableWorldDraft(value.draftContent),
    draftBasedOnWorldVersionId: value.draftBasedOnWorldVersionId,
    draftUpdatedAt: value.draftUpdatedAt,
    versions: value.versions.map(parseVersion),
    campaigns: value.campaigns.map(parseCampaign)
  };
}

export function createEmptyWorldDraft(): EditableWorldDraft {
  return {
    schemaVersion: 5,
    world: { title: "", genre: "", tone: "", premise: "", backgroundStory: "", firstAction: "", rules: "" },
    playableCharacters: [],
    entities: [],
    relationships: [],
    rpgStats: [],
    defaultTriggers: [],
    eventTriggers: [],
    assets: [],
    defaults: {}
  };
}

export function cloneWorldDraft(world: WorldAggregate): EditableWorldDraft {
  if (world.draftContent === null) return createEmptyWorldDraft();
  const draft = typeof structuredClone === "function"
    ? structuredClone(world.draftContent)
    : JSON.parse(JSON.stringify(world.draftContent)) as EditableWorldDraft;
  draft.schemaVersion = 5;
  return draft;
}

export function worldEditorPath(worldId: string): string {
  return `/app/worlds/${encodeURIComponent(worldId)}`;
}

export function worldIdFromPath(pathname: string): string | null {
  const match = /^\/app\/worlds\/([^/]+)$/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    const worldId = decodeURIComponent(match[1]);
    return worldId === "new" ? null : worldId;
  } catch {
    return null;
  }
}
