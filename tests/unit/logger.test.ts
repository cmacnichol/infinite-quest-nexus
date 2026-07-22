import { describe, expect, it } from "vitest";
import { createLoggerOptions, LOGGER_REDACT_PATHS } from "../../packages/logger/src/index.js";

describe("shared logger configuration", () => {
  it("redacts request credentials and provider secrets", () => {
    const options = createLoggerOptions();
    const redaction = options.redact as { censor?: string; paths?: string[] };

    expect(redaction.censor).toBe("[Redacted]");
    expect(redaction.paths).toEqual(expect.arrayContaining([
      "req.headers.authorization",
      "req.headers.cookie",
      "*.apiKey",
      "*.credentialSecret"
    ]));
    expect(redaction.paths).toEqual([...LOGGER_REDACT_PATHS]);
  });
});
