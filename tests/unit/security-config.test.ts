import { afterEach, describe, expect, it } from "vitest";
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
  "TRUST_PROXY_HOPS"
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
