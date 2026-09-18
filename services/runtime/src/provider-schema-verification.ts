import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SchemaVerification } from "@infinite-quest/contracts";

const MAX_BYTES = 1_048_576;
const MAX_RECORDS = 1_000;
const MAX_DURATION_MS = 30 * 86_400_000;
export type SchemaVerificationFile = Readonly<{ records: readonly SchemaVerification[]; digest: string }>;

function invalid(): never { throw new Error("TEXT_SCHEMA_VERIFICATION_FILE is invalid."); }
function record(value: unknown): SchemaVerification {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || (item.providerType !== "openrouter" && item.providerType !== "openai_compatible") || item.adapterProtocol !== "text-schema-adapter-v1" || !["story", "choices", "continuity_review"].includes(String(item.operation)) || typeof item.streaming !== "boolean" || typeof item.nativeOpenTrackerObjects !== "boolean") return invalid();
  const strings = ["endpointIdentity", "model", "routeConfigHash", "schemaHash", "verifiedAt", "expiresAt"] as const;
  if (strings.some((key) => typeof item[key] !== "string" || !item[key])) return invalid();
  if (!Array.isArray(item.providerRoutingSlugs) || item.providerRoutingSlugs.some((slug) => typeof slug !== "string" || slug.length > 128)) return invalid();
  const verifiedAt = Date.parse(item.verifiedAt as string), expiresAt = Date.parse(item.expiresAt as string);
  if (!Number.isFinite(verifiedAt) || !Number.isFinite(expiresAt) || expiresAt <= verifiedAt || expiresAt - verifiedAt > MAX_DURATION_MS || verifiedAt > Date.now()) return invalid();
  return Object.freeze({ ...item, providerRoutingSlugs: Object.freeze([...item.providerRoutingSlugs]) }) as SchemaVerification;
}
export function loadSchemaVerificationFile(path: string | undefined): SchemaVerificationFile {
  if (!path) return Object.freeze({ records: Object.freeze([]), digest: createHash("sha256").update("").digest("hex") });
  const bytes = readFileSync(path); if (bytes.byteLength > MAX_BYTES) return invalid();
  let parsed: unknown; try { parsed = JSON.parse(bytes.toString("utf8")); } catch { return invalid(); }
  if (!Array.isArray(parsed) || parsed.length > MAX_RECORDS) return invalid();
  return Object.freeze({ records: Object.freeze(parsed.map(record)), digest: createHash("sha256").update(bytes).digest("hex") });
}
