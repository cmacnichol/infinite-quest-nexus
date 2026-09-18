import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDatabasePool, type DatabasePool } from "../../packages/database/src/pool.js";
import { generationResponseFormatProjection } from "../../packages/database/src/generation-response-format-projection.js";
import { projectGenerationResponseFormat } from "../../packages/contracts/src/generation-response-format-projection.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("generation response-contract SQL projection", () => {
  let pool: DatabasePool;
  beforeAll(() => { pool = createDatabasePool(databaseUrl!, 1); });
  afterAll(async () => { await pool.end(); });

  test("preserves numeric v1 and converts malformed boolean/scalars to safe unknown values", async () => {
    const source = {
      queuedResponsePolicy: { version: 1, policy: "required", model: "model-a" },
      frozenResponseContracts: { version: 1, contracts: { "story:stream": { mode: "json_schema", operation: "story", streaming: true, schemaVersion: "story-v1", schemaHash: "a".repeat(64) } } },
      responseContractInvocations: [{ version: 999999999999999999999999999999999999999999999999999999999999999999999, invocationKey: "story:stream", request: { mode: "json_schema", streaming: "not-a-boolean", requestedModel: "x".repeat(300), schemaHash: "a".repeat(64) }, response: { returnedModel: "model-b", returnedProviderRoute: "route-a", diagnosticCode: null } }]
    };
    const result = await pool.query<{ projected: unknown }>(`SELECT ${generationResponseFormatProjection("source")} AS projected FROM (SELECT $1::jsonb AS source) item`, [JSON.stringify(source)]);
    expect(result.rows[0]?.projected).toMatchObject({ queuedResponsePolicy: { version: 1 }, frozenResponseContracts: { version: 1 } });
    expect(projectGenerationResponseFormat(result.rows[0]?.projected)).toMatchObject({ savedPolicy: "required", effectiveMode: "unknown", preflight: "unknown" });
  });

  test("projects absent legacy, selected v1 ledger, and preflight unavailability from actual PostgreSQL JSONB", async () => {
    const selected = {
      queuedResponsePolicy: { version: 1, policy: "auto", model: "model-a" },
      frozenResponseContracts: { version: 1, contracts: { "story:nonstream": { mode: "json_object", operation: "story", streaming: false } } },
      responseContractInvocations: [{ version: 1, invocationKey: "story:nonstream", request: { mode: "json_object", requestedModel: "model-a" }, response: { returnedModel: "model-b", returnedProviderRoute: "route-b", diagnosticCode: null } }]
    };
    const result = await pool.query<{ projected: unknown }>(`SELECT ${generationResponseFormatProjection("source")} AS projected FROM (VALUES ('{}'::jsonb), ($1::jsonb)) AS cases(source) ORDER BY source = '{}'::jsonb DESC`, [JSON.stringify(selected)]);
    expect(projectGenerationResponseFormat(result.rows[0]?.projected)).toMatchObject({ savedPolicy: "legacy", effectiveMode: "legacy" });
    expect(projectGenerationResponseFormat(result.rows[1]?.projected)).toMatchObject({ savedPolicy: "auto", effectiveMode: "json_object", operation: "story", streaming: false, requestedModel: "model-a", returnedModel: "model-b", returnedRoute: "route-b", preflight: "selected" });
    expect(projectGenerationResponseFormat({ ...(result.rows[0]?.projected as object), queuedResponsePolicy: { version: 1, policy: "required" }, errorCode: "response_contract_unavailable" })).toMatchObject({ savedPolicy: "required", effectiveMode: "unavailable", preflight: "unavailable" });
  });
});
