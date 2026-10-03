import type { Page, Route } from "@playwright/test";
import { quietLeafApiPayloads } from "../../fixtures/quiet-leaf-payloads.js";
import type {
  LegacyUiFixture,
  LegacyUiFixtureOptions,
  LegacyUiRequestRecord,
  LegacyUiRouteInstrumentation,
  LegacyUiRouteOptions
} from "./legacy-ui-fixtures.types.js";

const fixtureCanaries = ["PRIVATE-CANARY-", "HIDDEN-MECHANIC-CANARY-", "SCRATCHPAD-CANARY-"] as const;
const base = quietLeafApiPayloads({ completeHistory: true });
const timestamp = "2026-10-03T12:00:00.000Z";

function syntheticId(index: number): string {
  return `10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function worldContent(title: string): Record<string, unknown> {
  return {
    schemaVersion: 5,
    world: {
      title,
      genre: "Quiet mystery",
      tone: "Reflective",
      premise: "A small, fully synthetic setting used for repeatable interface checks.",
      backgroundStory: "The town grew around a station that no longer appears on maps.",
      firstAction: "Look along the empty platform.",
      rules: "Describe observable events in clear language."
    },
    playableCharacters: [{
      id: "fixture-observer",
      name: "The Observer",
      description: "A curious traveler following a trail of chalk marks.",
      personality: "Patient and attentive.",
      background: "Arrived on the last train.",
      goals: ["Find the source of the signals."],
      traits: []
    }],
    entities: [],
    relationships: [],
    rpgStats: [],
    defaultTriggers: [],
    eventTriggers: [],
    assets: [],
    defaults: {}
  };
}

function syntheticTurn(turnNumber: number): Record<string, unknown> {
  return {
    id: syntheticId(10_000 + turnNumber),
    turnNumber,
    action: turnNumber === 1 ? "Look along the empty platform." : `Follow the marked path ${turnNumber}.`,
    inputMode: "action",
    inputModeSource: "explicit",
    narration: `The synthetic station remains quiet in scene ${turnNumber}. A pale chalk mark leads toward the old ticket window. Rain taps against the roof while the platform clock keeps steady time.`,
    choices: ["Inspect the ticket window", "Follow the chalk mark", "Wait by the platform"],
    customActionSuggestion: "",
    imagePrompt: "",
    imageUrl: null,
    acceptedAt: timestamp,
    chronicleRetrieval: null,
    reportedCost: null
  };
}

export function legacyUiFixture(options: LegacyUiFixtureOptions = {}): LegacyUiFixture {
  const turnCount = options.turnCount ?? 50;
  const worldCount = options.worldCount ?? 3;
  const campaignCount = options.campaignCount ?? 2;
  for (const [name, value] of Object.entries({ turnCount, worldCount, campaignCount })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
  }

  const worlds: Record<string, unknown>[] = [];
  const worldDetails = new Map<string, Record<string, unknown>>();
  for (let index = 0; index < worldCount; index += 1) {
    const id = syntheticId(100 + index);
    const versionId = syntheticId(200 + index);
    const title = `Fixture World ${index + 1}`;
    const content = worldContent(title);
    const world = {
      ...base.worlds.worlds[0],
      id,
      title,
      createdAt: timestamp,
      updatedAt: timestamp,
      latestVersionId: versionId,
      latestPreview: (content.world as Record<string, unknown>),
      campaignCount: 0
    };
    worlds.push(world);
    worldDetails.set(id, {
      ...world,
      draftRevision: 1,
      versions: [{ id: versionId, versionNumber: 1, releaseNotes: "Synthetic browser fixture", publishedAt: timestamp, content }],
      campaigns: [],
      draftContent: content,
      content
    });
  }

  const primaryWorldId = String(worlds[0]?.id ?? syntheticId(100));
  const primaryVersionId = String(worldDetails.get(primaryWorldId)?.latestVersionId ?? syntheticId(200));
  const campaignId = syntheticId(300);
  const turns = Array.from({ length: turnCount }, (_, index) => syntheticTurn(index + 1));
  const campaigns = Array.from({ length: campaignCount }, (_, index) => ({
    ...base.campaigns.campaigns[0],
    id: index === 0 ? campaignId : syntheticId(300 + index),
    title: `Fixture Campaign ${index + 1}`,
    activeTurnNumber: index === 0 ? turnCount : Math.max(0, turnCount - index),
    createdAt: timestamp,
    updatedAt: timestamp,
    worldId: primaryWorldId,
    worldTitle: String(worlds[0]?.title ?? "Fixture World 1"),
    worldVersionId: primaryVersionId,
    worldVersionNumber: 1,
    selectedCharacterId: "fixture-observer",
    selectedCharacterName: "The Observer"
  }));
  const syncStatus = {
    ...base.syncStatus,
    campaign: {
      ...base.syncStatus.campaign,
      id: campaignId,
      title: "Fixture Campaign 1",
      activeTurnNumber: turnCount,
      worldVersionId: primaryVersionId,
      updatedAt: timestamp,
      selectedCharacterId: "fixture-observer",
      selectedCharacterName: "The Observer",
      characterSnapshot: null,
      characterProfile: null
    },
    world: {
      ...base.syncStatus.world,
      id: primaryWorldId,
      title: String(worlds[0]?.title ?? "Fixture World 1"),
      premise: "A small, fully synthetic setting used for repeatable interface checks.",
      playableCharacters: []
    },
    turns: {
      campaignId,
      nextCursor: turnCount > 50 ? `before-${turnCount - 49}` : null,
      turns: turns.slice(-50)
    }
  };
  const runtimeState = {
    ...base.runtimeState,
    campaignId,
    activeTurnNumber: turnCount,
    viewedTurnNumber: turnCount,
    isCurrent: true,
    continuitySummary: "A synthetic fixture state for browser checks."
  };
  const session = {
    ...base.session,
    user: { ...base.session.user, id: syntheticId(999), displayName: "Fixture Reader" }
  };
  const fixture = {
    turnCount,
    worlds,
    worldDetails,
    campaigns,
    campaignId,
    worldId: primaryWorldId,
    worldVersionId: primaryVersionId,
    turns,
    syncStatus,
    runtimeState,
    session,
    dashboardStats: {
      worlds: { total: worldCount, available: worldCount, published: worldCount },
      campaigns: { total: campaignCount, active: campaignCount, archived: 0 },
      turns: { total: turnCount * campaignCount },
      costs: { totalUsd: 0, byProvider: [] }
    }
  } satisfies LegacyUiFixture;

  const serialized = JSON.stringify(fixture);
  if (fixtureCanaries.some(canary => serialized.includes(canary))) throw new Error("Synthetic fixture includes a prohibited private-data canary");
  return fixture;
}

export async function installLegacyUiFixture(
  page: Page,
  fixture: LegacyUiFixture,
  options: LegacyUiRouteOptions = {}
): Promise<LegacyUiRouteInstrumentation> {
  const requests: LegacyUiRequestRecord[] = [];
  const writes: LegacyUiRouteInstrumentation["writes"] = [];
  const pendingDelays: Array<() => void> = [];

  const fulfill = async (route: Route, body: unknown, status = 200) => {
    const serialized = JSON.stringify(body);
    await route.fulfill({ status, contentType: "application/json", body: serialized });
    return { status, responseBytes: Buffer.byteLength(serialized) };
  };

  await page.route("**/api/v1/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;
    const requestBody = request.postData() ?? "";
    const record: LegacyUiRequestRecord = {
      method,
      path,
      requestBytes: Buffer.byteLength(requestBody),
      responseBytes: 0,
      startedAt: performance.now()
    };
    requests.push(record);
    if (method !== "GET" && method !== "HEAD") {
      let body: unknown = requestBody || null;
      try { body = request.postDataJSON(); } catch { /* Preserve non-JSON writes as their raw request body. */ }
      writes.push({ method, path, body });
    }

    const key = `${method} ${path}`;
    const delayMs = options.delays?.[key] ?? options.delays?.[path] ?? 0;
    if (delayMs > 0) {
      await new Promise<void>(resolve => {
        let released = false;
        const release = () => {
          if (!released) { released = true; clearTimeout(timer); resolve(); }
        };
        const timer = setTimeout(release, delayMs);
        pendingDelays.push(release);
      });
    }

    const failureStatus = options.failures?.[key] ?? options.failures?.[path];
    let result: { status: number; responseBytes: number };
    if (failureStatus) {
      result = await fulfill(route, { error: "Fixture failure", message: "A configured synthetic route failure." }, failureStatus);
    } else if (path === "/api/v1/meta") {
      result = await fulfill(route, { application: { version: "fixture" }, capabilities: {} });
    } else if (path === "/api/v1/session") {
      result = await fulfill(route, fixture.session);
    } else if (path === "/api/v1/worlds") {
      result = await fulfill(route, { worlds: fixture.worlds });
    } else if (path === "/api/v1/campaigns") {
      result = await fulfill(route, { campaigns: fixture.campaigns });
    } else if (path === "/api/v1/dashboard/stats") {
      result = await fulfill(route, fixture.dashboardStats);
    } else if (path === "/api/v1/providers") {
      result = await fulfill(route, { providers: [{
        id: syntheticId(900),
        name: "Synthetic text profile",
        providerType: "lm_studio",
        providerRole: "text",
        baseUrl: "http://127.0.0.1:1234/v1",
        defaultModel: "fixture-model",
        configuration: {},
        enabled: true,
        isDefault: true,
        hasApiKey: false,
        healthStatus: "unknown"
      }] });
    } else if (path === `/api/v1/worlds/${fixture.worldId}`) {
      result = await fulfill(route, fixture.worldDetails.get(fixture.worldId) ?? {});
    } else if (/^\/api\/v1\/worlds\/[0-9a-f-]+$/iu.test(path)) {
      const id = path.split("/").at(-1) ?? "";
      result = await fulfill(route, fixture.worldDetails.get(id) ?? {});
    } else if (path === `/api/v1/world-versions/${fixture.worldVersionId}/playable-characters`) {
      result = await fulfill(route, { characters: [{ id: "fixture-observer", name: "The Observer", rpgStatCount: 0, defaultTriggerCount: 0 }], readiness: { ready: true, issues: [] } });
    } else if (path === `/api/v1/campaigns/${fixture.campaignId}/sync-status`) {
      result = await fulfill(route, fixture.syncStatus);
    } else if (path === `/api/v1/campaigns/${fixture.campaignId}/turns`) {
      const beforeCursor = url.searchParams.get("before");
      const before = Number(beforeCursor?.match(/(\d+)$/u)?.[1] ?? Number.MAX_SAFE_INTEGER);
      const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") ?? 50), 5000));
      const selected = fixture.turns.filter(turn => Number(turn.turnNumber) < before).slice(-limit);
      result = await fulfill(route, { campaignId: fixture.campaignId, turns: selected, nextCursor: selected[0] && Number(selected[0].turnNumber) > 1 ? `before-${selected[0].turnNumber}` : null });
    } else if (path === `/api/v1/campaigns/${fixture.campaignId}/state` || path === `/api/v1/campaigns/${fixture.campaignId}/state/inspection`) {
      result = await fulfill(route, fixture.runtimeState);
    } else if (path === `/api/v1/campaigns/${fixture.campaignId}/story-memory`) {
      result = await fulfill(route, { level: "off", reviewMode: "off", availableLevels: ["off"] });
    } else if (path === `/api/v1/campaigns/${fixture.campaignId}/illustration-config`) {
      result = await fulfill(route, { enabled: false, sourcePolicy: "off", matchingScope: "campaign", confidenceProfile: "balanced", repetitionWindow: 0, providerProfileId: null, model: "disabled", size: "1024x1024", aspectRatio: "1:1", quality: "standard", outputFormat: "png", maxAttempts: 1, segmentWordCount: 120, imagesPerSegment: 1, segmentPromptMode: "direct", refinementPrompt: "Synthetic browser fixture.", defaultRefinementPrompt: "Synthetic browser fixture.", updatedAt: timestamp });
    } else if (path === `/api/v1/campaigns/${fixture.campaignId}/illustration-segments`) {
      result = await fulfill(route, { segments: [] });
    } else if (path === `/api/v1/campaigns/${fixture.campaignId}/image-jobs`) {
      result = await fulfill(route, { jobs: [] });
    } else if (path === `/api/v1/campaigns/${fixture.campaignId}/memory/context-preview`) {
      result = await fulfill(route, { sections: [], totalTokens: 0 });
    } else {
      result = await fulfill(route, {});
    }
    record.status = result.status;
    record.responseBytes = result.responseBytes;
    record.finishedAt = performance.now();
  });

  return { requests, writes, releaseDelayedRoute: () => pendingDelays.splice(0).forEach(release => release()) };
}
