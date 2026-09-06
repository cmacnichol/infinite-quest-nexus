import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadRuntimeConfig } from "../../packages/database/src/config.js";

const originalEnvironment = { ...process.env };
const securitySettingNames = [
  "CORS_ALLOWED_ORIGINS",
  "PROVIDER_NETWORK_ALLOWLIST",
  "CSP_IMAGE_ALLOWED_ORIGINS",
  "API_DEFAULT_BODY_LIMIT_BYTES",
  "API_IMPORT_BODY_LIMIT_BYTES",
  "API_ASSET_BODY_LIMIT_BYTES",
  "API_RATE_LIMIT_WINDOW_SECONDS",
  "API_RATE_LIMIT_PROVIDER_REQUESTS",
  "API_RATE_LIMIT_GENERATION_REQUESTS",
  "API_RATE_LIMIT_IMPORT_REQUESTS",
  "API_CONCURRENCY_PROVIDER_REQUESTS",
  "API_CONCURRENCY_IMPORT_REQUESTS",
  "TRUST_PROXY_HOPS",
  "LEGACY_WEB_ROOT",
  "NEXT_WEB_ROOT",
  "APP_ROLE",
  "DATABASE_MAX_CONNECTIONS",
  "WORKER_GENERATION_CONCURRENCY",
  "SYSTEM_ARCHIVE_ENABLED",
  "SYSTEM_ARCHIVE_UPLOAD_TTL_SECONDS",
  "SYSTEM_ARCHIVE_CHUNK_BYTES",
  "SYSTEM_ARCHIVE_ALLOW_LIMIT_INCREASE",
  "SYSTEM_ARCHIVE_ALLOW_UNKNOWN_FREE_SPACE",
  "SYSTEM_ARCHIVE_MAX_COMPRESSED_BYTES"
] as const;

afterEach(() => {
  process.env = { ...originalEnvironment };
});

function minimumEnvironment(): void {
  process.env.DATABASE_URL = "postgresql://test@localhost/test";
  for (const settingName of securitySettingNames) delete process.env[settingName];
}

describe("runtime security configuration", () => {
  it("defaults browser access to same-origin and provider access to localhost", () => {
    minimumEnvironment();
    const config = loadRuntimeConfig();

    expect(config.security.corsAllowedOrigins).toEqual([]);
    expect(config.security.providerNetworkAllowlist).toEqual([
      "localhost",
      "127.0.0.0/8",
      "::1/128"
    ]);
    expect(config.security.cspImageAllowedOrigins).toEqual([]);
    expect(config.security.apiDefaultBodyLimitBytes).toBe(1_048_576);
    expect(config.security.apiImportBodyLimitBytes).toBe(2_147_483_648);
    expect(config.security.trustProxyHops).toBe(0);
    expect(config.legacyWebRoot).toBe(resolve("apps/web/dist"));
    expect(config.nextWebRoot).toBe(resolve("apps/web-next/dist"));
  });

  it("resolves explicit legacy and replacement web roots", () => {
    minimumEnvironment();
    process.env.LEGACY_WEB_ROOT = "tmp/legacy-web";
    process.env.NEXT_WEB_ROOT = "tmp/next-web";

    const config = loadRuntimeConfig();

    expect(config.legacyWebRoot).toBe(resolve("tmp/legacy-web"));
    expect(config.nextWebRoot).toBe(resolve("tmp/next-web"));
  });

  it("rejects wildcard and path-bearing origins", () => {
    minimumEnvironment();
    process.env.CORS_ALLOWED_ORIGINS = "*";
    expect(() => loadRuntimeConfig()).toThrow("CORS_ALLOWED_ORIGINS");
    process.env.CORS_ALLOWED_ORIGINS = "https://nexus.example/path";
    expect(() => loadRuntimeConfig()).toThrow("CORS_ALLOWED_ORIGINS");
  });

  it("extends localhost with configured provider destinations", () => {
    minimumEnvironment();
    process.env.PROVIDER_NETWORK_ALLOWLIST = "host.docker.internal,10.20.0.0/16";

    expect(loadRuntimeConfig().security.providerNetworkAllowlist).toEqual([
      "localhost",
      "127.0.0.0/8",
      "::1/128",
      "host.docker.internal",
      "10.20.0.0/16"
    ]);
  });

  it("rejects provider CIDR entries with multiple slashes", () => {
    minimumEnvironment();
    process.env.PROVIDER_NETWORK_ALLOWLIST = "10.20.0.0/16/extra";

    expect(() => loadRuntimeConfig()).toThrow("PROVIDER_NETWORK_ALLOWLIST");
  });

  it("fails instead of clamping invalid security limits", () => {
    minimumEnvironment();
    process.env.API_CONCURRENCY_IMPORT_REQUESTS = "0";
    expect(() => loadRuntimeConfig()).toThrow("API_CONCURRENCY_IMPORT_REQUESTS");
  });
});

