import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("client-contract benchmark", () => {
  it("labels serialized JSON measurements as payload bytes", () => {
    const output = execFileSync(
      "pnpm",
      ["exec", "tsx", "scripts/benchmark-client-contracts.ts"],
      { encoding: "utf8" }
    );
    const result = JSON.parse(output) as Record<string, unknown>;

    expect(result).toHaveProperty("payloadBytes");
    expect(result).not.toHaveProperty("frameBytes");
    expect(result).toHaveProperty("pollingPayloadBytes");
  });
});
