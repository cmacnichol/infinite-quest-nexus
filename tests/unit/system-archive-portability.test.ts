import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SYSTEM_ARCHIVE_TABLE_CLASSIFICATIONS } from "../../packages/application/src/system-archives/portability-registry.js";

async function readCreatedTableNames(directory: string): Promise<string[]> {
  const names = new Set<string>();
  const migrations = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();

  for (const migration of migrations) {
    const source = await readFile(join(directory, migration), "utf8");
    const createStatements = source.match(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+[^;]+;/gi) ?? [];
    for (const statement of createStatements) {
      const match = /^CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-z_][a-z0-9_]*)\s*\(/i.exec(statement.trim());
      if (!match) throw new Error(`Migration ${migration} has a dynamic or unsupported CREATE TABLE identifier.`);
      const table = match[1]!.toLowerCase();
      if (names.has(table)) throw new Error(`Migration inventory contains duplicate CREATE TABLE identifier: ${table}.`);
      names.add(table);
    }
  }

  return [...names].sort();
}

describe("System Archive portability registry", () => {
  it("classifies every literal table created by the current migrations exactly once", async () => {
    const createdTables = await readCreatedTableNames("database/migrations");
    expect(createdTables.filter((table) => !(table in SYSTEM_ARCHIVE_TABLE_CLASSIFICATIONS))).toEqual([]);
    expect(Object.keys(SYSTEM_ARCHIVE_TABLE_CLASSIFICATIONS).sort()).toEqual(createdTables);
  });
});
