import { instanceSettingsSchema } from "../../packages/contracts/src/instance-settings.js";
import { loadRuntimeConfig } from "../../packages/database/src/config.js";

export function runtimeConfigFixture() {
  const before = process.env;
  try {
    process.env = { DATABASE_URL: "postgresql://fixture@localhost/fixture", APP_ROLE: "worker" };
    return loadRuntimeConfig();
  } finally {
    process.env = before;
  }
}

export function settingsFixture() {
  const { security, ...rest } = runtimeConfigFixture();
  return instanceSettingsSchema.parse(Object.fromEntries(Object.entries({ ...rest, ...security, logLevel: "info" }).filter(([key]) => key in instanceSettingsSchema.shape)));
}
