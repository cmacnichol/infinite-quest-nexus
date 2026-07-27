import { randomUUID } from "node:crypto";
import { afterAll } from "vitest";
import { createDatabasePool } from "../../packages/database/src/pool.js";
import { dropTestDatabaseWhenIdle } from "./database-test-helpers.js";

const rootDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!rootDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL was not provisioned before integration tests started.");
}

const databaseName = `infinitequest_test_${randomUUID().replaceAll("-", "")}`;
const adminPool = createDatabasePool(rootDatabaseUrl, 1);
const isolatedUrl = new URL(rootDatabaseUrl);
isolatedUrl.pathname = `/${databaseName}`;

await adminPool.query(`CREATE DATABASE ${databaseName}`);
process.env.TEST_DATABASE_URL = isolatedUrl.toString();

afterAll(async () => {
  process.env.TEST_DATABASE_URL = rootDatabaseUrl;
  try {
    await dropTestDatabaseWhenIdle(adminPool, databaseName);
  } finally {
    await adminPool.end();
  }
});
