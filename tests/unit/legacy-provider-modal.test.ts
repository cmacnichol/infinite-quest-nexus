import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const nexusSource = readFileSync("apps/web/src/nexus.js", "utf8");
const providerEditor = readFileSync("apps/web-next/src/settings/provider-editor.js", "utf8");
const markup = readFileSync("apps/web/public/index.html", "utf8");

describe("legacy provider and authoring dismissal", () => {
  it("uses the configured remote LM Studio endpoint instead of host.docker.internal", () => {
    expect(providerEditor).not.toContain("host.docker.internal");
    expect(providerEditor).toContain("http://10.11.41.224:1234");
  });

  it("assigns a unique suggested name when creating another provider", () => {
    expect(providerEditor).toContain("function nextAvailableProviderName");
    expect(providerEditor).toContain("nextAvailableProviderName(\"Local LM Studio\")");
  });

  it("reduces the output reserve when a discovered model has a smaller context window", () => {
    expect(providerEditor).toContain("function constrainProviderOutputReserve");
    expect(providerEditor).toContain("contextLength - 513");
  });

  it("keeps the response-format policy in the text-only provider configuration", () => {
    expect(providerEditor).toContain('elements.providerResponseFormatPolicy.value = "required"');
    expect(providerEditor).toContain("configuration.textResponseFormatPolicy = elements.providerResponseFormatPolicy.value");
    expect(providerEditor).toContain('delete configuration.textResponseFormatPolicy');
    expect(providerEditor).toContain("provider.configuration?.textResponseFormatPolicy || \"required\"");
  });

  it("renders bounded server capability status and clears stale capability details", () => {
    expect(providerEditor).toContain("function renderResponseFormatCapability");
    expect(providerEditor).toContain("responseFormatCapability");
    expect(providerEditor).toContain("responseFormatCapabilitySequence += 1");
    expect(providerEditor).toContain('operation?.status === "verified"');
    expect(providerEditor).toContain("operation.expiresAt");
    expect(providerEditor).toContain("discovered ${advertisedAt}");
    expect(providerEditor).toContain("Mixed schema coverage");
  });

  it("uses the shared edit dismissal policy for staged provider and authoring dialogs", () => {
    expect(nexusSource).toContain("bindEditDialogDismissal");
    expect(nexusSource).toContain("requestEditDismissal");
    expect(providerEditor).toContain("bindEditDialogDismissal");
    expect(nexusSource).toContain("worldAuthorDialog");
    expect(nexusSource).toContain("characterDialog");
  });

  it("keeps provider credentials out of serialized edit snapshots", () => {
    expect(providerEditor).toContain('control.type === "password" ? Boolean(control.value)');
    expect(nexusSource).toMatch(/control instanceof HTMLInputElement && control\.type === "password"\)\s*\{\s*return `\$\{control\.id\}:\$\{Boolean\(control\.value\)\}`;/);
  });

  it("labels world-scoped character application as a local draft operation", () => {
    expect(nexusSource).toContain('elements.saveCharacter.textContent = "Apply to world draft"');
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
