import { ensureTestDatabase } from "../../scripts/ensure-test-database.mjs";

export async function configureIntegrationDatabase({ ensure = ensureTestDatabase } = {}): Promise<void> {
  const { databaseUrl } = await ensure();
  process.env.TEST_DATABASE_URL = databaseUrl;
}

export default async function ensureTestDatabaseSetup(): Promise<void> {
  await configureIntegrationDatabase();
}
