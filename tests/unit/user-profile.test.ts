import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { buildServer } from "../../services/api/src/server.js";
import { inertStorageServerOptions as serverOptions } from "../helpers/build-server-options.js";
import { historicalUserSettingsSchema, userProfileSchema, userSettingsSchema, userProfileUpdateSchema } from "../../packages/contracts/src/users.js";
import { createPostgresSessionProfileRepository } from "../../packages/database/src/world-generation-repository.js";
import { createPostgresWorldCampaignTransactionPort } from "../../packages/database/src/world-campaign-transaction.js";
import { testWorldCampaignApplication } from "../helpers/build-server-options.js";
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
    workerGenerationConcurrency: 1,
    legacyWebRoot: resolve("apps/web/public"),
    nextWebRoot: resolve("apps/web-next"),
    assetStorageDriver: "filesystem",
    assetStorageRoot: resolve("local-data/assets"),
    archiveStorageRoot: resolve("local-data/archives"),
    archivePreviewTtlSeconds: 1_800,
    systemArchiveArtifactTtlSeconds: 86_400,
    campaignArchiveLimits: {
      maxCompressedBytes: 2_147_483_648,
      maxUncompressedBytes: 21_474_836_480,
      maxEntries: 100_000,
      maxExpansionRatio: 100,
      maxManifestBytes: 5_242_880,
      maxJsonEntryBytes: 1_073_741_824,
      maxOriginalImageBytes: 26_214_400
    },
    systemArchiveLimits: {
      maxCompressedBytes: 53_687_091_200,
      maxUncompressedBytes: 214_748_364_800,
      maxEntries: 1_000_000,
      maxExpansionRatio: 100,
      maxManifestBytes: 5_242_880,
      maxJsonEntryBytes: 1_073_741_824,
      maxOriginalImageBytes: 26_214_400
    },
    credentialEncryptionKey: "",
    security: {
      corsAllowedOrigins: [],
      providerNetworkAllowlist: ["localhost", "127.0.0.0/8", "::1/128"],
      cspImageAllowedOrigins: [],
      apiDefaultBodyLimitBytes: 1_048_576,
      apiImportBodyLimitBytes: 16_777_216,
      apiAssetBodyLimitBytes: 33_554_432,
      apiRateLimitWindowSeconds: 60,
      apiRateLimitProviderRequests: 10,
      apiRateLimitGenerationRequests: 12,
      apiRateLimitImportRequests: 4,
      apiConcurrencyProviderRequests: 2,
      apiConcurrencyImportRequests: 1,
      trustProxyHops: 0
    },
    ...overrides
  };
}

