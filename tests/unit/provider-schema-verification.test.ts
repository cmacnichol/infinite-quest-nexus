import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSchemaVerificationFile } from "../../services/runtime/src/provider-schema-verification.js";
const valid = { version: 1, providerType: "openrouter", endpointIdentity: "e", model: "m", routeConfigHash: "r", adapterProtocol: "text-schema-adapter-v1", operation: "story", schemaHash: "s", streaming: false, verifiedAt: "2026-09-17T00:00:00.000Z", expiresAt: "2026-09-19T00:00:00.000Z", providerRoutingSlugs: [], nativeOpenTrackerObjects: true };
function file(value: unknown) { const path = join(mkdtempSync(join(tmpdir(), "schema-verification-")), "records.json"); writeFileSync(path, JSON.stringify(value)); return path; }
describe("schema verification file", () => {
  it("loads immutable valid records with a deterministic digest", () => { const path = file([valid]); expect(loadSchemaVerificationFile(path)).toMatchObject({ records: [valid] }); expect(loadSchemaVerificationFile(path).digest).toBe(loadSchemaVerificationFile(path).digest); });
  it.each([{ ...valid, verifiedAt: "2026-09-19T00:00:00.000Z" }, { ...valid, expiresAt: "2026-11-19T00:00:00.000Z" }, { ...valid, expiresAt: "no" }])("rejects invalid verification chronology", (value) => expect(() => loadSchemaVerificationFile(file([value]))).toThrow("TEXT_SCHEMA_VERIFICATION_FILE"));
});
