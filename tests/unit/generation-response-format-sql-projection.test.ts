import { expect, test } from "vitest";
import { generationResponseFormatProjection } from "../../packages/database/src/generation-response-format-projection.js";

test("response-format status SQL projects bounded scalar paths and never casts malformed booleans", () => {
  const sql = generationResponseFormatProjection("orchestration_private");
  expect(sql).toContain("responseContractInvocations");
  expect(sql).toContain("IN ('true','false')");
  expect(sql).not.toMatch(/schema'\)|endpointIdentity|routeConfigHash|providerRoutingSlugs|prompt|credential/i);
});
