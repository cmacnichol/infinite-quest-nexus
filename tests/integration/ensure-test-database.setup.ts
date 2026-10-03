import { ensureTestDatabase } from "../../scripts/ensure-test-database.mjs";

const SAFE_TEST_DATABASE_NAME = /^infinitequest_test(?:_[A-Za-z0-9_]+)?$/u;
const UNSAFE_TEST_DATABASE_PARAMETERS = new Set(["host", "hostaddr", "dbname", "service", "servicefile"]);

function validateTestDatabaseUrl(databaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("INFINITEQUEST_TEST_DATABASE_URL must be a valid loopback PostgreSQL test database URL.");
  }

  const hostname = parsed.hostname.toLowerCase();
  const isLoopback = hostname === "localhost" || hostname === "127.0.0.1";
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    throw new Error("INFINITEQUEST_TEST_DATABASE_URL must be a valid loopback PostgreSQL test database URL.");
  }
  const hasUnsafeParameter = [...parsed.searchParams.keys()]
    .some((parameter) => UNSAFE_TEST_DATABASE_PARAMETERS.has(parameter.toLowerCase()));

  if (
    !["postgres", "postgresql"].includes(parsed.protocol.slice(0, -1).toLowerCase()) ||
    !isLoopback ||
    !SAFE_TEST_DATABASE_NAME.test(databaseName) ||
    hasUnsafeParameter
  ) {
    throw new Error("INFINITEQUEST_TEST_DATABASE_URL must target a loopback PostgreSQL test database without host, database, or service overrides.");
  }

  return databaseUrl;
}

export async function configureIntegrationDatabase({
  ensure = ensureTestDatabase,
  testDatabaseUrl = process.env.INFINITEQUEST_TEST_DATABASE_URL
}: {
  ensure?: typeof ensureTestDatabase;
  testDatabaseUrl?: string | undefined;
} = {}): Promise<void> {
  const databaseUrl = testDatabaseUrl === undefined
    ? (await ensure()).databaseUrl
    : validateTestDatabaseUrl(testDatabaseUrl);

  // Publish only after validation, before integration test modules load.
  process.env.TEST_DATABASE_URL = databaseUrl;
}

export default async function ensureTestDatabaseSetup(): Promise<void> {
  await configureIntegrationDatabase();
}