describe("worker concurrency configuration", () => {
  it("defaults generation concurrency to one with role-safe pool capacities", () => {
    minimumEnvironment();
    process.env.APP_ROLE = "worker";

    const worker = loadRuntimeConfig();
    expect(worker.workerGenerationConcurrency).toBe(1);
    expect(worker.databaseMaxConnections).toBe(8);

    process.env.APP_ROLE = "all";
    const all = loadRuntimeConfig();
    expect(all.workerGenerationConcurrency).toBe(1);
    expect(all.databaseMaxConnections).toBe(12);
  });

  it.each([1, 4])("accepts generation concurrency boundary %i", (concurrency) => {
    minimumEnvironment();
    process.env.APP_ROLE = "worker";
    process.env.WORKER_GENERATION_CONCURRENCY = String(concurrency);

    expect(loadRuntimeConfig().workerGenerationConcurrency).toBe(concurrency);
  });

  it.each(["0", "5", "1.5", "workers", " "])(
    "rejects invalid generation concurrency %j instead of clamping",
    (concurrency) => {
      minimumEnvironment();
      process.env.APP_ROLE = "worker";
      process.env.WORKER_GENERATION_CONCURRENCY = concurrency;

      expect(() => loadRuntimeConfig()).toThrow("WORKER_GENERATION_CONCURRENCY");
    }
  );

  it.each([
    { role: "worker", concurrency: 4, connections: 7, minimum: 8 },
    { role: "all", concurrency: 4, connections: 11, minimum: 12 }
  ] as const)(
    "rejects $role pool capacity below $minimum and names both settings",
    ({ role, concurrency, connections }) => {
      minimumEnvironment();
      process.env.APP_ROLE = role;
      process.env.WORKER_GENERATION_CONCURRENCY = String(concurrency);
      process.env.DATABASE_MAX_CONNECTIONS = String(connections);

      expect(() => loadRuntimeConfig()).toThrow(
        /DATABASE_MAX_CONNECTIONS.*WORKER_GENERATION_CONCURRENCY/u
      );
    }
  );

  it.each([
    { role: "worker", concurrency: 4, connections: 8 },
    { role: "all", concurrency: 4, connections: 12 }
  ] as const)(
    "accepts the exact $role pool-capacity boundary",
    ({ role, concurrency, connections }) => {
      minimumEnvironment();
      process.env.APP_ROLE = role;
      process.env.WORKER_GENERATION_CONCURRENCY = String(concurrency);
      process.env.DATABASE_MAX_CONNECTIONS = String(connections);

      const config = loadRuntimeConfig();
      expect(config.workerGenerationConcurrency).toBe(concurrency);
      expect(config.databaseMaxConnections).toBe(connections);
    }
  );
});

describe("System Archive configuration", () => {
  it("defaults the released capability on while keeping operator exception gates off", () => {
    minimumEnvironment();

    const config = loadRuntimeConfig();

    expect(config.systemArchiveEnabled).toBe(true);
    expect(config.systemArchiveUploadTtlSeconds).toBe(86_400);
    expect(config.systemArchiveChunkBytes).toBe(16_777_216);
    expect(config.systemArchiveAllowLimitIncrease).toBe(false);
    expect(config.systemArchiveAllowUnknownFreeSpace).toBe(false);
  });

  it.each([
    "SYSTEM_ARCHIVE_ENABLED",
    "SYSTEM_ARCHIVE_ALLOW_LIMIT_INCREASE",
    "SYSTEM_ARCHIVE_ALLOW_UNKNOWN_FREE_SPACE"
  ] as const)("rejects malformed %s instead of weakening startup", (settingName) => {
    minimumEnvironment();
    process.env[settingName] = "sometimes";

    expect(() => loadRuntimeConfig()).toThrow(`${settingName} must be true or false.`);
  });

  it("keeps approved System Archive maxima hard unless the operator explicitly enables increases", () => {
    minimumEnvironment();
    process.env.SYSTEM_ARCHIVE_MAX_COMPRESSED_BYTES = "53687091201";
    expect(loadRuntimeConfig().systemArchiveLimits.maxCompressedBytes).toBe(53_687_091_200);

    process.env.SYSTEM_ARCHIVE_ALLOW_LIMIT_INCREASE = "true";
    expect(loadRuntimeConfig().systemArchiveLimits.maxCompressedBytes).toBe(53_687_091_201);
  });

  it("reserves a bounded 16 MiB manifest allowance for System Archive asset inventories", () => {
    minimumEnvironment();
    expect(loadRuntimeConfig().systemArchiveLimits.maxManifestBytes).toBe(16_777_216);

    process.env.SYSTEM_ARCHIVE_MAX_MANIFEST_BYTES = "16777217";
    expect(loadRuntimeConfig().systemArchiveLimits.maxManifestBytes).toBe(16_777_216);
  });

  it.each([
    ["SYSTEM_ARCHIVE_UPLOAD_TTL_SECONDS", "299"],
    ["SYSTEM_ARCHIVE_UPLOAD_TTL_SECONDS", "604801"],
    ["SYSTEM_ARCHIVE_CHUNK_BYTES", "1048575"],
    ["SYSTEM_ARCHIVE_CHUNK_BYTES", "67108865"]
  ] as const)("clamps %s to its approved operational range", (settingName, value) => {
    minimumEnvironment();
    process.env[settingName] = value;

    const config = loadRuntimeConfig();
    if (settingName === "SYSTEM_ARCHIVE_UPLOAD_TTL_SECONDS") {
      expect(config.systemArchiveUploadTtlSeconds).toBe(value === "299" ? 300 : 604_800);
    } else {
      expect(config.systemArchiveChunkBytes).toBe(value === "1048575" ? 1_048_576 : 67_108_864);
    }
  });
});
