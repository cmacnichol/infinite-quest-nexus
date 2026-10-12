import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadRuntimeConfig, type RuntimeConfig } from "../../packages/database/src/config.js";
import type { DatabasePool } from "../../packages/database/src/pool.js";
import { buildServer } from "../../services/api/src/server.js";
import { installLegacyUiFixture, legacyUiFixture } from "../e2e/helpers/legacy-ui-fixtures.js";
import { inertStorageServerOptions } from "../helpers/build-server-options.js";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const PRODUCTION_ROOT = resolve("apps/web/dist");
const DEVELOPMENT_ROOT = resolve("apps/web");
const NEXT_ROOT = resolve("apps/web-next/dist");
const EVIDENCE_ROOT = resolve(".superpowers/sdd/legacy-ui-2026-10-03/evidence/T31-served-runtime");

type RuntimeSurface = Readonly<{
  name: string;
  baseUrl: string;
}>;

type ImportOrder = Readonly<{
  name: string;
  controllerFirst: boolean;
  expectedRequests: readonly string[];
}>;

type ViteDevServerLike = Readonly<{
  httpServer: Server | null;
  listen(): Promise<void>;
  close(): Promise<void>;
}>;

const bridgeFirstOrder: ImportOrder = {
  name: "bridge then compatibility controller",
  controllerFirst: false,
  expectedRequests: ["/nexus/legacy-management.js", "/nexus/nexus.js"]
};
const controllerFirstOrder: ImportOrder = {
  name: "compatibility controller then bridge",
  controllerFirst: true,
  expectedRequests: ["/nexus/nexus.js", "/nexus/legacy-management.js"]
};

declare global {
  interface Window {
    __t31RefreshCampaignClickListeners: number;
    __t31SetupClickListeners: number;
    __t31SetupClickListenerStacks: string[];
    __t31MenuDiagnostics: Array<Record<string, unknown>>;
    __t31ControllerPreloadError?: string;
    __t31ControllerPreloadComplete: boolean;
  }
}

let browser: Browser;
let builtApp: FastifyInstance;
let productionBaseUrl: string;
let devServer: ViteDevServerLike;
let developmentBaseUrl: string;

function makeMockPool(): DatabasePool {
  return {
    query: async (sql: string) => ({
      rows: sql.includes("system_key = 'initial-owner'") ? [{ id: OWNER_ID }] : [],
      rowCount: 0
    })
  } as unknown as DatabasePool;
}

function runtimeConfig(): RuntimeConfig {
  vi.stubEnv("DATABASE_URL", "postgresql://t31-fixture@127.0.0.1:1/not-connected");
  try {
    const loaded = loadRuntimeConfig();
    return {
      ...loaded,
      role: "api",
      host: "127.0.0.1",
      port: 0,
      databaseUrl: "postgresql://t31-fixture@127.0.0.1:1/not-connected",
      legacyWebRoot: PRODUCTION_ROOT,
      nextWebRoot: NEXT_ROOT,
      credentialEncryptionKey: "",
      systemArchiveEnabled: false,
      security: {
        ...loaded.security,
        corsAllowedOrigins: [],
        providerNetworkAllowlist: ["localhost", "127.0.0.0/8", "::1/128"],
        cspImageAllowedOrigins: [],
        trustProxyHops: 0
      }
    };
  } finally {
    vi.unstubAllEnvs();
  }
}

function devAddress(server: ViteDevServerLike): string {
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Vite did not expose its local test listener.");
  return `http://127.0.0.1:${address.port}`;
}

