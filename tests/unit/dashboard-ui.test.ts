import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dashboardHtml = readFileSync("apps/web/public/index.html", "utf8");
const dashboardScript = readFileSync("apps/web/public/nexus.js", "utf8");
const dashboardCss = readFileSync("apps/web/public/nexus.css", "utf8");
const navigationCss = readFileSync("apps/web/public/navigation.css", "utf8");

describe("Nexus central dashboard", () => {
  it("is the default view and exposes the universal navigation in product order", () => {
    expect(dashboardScript).toContain('const hash = window.location.hash || "#dashboard";');
    expect(dashboardHtml.indexOf('id="navDashboard"')).toBeLessThan(dashboardHtml.indexOf('id="storyViewLink"'));
    expect(dashboardHtml).toContain('id="navSetup" class="nav-menu-trigger"');
    expect(dashboardHtml).toContain('class="nav-section-divider"');
    expect(dashboardHtml).toContain('id="navImports" href="#imports"');
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
    expect(navigationCss).toContain(".universal-nav .nav-meta { display: none; }");
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

  it("provides searchable, accessible world and campaign carousels with image-ready cards", () => {
    expect(dashboardHtml).toContain('id="worldSearch" type="search"');
    expect(dashboardHtml).toContain('id="campaignSearch" type="search"');
    expect(dashboardHtml).toContain('id="worldCarouselPrev"');
    expect(dashboardHtml).toContain('id="campaignCarouselNext"');
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

  it("creates a basic campaign with system defaults and immediately opens the story", () => {
    expect(dashboardHtml).toContain('id="quickCampaignName"');
    expect(dashboardHtml).toContain('id="quickCampaignCharacter"');
    expect(dashboardHtml).toContain('id="advancedCampaignCreation" href="#campaigns"');
    expect(dashboardHtml).not.toMatch(/id="quickCampaign(?:StoryLength|TurnControl|Provider|Illustration)/);
    expect(dashboardScript).toContain("body: JSON.stringify({ title, worldVersionId: dashboardWorld.latestVersionId, selectedCharacterId })");
    expect(dashboardScript).toContain('window.location.assign(`/story/${encodeURIComponent(campaign.id)}`)');
  });

  it("resumes a selected campaign directly from its dashboard card", () => {
    expect(dashboardScript).toContain("function createDashboardCampaignCard(campaign)");
    expect(dashboardScript).toContain('localStorage.setItem("infiniteQuestLastCampaignId", campaign.id)');
    expect(dashboardScript).toContain('window.location.assign(`/story/${encodeURIComponent(campaign.id)}`)');
  });
});
