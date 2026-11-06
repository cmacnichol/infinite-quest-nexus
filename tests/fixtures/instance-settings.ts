import { instanceSettingsSchema } from "../../packages/contracts/src/instance-settings.js";
import { loadRuntimeConfig } from "../../packages/database/src/config.js";

export function settingsFixture() {
  const before = process.env;
  try {
    process.env = { DATABASE_URL: "postgresql://fixture@localhost/fixture", APP_ROLE: "worker" };
    const { security, ...rest } = loadRuntimeConfig();
    return instanceSettingsSchema.parse(Object.fromEntries(Object.entries({ ...rest, ...security, logLevel: "info" }).filter(([key]) => key in instanceSettingsSchema.shape)));
  } finally {
    process.env = before;
  }
}
