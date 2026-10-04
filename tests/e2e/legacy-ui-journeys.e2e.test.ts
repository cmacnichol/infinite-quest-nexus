import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  generationJobSnapshotSchema,
  generationResultSchema,
  readerSceneWindowResponseSchema
} from "../../packages/contracts/src/index.js";
import { quietLeafApiPayloads } from "../fixtures/quiet-leaf-payloads.js";
import { installLegacyUiFixture, legacyUiFixture } from "./helpers/legacy-ui-fixtures.js";

const legacyOrigin = `http://127.0.0.1:${process.env.PLAYWRIGHT_LEGACY_PORT ?? "43173"}`;
const webNextOrigin = `http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? "43174"}`;
const timestamp = "2026-10-03T12:00:00.000Z";
const worldId = "10000000-0000-4000-8000-000000000064";
const versionOneId = "10000000-0000-4000-8000-0000000000c8";
const versionTwoId = "10000000-0000-4000-8000-0000000000c9";
const campaignIds = [
  "10000000-0000-4000-8000-000000000190",
  "10000000-0000-4000-8000-000000000191",
  "10000000-0000-4000-8000-000000000192"
] as const;

type WriteRecord = Readonly<{ method: string; path: string; body: unknown }>;
type WorldVersion = Readonly<{ id: string; versionNumber: number; releaseNotes: string; content: Record<string, unknown> }>;
type JourneyWorld = {
  id: string;
  title: string;
  status: "draft" | "active";
  draftRevision: number;
  draftContent: Record<string, unknown>;
  latestVersionId: string | null;
  latestVersionNumber: number | null;
  versions: WorldVersion[];
  campaigns: Array<Record<string, unknown>>;
};
type JourneyCampaign = {
  id: string;
  title: string;
  worldVersionId: string;
  worldVersionNumber: number;
  selectedCharacterId: string;
  turnControlStyle: "action_only" | "flexible_action" | "flexible_scene";
  turns: Array<Record<string, unknown>>;
};
type JourneyApi = {
  readonly fixture: ReturnType<typeof legacyUiFixture>;
  readonly writes: WriteRecord[];
  readonly campaignCreates: Array<{ readonly id: string; readonly body: Record<string, unknown> }>;
  readonly generationCreates: Array<{ readonly campaignId: string; readonly body: Record<string, unknown> }>;
  readonly imageFailureReads: Array<{ readonly path: string; readonly status: number }>;
  readonly privateStateReads: string[];
  readonly privateStateCanaryResponses: Array<{ readonly campaignId: string; readonly scratchpad: string }>;
  readonly sceneWindowCaptures: Array<{
    readonly request: { readonly anchorTurnNumber: number; readonly anchorTurnId: string; readonly direction: "older" | "newer"; readonly neighborLimit: number; readonly historyToken: string | null };
    readonly response: ReturnType<typeof readerSceneWindowResponseSchema.parse>;
  }>;
  readonly world: () => JourneyWorld | null;
  readonly campaign: (campaignId: string) => JourneyCampaign | undefined;
  readonly seedAcceptedTurn: (campaignId: string, turnNumber: number, narration: string) => void;
  readonly setPrivateStateCanary: (campaignId: string, canary: string) => void;
  readonly delayNextCampaignCreate: (gate: Promise<void>) => void;
  readonly delayNextGeneration: (gate: Promise<void>) => void;
};

function versionId(versionNumber: number): string {
  return versionNumber === 1 ? versionOneId : versionTwoId;
}

function selectedCharacters(content: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(content.playableCharacters)
    ? content.playableCharacters as Array<Record<string, unknown>>
    : [];
}

