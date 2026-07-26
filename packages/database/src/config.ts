import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { parseExactOriginList } from "../../security/src/exact-origins.js";

export type RuntimeSecurityConfig = {
  corsAllowedOrigins: string[];
  providerNetworkAllowlist: string[];
  cspImageAllowedOrigins: string[];
  apiDefaultBodyLimitBytes: number;
  apiImportBodyLimitBytes: number;
  apiAssetBodyLimitBytes: number;
  apiRateLimitWindowSeconds: number;
  apiRateLimitProviderRequests: number;
  apiRateLimitGenerationRequests: number;
  apiRateLimitImportRequests: number;
  apiConcurrencyProviderRequests: number;
  apiConcurrencyImportRequests: number;
  trustProxyHops: number;
};

export type ArchiveLimits = {
  maxCompressedBytes: number;
  maxUncompressedBytes: number;
  maxEntries: number;
  maxExpansionRatio: number;
  maxManifestBytes: number;
  maxJsonEntryBytes: number;
};

export type RuntimeConfig = {
  role: "all" | "api" | "worker" | "migrate";
  host: string;
  port: number;
  databaseUrl: string;
  databaseMaxConnections: number;
  migrationDirectory: string;
  migrationWaitSeconds: number;
  allowMaintenanceMigrations: boolean;
  workerPollIntervalMs: number;
  workerLeaseSeconds: number;
  webRoot: string;
  assetStorageDriver: "filesystem";
  assetStorageRoot: string;
  archiveStorageRoot: string;
  archivePreviewTtlSeconds: number;
  systemArchiveArtifactTtlSeconds: number;
  campaignArchiveLimits: ArchiveLimits;
  systemArchiveLimits: ArchiveLimits;
  credentialEncryptionKey: string;
  security: RuntimeSecurityConfig;
};

function secretSetting(name: string): string {
  const direct = process.env[name]?.trim();
  if (direct) return direct;
  const file = process.env[`${name}_FILE`]?.trim();
  if (!file) return "";
  return readFileSync(file, "utf8").trim();
}

function integerSetting(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function archiveLimitsSetting(
  scope: "CAMPAIGN" | "SYSTEM",
  approved: Pick<ArchiveLimits, "maxCompressedBytes" | "maxUncompressedBytes" | "maxEntries">
): ArchiveLimits {
  const prefix = `${scope}_ARCHIVE`;
  return {
    maxCompressedBytes: integerSetting(`${prefix}_MAX_COMPRESSED_BYTES`, approved.maxCompressedBytes, 1, approved.maxCompressedBytes),
    maxUncompressedBytes: integerSetting(`${prefix}_MAX_UNCOMPRESSED_BYTES`, approved.maxUncompressedBytes, 1, approved.maxUncompressedBytes),
    maxEntries: integerSetting(`${prefix}_MAX_ENTRIES`, approved.maxEntries, 1, approved.maxEntries),
    maxExpansionRatio: integerSetting(`${prefix}_MAX_EXPANSION_RATIO`, 100, 1, 100),
    maxManifestBytes: integerSetting(`${prefix}_MAX_MANIFEST_BYTES`, 5_242_880, 1, 5_242_880),
    maxJsonEntryBytes: integerSetting(`${prefix}_MAX_JSON_ENTRY_BYTES`, 1_073_741_824, 1, 1_073_741_824)
  };
}

function requiredIntegerSetting(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

const BUILT_IN_PROVIDER_ALLOWLIST = ["localhost", "127.0.0.0/8", "::1/128"] as const;

function normalizeProviderAllowlistEntry(value: string): string {
  const entry = value.trim().toLowerCase();
  const cidrParts = entry.split("/");
  if (cidrParts.length > 2) {
    throw new Error(`PROVIDER_NETWORK_ALLOWLIST contains an invalid CIDR '${value}'.`);
  }
  const [address = "", prefixText] = cidrParts;
  if (prefixText !== undefined) {
    const family = isIP(address);
    const prefix = /^\d+$/.test(prefixText) ? Number(prefixText) : Number.NaN;
    const maximum = family === 4 ? 32 : family === 6 ? 128 : -1;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > maximum) {
      throw new Error(`PROVIDER_NETWORK_ALLOWLIST contains an invalid CIDR '${value}'.`);
    }
    return `${address}/${prefix}`;
  }
  if (isIP(entry)) return entry;
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(entry)) {
    throw new Error(`PROVIDER_NETWORK_ALLOWLIST contains an invalid hostname '${value}'.`);
  }
  return entry;
}

export function parseProviderAllowlist(value: string | undefined): string[] {
  const configured = value?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [];
  return [...new Set([...BUILT_IN_PROVIDER_ALLOWLIST, ...configured.map(normalizeProviderAllowlistEntry)])];
}

