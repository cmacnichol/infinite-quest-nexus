import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
// @ts-expect-error Repository runner scripts intentionally have no declaration files.
import { tsxCommand } from "../../scripts/node-tool-command.mjs";

describe("client-contract benchmark", () => {
  it("labels serialized JSON measurements as payload bytes", () => {
    const command = tsxCommand(["scripts/benchmark-client-contracts.ts"]);
    const output = execFileSync(
      command.executable,
      command.arguments,
      { encoding: "utf8" }
    );
    const result = JSON.parse(output) as Record<string, unknown>;

    expect(result).toHaveProperty("payloadBytes");
    expect(result).not.toHaveProperty("frameBytes");
    expect(result).toHaveProperty("pollingPayloadBytes");
    expect(result).toMatchObject({
      streamAllowlist: [
        "id",
        "campaignId",
        "expectedTurnNumber",
        "status",
        "action",
        "operationKind",
        "replacementTurnId",
        "attempts",
        "partialNarration",
        "errorMessage",
        "errorCode",
        "resultTurnId"
      ]
    });
  });
});
