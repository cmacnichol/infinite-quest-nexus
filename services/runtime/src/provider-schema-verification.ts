import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import type { SchemaVerification } from "@infinite-quest/contracts";

const MAX_BYTES = 1_048_576;
const MAX_RECORDS = 1_000;
const MAX_DURATION_MS = 30 * 86_400_000;
const MAX_MODEL_LENGTH = 256;
const MAX_ROUTING_SLUGS = 64;
const MAX_ROUTING_SLUG_LENGTH = 128;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const ROUTING_SLUG = /^[a-z0-9][a-z0-9._:/-]*$/i;
const ALLOWED_RECORD_KEYS = new Set([
  "version", "providerType", "endpointIdentity", "model", "routeConfigHash", "adapterProtocol", "operation", "schemaHash",
  "streaming", "verifiedAt", "expiresAt", "providerRoutingSlugs", "nativeOpenTrackerObjects"
]);
export type SchemaVerificationFile = Readonly<{ records: readonly SchemaVerification[]; digest: string }>;
export type SchemaVerificationFileOptions = Readonly<{ now?: () => number }>;

function invalid(): never { throw new Error("TEXT_SCHEMA_VERIFICATION_FILE is invalid."); }
function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
function isConcreteModel(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_MODEL_LENGTH && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value) && !/(^|[/:@])(auto|default|preset)(?:$|[/:@])/i.test(value);
}
function isSha256Digest(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}
function readBounded(path: string): Buffer {
  let descriptor: number | undefined;
  try {
    const initial = statSync(path);
    if (!initial.isFile() || initial.size > MAX_BYTES) return invalid();
    descriptor = openSync(path, "r");
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_BYTES) return invalid();
    const bytes = Buffer.alloc(stat.size);
    if (readSync(descriptor, bytes, 0, bytes.length, 0) !== bytes.length || readSync(descriptor, Buffer.alloc(1), 0, 1, bytes.length) !== 0) return invalid();
    return bytes;
  } catch {
    return invalid();
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* configuration failure is already normalized */ }
    }
  }
}
function record(value: unknown, now: number): SchemaVerification {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !ALLOWED_RECORD_KEYS.has(key)) || Object.keys(item).length !== ALLOWED_RECORD_KEYS.size) return invalid();
  if (item.version !== 1 || (item.providerType !== "openrouter" && item.providerType !== "openai_compatible") || item.adapterProtocol !== "text-schema-adapter-v1" || !["story", "choices", "continuity_review"].includes(String(item.operation)) || typeof item.streaming !== "boolean" || typeof item.nativeOpenTrackerObjects !== "boolean") return invalid();
  if (!isSha256Digest(item.endpointIdentity) || !isSha256Digest(item.routeConfigHash) || !isSha256Digest(item.schemaHash) || !isConcreteModel(item.model) || !isCanonicalTimestamp(item.verifiedAt) || !isCanonicalTimestamp(item.expiresAt)) return invalid();
  if (!Array.isArray(item.providerRoutingSlugs) || item.providerRoutingSlugs.length > MAX_ROUTING_SLUGS || item.providerRoutingSlugs.some((slug) => typeof slug !== "string" || slug.length === 0 || slug.length > MAX_ROUTING_SLUG_LENGTH || !ROUTING_SLUG.test(slug)) || new Set(item.providerRoutingSlugs).size !== item.providerRoutingSlugs.length) return invalid();
  if ((item.providerType === "openrouter" && item.providerRoutingSlugs.length === 0) || (item.providerType === "openai_compatible" && item.providerRoutingSlugs.length !== 0)) return invalid();
  const verifiedAt = Date.parse(item.verifiedAt), expiresAt = Date.parse(item.expiresAt);
  if (expiresAt <= verifiedAt || expiresAt - verifiedAt > MAX_DURATION_MS || verifiedAt > now) return invalid();
  return Object.freeze({
    version: 1,
    providerType: item.providerType,
    endpointIdentity: item.endpointIdentity,
    model: item.model,
    routeConfigHash: item.routeConfigHash,
    adapterProtocol: "text-schema-adapter-v1",
    operation: item.operation as SchemaVerification["operation"],
    schemaHash: item.schemaHash,
    streaming: item.streaming,
    verifiedAt: item.verifiedAt,
    expiresAt: item.expiresAt,
    providerRoutingSlugs: Object.freeze([...item.providerRoutingSlugs]),
    nativeOpenTrackerObjects: item.nativeOpenTrackerObjects
  });
}
export function loadSchemaVerificationFile(path: string | undefined, options: SchemaVerificationFileOptions = {}): SchemaVerificationFile {
  if (!path) return Object.freeze({ records: Object.freeze([]), digest: createHash("sha256").update("").digest("hex") });
  const bytes = readBounded(path);
  let parsed: unknown; try { parsed = JSON.parse(bytes.toString("utf8")); } catch { return invalid(); }
  if (!Array.isArray(parsed) || parsed.length > MAX_RECORDS) return invalid();
  const now = options.now?.() ?? Date.now();
  if (!Number.isFinite(now)) return invalid();
  return Object.freeze({ records: Object.freeze(parsed.map((value) => record(value, now))), digest: createHash("sha256").update(bytes).digest("hex") });
}