function booleanSetting(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${name} must be true or false.`);
}

export function loadRuntimeConfig(): RuntimeConfig {
  const roleValue = process.env.APP_ROLE ?? process.argv[2] ?? "all";
  if (!(["all", "api", "worker", "migrate"] as const).includes(roleValue as RuntimeConfig["role"])) {
    throw new Error(`Unsupported APP_ROLE '${roleValue}'. Expected all, api, worker, or migrate.`);
  }
  const databaseUrl = secretSetting("DATABASE_URL");
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");

  return {
    role: roleValue as RuntimeConfig["role"],
    host: process.env.APP_HOST?.trim() || "0.0.0.0",
    port: integerSetting("APP_PORT", 8080, 1, 65535),
    databaseUrl,
    databaseMaxConnections: integerSetting("DATABASE_MAX_CONNECTIONS", roleValue === "worker" ? 8 : 12, 2, 100),
    migrationDirectory: resolve(process.env.MIGRATION_DIRECTORY?.trim() || "database/migrations"),
    migrationWaitSeconds: integerSetting("MIGRATION_WAIT_SECONDS", 120, 10, 3600),
    allowMaintenanceMigrations: booleanSetting("ALLOW_MAINTENANCE_MIGRATIONS", false),
    workerPollIntervalMs: integerSetting("WORKER_POLL_INTERVAL_MS", 2000, 250, 60000),
    workerLeaseSeconds: integerSetting("WORKER_LEASE_SECONDS", 60, 15, 3600),
    webRoot: resolve(process.env.WEB_ROOT?.trim() || "apps/web/public"),
    assetStorageDriver: "filesystem",
    assetStorageRoot: resolve(process.env.ASSET_STORAGE_ROOT?.trim() || "local-data/assets"),
    archiveStorageRoot: resolve(process.env.ARCHIVE_STORAGE_ROOT?.trim() || "local-data/archives"),
    archivePreviewTtlSeconds: integerSetting("ARCHIVE_PREVIEW_TTL_SECONDS", 1800, 60, 86400),
    systemArchiveArtifactTtlSeconds: integerSetting("SYSTEM_ARCHIVE_ARTIFACT_TTL_SECONDS", 86400, 300, 604800),
    campaignArchiveLimits: archiveLimitsSetting("CAMPAIGN", {
      maxCompressedBytes: 2_147_483_648,
      maxUncompressedBytes: 21_474_836_480,
      maxEntries: 100_000
    }),
    systemArchiveLimits: archiveLimitsSetting("SYSTEM", {
      maxCompressedBytes: 53_687_091_200,
      maxUncompressedBytes: 214_748_364_800,
      maxEntries: 1_000_000
    }),
    credentialEncryptionKey: secretSetting("CREDENTIAL_ENCRYPTION_KEY"),
    security: {
      corsAllowedOrigins: parseExactOriginList(process.env.CORS_ALLOWED_ORIGINS, "CORS_ALLOWED_ORIGINS"),
      providerNetworkAllowlist: parseProviderAllowlist(process.env.PROVIDER_NETWORK_ALLOWLIST),
      cspImageAllowedOrigins: parseExactOriginList(process.env.CSP_IMAGE_ALLOWED_ORIGINS, "CSP_IMAGE_ALLOWED_ORIGINS"),
      apiDefaultBodyLimitBytes: requiredIntegerSetting("API_DEFAULT_BODY_LIMIT_BYTES", 1_048_576, 65_536, 67_108_864),
      apiImportBodyLimitBytes: requiredIntegerSetting("API_IMPORT_BODY_LIMIT_BYTES", 16_777_216, 1_048_576, 67_108_864),
      apiAssetBodyLimitBytes: requiredIntegerSetting("API_ASSET_BODY_LIMIT_BYTES", 33_554_432, 1_048_576, 67_108_864),
      apiRateLimitWindowSeconds: requiredIntegerSetting("API_RATE_LIMIT_WINDOW_SECONDS", 60, 1, 3_600),
      apiRateLimitProviderRequests: requiredIntegerSetting("API_RATE_LIMIT_PROVIDER_REQUESTS", 10, 1, 10_000),
      apiRateLimitGenerationRequests: requiredIntegerSetting("API_RATE_LIMIT_GENERATION_REQUESTS", 12, 1, 10_000),
      apiRateLimitImportRequests: requiredIntegerSetting("API_RATE_LIMIT_IMPORT_REQUESTS", 4, 1, 10_000),
      apiConcurrencyProviderRequests: requiredIntegerSetting("API_CONCURRENCY_PROVIDER_REQUESTS", 2, 1, 1_000),
      apiConcurrencyImportRequests: requiredIntegerSetting("API_CONCURRENCY_IMPORT_REQUESTS", 1, 1, 1_000),
      trustProxyHops: requiredIntegerSetting("TRUST_PROXY_HOPS", 0, 0, 16)
    }
  };
}
