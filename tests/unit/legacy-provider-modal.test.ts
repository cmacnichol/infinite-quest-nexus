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

  it("submits either explicit model routing or a resolved OpenRouter preset, never both", () => {
    const saveStart = nexusSource.indexOf("async function saveProvider");
    const saveEnd = nexusSource.indexOf("\nasync function refreshProviderModelsFromForm", saveStart);
    const saveSource = nexusSource.slice(saveStart, saveEnd);
    expect(saveSource).toContain("providerRoutingPayload()");
    expect(saveSource).toContain("...routing");
    expect(saveSource).not.toContain("providerPolicy:");
  });
});
