import { afterEach, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../packages/database/src/config.js";

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
});

function minimumEnvironment(): void {
  process.env.DATABASE_URL = "postgresql://test@localhost/test";
  delete process.env.CORS_ALLOWED_ORIGINS;
  delete process.env.PROVIDER_NETWORK_ALLOWLIST;
  delete process.env.CSP_IMAGE_ALLOWED_ORIGINS;
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

  it("fails instead of clamping invalid security limits", () => {
    minimumEnvironment();
    process.env.API_CONCURRENCY_IMPORT_REQUESTS = "0";
    expect(() => loadRuntimeConfig()).toThrow("API_CONCURRENCY_IMPORT_REQUESTS");
  });
});
