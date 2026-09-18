import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const nexusSource = readFileSync("apps/web/public/nexus.js", "utf8");

describe("legacy provider modal defaults", () => {
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
    expect(nexusSource).toContain('elements.providerResponseFormatPolicy.value = "legacy"');
    expect(nexusSource).toContain("configuration.textResponseFormatPolicy = elements.providerResponseFormatPolicy.value");
    expect(nexusSource).toContain('delete configuration.textResponseFormatPolicy');
    expect(nexusSource).toContain("provider.configuration?.textResponseFormatPolicy || \"legacy\"");
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
});
