import { expect, test } from "vitest";
import { generationResponseFormatProjection } from "../../packages/database/src/generation-response-format-projection.js";

test("response-format status SQL projects bounded scalar paths and never casts malformed booleans", () => {
  const sql = generationResponseFormatProjection("orchestration_private");
  expect(sql).toContain("responseContractInvocations");
  expect(sql).toContain("IN ('true','false')");
  expect(sql).toContain("queuedResponsePolicy,authority,selection,slug");
  expect(sql).toContain("queuedResponsePolicy,authority,model");
  expect(sql).toContain("response,returnedModel}') BETWEEN 1 AND 500");
  expect(sql).toContain("response,returnedProviderRoute}') BETWEEN 1 AND 500");
  expect(sql).toContain("returnedProviderRoute");
  expect(sql).not.toMatch(/schema'\)|endpointIdentity|endpointReference|routeConfigHash|providerRoutingSlugs|prompt|credential/i);
});
