import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const dashboardHtml = readFileSync("apps/web/public/index.html", "utf8");
const dashboardScript = readFileSync("apps/web/src/nexus.js", "utf8");
const dashboardCss = readFileSync("apps/web/public/nexus.css", "utf8");
const navigationCss = readFileSync("apps/web/public/navigation.css", "utf8");


function dashboardFunctionSources(names: string[]) {
  return names.map((name) => {
    const match = new RegExp(`(?:async )?function ${name}\\(`, "u").exec(dashboardScript);
    if (!match || match.index === undefined) throw new Error(`Unable to locate dashboard function ${name}.`);
    const next = /\n(?:async )?function /.exec(dashboardScript.slice(match.index + 1));
    const end = next ? match.index + 1 + next.index : dashboardScript.length;
    return dashboardScript.slice(match.index, end);
  });
}

function dashboardStatsHarness(read: () => Promise<boolean>) {
  const source = dashboardFunctionSources(["loadDashboardStats"]);
  const implementation = Function(
    "elements", "dashboardInitialStatsSources", "readAndRenderDashboardStats",
    `let dashboardInitialStatsPromise = null;\n${source.join("\n")}\nreturn { loadDashboardStats };`
  )({ dashboardStatsGrid: {} }, new Set(["worlds", "campaigns"]), read) as {
    loadDashboardStats(source?: string): Promise<boolean>;
  };
  return implementation;
}

function dashboardWorldDetailsHarness(api: (path: string) => Promise<Record<string, unknown>>) {
  const details = new Map<string, Record<string, unknown>>();
  const requests = new Map<string, Promise<Record<string, unknown>>>();
  const epochs = new Map<string, number>();
  const worlds = [{ id: "world-a" }, { id: "world-b" }];
  const sources = dashboardFunctionSources([
    "getDashboardWorldDetails",
    "beginDashboardWorldDetailRequest",
    "isDashboardWorldDetailRequestCurrent",
    "invalidateDashboardWorldDetails"
  ]);
  const implementation = Function(
    "dashboardWorldDetails", "dashboardWorldDetailRequests", "dashboardWorldDetailRequestEpochs", "api", "worlds",
    `${sources.join("\n")}\nreturn { getDashboardWorldDetails, invalidateDashboardWorldDetails };`
  )(details, requests, epochs, api, worlds) as {
    getDashboardWorldDetails(worldId: string): Promise<Record<string, unknown>>;
    invalidateDashboardWorldDetails(worldId: string): void;
  };
  return { implementation, details, requests, epochs };
}

