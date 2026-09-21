import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSchemaVerificationFile } from "../../services/runtime/src/provider-schema-verification.js";
import { createProviderResponseFormatCapabilities } from "../../services/runtime/src/provider-response-format-capabilities.js";
import { getProviderOutputSchemaV2 } from "../../packages/contracts/src/provider-output-schema.js";
import { resolveResponseContractAdmission } from "../../packages/application/src/providers/response-format.js";
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
} as const;
const directories: string[] = [];
function file(value: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "schema-verification-"));
  directories.push(directory);
  const path = join(directory, "records.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}
function rawFile(value: string) {
  const directory = mkdtempSync(join(tmpdir(), "schema-verification-"));
  directories.push(directory);
  const path = join(directory, "records.json");
  writeFileSync(path, value);
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
  it("keeps v2 catalog evidence separate from v1 and exposes it to the v2 capability gate", () => {
    const v2 = { ...valid, version: 2, adapterProtocol: "text-schema-adapter-v2", operation: "event_coverage", schemaHash: "d".repeat(64) };
    const loaded = load(file([valid, v2]));
    expect(loaded.records.map((record) => record.version)).toEqual([1, 2]);
    const result = createProviderResponseFormatCapabilities({ records: loaded.records, registryDigest: loaded.digest, now: () => Date.parse(now) })
      .eligibilityV2({ advertisement: { supportedParameters: ["response_format", "structured_outputs"], discoveredAt: now }, providerType: "openrouter",
        endpointIdentity: digest, model: valid.model, routeConfigHash: valid.routeConfigHash, adapterProtocol: "text-schema-adapter-v2",
        operation: "event_coverage", schemaHash: "d".repeat(64), streaming: false, now });
    expect(result).toMatchObject({ status: "verified", verification: { version: 2, operation: "event_coverage" } });
    const storyV2 = { ...valid, version: 2 as const, adapterProtocol: "text-schema-adapter-v2" as const };
    const v1Only = createProviderResponseFormatCapabilities({ records: [valid], now: () => Date.parse(now) });
    expect(v1Only.eligibilityV2({ advertisement: { supportedParameters: ["response_format", "structured_outputs"], discoveredAt: now }, providerType: "openrouter",
      endpointIdentity: digest, model: valid.model, routeConfigHash: valid.routeConfigHash, adapterProtocol: "text-schema-adapter-v2",
      operation: "story", schemaHash: valid.schemaHash, streaming: false, now })).toMatchObject({ reason: "missing_verification" });
    const v2Only = createProviderResponseFormatCapabilities({ records: [storyV2], now: () => Date.parse(now) });
    expect(v2Only.eligibility({ advertisement: { supportedParameters: ["response_format", "structured_outputs"], discoveredAt: now }, providerType: "openrouter",
      endpointIdentity: digest, model: valid.model, routeConfigHash: valid.routeConfigHash, adapterProtocol: "text-schema-adapter-v1",
      operation: "story", schemaHash: valid.schemaHash, streaming: false, now })).toMatchObject({ reason: "missing_verification" });
  });
  it("carries a file-loaded exact Story v2 record into direct-model admission", () => {
    const story = getProviderOutputSchemaV2("story");
    const v2 = { ...valid, version: 2, adapterProtocol: "text-schema-adapter-v2", operation: "story", schemaHash: story.schemaHash };
    const loaded = load(file([v2]));
    const capabilities = createProviderResponseFormatCapabilities({ records: loaded.records, registryDigest: loaded.digest, now: () => Date.parse(now) });
    const admission = resolveResponseContractAdmission({ selection: { kind: "model", modelId: valid.model }, directEligibility: () => capabilities.eligibilityV2({
      advertisement: { supportedParameters: ["response_format", "structured_outputs"], discoveredAt: now }, providerType: "openrouter",
      endpointIdentity: digest, model: valid.model, routeConfigHash: valid.routeConfigHash, adapterProtocol: "text-schema-adapter-v2",
      operation: "story", schemaHash: story.schemaHash, streaming: false, now, nativeOpenTrackerObjects: true
    }) });
    expect(admission).toMatchObject({ basis: "model_verified", verification: { version: 2, schemaHash: story.schemaHash, operation: "story" } });
  });
  it("returns an empty immutable registry when no path is configured", () => expect(load(undefined)).toEqual({ records: [], digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }));
  it("loads expired records so the resolver can report expiry", () => expect(load(file([{ ...valid, expiresAt: "2026-09-18T11:59:59.999Z" }])).records[0]?.expiresAt).toBe("2026-09-18T11:59:59.999Z"));
  it("allows empty routing only for OpenAI-compatible records", () => expect(load(file([{ ...valid, providerType: "openai_compatible", providerRoutingSlugs: [] }])).records[0]?.providerRoutingSlugs).toEqual([]));
  it.each([
    { ...valid, ignored: "untrusted" }, { ...valid, endpointIdentity: "endpoint" }, { ...valid, endpointIdentity: [digest] }, { ...valid, operation: ["story"] }, { ...valid, routeConfigHash: "route" }, { ...valid, schemaHash: "schema" },
    { ...valid, model: " ".repeat(257) }, { ...valid, model: "provider/auto" }, { ...valid, providerRoutingSlugs: [] }, { ...valid, providerRoutingSlugs: ["not a route"] },
    { ...valid, verifiedAt: "2026-09-18T12:00:00.001Z" }, { ...valid, expiresAt: "2026-11-19T12:00:00.000Z" }, { ...valid, expiresAt: "not-a-date" },
    { ...valid, version: 2, adapterProtocol: "text-schema-adapter-v1" }, { ...valid, version: 1, adapterProtocol: "text-schema-adapter-v2" },
    { ...valid, version: 2, adapterProtocol: "text-schema-adapter-v2", operation: "not_a_catalog_operation" }
  ])("rejects malformed or unsafe records", (value) => expect(() => load(file([value]))).toThrow("TEXT_SCHEMA_VERIFICATION_FILE is invalid."));
  it("rejects unreadable and oversized configured files with the same safe error", () => {
    const directory = mkdtempSync(join(tmpdir(), "schema-verification-")); directories.push(directory);
    const oversized = join(directory, "oversized.json"); writeFileSync(oversized, "[".padEnd(1_048_578, " "));
    expect(() => load(join(directory, "missing.json"))).toThrow("TEXT_SCHEMA_VERIFICATION_FILE is invalid.");
    expect(() => load(oversized)).toThrow("TEXT_SCHEMA_VERIFICATION_FILE is invalid.");
  });
  it("accepts exactly one MiB and 1,000 records, then rejects either bound when exceeded", () => {
    const exactMiB = JSON.stringify([valid]);
    expect(exactMiB.length).toBeLessThan(1_048_576);
    expect(load(rawFile(`${exactMiB}${" ".repeat(1_048_576 - exactMiB.length)}`)).records).toHaveLength(1);
    expect(load(file(Array.from({ length: 1_000 }, () => valid))).records).toHaveLength(1_000);
    expect(() => load(file(Array.from({ length: 1_001 }, () => valid)))).toThrow("TEXT_SCHEMA_VERIFICATION_FILE is invalid.");
    expect(() => load(rawFile(`${exactMiB}${" ".repeat(1_048_577 - exactMiB.length)}`))).toThrow("TEXT_SCHEMA_VERIFICATION_FILE is invalid.");
  });
  it("accepts an expiry exactly thirty days after verification", () => {
    expect(load(file([{ ...valid, verifiedAt: "2026-08-19T12:00:00.000Z", expiresAt: "2026-09-18T12:00:00.000Z" }])).records).toHaveLength(1);
  });
  it("rejects OpenAI-compatible records that contain OpenRouter routing", () => expect(() => load(file([{ ...valid, providerType: "openai_compatible", providerRoutingSlugs: ["openai/gpt-4o"] }]))).toThrow("TEXT_SCHEMA_VERIFICATION_FILE is invalid."));
});
