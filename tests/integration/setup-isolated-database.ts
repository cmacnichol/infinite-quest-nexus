import { randomUUID } from "node:crypto";
import { afterAll } from "vitest";
import { createDatabasePool } from "../../packages/database/src/pool.js";

const rootDatabaseUrl = process.env.TEST_DATABASE_URL;

if (process.env.CI && !rootDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required for integration tests in CI; refusing to report a fully skipped database suite as successful.");
}

if (rootDatabaseUrl) {
  const databaseName = `infinitequest_test_${randomUUID().replaceAll("-", "")}`;
  const adminPool = createDatabasePool(rootDatabaseUrl, 1);
  const isolatedUrl = new URL(rootDatabaseUrl);
  isolatedUrl.pathname = `/${databaseName}`;

  await adminPool.query(`CREATE DATABASE ${databaseName}`);
  process.env.TEST_DATABASE_URL = isolatedUrl.toString();

  afterAll(async () => {
    process.env.TEST_DATABASE_URL = rootDatabaseUrl;
    try {
      await adminPool.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    } finally {
      await adminPool.end();
    }
  });
}