describe("Nexus central dashboard", () => {
  it("is the default view and exposes the universal navigation in product order", () => {
    expect(dashboardScript).toContain("function parseManagementRoute(hash)");
    expect(dashboardScript).toContain('MANAGEMENT_ROUTE_NAMES = new Set(["#dashboard", "#world-library", "#campaigns", "#providers", "#prompt-library", "#data-transfer", "#imports"])');
    expect(dashboardScript).toContain("acceptedManagementHistoryIndex = previousIndex + 1;");
    expect(dashboardScript).toContain("rollbackManagementHistory(destinationIndex)");
    expect(dashboardHtml).toContain('id="campaignWorldLink"');
    expect(dashboardHtml.indexOf('id="navDashboard"')).toBeLessThan(dashboardHtml.indexOf('id="storyViewLink"'));
    expect(dashboardHtml).toContain('id="navSetup" class="nav-menu-trigger"');
    expect(dashboardHtml).toContain('class="nav-section-divider"');
    expect(dashboardHtml).toContain('id="navDataTransfer" href="#data-transfer"');
    expect(dashboardHtml).not.toContain('>Export</button>');
    expect(dashboardHtml).not.toContain('<details class="nav-menu">');
    expect(dashboardHtml).not.toContain('<summary>Setup</summary>');
    expect(dashboardHtml).toContain('id="openNexusAbout"');
    expect(dashboardHtml).toContain('id="openNexusUserProfile" class="nav-profile-button"');
    expect(dashboardHtml).toContain('title="User profile and settings"');
    expect(dashboardHtml).toContain('id="nexusUserProfileDialog"');
    expect(dashboardScript).toContain('async function openNexusUserProfile()');
    expect(dashboardScript).toContain('async function saveNexusUserProfile(event)');
    expect(dashboardCss).toContain("@import url('navigation.css');");
    expect(navigationCss).toContain(".universal-nav {");
    expect(navigationCss).toContain("position: sticky;");
    expect(navigationCss).toContain(".nav-section-divider");
    expect(navigationCss).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(navigationCss).toContain("justify-content: stretch;");
    expect(navigationCss).toContain("justify-items: start;");
    expect(navigationCss).toContain(".nav-menu-label { margin: 6px 12px 3px;");
    expect(navigationCss).toContain("@media (max-width: 340px)");
    expect(navigationCss).toContain(".nav-meta { min-width: 38px; }");
    expect(navigationCss).toContain(".nav-meta > :not(.nav-profile-button) { display: none; }");
    expect(navigationCss).not.toContain(".universal-nav .nav-meta { display: none; }");
    expect(navigationCss).not.toContain('content: "⌄"');
    expect(dashboardScript).toContain('function closeNavigationMenus(except = null)');
    expect(dashboardScript).toContain('function setNavigationMenuState(menu, open)');
    expect(dashboardScript).toContain('trigger.setAttribute("aria-expanded", String(open))');
    expect(dashboardScript).toContain('document.addEventListener("pointerdown"');
    expect(dashboardScript).toContain('document.addEventListener("keydown"');
  });

  it("uses the generated RPG, reading, and AI brand mark", () => {
    expect(dashboardHtml).toContain('src="/nexus/nexus-mark.png"');
    expect(existsSync("apps/web/public/nexus-mark.png")).toBe(true);
  });

  it("renders dashboard statistics including provider-reported fees", () => {
    for (const id of ["statWorlds", "statCampaigns", "statTurns", "statCost", "statCostProviders", "statActiveWorlds"]) {
      expect(dashboardHtml).toContain(`id="${id}"`);
    }
    expect(dashboardScript).toContain('api("/api/v1/dashboard/stats")');
    expect(dashboardScript).toContain("dashboardReportedCost(stats.providerCosts)");
    expect(dashboardScript).toContain('`${category} · ${label}: ${money(cost.amount, cost.currency)');
    expect(dashboardScript).toContain('cost.category === "image" ? "Image"');
    expect(dashboardScript).toContain('return { total: "Not reported", providers: "Local and unsupported fees are not estimated" };');
  });

  it("puts recent campaigns first and keeps every collection searchable and filterable", () => {
    expect(dashboardHtml).toContain('id="worldSearch" type="search"');
    expect(dashboardHtml).toContain('id="managementCampaignSearch" type="search"');
    expect(dashboardHtml).toContain('id="managementCampaignStatus"');
    expect(dashboardHtml).toContain('id="managementCampaignSort"');
    expect(dashboardHtml).toContain('id="managementWorldSort"');
    expect(dashboardHtml).toContain('id="managementCampaignResults"');
    expect(dashboardHtml).toContain('id="managementWorldResults"');
    expect(dashboardHtml).toContain('class="collection-results" role="status" aria-live="polite" aria-atomic="true"');
    expect(dashboardHtml).toContain('data-world-filter="active" aria-pressed="false">Active</button>');
    expect(dashboardHtml.indexOf("dashboard-recent-campaigns")).toBeLessThan(dashboardHtml.indexOf('aria-labelledby="browseWorldsTitle"'));
    expect(dashboardHtml).not.toContain('id="campaignSearch"');
    expect(dashboardScript).toContain("function reconcileKeyedCollection(container, records, keyAttribute, createNode, updateNode)");
    expect(dashboardScript).toContain("setTimeout(renderManagementCampaigns, 250)");
    expect(dashboardScript).toContain("setTimeout(renderManagementWorlds, 250)");
    expect(dashboardScript).toContain('status: "active", sort: "updated-desc" }).slice(0, 5)');
    expect(dashboardScript).toContain("filterSortCampaigns(campaigns, { query, status: managementCampaignStatus, sort: managementCampaignSort })");
    expect(dashboardScript).toContain("filterSortWorlds(worlds, { query, status: managementWorldFilter, sort: managementWorldSort })");
    expect(dashboardScript).toContain('collectionEmptyState(message, "campaign", clearCampaignCollectionFilters)');
    expect(dashboardScript).toContain('collectionEmptyState(message, "world", clearWorldCollectionFilters)');
    expect(dashboardHtml).toContain('id="worldCarouselPrev"');
    expect(dashboardScript).toContain("function renderDashboardWorlds()");
    expect(dashboardScript).toContain("function renderDashboardCampaigns()");
    expect(dashboardScript).toContain("function applyArtwork(element, record)");
    expect(dashboardScript).toContain("cta.append(ctaLabel, ctaArrow)");
    expect(dashboardScript).toContain('ctaArrow.setAttribute("aria-hidden", "true")');
    expect(dashboardCss).toContain("scroll-snap-type: x mandatory");
    expect(dashboardCss).toContain(".dashboard-story-link { display: inline-flex;");
    expect(dashboardCss).toContain("gap: 8px;");
  });

  it("opens world details and keeps management actions in the management pane", () => {
    expect(dashboardHtml).toContain('id="worldDetailsDialog"');
    expect(dashboardHtml).toContain('id="editWorldDetails" class="button secondary" href="#world-library"');
    expect(dashboardScript).toContain("async function openWorldDetails(worldId)");
    expect(dashboardScript).toContain("openManagedModal(elements.worldDetailsDialog)");
  });

  it("routes dashboard and management campaign creation through the same saved-style dialog", () => {
    expect(dashboardHtml).toContain('id="createCampaignDialog"');
    expect(dashboardHtml).toContain('id="createCampaignWorldVersion"');
    expect(dashboardHtml).toContain('id="newCampaignTitle"');
    expect(dashboardHtml).toContain('id="newCampaignCharacter"');
    expect(dashboardHtml).toContain('id="createCampaignAdvanced"');
    expect(dashboardHtml).toContain('id="createAndStartCampaign"');
    expect(dashboardHtml).toContain('id="confirmCreateCampaign"');
    expect(dashboardHtml).not.toContain('id="quickCampaignDialog"');
    expect(dashboardScript).toContain('campaignCreationEntryPoint = "dashboard";');
    expect(dashboardScript).toContain('campaignCreationEntryPoint = "management";');
    expect(dashboardScript).toContain("openCampaignCreation({");
    expect(dashboardScript).toContain("buildCampaignCreateRequest(draft)");
    expect(dashboardScript).toContain("userSettings: sessionUser?.settings");
    expect(dashboardScript).toContain('window.location.assign(`/story/${encodeURIComponent(session.committedCampaignId)}`)');
  });

  it("keeps resume precedence in the established resolver and opens recent cards by ID", () => {
    expect(dashboardScript).toContain("function createDashboardCampaignCard(campaign, card = null)");
    expect(dashboardScript).toContain("resolveResumeCampaign(");
    expect(dashboardScript).toContain('localStorage.setItem("infiniteQuestLastCampaignId", campaign.id)');
    expect(dashboardScript).toContain('window.location.assign(`/story/${encodeURIComponent(campaign.id)}`)');
  });
});


