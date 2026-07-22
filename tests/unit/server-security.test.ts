import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { buildServer } from "../../services/api/src/server.js";
import type { RuntimeConfig } from "../../packages/database/src/config.js";
import type { DatabasePool } from "../../packages/database/src/pool.js";

function makeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    role: "all",
    host: "127.0.0.1",
    port: 8080,
    databaseUrl: "postgresql://mock@localhost:5432/mock",
    databaseMaxConnections: 2,
    migrationDirectory: resolve("database/migrations"),
    migrationWaitSeconds: 10,
    allowMaintenanceMigrations: false,
    workerPollIntervalMs: 1000,
    workerLeaseSeconds: 60,
    webRoot: resolve("apps/web/public"),
    assetStorageDriver: "filesystem",
    assetStorageRoot: resolve("local-data/assets"),
    credentialEncryptionKey: "",
    corsAllowedOrigins: ["*"],
    ...overrides
  };
}

describe("API server security and CORS headers", () => {
  it("exposes public application metadata without querying the database", async () => {
    const config = makeConfig();
    const mockPool = { query: async () => { throw new Error("Metadata must not query the database."); } } as unknown as DatabasePool;
    const app = await buildServer({ config, pool: mockPool });

    const response = await app.inject({ method: "GET", url: "/api/v1/meta" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      application: { name: "Infinite Quest Nexus", version: expect.any(String) }
    });

    await app.close();
  });

  it.each(["/", "/index.html"])("redirects %s to the active Nexus client without serving legacy HTML", async (url) => {
    const config = makeConfig();
    const mockPool = { query: async () => ({ rows: [] }) } as unknown as DatabasePool;
    const app = await buildServer({ config, pool: mockPool });

    const response = await app.inject({ method: "GET", url });

    expect(response.statusCode).toBe(308);
    expect(response.headers.location).toBe("/nexus/");
    expect(response.headers["content-type"] ?? "").not.toContain("text/html");
    expect(response.payload).not.toContain("<!DOCTYPE html>");

    await app.close();
  });

  it("sets standard security headers on requests", async () => {
    const config = makeConfig();
    const mockPool = { query: async () => ({ rows: [] }) } as unknown as DatabasePool;
    const app = await buildServer({ config, pool: mockPool });

    const response = await app.inject({
      method: "GET",
      url: "/health/live"
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(response.headers["strict-transport-security"]).toContain("max-age=31536000");

    await app.close();
  });

  it("handles CORS headers with wildcard allowed origins", async () => {
    const config = makeConfig({ corsAllowedOrigins: ["*"] });
    const mockPool = { query: async () => ({ rows: [] }) } as unknown as DatabasePool;
    const app = await buildServer({ config, pool: mockPool });

    const response = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { origin: "https://example.test" }
    });

    expect(response.headers["access-control-allow-origin"]).toBe("https://example.test");
    expect(response.headers["vary"]).toBe("Origin");
    expect(response.headers["access-control-allow-credentials"]).toBe("true");

    const optionsRes = await app.inject({
      method: "OPTIONS",
      url: "/health/live",
      headers: { origin: "https://example.test" }
    });
    expect(optionsRes.statusCode).toBe(204);

    await app.close();
  });

  it("handles CORS headers with restricted allowed origins list", async () => {
    const config = makeConfig({ corsAllowedOrigins: ["https://trusted.test", "https://app.infinitequest.com"] });
    const mockPool = { query: async () => ({ rows: [] }) } as unknown as DatabasePool;
    const app = await buildServer({ config, pool: mockPool });

    const trustedRes = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { origin: "https://trusted.test" }
    });
    expect(trustedRes.headers["access-control-allow-origin"]).toBe("https://trusted.test");

    const untrustedRes = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { origin: "https://evil.test" }
    });
    expect(untrustedRes.headers["access-control-allow-origin"]).toBeUndefined();

    await app.close();
  });

  it("returns 400 InvalidUuidError when PostgreSQL throws 22P02 invalid uuid syntax", async () => {
    const config = makeConfig();
    const mockPool = {
      query: async () => {
        const error = Object.assign(new Error('invalid input syntax for type uuid: "not-a-uuid"'), { code: "22P02" });
        throw error;
      }
    } as unknown as DatabasePool;
    const app = await buildServer({ config, pool: mockPool });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/session"
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe("InvalidUuidError");
    expect(body.message).toContain("The provided ID is not a valid UUID.");

    await app.close();
  });
});