async function captureRuntimeEvidence(
  page: Page,
  name: string,
  assertions: Readonly<Record<string, unknown>>
): Promise<void> {
  await mkdir(EVIDENCE_ROOT, { recursive: true });
  const slug = name.replace(/[^a-z0-9-]+/giu, "-").toLowerCase();
  const evidenceId = randomUUID();
  const screenshotPath = resolve(EVIDENCE_ROOT, `${slug}-${evidenceId}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await writeFile(`${screenshotPath.slice(0, -4)}.json`, `${JSON.stringify({ screenshotPath, assertions }, null, 2)}\n`, "utf8");
}

async function instrumentBoot(page: Page, controllerFirst: boolean): Promise<void> {
  await page.addInitScript(() => {
    window.__t31RefreshCampaignClickListeners = 0;
    window.__t31ControllerPreloadComplete = false;
    window.__t31SetupClickListeners = 0;
    window.__t31SetupClickListenerStacks = [];
    window.__t31MenuDiagnostics = [];
    const recordMenuState = (kind: string, event: Event | { target: Node }) => {
      const target = event?.target instanceof Element ? event.target : null;
      const trigger = document.querySelector("#navSetup");
      const panel = document.querySelector("#nexusSetupMenu");
      const menu = trigger?.closest(".nav-menu");
      window.__t31MenuDiagnostics.push({
        kind,
        targetId: target?.closest("#navSetup, #nexusSetupMenu, #nexusSetupMenu *")?.id ?? null,
        expanded: trigger?.getAttribute("aria-expanded") ?? null,
        hidden: panel instanceof HTMLElement ? panel.hidden : null,
        menuOpen: menu?.classList.contains("open") ?? false
      });
      if (window.__t31MenuDiagnostics.length > 30) window.__t31MenuDiagnostics.shift();
    };
    document.addEventListener("pointerdown", event => recordMenuState("pointerdown", event), true);
    document.addEventListener("click", event => recordMenuState("click-capture", event), true);
    document.addEventListener("click", event => recordMenuState("click-bubble", event));
    const menuObserver = new MutationObserver(records => {
      for (const record of records) {
        const target = record.target;
        if (target instanceof Element && ["navSetup", "nexusSetupMenu"].includes(target.id)) {
          recordMenuState(`mutation-${record.attributeName}`, { target });
        }
      }
    });
    document.addEventListener("DOMContentLoaded", () => menuObserver.observe(document.body, {
      attributes: true,
      subtree: true,
      attributeFilter: ["aria-expanded", "class", "hidden"]
    }), { once: true });
    const original = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (this instanceof HTMLElement && this.id === "refreshCampaigns" && type === "click") {
        window.__t31RefreshCampaignClickListeners += 1;
      }
      if (this instanceof HTMLElement && this.id === "navSetup" && type === "click") {
        window.__t31SetupClickListeners += 1;
        window.__t31SetupClickListenerStacks.push(new Error().stack ?? "No registration stack available.");
      }
      return original.call(this, type, listener, options);
    };
  });
  if (controllerFirst) {
    // Raw browser source keeps Vitest's SSR transform out of the native imports.
    await page.addInitScript({ content: `
      document.addEventListener("DOMContentLoaded", () => {
        import("/nexus/nexus.js")
          .then(() => import("/nexus/legacy-management.js"))
          .then(() => { window.__t31ControllerPreloadComplete = true; })
          .catch(error => { window.__t31ControllerPreloadError = String(error); });
      });
    ` });
  }
}

function managementShellUrl(baseUrl: string): string {
  // Vite serves the public HTML file explicitly; Fastify owns directory navigation.
  return `${baseUrl}/nexus/${baseUrl === developmentBaseUrl ? "index.html" : ""}`;
}

async function suppressShellStartupForControllerFirstProof(page: Page, baseUrl: string): Promise<void> {
  // The ordinary bridge-first cases run the untouched shell. For reverse-order proof only,
  // remove its automatic module tag so the init hook can wait for parsed DOM before importing
  // the same, real Vite/Fastify-served controller and bridge modules in a deterministic order.
  await page.route(managementShellUrl(baseUrl), async (route) => {
    const response = await route.fetch();
    const html = await response.text();
    const startupScript = /<script\b(?=[^>]*\bsrc=["']\/nexus\/legacy-management\.js["'])[^>]*>\s*<\/script>/giu;
    const matches = [...html.matchAll(startupScript)];
    if (matches.length !== 1) throw new Error("Served management shell did not contain exactly one stable bridge startup.");
    const headers = { ...response.headers() };
    delete headers["content-length"];
    delete headers["content-encoding"];
    await route.fulfill({ status: response.status(), headers, body: html.replace(startupScript, "") });
  });
}

async function expectManagementStartup(page: Page, pageErrors: readonly string[]): Promise<void> {
  try {
    await page.waitForFunction(() => window.__t31RefreshCampaignClickListeners >= 1, undefined, { timeout: 8_000 });
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      listenerCount: window.__t31RefreshCampaignClickListeners,
      preloadError: window.__t31ControllerPreloadError ?? null,
      documentState: document.readyState
    }));
    await captureRuntimeEvidence(page, "startup-failure", { ...diagnostic, pageErrors });
    throw new Error(`Management startup did not complete: ${JSON.stringify({ ...diagnostic, pageErrors })}`, { cause: error });
  }
}

async function clickManagementControl(page: Page, selector: string): Promise<void> {
  try {
    await page.locator(selector).click({ timeout: 5_000 });
  } catch (error) {
    await captureRuntimeEvidence(page, "interaction-failure", {
      selector,
      url: page.url(),
      visible: await page.locator(selector).isVisible(),
      menuHidden: await page.locator("#nexusSetupMenu").evaluate(element => (element as HTMLElement).hidden),
      setupExpanded: await page.locator("#navSetup").getAttribute("aria-expanded"),
      setupListenerCount: await page.evaluate(() => window.__t31SetupClickListeners),
      setupListenerStacks: await page.evaluate(() => window.__t31SetupClickListenerStacks),
      menuDiagnostics: await page.evaluate(() => window.__t31MenuDiagnostics)
    });
    throw error;
  }
}

async function openManagement(
  page: Page,
  surface: RuntimeSurface,
  order: ImportOrder
): Promise<{ campaignRequests: Array<{ finishedAt?: number }>; pageErrors: string[] }> {
  const fixture = legacyUiFixture({ turnCount: 4, worldCount: 2, campaignCount: 2 });
  const api = await installLegacyUiFixture(page, fixture);
  const pageErrors: string[] = [];
  const moduleRequests: string[] = [];
  const moduleRequestUrls: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    const requestUrl = new URL(request.url());
    const pathname = requestUrl.pathname;
    if (pathname === "/nexus/legacy-management.js" || pathname === "/nexus/nexus.js") {
      moduleRequests.push(pathname);
      moduleRequestUrls.push(`${pathname}${requestUrl.search}`);
    }
  });
  await instrumentBoot(page, order.controllerFirst);

  const shellResponse = await page.context().request.get(managementShellUrl(surface.baseUrl));
  expect(shellResponse.status()).toBe(200);
  const shell = await shellResponse.text();
  expect([...shell.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>/giu)]
    .map((match) => match[1])
    .filter((src) => src !== "/@vite/client"))
    .toEqual(["/nexus/legacy-management.js"]);

  if (order.controllerFirst) await suppressShellStartupForControllerFirstProof(page, surface.baseUrl);
  await page.goto(managementShellUrl(surface.baseUrl), { waitUntil: "domcontentloaded" });
  await expectManagementStartup(page, pageErrors);
  if (order.controllerFirst) {
    await page.waitForFunction(() => window.__t31ControllerPreloadComplete || window.__t31ControllerPreloadError !== undefined, undefined, { timeout: 8_000 });
  }
  expect(await page.evaluate(() => window.__t31ControllerPreloadError)).toBeUndefined();
  expect(await page.evaluate(() => window.__t31RefreshCampaignClickListeners)).toBe(1);
  expect(await page.evaluate(() => window.__t31SetupClickListeners)).toBe(1);
  await vi.waitFor(() => {
    const pendingCampaignReads = api.requests.filter((request) =>
      request.method === "GET" && request.path === "/api/v1/campaigns" && request.finishedAt === undefined
    );
    expect(pendingCampaignReads).toHaveLength(0);
    expect(api.requests.some((request) => request.method === "GET" && request.path === "/api/v1/campaigns"))
      .toBe(true);
  });
  expect([...new Set(moduleRequests)]).toEqual(order.expectedRequests);

  await clickManagementControl(page, "#navSetup");
  const setupMenuAfterTrigger = await page.evaluate(() => ({
    expanded: document.querySelector("#navSetup")?.getAttribute("aria-expanded"),
    hidden: (document.querySelector("#nexusSetupMenu") as HTMLElement | null)?.hidden,
    lifecycle: window.__t31MenuDiagnostics.slice(-8)
  }));
  if (setupMenuAfterTrigger.expanded !== "true" || setupMenuAfterTrigger.hidden !== false) {
    await captureRuntimeEvidence(page, `${surface.name}-${order.name}-setup-menu-not-open`, {
      setupMenuAfterTrigger,
      setupListenerCount: await page.evaluate(() => window.__t31SetupClickListeners),
      setupListenerStacks: await page.evaluate(() => window.__t31SetupClickListenerStacks)
    });
    throw new Error(`Setup menu did not open after its trigger click: ${JSON.stringify(setupMenuAfterTrigger)}`);
  }
  await clickManagementControl(page, "#navCampaigns");
  await page.locator("#refreshCampaigns").waitFor({ state: "visible", timeout: 5_000 });

  const campaignRequests = () => api.requests.filter((request) =>
    request.method === "GET" && request.path === "/api/v1/campaigns"
  );
  const beforeClick = campaignRequests().length;
  await clickManagementControl(page, "#refreshCampaigns");
  await vi.waitFor(() => expect(campaignRequests()).toHaveLength(beforeClick + 1));
  await vi.waitFor(() => expect(campaignRequests().filter((request) => request.finishedAt === undefined)).toHaveLength(0));

  expect(await page.evaluate(() => window.__t31RefreshCampaignClickListeners)).toBe(1);
  expect(pageErrors).toEqual([]);
  await captureRuntimeEvidence(page, `${surface.name}-${order.name}`, {
    moduleRequests,
    moduleRequestUrls,
    setupClickListeners: await page.evaluate(() => window.__t31SetupClickListeners),
    refreshCampaignClickListeners: await page.evaluate(() => window.__t31RefreshCampaignClickListeners),
    explicitRefreshCampaignRequests: campaignRequests().length - beforeClick
  });
  return { campaignRequests: campaignRequests(), pageErrors };
}

describe("legacy management served runtime bundle contract", () => {
  beforeAll(async () => {
    for (const requiredFile of [
      resolve(PRODUCTION_ROOT, "index.html"),
      resolve(PRODUCTION_ROOT, "story.html"),
      resolve(NEXT_ROOT, "index.html")
    ]) {
      if (!existsSync(requiredFile)) {
        throw new Error(`Build both web clients before this served-runtime test; missing ${requiredFile}`);
      }
    }

    builtApp = await buildServer(inertStorageServerOptions({ config: runtimeConfig(), pool: makeMockPool() }));
    productionBaseUrl = await builtApp.listen({ host: "127.0.0.1", port: 0 });

    const vite = createRequire(resolve("apps/web/package.json"))("vite") as {
      createServer(options: Record<string, unknown>): Promise<ViteDevServerLike>;
    };
    devServer = await vite.createServer({
      configFile: resolve("apps/web/vite.config.ts"),
      root: DEVELOPMENT_ROOT,
      server: { host: "127.0.0.1", port: 0, strictPort: false }
    });
    await devServer.listen();
    developmentBaseUrl = devAddress(devServer);
    browser = await chromium.launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await devServer?.close();
    await builtApp?.close();
  });

  it("serves stable production entry URLs and both legacy story routes through Fastify", async () => {
    for (const path of ["/nexus/", "/nexus/legacy-management.js", "/nexus/nexus.js", "/story", "/story/22222222-2222-4222-8222-222222222222", "/app/"]) {
      const response = await builtApp.inject({ method: "GET", url: path });
      expect(response.statusCode, path).toBe(200);
      if (path.endsWith(".js")) expect(response.headers["content-type"]).toContain("javascript");
    }
  });

  it("renders the built dashboard, management surfaces, and accepted Story through Fastify", async () => {
    const page = await browser.newPage();
    const fixture = legacyUiFixture({ turnCount: 3, worldCount: 2, campaignCount: 1 });
    const api = await installLegacyUiFixture(page, fixture);
    const pageErrors: string[] = [];
    const servedResources = new Set<string>();
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/nexus/") || url.pathname.startsWith("/story")) servedResources.add(url.pathname);
    });

    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${productionBaseUrl}/nexus/#dashboard`, { waitUntil: "domcontentloaded" });
      await page.locator("#dashboardTitle").waitFor({ state: "visible" });
      const dashboardWorld = page.locator(`#dashboardWorlds [data-world-id="${fixture.worldId}"]`);
      await dashboardWorld.waitFor({ state: "visible" });
      await vi.waitFor(() => expect(page.locator("#dashboardStoryLink").getAttribute("href")).resolves.toBe(`/story/${fixture.campaignId}`));
      await captureRuntimeEvidence(page, "fastify-built-dashboard", {
        heading: await page.locator("#dashboardTitle").textContent(),
        storyHref: await page.locator("#dashboardStoryLink").getAttribute("href"),
        selectedWorldId: fixture.worldId
      });

      const openSetupRoute = async (selector: string) => {
        await clickManagementControl(page, "#navSetup");
        await clickManagementControl(page, selector);
      };

      await openSetupRoute("#navCampaigns");
      await page.locator("#managementCampaignResults").waitFor({ state: "visible", timeout: 5_000 });
      await vi.waitFor(async () => expect(await page.locator("#managementCampaignResults").textContent()).toContain("1"));
      await captureRuntimeEvidence(page, "fastify-built-campaign-management", {
        heading: await page.locator("#managementTitle").textContent(),
        results: await page.locator("#managementCampaignResults").textContent()
      });

      await openSetupRoute("#navWorlds");
      const worldCard = page.locator(`#worldManagementCarousel [data-world-id="${fixture.worldId}"]`);
      await worldCard.waitFor({ state: "visible" });
      await worldCard.click();
      await page.locator("#editWorldDraft").click();
      const worldAuthorDialog = page.locator("#worldAuthorDialog");
      await worldAuthorDialog.waitFor({ state: "visible" });
      await captureRuntimeEvidence(page, "fastify-built-world-author", {
        heading: await page.locator("#worldAuthorDialogTitle").textContent(),
        worldTitle: await page.locator("#worldTitle").inputValue()
      });
      await page.locator("#cancelWorldAuthor").click();
      await worldAuthorDialog.waitFor({ state: "hidden" });
      expect(await page.locator("#discardChangesDialog").evaluate(element => (element as HTMLDialogElement).open)).toBe(false);

      await page.locator("#createCampaignModalBtn").click();
      const campaignDialog = page.locator("#createCampaignDialog");
      await campaignDialog.waitFor({ state: "visible" });
      await vi.waitFor(async () => expect(await page.locator("#createCampaignWorldVersion").textContent()).toContain("Fixture World 1"));
      await captureRuntimeEvidence(page, "fastify-built-campaign-create", {
        worldVersion: await page.locator("#createCampaignWorldVersion").textContent(),
        characterOptions: await page.locator("#newCampaignCharacter").locator("option").allTextContents()
      });
      await page.locator("#cancelCreateCampaign").click();
      await campaignDialog.waitFor({ state: "hidden" });

      await openSetupRoute("#navProviders");
      await page.locator("#newProviderButton").click();
      const providerDialog = page.locator("#providerDialog");
      await providerDialog.waitFor({ state: "visible" });
      await captureRuntimeEvidence(page, "fastify-built-provider-add", {
        heading: await page.locator("#providerDialogTitle").textContent(),
        profileName: await page.locator("#providerName").inputValue()
      });
      await page.locator("#cancelProviderEdit").click();
      await providerDialog.waitFor({ state: "hidden" });

      await openSetupRoute("#navDataTransfer");
      await page.locator("#dataTransferTitle").waitFor({ state: "visible", timeout: 5_000 });
      await captureRuntimeEvidence(page, "fastify-built-data-transfer", {
        heading: await page.locator("#dataTransferTitle").textContent()
      });

      await page.locator("#navDashboard").click();
      await page.locator("#dashboardTitle").waitFor({ state: "visible" });
      await page.locator("#dashboardStoryLink").click();
      await page.locator("#freeAction").waitFor({ state: "visible" });
      await vi.waitFor(async () => expect(await page.locator("#storySyncStatus").textContent()).toContain("Story synced"));
      const latestTurn = fixture.turns.at(-1);
      if (!latestTurn || typeof latestTurn.narration !== "string") throw new Error("Built Story smoke fixture has no accepted narration.");
      await vi.waitFor(async () => expect(await page.locator("#storyArea").textContent()).toContain(latestTurn.narration));
      await captureRuntimeEvidence(page, "fastify-built-accepted-story", {
        storyTitle: await page.locator("#storyTitle").textContent(),
        acceptedTurnNumber: 3,
        narrationPresent: true
      });

      expect([...servedResources]).toEqual(expect.arrayContaining([
        "/nexus/",
        "/nexus/legacy-management.js",
        "/nexus/nexus.js",
        `/story/${fixture.campaignId}`
      ]));
      expect(api.writes).toEqual([]);
      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 45_000);

  it.each([
    { name: "Vite development server", baseUrl: () => developmentBaseUrl },
    { name: "Fastify production static root", baseUrl: () => productionBaseUrl }
  ])("starts once in $name when loading bridge then controller", async ({ name, baseUrl }) => {
    const page = await browser.newPage();
    try {
      const result = await openManagement(page, { name, baseUrl: baseUrl() }, bridgeFirstOrder);
      expect(result.campaignRequests.length).toBeGreaterThan(1);
    } finally {
      await page.close();
    }
  });

  it.each([
    { name: "Vite development server", baseUrl: () => developmentBaseUrl },
    { name: "Fastify production static root", baseUrl: () => productionBaseUrl }
  ])("starts once in $name when loading controller then bridge", async ({ name, baseUrl }) => {
    const page = await browser.newPage();
    try {
      const result = await openManagement(page, { name, baseUrl: baseUrl() }, controllerFirstOrder);
      expect(result.campaignRequests.length).toBeGreaterThan(1);
    } finally {
      await page.close();
    }
  });

  it.each([
    { name: "Vite development server", baseUrl: () => developmentBaseUrl },
    { name: "Fastify production static root", baseUrl: () => productionBaseUrl }
  ])("loads the image-library module only on first use and retries a failed import in $name", async ({ name, baseUrl }) => {
    const page = await browser.newPage();
    const fixture = legacyUiFixture({ turnCount: 1, worldCount: 1, campaignCount: 1 });
    await installLegacyUiFixture(page, fixture);
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    let imageModuleRequests = 0;
    await page.route("**/nexus/image-library-browser.js*", async (route) => {
      if (new URL(route.request().url()).pathname !== "/nexus/image-library-browser.js") return route.fallback();
      imageModuleRequests += 1;
      if (imageModuleRequests === 1) await route.abort("failed");
      else await route.fallback();
    });
    try {
      await instrumentBoot(page, false);
      await page.goto(managementShellUrl(baseUrl()), { waitUntil: "domcontentloaded" });
      expect(imageModuleRequests).toBe(0);
      await expectManagementStartup(page, pageErrors);

      await clickManagementControl(page, "#navSetup");
      await clickManagementControl(page, "#navWorlds");
      await clickManagementControl(page, "#newWorld");
      await page.locator("#worldCoverOptions > summary").click();
      await page.locator("#worldCoverLibraryMode").check();
      const failedRequest = page.waitForEvent("requestfailed", (request) =>
        new URL(request.url()).pathname === "/nexus/image-library-browser.js"
      );
      await page.locator("#chooseWorldCover").click();
      await failedRequest;
      expect(imageModuleRequests).toBe(1);
      expect(await page.locator("#assetLibraryDialog").evaluate((dialog) => (dialog as HTMLDialogElement).open)).toBe(false);

      await page.locator("#chooseWorldCover").click();
      await vi.waitFor(() => expect(imageModuleRequests, "retry must issue a fresh module request").toBe(2), { timeout: 2_000, interval: 10 });
      await page.waitForFunction(() => (document.querySelector("#assetLibraryDialog") as HTMLDialogElement | null)?.open === true, undefined, { timeout: 8_000 });
      expect(imageModuleRequests).toBe(2);
      await captureRuntimeEvidence(page, `${name}-image-library-retry`, {
        imageModuleRequestsBeforeUse: 0,
        abortedFirstImportAttempts: 1,
        successfulRetryRequests: imageModuleRequests - 1,
        imageLibraryDialogOpen: true
      });
    } finally {
      await page.close();
    }
  });
});