describe("dashboard world summaries", () => {
  it("uses summary artwork without a detail object", () => {
    const source = dashboardFunctionSources(["worldPreview"]);
    const worldPreview = Function("dashboardWorldDetails", `${source.join("\n")}\nreturn worldPreview;`)(new Map()) as (world: Record<string, unknown>) => { imageUrl: string };

    expect(worldPreview({ id: "world-a", imageUrl: "summary-art.png" }).imageUrl).toBe("summary-art.png");
  });
});

describe("dashboard world detail reads", () => {
  it("coalesces concurrent reads and caches only a successful result", async () => {
    let resolveRead!: (detail: Record<string, unknown>) => void;
    const pending = new Promise<Record<string, unknown>>((resolve) => { resolveRead = resolve; });
    const api = vi.fn(() => pending);
    const { implementation, details } = dashboardWorldDetailsHarness(api);

    const first = implementation.getDashboardWorldDetails("world-a");
    const second = implementation.getDashboardWorldDetails("world-a");
    await Promise.resolve();
    expect(api).toHaveBeenCalledTimes(1);
    resolveRead({ id: "world-a", title: "Fresh Alpha" });

    await expect(first).resolves.toEqual({ id: "world-a", title: "Fresh Alpha" });
    await expect(second).resolves.toEqual({ id: "world-a", title: "Fresh Alpha" });
    await expect(implementation.getDashboardWorldDetails("world-a")).resolves.toEqual({ id: "world-a", title: "Fresh Alpha" });
    expect(api).toHaveBeenCalledTimes(1);
    expect(details.get("world-a")).toEqual({ id: "world-a", title: "Fresh Alpha" });
  });

  it("evicts a failed read so an explicit retry reaches the API again", async () => {
    const api = vi.fn()
      .mockRejectedValueOnce(new Error("Synthetic detail read failure"))
      .mockResolvedValueOnce({ id: "world-a", title: "Retried Alpha" });
    const { implementation, requests } = dashboardWorldDetailsHarness(api);

    await expect(implementation.getDashboardWorldDetails("world-a")).rejects.toThrow("Synthetic detail read failure");
    expect(requests.has("world-a")).toBe(false);
    await expect(implementation.getDashboardWorldDetails("world-a")).resolves.toEqual({ id: "world-a", title: "Retried Alpha" });
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("invalidates only the edited world and prevents a late old read replacing the fresh detail", async () => {
    let resolveOld!: (detail: Record<string, unknown>) => void;
    const oldRead = new Promise<Record<string, unknown>>((resolve) => { resolveOld = resolve; });
    let resolveFresh!: (detail: Record<string, unknown>) => void;
    const freshRead = new Promise<Record<string, unknown>>((resolve) => { resolveFresh = resolve; });
    let callCount = 0;
    const api = vi.fn(() => callCount++ === 0 ? oldRead : freshRead);
    const { implementation, details } = dashboardWorldDetailsHarness(api);
    details.set("world-b", { id: "world-b", title: "Current Beta" });

    const stale = implementation.getDashboardWorldDetails("world-a");
    implementation.invalidateDashboardWorldDetails("world-a");
    expect(details.has("world-a")).toBe(false);
    expect(details.get("world-b")).toEqual({ id: "world-b", title: "Current Beta" });
    const current = implementation.getDashboardWorldDetails("world-a");
    resolveFresh({ id: "world-a", title: "New Alpha" });
    await expect(current).resolves.toEqual({ id: "world-a", title: "New Alpha" });
    resolveOld({ id: "world-a", title: "Stale Alpha" });
    await expect(stale).resolves.toEqual({ id: "world-a", title: "Stale Alpha" });

    expect(details.get("world-a")).toEqual({ id: "world-a", title: "New Alpha" });
    expect(details.get("world-b")).toEqual({ id: "world-b", title: "Current Beta" });
    expect(api).toHaveBeenCalledTimes(2);
  });
});


describe("dashboard statistics reads", () => {
  it("shares a held initial request between world and campaign summaries", async () => {
    let resolveRead!: (loaded: boolean) => void;
    const pending = new Promise<boolean>((resolve) => { resolveRead = resolve; });
    const read = vi.fn(() => pending);
    const dashboard = dashboardStatsHarness(read);

    const worldsRead = dashboard.loadDashboardStats("worlds");
    const campaignsRead = dashboard.loadDashboardStats("campaigns");
    expect(read).toHaveBeenCalledTimes(1);
    resolveRead(true);
    await expect(worldsRead).resolves.toBe(true);
    await expect(campaignsRead).resolves.toBe(true);
  });

  it("retains a fast successful initial result until the other list consumes it", async () => {
    const read = vi.fn().mockResolvedValue(true);
    const dashboard = dashboardStatsHarness(read);

    await expect(dashboard.loadDashboardStats("worlds")).resolves.toBe(true);
    await expect(dashboard.loadDashboardStats("campaigns")).resolves.toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    await expect(dashboard.loadDashboardStats()).resolves.toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("evicts a failed initial request so the next list load retries", async () => {
    const read = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const dashboard = dashboardStatsHarness(read);

    await expect(dashboard.loadDashboardStats("worlds")).resolves.toBe(false);
    await expect(dashboard.loadDashboardStats("campaigns")).resolves.toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

function dashboardWorldDetailsDialogHarness(api: (path: string) => Promise<Record<string, unknown>>) {
  const details = new Map<string, Record<string, unknown>>();
  const requests = new Map<string, Promise<Record<string, unknown>>>();
  const epochs = new Map<string, number>();
  const worlds = [{ id: "world-a", title: "World Alpha", latestVersionId: "version-a", latestVersionNumber: 1, updatedAt: "2026-10-03T00:00:00.000Z" }];
  const elements = {
    dashboardStatsStatus: { textContent: "Current dashboard status" },
    worldDetailsTitle: { textContent: "" },
    worldDetailsEyebrow: { textContent: "" },
    worldDetailsSummary: { textContent: "" },
    worldDetailsMeta: { replaceChildren: vi.fn(), append: vi.fn() },
    worldDetailsMedia: { className: "", style: { backgroundImage: "" } },
    beginCampaignFromWorld: { disabled: true },
    editWorldDetails: { href: "" },
    worldDetailsDialog: { open: false }
  };
  const openManagedModal = vi.fn((dialog: { open: boolean }) => { dialog.open = true; });
  const sources = dashboardFunctionSources([
    "getDashboardWorldDetails",
    "beginDashboardWorldDetailRequest",
    "isDashboardWorldDetailRequestCurrent",
    "invalidateDashboardWorldDetails",
    "openWorldDetails"
  ]);
  const implementation = Function(
    "document", "elements", "api", "worlds", "dashboardWorldDetails", "dashboardWorldDetailRequests", "dashboardWorldDetailRequestEpochs",
    "worldPreview", "number", "managementSelectionHash", "openManagedModal", "applyArtwork",
    `let dashboardWorldDetailsSelectionEpoch = 0;\n${sources.join("\n")}\nreturn { openWorldDetails, invalidateDashboardWorldDetails };`
  )(
    { createElement: () => ({ textContent: "", append: vi.fn() }) },
    elements,
    api,
    worlds,
    details,
    requests,
    epochs,
    () => ({ genre: "Fantasy", description: "Summary", tone: "Hopeful", firstAction: "Begin" }),
    String,
    () => "#world-library",
    openManagedModal,
    vi.fn()
  ) as {
    openWorldDetails(worldId: string): Promise<void>;
    invalidateDashboardWorldDetails(worldId: string): void;
  };
  return { implementation, elements, openManagedModal, details };
}

describe("dashboard world detail dialog request fences", () => {
  it("does not install a detail response invalidated while the dialog is opening", async () => {
    let resolveRead!: (detail: Record<string, unknown>) => void;
    const pending = new Promise<Record<string, unknown>>((resolve) => { resolveRead = resolve; });
    const api = vi.fn(() => pending);
    const { implementation, elements, openManagedModal, details } = dashboardWorldDetailsDialogHarness(api);

    const opening = implementation.openWorldDetails("world-a");
    implementation.invalidateDashboardWorldDetails("world-a");
    resolveRead({ id: "world-a", title: "Stale Alpha" });
    await opening;

    expect(openManagedModal).not.toHaveBeenCalled();
    expect(elements.worldDetailsTitle.textContent).toBe("");
    expect(elements.dashboardStatsStatus.textContent).toBe("Current dashboard status");
    expect(details.has("world-a")).toBe(false);
  });

  it("does not present a failure from a detail read invalidated while the dialog is opening", async () => {
    let rejectRead!: (reason: Error) => void;
    const pending = new Promise<Record<string, unknown>>((_resolve, reject) => { rejectRead = reject; });
    const api = vi.fn(() => pending);
    const { implementation, elements, openManagedModal } = dashboardWorldDetailsDialogHarness(api);

    const opening = implementation.openWorldDetails("world-a");
    implementation.invalidateDashboardWorldDetails("world-a");
    rejectRead(new Error("Stale detail read failure"));
    await opening;

    expect(openManagedModal).not.toHaveBeenCalled();
    expect(elements.dashboardStatsStatus.textContent).toBe("Current dashboard status");
  });
});
