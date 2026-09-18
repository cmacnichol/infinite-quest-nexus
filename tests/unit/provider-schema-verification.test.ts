import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSchemaVerificationFile } from "../../services/runtime/src/provider-schema-verification.js";
const now = "2026-09-18T12:00:00.000Z";
const digest = "a".repeat(64);
const valid = {
  version: 1,
  providerType: "openrouter",
  endpointIdentity: digest,
  model: "openai/gpt-4o",
  routeConfigHash: "b".repeat(64),
  adapterProtocol: "text-schema-adapter-v1",
  operation: "story",
  schemaHash: "c".repeat(64),
  streaming: false,
  verifiedAt: "2026-09-17T12:00:00.000Z",
  expiresAt: "2026-09-19T12:00:00.000Z",
  providerRoutingSlugs: ["openai/gpt-4o"],
  nativeOpenTrackerObjects: true
};
const directories: string[] = [];
function file(value: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "schema-verification-"));
  directories.push(directory);
  const path = join(directory, "records.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}
function load(path: string | undefined) { return loadSchemaVerificationFile(path, { now: () => Date.parse(now) }); }
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
describe("schema verification file", () => {
  it("loads immutable exact records and a digest derived from file bytes", () => {
    const result = load(file([valid]));
    expect(result.records).toEqual([valid]);
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.records)).toBe(true);
    expect(Object.isFrozen(result.records[0])).toBe(true);
    expect(Object.isFrozen(result.records[0]?.providerRoutingSlugs)).toBe(true);
  });
  it("returns an empty immutable registry when no path is configured", () => expect(load(undefined)).toEqual({ records: [], digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }));
  it("loads expired records so the resolver can report expiry", () => expect(load(file([{ ...valid, expiresAt: "2026-09-18T11:59:59.999Z" }])).records[0]?.expiresAt).toBe("2026-09-18T11:59:59.999Z"));
  it("allows empty routing only for OpenAI-compatible records", () => expect(load(file([{ ...valid, providerType: "openai_compatible", providerRoutingSlugs: [] }])).records[0]?.providerRoutingSlugs).toEqual([]));
  it.each([
    { ...valid, ignored: "untrusted" }, { ...valid, endpointIdentity: "endpoint" }, { ...valid, endpointIdentity: [digest] }, { ...valid, routeConfigHash: "route" }, { ...valid, schemaHash: "schema" },
    { ...valid, model: " ".repeat(257) }, { ...valid, model: "provider/auto" }, { ...valid, providerRoutingSlugs: [] }, { ...valid, providerRoutingSlugs: ["not a route"] },
    { ...valid, verifiedAt: "2026-09-18T12:00:00.001Z" }, { ...valid, expiresAt: "2026-11-19T12:00:00.000Z" }, { ...valid, expiresAt: "not-a-date" }
  ])("rejects malformed or unsafe records", (value) => expect(() => load(file([value]))).toThrow("TEXT_SCHEMA_VERIFICATION_FILE is invalid."));
  it("rejects unreadable and oversized configured files with the same safe error", () => {
    const directory = mkdtempSync(join(tmpdir(), "schema-verification-")); directories.push(directory);
    const oversized = join(directory, "oversized.json"); writeFileSync(oversized, "[".padEnd(1_048_578, " "));
    expect(() => load(join(directory, "missing.json"))).toThrow("TEXT_SCHEMA_VERIFICATION_FILE is invalid.");
    expect(() => load(oversized)).toThrow("TEXT_SCHEMA_VERIFICATION_FILE is invalid.");
  });
  it("rejects OpenAI-compatible records that contain OpenRouter routing", () => expect(() => load(file([{ ...valid, providerType: "openai_compatible", providerRoutingSlugs: ["openai/gpt-4o"] }]))).toThrow("TEXT_SCHEMA_VERIFICATION_FILE is invalid."));
});
