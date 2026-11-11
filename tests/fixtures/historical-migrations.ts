import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll } from "vitest";

// The shipped baseline has no intermediate schemas. Historical regression tests
// materialize the frozen SQL from the final pre-baseline release in a private directory.
export const historicalMigrations = mkdtempSync(join(tmpdir(), "iq-pre-baseline-"));
const archive = readFileSync("tests/fixtures/pre-baseline-migrations.json.gz");
const files: Record<string, string> = JSON.parse(gunzipSync(archive).toString("utf8"));
for (const [name, sql] of Object.entries(files)) writeFileSync(join(historicalMigrations, name), sql);
afterAll(() => rmSync(historicalMigrations, { recursive: true, force: true }));
