import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const nexusSource = readFileSync("apps/web/src/nexus.js", "utf8");
const markup = readFileSync("apps/web/public/index.html", "utf8");

describe("legacy provider and authoring dismissal", () => {
  it("uses the configured remote LM Studio endpoint instead of host.docker.internal", () => {
    expect(nexusSource).not.toContain("host.docker.internal");
    expect(nexusSource).toContain("http://10.11.41.224:1234");
  });

  it("assigns a unique suggested name when creating another provider", () => {
    expect(nexusSource).toContain("function nextAvailableProviderName");
    expect(nexusSource).toContain("nextAvailableProviderName(\"Local LM Studio\")");
  });

  it("reduces the output reserve when a discovered model has a smaller context window", () => {
    expect(nexusSource).toContain("function constrainProviderOutputReserve");
    expect(nexusSource).toContain("contextLength - 513");
  });

  it("keeps the response-format policy in the text-only provider configuration", () => {
    expect(nexusSource).toContain('elements.providerResponseFormatPolicy.value = "required"');
    expect(nexusSource).toContain("configuration.textResponseFormatPolicy = elements.providerResponseFormatPolicy.value");
    expect(nexusSource).toContain('delete configuration.textResponseFormatPolicy');
    expect(nexusSource).toContain("provider.configuration?.textResponseFormatPolicy || \"required\"");
  });

  it("renders bounded server capability status and clears stale capability details", () => {
    expect(nexusSource).toContain("function renderResponseFormatCapability");
    expect(nexusSource).toContain("responseFormatCapability");
    expect(nexusSource).toContain("responseFormatCapabilitySequence += 1");
    expect(nexusSource).toContain('operation?.status === "verified"');
    expect(nexusSource).toContain("operation.expiresAt");
    expect(nexusSource).toContain("discovered ${advertisedAt}");
    expect(nexusSource).toContain("Mixed schema coverage");
  });

  it("uses the shared edit dismissal policy for staged provider and authoring dialogs", () => {
    expect(nexusSource).toContain("bindEditDialogDismissal");
    expect(nexusSource).toContain("requestEditDismissal");
    expect(nexusSource).toContain("providerDialog");
    expect(nexusSource).toContain("worldAuthorDialog");
    expect(nexusSource).toContain("characterDialog");
  });

  it("keeps provider credentials out of serialized edit snapshots", () => {
    expect(nexusSource).toContain("providerApiKey");
    expect(nexusSource).toMatch(/control instanceof HTMLInputElement && control\.type === "password"\)\s*\{\s*return `\$\{control\.id\}:\$\{Boolean\(control\.value\)\}`;/);
  });

  it("labels world-scoped character application as a local draft operation", () => {
    expect(markup).toContain("Apply to world draft");
    expect(nexusSource).toContain("worldAuthorWorkingContent");
    expect(nexusSource).toContain("Save the world form to persist this change");
  });

  it("preserves immediate campaign character profile persistence", () => {
    expect(nexusSource).toContain("/character-profile");
    expect(nexusSource).toContain('method: "PUT"');
    expect(nexusSource).toContain('characterModalScope === "campaign"');
  });

  it("sets the shared Save decision's rendered display state for each prompt owner", () => {
    expect(nexusSource).toContain('elements.saveCampaignEditsDecision.style.display = visible ? "" : "none"');
    expect(nexusSource).toContain("setCampaignSaveDecisionVisible(allowSave)");
    expect(nexusSource).toContain("setCampaignSaveDecisionVisible(true)");
    expect(nexusSource).toContain("setCampaignSaveDecisionVisible(false)");
  });
});