describe("user profile and settings contracts", () => {
  it("defaults autoSubmitTurnChoices to true and continuousReading to false in userSettingsSchema", () => {
    const settings = userSettingsSchema.parse({});
    expect(settings.autoSubmitTurnChoices).toBe(true);
    expect(settings.continuousReading).toBe(false);
    expect(settings.readerPreferences).toEqual({ widthCh: 72, fontSizePx: 18, lineHeight: 1.7, theme: "dark" });
  });

  it("normalizes malformed historical reader preferences field by field without dropping other settings", () => {
    const settings = historicalUserSettingsSchema.parse({
      readerPreferences: { widthCh: 60, fontSizePx: 999, lineHeight: 0.4, theme: "neon" },
      customFlag: 123
    });
    expect(settings.readerPreferences).toEqual({ widthCh: 60, fontSizePx: 18, lineHeight: 1.7, theme: "dark" });
    expect(settings).toMatchObject({ customFlag: 123 });
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

  it("rejects explicitly invalid reader preferences in a profile update", () => {
    expect(() => userProfileUpdateSchema.parse({
      settings: { readerPreferences: { widthCh: 61, fontSizePx: 18, lineHeight: 1.7, theme: "dark" } }
    })).toThrow();
  });

  it("leaves omitted reader preferences absent from a partial settings update", () => {
    const update = userProfileUpdateSchema.parse({ settings: { continuousReading: true } });
    expect(Object.hasOwn(update.settings ?? {}, "readerPreferences")).toBe(false);
  });
});

describe("user service and API endpoints", () => {
  it("returns session user profile and updates settings via endpoints", async () => {
    const mockUserId = "22222222-2222-4222-8222-222222222222";
    let currentSettings: Record<string, unknown> = {
      autoSubmitTurnChoices: true,
      continuousReading: false,
      defaultTurnControlStyle: "flexible_scene",
      readerPreferences: { widthCh: 84, fontSizePx: 22, lineHeight: 1.9, theme: "sepia" },
      extensionSetting: { retained: true }
    };
    let currentDisplayName = "Initial Owner";
    let lastSettingsPatch: Record<string, unknown> | null = null;

    const mockClient = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql === "BEGIN" || sql.startsWith("BEGIN TRANSACTION") || sql === "COMMIT" || sql === "ROLLBACK") {
          return { rows: [] };
        }
        if (sql.includes("SELECT id, system_key AS \"systemKey\"")) {
          return { rows: [{ id: mockUserId, systemKey: "initial-owner", displayName: currentDisplayName, settings: currentSettings }] };
        }
        if (sql.includes("UPDATE users") && sql.includes("settings = CASE")) {
          currentDisplayName = (params?.[1] as string | null) ?? currentDisplayName;
          const serializedPatch = params?.[2] as string | null;
          if (serializedPatch !== null) {
            lastSettingsPatch = JSON.parse(serializedPatch) as Record<string, unknown>;
            currentSettings = { ...currentSettings, ...lastSettingsPatch };
          }
          return { rowCount: 1, rows: [{ id: mockUserId, systemKey: "initial-owner", displayName: currentDisplayName, settings: currentSettings }] };
        }
        return { rows: [] };
      },
      release: () => {}
    };
    const mockPool = {
      connect: async () => mockClient,
      query: async (sql: string) => {
        if (sql.includes("SELECT id FROM users WHERE system_key = 'initial-owner'")) {
          return { rows: [{ id: mockUserId }] };
        }
        return { rows: [] };
      }
    } as unknown as DatabasePool;

    const sessionProfile = createPostgresSessionProfileRepository();
    const transaction = createPostgresWorldCampaignTransactionPort(mockPool);
    const worldCampaign = testWorldCampaignApplication({
      getSessionProfile: (scope) => transaction.read((database) => sessionProfile.getSessionProfile(database, scope)),
      updateSessionProfile: (scope, request) => transaction.command(async (database) => {
        const result = await sessionProfile.updateSessionProfile(database, scope, request);
        if (!result.ok) throw new Error("Seeded session profile update unexpectedly failed.");
        return result.value;
      })
    });
    const app = await buildServer(serverOptions({ config: makeConfig(), pool: mockPool, worldCampaign }));

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
        settings: { autoSubmitTurnChoices: false, continuousReading: true, defaultTurnControlStyle: "flexible_scene" }
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

    const legacySettingsPatch = await app.inject({
      method: "PATCH",
      url: "/api/v1/users/me/profile",
      payload: { settings: { autoSubmitTurnChoices: false, continuousReading: false, defaultTurnControlStyle: "flexible_scene" } }
    });
    expect(legacySettingsPatch.statusCode).toBe(200);
    expect(Object.hasOwn(lastSettingsPatch ?? {}, "readerPreferences")).toBe(false);
    expect(JSON.parse(legacySettingsPatch.payload).user.settings.readerPreferences).toEqual({ widthCh: 84, fontSizePx: 22, lineHeight: 1.9, theme: "sepia" });
    expect(JSON.parse(legacySettingsPatch.payload).user.settings.extensionSetting).toEqual({ retained: true });
    expect(JSON.parse(legacySettingsPatch.payload).user.settings.defaultTurnControlStyle).toBe("flexible_scene");

    const displayNamePatch = await app.inject({
      method: "PATCH",
      url: "/api/v1/users/me/profile",
      payload: { displayName: "Reader With New Name" }
    });
    expect(displayNamePatch.statusCode).toBe(200);
    expect(JSON.parse(displayNamePatch.payload).user.settings.readerPreferences).toEqual({ widthCh: 84, fontSizePx: 22, lineHeight: 1.9, theme: "sepia" });
    expect(JSON.parse(displayNamePatch.payload).user.settings.extensionSetting).toEqual({ retained: true });
    expect(JSON.parse(displayNamePatch.payload).user.settings.defaultTurnControlStyle).toBe("flexible_scene");

    await app.close();
  });
});
