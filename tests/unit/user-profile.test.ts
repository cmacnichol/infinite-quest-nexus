import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { buildServer } from "../../services/api/src/server.js";
import { getSessionUserProfile, updateSessionUserProfile } from "../../services/api/src/user-service.js";
import { userProfileSchema, userSettingsSchema, userProfileUpdateSchema } from "../../packages/contracts/src/users.js";
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

describe("user profile and settings contracts", () => {
  it("defaults autoSubmitTurnChoices to true and continuousReading to false in userSettingsSchema", () => {
    const settings = userSettingsSchema.parse({});
    expect(settings.autoSubmitTurnChoices).toBe(true);
    expect(settings.continuousReading).toBe(false);
  });

  it("parses userProfileSchema with default or provided settings", () => {
    const profile = userProfileSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      systemKey: "initial-owner",
      displayName: "Test Owner"
    });
    expect(profile.settings.autoSubmitTurnChoices).toBe(true);
    expect(profile.settings.continuousReading).toBe(false);

    const customProfile = userProfileSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      systemKey: "initial-owner",
      displayName: "Test Owner",
      settings: { autoSubmitTurnChoices: false, continuousReading: true, customFlag: 123 }
    });
    expect(customProfile.settings.autoSubmitTurnChoices).toBe(false);
    expect(customProfile.settings.continuousReading).toBe(true);
    expect(customProfile.settings.customFlag).toBe(123);
  });

  it("validates user profile updates", () => {
    const update = userProfileUpdateSchema.parse({
      displayName: "New Display Name",
      settings: { autoSubmitTurnChoices: false, continuousReading: true }
    });
    expect(update.displayName).toBe("New Display Name");
    expect(update.settings?.autoSubmitTurnChoices).toBe(false);
    expect(update.settings?.continuousReading).toBe(true);
  });
});

describe("user service and API endpoints", () => {
  it("returns session user profile and updates settings via endpoints", async () => {
    const mockUserId = "22222222-2222-4222-8222-222222222222";
    let currentSettings: Record<string, unknown> = { autoSubmitTurnChoices: true, continuousReading: false };
    let currentDisplayName = "Initial Owner";

    const mockPool = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes("SELECT id FROM users WHERE system_key = 'initial-owner'")) {
          return { rows: [{ id: mockUserId }] };
        }
        if (sql.includes("SELECT id, system_key")) {
          return {
            rows: [{
              id: mockUserId,
              systemKey: "initial-owner",
              displayName: currentDisplayName,
              settings: currentSettings
            }]
          };
        }
        if (sql.includes("UPDATE users SET display_name = $1, settings = COALESCE(settings")) {
          currentDisplayName = params?.[0] as string;
          const patch = JSON.parse(params?.[1] as string);
          currentSettings = { ...currentSettings, ...patch };
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes("UPDATE users SET settings = COALESCE(settings")) {
          const patch = JSON.parse(params?.[0] as string);
          currentSettings = { ...currentSettings, ...patch };
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes("UPDATE users SET display_name = $1")) {
          currentDisplayName = params?.[0] as string;
          return { rowCount: 1, rows: [] };
        }
        return { rows: [] };
      }
    } as unknown as DatabasePool;

    const app = await buildServer({ config: makeConfig(), pool: mockPool });

    const getSessionRes = await app.inject({
      method: "GET",
      url: "/api/v1/session"
    });
    expect(getSessionRes.statusCode).toBe(200);
    const sessionBody = JSON.parse(getSessionRes.payload);
    expect(sessionBody.user.displayName).toBe("Initial Owner");
    expect(sessionBody.user.settings.autoSubmitTurnChoices).toBe(true);
    expect(sessionBody.user.settings.continuousReading).toBe(false);

    const patchRes = await app.inject({
      method: "PATCH",
      url: "/api/v1/users/me/profile",
      payload: {
        displayName: "Updated Owner",
        settings: { autoSubmitTurnChoices: false, continuousReading: true }
      }
    });
    expect(patchRes.statusCode).toBe(200);
    const patchBody = JSON.parse(patchRes.payload);
    expect(patchBody.user.displayName).toBe("Updated Owner");
    expect(patchBody.user.settings.autoSubmitTurnChoices).toBe(false);
    expect(patchBody.user.settings.continuousReading).toBe(true);

    const getMeRes = await app.inject({
      method: "GET",
      url: "/api/v1/users/me"
    });
    expect(getMeRes.statusCode).toBe(200);
    expect(JSON.parse(getMeRes.payload).user.settings.autoSubmitTurnChoices).toBe(false);
    expect(JSON.parse(getMeRes.payload).user.settings.continuousReading).toBe(true);

    await app.close();
  });
});