async function installJourneyApi(page: Page, options: { readonly imageFailure?: boolean } = {}): Promise<JourneyApi> {
  const fixture = legacyUiFixture({ turnCount: 0, worldCount: 1, campaignCount: 1 });
  await installLegacyUiFixture(page, fixture);
  const basePayloads = quietLeafApiPayloads({ turnControlStyle: "flexible_action" });
  const turnTemplate = basePayloads.syncStatus.turns?.turns[0];
  if (!turnTemplate) throw new Error("The synthetic story fixture must provide a valid turn template.");
  const writes: WriteRecord[] = [];
  const campaignCreates: Array<{ id: string; body: Record<string, unknown> }> = [];
  const generationCreates: Array<{ campaignId: string; body: Record<string, unknown> }> = [];
  const imageFailureReads: Array<{ path: string; status: number }> = [];
  const privateStateReads: string[] = [];
  const privateStateCanaryResponses: Array<{ campaignId: string; scratchpad: string }> = [];
  const sceneWindowCaptures: Array<{
    request: { anchorTurnNumber: number; anchorTurnId: string; direction: "older" | "newer"; neighborLimit: number; historyToken: string | null };
    response: ReturnType<typeof readerSceneWindowResponseSchema.parse>;
  }> = [];
  const campaigns = new Map<string, JourneyCampaign>();
  const privateStateCanaries = new Map<string, string>();
  const jobs = new Map<string, {
    readonly campaignId: string;
    readonly action: string;
    readonly turnNumber: number;
    readonly resultTurnId: string;
    readonly turn: Record<string, unknown>;
  }>();
  let world: JourneyWorld | null = null;
  let nextCampaignCreateGate: Promise<void> | null = null;
  let nextGenerationGate: Promise<void> | null = null;

  const campaignRows = () => [...campaigns.values()].map(campaign => ({
    ...basePayloads.campaigns.campaigns[0]!,
    id: campaign.id,
    title: campaign.title,
    activeTurnNumber: campaign.turns.length,
    worldId,
    worldTitle: world?.title ?? "Journey World",
    worldVersionId: campaign.worldVersionId,
    worldVersionNumber: campaign.worldVersionNumber,
    latestWorldVersionNumber: world?.latestVersionNumber ?? campaign.worldVersionNumber,
    selectedCharacterId: campaign.selectedCharacterId,
    selectedCharacterName: String(selectedCharacters(world?.draftContent ?? {}).find(character => character.id === campaign.selectedCharacterId)?.name ?? "Mira Vale")
  }));

  const worldSummary = () => {
    if (!world) return [];
    const template = fixture.worlds[0]!;
    const contentWorld = world.draftContent.world as Record<string, unknown> | undefined;
    return [{
      ...template,
      id: world.id,
      title: world.title,
      status: world.status,
      campaignCount: world.campaigns.length,
      latestVersionId: world.latestVersionId,
      latestVersionNumber: world.latestVersionNumber,
      updatedAt: timestamp,
      latestPreview: world.latestVersionNumber === null ? null : contentWorld ?? {}
    }];
  };

  const responseForCampaign = (campaign: JourneyCampaign) => {
    const activeTurnNumber = campaign.turns.length;
    const version = world?.versions.find(candidate => candidate.id === campaign.worldVersionId);
    const versionWorld = version?.content.world as Record<string, unknown> | undefined;
    const syncCampaign = {
      ...basePayloads.syncStatus.campaign,
      id: campaign.id,
      title: campaign.title,
      activeTurnNumber,
      worldVersionId: campaign.worldVersionId,
      worldVersionNumber: campaign.worldVersionNumber,
      selectedCharacterId: campaign.selectedCharacterId,
      selectedCharacterName: String(selectedCharacters(version?.content ?? {}).find(character => character.id === campaign.selectedCharacterId)?.name ?? "Mira Vale")
    };
    return {
      ...basePayloads.syncStatus,
      campaign: syncCampaign,
      activeTurnNumber,
      world: {
        ...basePayloads.syncStatus.world,
        id: worldId,
        title: String(versionWorld?.title ?? world?.title ?? "Journey World"),
        versionNumber: campaign.worldVersionNumber,
        playableCharacters: selectedCharacters(version?.content ?? {})
      },
      turns: {
        campaignId: campaign.id,
        nextCursor: null,
        turns: campaign.turns
      }
    };
  };

  await page.route("**/api/v1/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = method === "GET" ? null : request.postDataJSON() as Record<string, unknown>;
    const respond = (payload: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
    if (method !== "GET" && method !== "HEAD") writes.push({ method, path, body });

    if (path === "/api/v1/worlds" && method === "GET") return respond({ worlds: worldSummary() });
    if (path === "/api/v1/worlds" && method === "POST") {
      const content = body?.content as Record<string, unknown>;
      world = {
        id: worldId,
        title: String(body?.title ?? "Journey World"),
        status: "draft",
        draftRevision: 1,
        draftContent: content,
        latestVersionId: null,
        latestVersionNumber: null,
        versions: [],
        campaigns: []
      };
      return respond({ id: worldId }, 201);
    }
    if (path === `/api/v1/worlds/${worldId}` && method === "GET") return respond(world ?? {});
    if (path === `/api/v1/worlds/${worldId}/draft` && method === "PUT") {
      if (world) {
        world.title = String(body?.title ?? world.title);
        world.draftContent = body?.content as Record<string, unknown>;
        world.draftRevision += 1;
      }
      return respond({});
    }
    if (path === `/api/v1/worlds/${worldId}/publish` && method === "POST") {
      if (!world) return respond({ error: "not_found" }, 404);
      const nextVersionNumber = world.versions.length + 1;
      const publishedVersion: WorldVersion = {
        id: versionId(nextVersionNumber),
        versionNumber: nextVersionNumber,
        releaseNotes: String(body?.releaseNotes ?? "Synthetic release"),
        content: structuredClone(world.draftContent)
      };
      world.versions.push(publishedVersion);
      world.latestVersionId = publishedVersion.id;
      world.latestVersionNumber = nextVersionNumber;
      world.status = "active";
      return respond({ versionNumber: nextVersionNumber });
    }
    if (path.startsWith("/api/v1/world-versions/") && path.endsWith("/playable-characters")) {
      const requestedVersionId = path.split("/").at(-2);
      const version = world?.versions.find(candidate => candidate.id === requestedVersionId);
      const characters = version ? selectedCharacters(version.content) : [];
      return respond({
        characters: characters.map(character => ({ id: character.id, name: character.name, rpgStatCount: 0, defaultTriggerCount: 0 })),
        readiness: { ready: characters.length > 0, issues: [] }
      });
    }
    if (path === "/api/v1/campaigns" && method === "GET") return respond({ campaigns: campaignRows() });
    if (path === "/api/v1/campaigns" && method === "POST") {
      const campaignIndex = campaignCreates.length;
      const campaignId = campaignIds[campaignIndex];
      if (!campaignId) return respond({ error: "fixture_exhausted" }, 500);
      campaignCreates.push({ id: campaignId, body: body ?? {} });
      const gate = nextCampaignCreateGate;
      nextCampaignCreateGate = null;
      if (gate) await gate;
      const requestedVersionId = String(body?.worldVersionId ?? world?.latestVersionId ?? versionOneId);
      const pinnedVersion = world?.versions.find(candidate => candidate.id === requestedVersionId);
      const campaign: JourneyCampaign = {
        id: campaignId,
        title: String(body?.title ?? `Journey Campaign ${campaignIndex + 1}`),
        worldVersionId: requestedVersionId,
        worldVersionNumber: pinnedVersion?.versionNumber ?? 1,
        selectedCharacterId: String(body?.selectedCharacterId ?? ""),
        turnControlStyle: (body?.turnControlStyle === "flexible_action" || body?.turnControlStyle === "flexible_scene")
          ? body.turnControlStyle
          : "action_only",
        turns: []
      };
      campaigns.set(campaignId, campaign);
      world?.campaigns.push({
        id: campaignId,
        title: campaign.title,
        worldVersionId: campaign.worldVersionId,
        worldVersionNumber: campaign.worldVersionNumber
      });
      return respond({ id: campaignId, title: campaign.title, selectedCharacterName: "Mira Vale" }, 201);
    }

    if (path.startsWith("/api/v1/generation-jobs/") && method === "GET") {
      const [jobId, suffix] = path.slice("/api/v1/generation-jobs/".length).split("/");
      const job = jobs.get(jobId ?? "");
      if (!job) return respond({ error: "not_found" }, 404);
      if (suffix === "stream") return route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
      if (suffix === "result") {
        const campaignForResult = campaigns.get(job.campaignId);
        if (campaignForResult && !campaignForResult.turns.some(turn => turn.id === job.resultTurnId)) {
          campaignForResult.turns.push(job.turn);
          campaignForResult.turns.sort((left, right) => Number(left.turnNumber) - Number(right.turnNumber));
        }
        return respond(generationResultSchema.parse({
          id: jobId,
          campaignId: job.campaignId,
          expectedTurnNumber: job.turnNumber,
          action: job.action,
          requestedInputMode: "action",
          resolvedInputMode: "action",
          inputModeSource: "explicit",
          operationKind: "append",
          replacementTurnId: null,
          attempts: 1,
          resultTurnId: job.resultTurnId,
          errorCode: null,
          errorMessage: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          status: "completed",
          turnNumber: job.turnNumber,
          inputMode: "action",
          narration: job.turn.narration,
          choices: [],
          customActionSuggestion: "",
          imagePrompt: job.turn.imagePrompt,
          imageUrl: null,
          acceptedAt: timestamp,
          chronicleRetrieval: null,
          modelMetadata: null,
          mechanics: null,
          stateSnapshot: {},
          reportedCost: null
        }));
      }
      return respond(generationJobSnapshotSchema.parse({
        id: jobId,
        campaignId: job.campaignId,
        expectedTurnNumber: job.turnNumber,
        action: job.action,
        requestedInputMode: "action",
        resolvedInputMode: "action",
        inputModeSource: "explicit",
        operationKind: "append",
        replacementTurnId: null,
        attempts: 1,
        resultTurnId: job.resultTurnId,
        errorCode: null,
        errorMessage: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        partialNarration: null,
        status: "completed"
      }));
    }

    const campaignPath = path.match(/^\/api\/v1\/campaigns\/([^/]+)\/(.+)$/u);
    if (campaignPath) {
      const campaignId = decodeURIComponent(campaignPath[1]!);
      const resource = campaignPath[2]!;
      const campaign = campaigns.get(campaignId);
      if (!campaign) return route.fallback();
      if (resource === "sync-status" && method === "GET") return respond(responseForCampaign(campaign));
      if (resource === "turns" && method === "GET") {
        const allTurns = campaign.turns;
        return respond({ campaignId, turns: allTurns.slice(-50), nextCursor: null });
      }
      if ((resource === "state" || resource === "state/inspection") && method === "GET") {
        privateStateReads.push(campaignId);
        const privateScratchpad = privateStateCanaries.get(campaignId);
        if (privateScratchpad !== undefined) privateStateCanaryResponses.push({ campaignId, scratchpad: privateScratchpad });
        return respond({
          ...basePayloads.runtimeState,
          campaignId,
          activeTurnNumber: campaign.turns.length,
          viewedTurnNumber: campaign.turns.length,
          ...(privateScratchpad !== undefined ? { scratchpad: privateScratchpad } : {})
        });
      }
      if (resource === "reader/scene-window" && method === "GET") {
        const direction = url.searchParams.get("direction");
        if (direction !== "older" && direction !== "newer") return respond({ error: "invalid_request" }, 400);
        const anchorTurnNumber = Number(url.searchParams.get("anchorTurnNumber"));
        const anchorTurnId = url.searchParams.get("anchorTurnId") ?? "";
        const neighborLimit = Number(url.searchParams.get("neighborLimit") ?? 9);
        const historyToken = url.searchParams.get("historyToken");
        const anchorIndex = campaign.turns.findIndex(turn => Number(turn.turnNumber) === anchorTurnNumber && turn.id === anchorTurnId);
        if (anchorIndex < 0) return respond({ error: "not_found" }, 404);
        const boundedLimit = Math.min(9, Math.max(1, neighborLimit));
        const start = direction === "older" ? Math.max(0, anchorIndex - boundedLimit) : anchorIndex;
        const end = direction === "older" ? anchorIndex + 1 : Math.min(campaign.turns.length, anchorIndex + boundedLimit + 1);
        const response = readerSceneWindowResponseSchema.parse({
          campaignId,
          anchor: { turnNumber: anchorTurnNumber, id: anchorTurnId },
          direction,
          turns: campaign.turns.slice(start, end),
          hasMore: direction === "older" ? start > 0 : end < campaign.turns.length,
          historyToken: "t35-synthetic-bounded-window-token"
        });
        sceneWindowCaptures.push({
          request: { anchorTurnNumber, anchorTurnId, direction, neighborLimit, historyToken },
          response
        });
        return respond(response);
      }
      if (resource === "story-memory" && method === "GET") return respond({ level: "off", reviewMode: "off", availableLevels: ["off"] });
      if (resource === "character-profile" && method === "GET") return respond({ campaignId, revision: 1, name: "Mira Vale", profile: {}, storedProfile: null, inheritedFromSnapshot: false, legacyCharacterText: "", rpgStats: [], defaultTriggers: [] });
      if (resource === "illustration-config" && method === "GET") {
        return respond(options.imageFailure ? { ...basePayloads.illustrationConfig, enabled: true, sourcePolicy: "generate" } : basePayloads.illustrationConfig);
      }
      if (resource === "illustration-segments" && method === "GET") {
        if (options.imageFailure && campaign.turns.length > 0) {
          imageFailureReads.push({ path: `/api/v1/campaigns/${campaignId}/${resource}`, status: 503 });
          return respond({ error: "Synthetic image service failure." }, 503);
        }
        return respond(basePayloads.illustrationSegments);
      }
      if (resource === "image-jobs" && method === "GET") {
        if (options.imageFailure && campaign.turns.length > 0) {
          imageFailureReads.push({ path: `/api/v1/campaigns/${campaignId}/${resource}`, status: 503 });
          return respond({ error: "Synthetic image service failure." }, 503);
        }
        return respond({ jobs: [] });
      }
      if (resource === "reader/history" && method === "GET") {
        const query = url.searchParams.get("q")?.toLocaleLowerCase() ?? "";
        const items = campaign.turns
          .filter(turn => !query || `${turn.action} ${turn.narration}`.toLocaleLowerCase().includes(query))
          .slice(-50)
          .reverse()
          .map(turn => ({ id: turn.id, turnNumber: turn.turnNumber, acceptedAt: turn.acceptedAt, excerpt: String(turn.narration).slice(0, 240) }));
        return respond({ campaignId, items, nextCursor: null });
      }
      const exactTurn = resource.match(/^reader\/turns\/(\d+)$/u);
      if (exactTurn && method === "GET") {
        const found = campaign.turns.find(turn => Number(turn.turnNumber) === Number(exactTurn[1]));
        return found ? respond({ campaignId, turn: found }) : respond({ error: "not_found" }, 404);
      }
      if (resource === "generations" && method === "POST") {
        const jobNumber = generationCreates.length + 1;
        generationCreates.push({ campaignId, body: body ?? {} });
        const gate = nextGenerationGate;
        nextGenerationGate = null;
        if (gate) await gate;
        const jobId = `20000000-0000-4000-8000-${jobNumber.toString(16).padStart(12, "0")}`;
        const turnNumber = campaign.turns.length + 1;
        const action = String(body?.action ?? "");
        const resultTurnId = `30000000-0000-4000-8000-${jobNumber.toString(16).padStart(12, "0")}`;
        const turn = {
          ...turnTemplate,
          id: resultTurnId,
          turnNumber,
          action,
          narration: `Synthetic accepted scene ${turnNumber}.`,
          choices: [],
          imagePrompt: "A synthetic scene illustration.",
          acceptedAt: timestamp
        };
        jobs.set(jobId, { campaignId, action, turnNumber, resultTurnId, turn });
        return respond({ id: jobId, status: "queued", duplicate: false, operationKind: "append", replacementTurnId: null }, 202);
      }
    }
    return route.fallback();
  });

  const html = await readFile("apps/web/public/story.html", "utf8");
  await page.route("**/story/*", route => route.fulfill({ contentType: "text/html", body: html.replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts") }));

  return {
    fixture,
    writes,
    campaignCreates,
    generationCreates,
    imageFailureReads,
    privateStateReads,
    privateStateCanaryResponses,
    sceneWindowCaptures,
    world: () => world,
    campaign: campaignId => campaigns.get(campaignId),
    seedAcceptedTurn(campaignId, turnNumber, narration) {
      const campaign = campaigns.get(campaignId);
      if (!campaign) throw new Error(`Unknown synthetic campaign ${campaignId}`);
      campaign.turns.push({ ...turnTemplate, id: `40000000-0000-4000-8000-${turnNumber.toString(16).padStart(12, "0")}`, turnNumber, narration });
      campaign.turns.sort((left, right) => Number(left.turnNumber) - Number(right.turnNumber));
    },
    setPrivateStateCanary(campaignId, canary) {
      if (!campaigns.has(campaignId)) throw new Error(`Unknown synthetic campaign ${campaignId}`);
      privateStateCanaries.set(campaignId, canary);
    },
    delayNextCampaignCreate(gate) { nextCampaignCreateGate = gate; },
    delayNextGeneration(gate) { nextGenerationGate = gate; }
  };
}

async function openNewWorld(page: Page, title: string): Promise<void> {
  await page.goto(`${legacyOrigin}/nexus/index.html#world-library`);
  await page.locator("#newWorld").click();
  await page.locator("#worldTitle").fill(title);
  await page.locator('[data-world-author-step="character"]').click();
  await page.locator("#addPlayableCharacter").click();
  await page.locator("#characterName").fill("Mira Vale");
  await page.locator("#characterRole").fill("A patient guide");
  await page.locator("#saveCharacter").click();
  await expect(page.locator("#playableCharacterRoster")).toContainText("Mira Vale");
  await page.locator("#saveWorldDraft").click();
  await expect(page.locator("#worldAuthorDialog")).toBeHidden();
}

async function selectJourneyWorld(page: Page, title: string): Promise<void> {
  await page.locator("#worldManagementCarousel").getByRole("button", { name: `Select ${title}` }).click();
}

async function createJourneyCampaign(page: Page, title: string, start = false): Promise<void> {
  await page.locator("#createCampaignModalBtn").click();
  await expect(page.locator("#createCampaignDialog")).toBeVisible();
  await page.locator("#newCampaignTitle").fill(title);
  await page.locator("#newCampaignCharacter").selectOption({ label: "Mira Vale" });
  await page.getByRole("button", { name: start ? "Create and start" : "Create only" }).click();
}

async function createAndPublishJourneyWorld(page: Page, title = "T35 Journey World"): Promise<void> {
  await openNewWorld(page, title);
  await selectJourneyWorld(page, title);
  await page.locator("#publishWorld").click();
  await expect(page.locator("#worldStatus")).toContainText("Version 1 published");
}

async function startJourneyCampaign(page: Page, api: JourneyApi, title: string): Promise<string> {
  await createJourneyCampaign(page, title, true);
  const campaignId = api.campaignCreates.at(-1)?.id;
  if (!campaignId) throw new Error("Campaign creation did not return a synthetic campaign identity.");
  await expect(page).toHaveURL(new RegExp(`/story/${campaignId}$`, "u"));
  await expect(page.locator("#freeAction")).toBeVisible();
  return campaignId;
}

async function fillAndSubmitAction(page: Page, api: JourneyApi, campaignId: string, action: string): Promise<void> {
  const priorTurns = api.campaign(campaignId)?.turns ?? [];
  const priorIds = new Set(priorTurns.map(turn => String(turn.id)));
  const expectedTurnNumber = priorTurns.reduce((latest, turn) => Math.max(latest, Number(turn.turnNumber)), 0) + 1;
  await page.locator("#freeAction").fill(action);
  await page.locator("#btnTakeAction").click();
  await expect.poll(() => api.campaign(campaignId)?.turns.some(turn =>
    Number(turn.turnNumber) === expectedTurnNumber
      && !priorIds.has(String(turn.id))
      && String(turn.narration).includes(`Synthetic accepted scene ${expectedTurnNumber}.`)
  ) ?? false).toBe(true);
  await expect(page.locator(`#scene-${expectedTurnNumber} .scene-narration`)).toContainText(`Synthetic accepted scene ${expectedTurnNumber}.`);
  await expect(page.locator("#storySyncStatus")).toContainText("Story synced");
}

async function readSavedReaderPosition(page: Page, userId: string, campaignId: string): Promise<{ readonly turnId: string; readonly turnNumber: number } | null> {
  return page.evaluate(async ({ storageKey }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("infiniteQuest-reader-positions-v1", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const record = await new Promise<{ position?: { turnId?: unknown; turnNumber?: unknown } } | undefined>((resolve, reject) => {
      const request = database.transaction("positions", "readonly").objectStore("positions").get(storageKey);
      request.onsuccess = () => resolve(request.result as { position?: { turnId?: unknown; turnNumber?: unknown } } | undefined);
      request.onerror = () => reject(request.error);
    });
    database.close();
    const turnId = record?.position?.turnId;
    const turnNumber = record?.position?.turnNumber;
    return typeof turnId === "string" && typeof turnNumber === "number" ? { turnId, turnNumber } : null;
  }, { storageKey: `${userId}:${campaignId}` });
}

test("whole_journey_no_lost_draft: new world, character, publish, campaign, reload, older history and latest resume", async ({ page }) => {
  const api = await installJourneyApi(page);
  await createAndPublishJourneyWorld(page);
  const campaignId = await startJourneyCampaign(page, api, "T35 First Campaign");

  await fillAndSubmitAction(page, api, campaignId, "Look for the quiet platform signal.");
  await fillAndSubmitAction(page, api, campaignId, "Follow the marked path to the signal.");
  const acceptedTurns = api.campaign(campaignId)?.turns ?? [];
  expect(acceptedTurns.map(turn => Number(turn.turnNumber))).toEqual([1, 2]);
  const latestTurnId = String(acceptedTurns[1]?.id ?? "");
  expect(latestTurnId).not.toBe("");
  await page.locator("#freeAction").fill("Keep this next action for after the history check.");
  await expect(page.locator("#autosaveStatus")).toHaveText("Draft saved");
  await page.reload();
  await expect(page.locator("#freeAction")).toHaveValue("Keep this next action for after the history check.");
  await expect(page.locator("#scene-2 .scene-narration")).toContainText("Synthetic accepted scene 2.");
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 2 of 2");

  await page.locator("[data-story-reader-toolbar]").getByRole("button", { name: "History" }).click();
  const firstTurn = page.locator('#turnHistoryModalList .history-card[data-turn-number="1"]');
  await expect(firstTurn).toBeVisible();
  await firstTurn.click();
  await expect(firstTurn).toHaveAttribute("aria-pressed", "true");
  await page.locator("#btnTurnHistoryJump").click();
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 1 of 2");
  await expect(page.locator("#freeAction")).toHaveValue("Keep this next action for after the history check.");
  await page.locator("[data-story-reader-toolbar]").getByRole("button", { name: "History" }).click();
  await page.locator("#btnTurnHistoryJumpLatest").click();
  await expect(page.locator("#readerTurnCount")).toHaveText("Turn 2 of 2");
  await expect(page.locator("#scene-2 .scene-narration")).toContainText("Synthetic accepted scene 2.");
  await expect(page.locator("#freeAction")).toHaveValue("Keep this next action for after the history check.");
  await expect.poll(() => readSavedReaderPosition(page, String((api.fixture.session.user as Record<string, unknown>).id), campaignId))
    .toEqual({ turnId: latestTurnId, turnNumber: 2 });
  expect(api.generationCreates).toHaveLength(2);
  expect(api.campaign(campaignId)?.worldVersionId).toBe(versionOneId);
});

test("existing_campaign_version_unchanged: publishing edits creates a new pin without migrating current campaigns", async ({ page }) => {
  const api = await installJourneyApi(page);
  await createAndPublishJourneyWorld(page, "T35 Versioned World");
  const firstPublishedContent = structuredClone(api.world()?.versions[0]?.content);
  await createJourneyCampaign(page, "Pinned Version One");
  const oldCampaignId = api.campaignCreates.at(-1)?.id;
  expect(api.campaignCreates[0]?.body.worldVersionId).toBe(versionOneId);
  expect(api.campaign(oldCampaignId ?? "")?.worldVersionId).toBe(versionOneId);

  await page.locator("#editWorldDraft").click();
  await page.locator("#worldTitle").fill("T35 Versioned World Revised");
  await page.locator("#saveWorldDraft").click();
  await expect(page.locator("#worldAuthorDialog")).toBeHidden();
  await page.locator("#publishWorld").click();
  await expect(page.locator("#worldStatus")).toContainText("Version 2 published");
  expect(api.campaign(oldCampaignId ?? "")?.worldVersionId).toBe(versionOneId);
  expect(api.world()?.versions[0]?.content).toEqual(firstPublishedContent);
  expect((api.world()?.versions[1]?.content.world as Record<string, unknown> | undefined)?.title)
    .toBe("T35 Versioned World Revised");

  await createJourneyCampaign(page, "Explicit Version Two Campaign");
  const newCampaignId = api.campaignCreates.at(-1)?.id;
  expect(api.campaignCreates[1]?.body.worldVersionId).toBe(versionTwoId);
  expect(api.campaign(newCampaignId ?? "")?.worldVersionId).toBe(versionTwoId);
  expect(api.campaign(oldCampaignId ?? "")?.worldVersionNumber).toBe(1);

  if (!oldCampaignId) throw new Error("The first synthetic campaign was not created.");
  await page.goto(`${legacyOrigin}/story/${oldCampaignId}`);
  await page.locator("#btnOpenWorldSetup").click();
  await expect(page.locator("#setupWorldVersion")).toHaveText("T35 Versioned World v1");
});

test("duplicate_create_and_generation_guard: a held submit produces one campaign and one generation", async ({ page }) => {
  const api = await installJourneyApi(page);
  await createAndPublishJourneyWorld(page);
  let releaseCreate!: () => void;
  const createGate = new Promise<void>(resolve => { releaseCreate = resolve; });
  api.delayNextCampaignCreate(createGate);
  await page.locator("#createCampaignModalBtn").click();
  await page.locator("#newCampaignTitle").fill("Guarded Campaign");
  await page.locator("#newCampaignCharacter").selectOption({ label: "Mira Vale" });
  await page.getByRole("button", { name: "Create and start" }).click();
  await expect.poll(() => api.campaignCreates.length).toBe(1);
  await page.locator("#createCampaignDialog form").evaluate(form => (form as HTMLFormElement).requestSubmit());
  await page.locator("#createCampaignDialog form").evaluate(form => (form as HTMLFormElement).requestSubmit());
  expect(api.campaignCreates).toHaveLength(1);
  releaseCreate();
  const campaignId = api.campaignCreates[0]!.id;
  await expect(page).toHaveURL(new RegExp(`/story/${campaignId}$`, "u"));

  let releaseGeneration!: () => void;
  const generationGate = new Promise<void>(resolve => { releaseGeneration = resolve; });
  api.delayNextGeneration(generationGate);
  await page.locator("#freeAction").fill("Submit this accepted action once.");
  await page.locator("#btnTakeAction").click();
  await expect.poll(() => api.generationCreates.length).toBe(1);
  await page.locator("#freeAction").evaluate(field => (field as HTMLTextAreaElement).form?.requestSubmit());
  await page.locator("#freeAction").evaluate(field => (field as HTMLTextAreaElement).form?.requestSubmit());
  expect(api.generationCreates).toHaveLength(1);
  releaseGeneration();
  await expect(page.locator("#scene-1 .scene-narration")).toContainText("Synthetic accepted scene 1.");
  expect(api.generationCreates[0]?.body).toMatchObject({ action: "Submit this accepted action once.", idempotencyKey: expect.any(String) });
});

test("cross_campaign_public_scenes_and_private_state_stay_scoped: public scenes and private state remain correctly scoped", async ({ page }) => {
  const api = await installJourneyApi(page);
  await createAndPublishJourneyWorld(page);
  const firstCampaignId = await startJourneyCampaign(page, api, "Private Scope A");
  await page.goto(`${legacyOrigin}/nexus/index.html#world-library`);
  await selectJourneyWorld(page, "T35 Journey World");
  await createJourneyCampaign(page, "Private Scope B");
  const secondCampaignId = api.campaignCreates.at(-1)?.id;
  if (!secondCampaignId) throw new Error("Second synthetic campaign was not created.");
  const publicCanary = "T35_SYNTHETIC_PUBLIC_CAMPAIGN_B_SCENE";
  const privateCanary = "T35_SYNTHETIC_PRIVATE_CAMPAIGN_B_SCRATCHPAD";
  api.seedAcceptedTurn(secondCampaignId, 1, publicCanary);
  api.setPrivateStateCanary(secondCampaignId, privateCanary);

  await page.goto(`${legacyOrigin}/story/${firstCampaignId}`);
  await page.locator("#freeAction").fill("Draft belonging only to campaign A.");
  await expect(page.locator("#autosaveStatus")).toHaveText("Draft saved");
  await expect(page.locator("body")).not.toContainText(publicCanary);
  await expect(page.locator("body")).not.toContainText(privateCanary);

  await page.goto(`${legacyOrigin}/story/${secondCampaignId}`);
  await expect(page.locator("#scene-1 .scene-narration")).toContainText(publicCanary);
  await expect(page.locator("body")).not.toContainText(privateCanary);
  await expect(page.locator("#freeAction")).toHaveValue("");
  await expect(page.locator("body")).not.toContainText("Draft belonging only to campaign A.");
  await expect.poll(() => api.privateStateReads.includes(secondCampaignId)).toBe(true);
  expect(api.privateStateCanaryResponses).toContainEqual({ campaignId: secondCampaignId, scratchpad: privateCanary });

  await page.goto(`${legacyOrigin}/story/${firstCampaignId}`);
  await expect(page.locator("#freeAction")).toHaveValue("Draft belonging only to campaign A.");
  await expect(page.locator("body")).not.toContainText(privateCanary);
  expect(api.campaign(firstCampaignId)?.turns).toEqual([]);
});

test("image_failure_independent: unavailable image reads do not remove an accepted narration", async ({ page }) => {
  const api = await installJourneyApi(page, { imageFailure: true });
  await createAndPublishJourneyWorld(page);
  await startJourneyCampaign(page, api, "Image Failure Campaign");
  await page.locator("#freeAction").fill("Continue even when an optional image service is unavailable.");
  await page.locator("#btnTakeAction").click();
  await expect(page.locator("#scene-1 .scene-narration")).toContainText("Synthetic accepted scene 1.");
  await expect.poll(() => api.imageFailureReads.some(read =>
    read.path.startsWith(`/api/v1/campaigns/${api.campaignCreates[0]!.id}/`)
      && ["illustration-segments", "image-jobs"].some(resource => read.path.endsWith(`/${resource}`))
      && read.status === 503
  )).toBe(true);
  await expect(page.locator("#storyIllustrationPanel [role=status]")).toContainText("Illustration status could not be loaded");
  await expect(page.locator('#storyIllustrationPanel [data-action="refresh-illustrations"]')).toBeVisible();
  expect(api.campaignCreates).toHaveLength(1);
  expect(api.generationCreates).toHaveLength(1);
  await expect(page.locator("#storySyncStatus")).toContainText("Story synced");
  expect(api.campaign(api.campaignCreates[0]!.id)?.turns).toHaveLength(1);
  expect(api.writes.some(write => write.path.endsWith("/state") || write.path.endsWith("/illustration-segments") || write.path.endsWith("/image-jobs"))).toBe(false);
});

test("existing_routes_and_contracts_compatible: /nexus, /story and /app read the same accepted fixture", async ({ page }) => {
  const fixture = legacyUiFixture({ turnCount: 2, worldCount: 1, campaignCount: 1 });
  const requests = await installLegacyUiFixture(page, fixture);
  const html = await readFile("apps/web/public/story.html", "utf8");
  await page.route(`${legacyOrigin}/story/${fixture.campaignId}`, route => route.fulfill({
    contentType: "text/html",
    body: html.replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts")
  }));

  await page.goto(`${legacyOrigin}/nexus/index.html#dashboard`);
  await expect(page.locator("#dashboardWorlds")).toBeVisible();
  await page.goto(`${legacyOrigin}/story/${fixture.campaignId}`);
  await expect(page.locator("#scene-2 .scene-narration")).toContainText("synthetic station remains quiet");
  await page.goto(`${webNextOrigin}/app/story/${fixture.campaignId}`);
  await expect(page.getByRole("textbox", { name: "Custom Action", exact: true })).toBeVisible();
  await expect(page.locator("#scene-2 .scene-narration")).toContainText("synthetic station remains quiet in scene 2.");

  expect(requests.requests.filter(request => request.path === `/api/v1/campaigns/${fixture.campaignId}/sync-status`).length).toBeGreaterThanOrEqual(2);
  expect(requests.requests.some(request => request.path === `/api/v1/campaigns/${fixture.campaignId}/turns`)).toBe(true);
  expect(requests.writes).toEqual([]);
});

test("advanced_experience_edit_and_save: mechanics edits persist in a saved draft without moving an existing pin", async ({ page }) => {
  const api = await installJourneyApi(page);
  await createAndPublishJourneyWorld(page, "T35 Experienced World");
  await createJourneyCampaign(page, "Experienced Existing Campaign");
  const campaignId = api.campaignCreates[0]!.id;
  await page.locator("#editWorldDraft").click();
  await page.locator('[data-world-author-step="character"]').click();
  await page.getByRole("button", { name: "Edit Mira Vale" }).click();
  await page.locator("#characterMechanics > summary").click();
  await page.locator("#addCharacterStat").click();
  const lastStat = page.locator("#characterStats .character-edit-row").last();
  await lastStat.locator('[data-character-field="name"]').fill("Resolve");
  await lastStat.locator('[data-character-field="value"]').fill("17");
  await page.locator("#saveCharacter").click();
  await page.locator("#saveWorldDraft").click();
  await expect(page.locator("#worldAuthorDialog")).toBeHidden();

  const savedCharacters = api.world()?.draftContent.playableCharacters as Array<Record<string, unknown>> | undefined;
  expect(savedCharacters?.[0]?.rpgStats).toEqual([expect.objectContaining({ name: "Resolve", value: 17 })]);
  expect(api.campaign(campaignId)?.worldVersionId).toBe(versionOneId);
  expect(api.writes.filter(write => write.method === "PUT" && write.path === `/api/v1/worlds/${worldId}/draft`)).toHaveLength(1);
});

test("explicit_reader_window_bounds: startup and older-scene paging stay bounded for 0, 1, 50, 317 and 2000 turns", async ({ browser }) => {
  for (const turnCount of [0, 1, 50, 317, 2000]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const fixture = legacyUiFixture({ turnCount, worldCount: 1, campaignCount: 1 });
    const fixtureUser = fixture.session.user as Record<string, unknown>;
    fixtureUser.id = `50000000-0000-4000-8000-${turnCount.toString(16).padStart(12, "0")}`;
    const settings = fixtureUser.settings as Record<string, unknown>;
    fixtureUser.settings = { ...settings, continuousReading: true };
    const instrumentation = await installLegacyUiFixture(page, fixture);
    const requests: Array<{ method: string; path: string; url: string }> = [];
    const sceneWindowResponses: Array<{
      readonly request: { readonly anchorTurnNumber: number; readonly anchorTurnId: string; readonly direction: "older" | "newer"; readonly neighborLimit: number };
      readonly response: ReturnType<typeof readerSceneWindowResponseSchema.parse>;
    }> = [];
    page.on("request", request => {
      const url = new URL(request.url());
      requests.push({ method: request.method(), path: url.pathname, url: request.url() });
    });
    const html = await readFile("apps/web/public/story.html", "utf8");
    await page.route(`${legacyOrigin}/story/${fixture.campaignId}`, route => route.fulfill({
      contentType: "text/html",
      body: html.replace("/nexus/legacy-client.js", "/nexus/src/legacy-client-entry.ts")
    }));
    await page.route(`**/api/v1/campaigns/${fixture.campaignId}/reader/scene-window**`, async route => {
      const url = new URL(route.request().url());
      const direction = url.searchParams.get("direction");
      if (direction !== "older" && direction !== "newer") return route.fulfill({ status: 400, json: { error: "invalid_request" } });
      const anchorTurnNumber = Number(url.searchParams.get("anchorTurnNumber"));
      const anchorTurnId = url.searchParams.get("anchorTurnId") ?? "";
      const anchorIndex = fixture.turns.findIndex(turn => Number(turn.turnNumber) === anchorTurnNumber && turn.id === anchorTurnId);
      if (anchorIndex < 0) return route.fulfill({ status: 404, json: { error: "not_found" } });
      const requestedLimit = Number(url.searchParams.get("neighborLimit") ?? 9);
      const limit = Math.min(9, Math.max(1, requestedLimit));
      const start = direction === "older" ? Math.max(0, anchorIndex - limit) : anchorIndex;
      const end = direction === "older" ? anchorIndex + 1 : Math.min(fixture.turns.length, anchorIndex + limit + 1);
      const response = readerSceneWindowResponseSchema.parse({
        campaignId: fixture.campaignId,
        anchor: { turnNumber: anchorTurnNumber, id: anchorTurnId },
        direction,
        turns: fixture.turns.slice(start, end),
        hasMore: direction === "older" ? start > 0 : end < fixture.turns.length,
        historyToken: "t35-synthetic-bounded-window-token"
      });
      sceneWindowResponses.push({
        request: { anchorTurnNumber, anchorTurnId, direction, neighborLimit: requestedLimit },
        response
      });
      return route.fulfill({ json: response });
    });

    try {
      await page.goto(`${legacyOrigin}/story/${fixture.campaignId}`);
      if (turnCount === 0) {
        await expect(page.locator("#storySyncStatus")).toContainText("Story synced");
        await expect(page.locator("#storyArea .scene[data-turn-number]")).toHaveCount(0);
      } else {
        await expect(page.locator(`#scene-${turnCount}`)).toBeVisible();
      }
      const renderedScenes = await page.locator("#storyArea .scene[data-turn-number]").count();
      expect(renderedScenes, `rendered scene bound for ${turnCount} accepted turns`).toBeLessThanOrEqual(10);
      expect(sceneWindowResponses, `startup must not fetch a scene group for ${turnCount} turns`).toHaveLength(0);
      if (turnCount > 1) {
        const olderScenes = page.getByRole("button", { name: "Load older scenes" });
        await expect(olderScenes).toBeEnabled();
        await olderScenes.click();
        await expect.poll(() => sceneWindowResponses.length).toBe(1);
        const capture = sceneWindowResponses[0]!;
        expect(capture.request.direction).toBe("older");
        expect(capture.request.neighborLimit).toBeGreaterThanOrEqual(1);
        expect(capture.request.neighborLimit).toBeLessThanOrEqual(9);
        expect(capture.response.anchor).toEqual({
          turnNumber: capture.request.anchorTurnNumber,
          id: capture.request.anchorTurnId
        });
        expect(fixture.turns.some(turn => Number(turn.turnNumber) === capture.request.anchorTurnNumber && turn.id === capture.request.anchorTurnId)).toBe(true);
        expect(capture.response.turns.length).toBeLessThanOrEqual(10);
        expect(capture.response.turns.at(-1)).toMatchObject(capture.response.anchor);
        expect(capture.response.hasMore).toBe(true);
        expect(sceneWindowResponses).toHaveLength(1);
        await expect.poll(() => page.locator("#storyArea .scene[data-turn-number]").evaluateAll(scenes =>
          scenes.map(scene => Number((scene as HTMLElement).dataset.turnNumber))
        )).toEqual(capture.response.turns.map(turn => Number(turn.turnNumber)));
        await expect(page.locator("#storyArea .scene[data-turn-number]")).toHaveCount(capture.response.turns.length);
        expect(await page.locator("#storyArea .scene[data-turn-number]").count()).toBeLessThanOrEqual(10);
      } else {
        expect(sceneWindowResponses, `no scene paging request is possible for ${turnCount} turns`).toHaveLength(0);
      }
      const cursorReads = requests.filter(request => {
        const url = new URL(request.url);
        return request.method === "GET"
          && request.path === `/api/v1/campaigns/${fixture.campaignId}/turns`
          && url.searchParams.has("before");
      });
      expect(cursorReads, `startup cursor reads for ${turnCount} accepted turns`).toEqual([]);
      expect(instrumentation.requests.filter(request => request.path === `/api/v1/campaigns/${fixture.campaignId}/sync-status`)).toHaveLength(1);
      expect(instrumentation.writes).toEqual([]);
    } finally {
      await context.close();
    }
  }
});
