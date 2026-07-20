import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
  legacyIndexPath: string;
  assetStorageDriver: "filesystem";
  assetStorageRoot: string;
  credentialEncryptionKey: string;
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
    legacyIndexPath: resolve(process.env.LEGACY_INDEX_PATH?.trim() || "index.html"),
    assetStorageDriver: "filesystem",
    assetStorageRoot: resolve(process.env.ASSET_STORAGE_ROOT?.trim() || "local-data/assets"),
    credentialEncryptionKey: secretSetting("CREDENTIAL_ENCRYPTION_KEY")
  };
}
