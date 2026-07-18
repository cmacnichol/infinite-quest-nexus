import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const playerHtml = readFileSync("index.html", "utf8");
const managementHtml = readFileSync("apps/web/public/index.html", "utf8");
const managementScript = readFileSync("apps/web/public/nexus.js", "utf8");

describe("Nexus management UI contracts", () => {
  it("uses Nexus branding and focused management navigation", () => {
    expect(playerHtml).toContain("<h1>Infinite Quest Nexus</h1>");
    expect(playerHtml).not.toMatch(/single-page AI-powered choose-your-own-adventure story engine/i);
    expect(playerHtml).toContain('id="btnOpenNexusImport" type="button" role="menuitem">World Management');
    expect(playerHtml).toContain('id="btnOpenProviderManagement" type="button" role="menuitem">Provider Management');
  });

  it("exposes campaign resume and guarded campaign/world deletion", () => {
    expect(managementHtml).toContain('id="loadCampaign"');
    expect(managementHtml).toContain('id="deleteCampaign"');
    expect(managementHtml).toContain('id="deleteWorld"');
    expect(managementHtml).toContain('id="deleteDialog"');
    expect(managementScript).toContain("infiniteQuestNexusCampaignResume.v1");
    expect(managementScript).not.toContain("window.prompt");
  });

  it("documents compression and locks only API-supplied context", () => {
    expect(managementHtml.match(/option value="(?:auto|full|balanced|compact|summary)" title=/g)).toHaveLength(5);
    expect(managementScript).toContain("providerContextTokens.readOnly = true");
    expect(managementScript).toContain("providerContextTokens.readOnly = false");
    expect(managementScript).toContain("did not advertise a context length");
  });
});
