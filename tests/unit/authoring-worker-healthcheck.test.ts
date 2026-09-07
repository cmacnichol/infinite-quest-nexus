import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import * as configuration from "../../packages/database/src/config.js";

afterEach(() => vi.unstubAllEnvs());

it.each([
  ["Compose proof", "tests/fixtures/authoring/compose-p2-10.yaml", "worker"],
  ["Swarm", "deploy/swarm/stack.yaml", "infinitequest-worker"]
])("P2-M2 %s worker readiness uses real runtime configuration and signals query success/failure", async (_label, path, service) => {
  vi.stubEnv("DATABASE_URL", "postgresql://fixture@127.0.0.1:15440/fixture");
  vi.stubEnv("DATABASE_URL_FILE", "");
  vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", "synthetic-healthcheck-key");
  vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY_FILE", "");
  const source = readFileSync(path, "utf8").split(`  ${service}:`)[1]!.split(/\n  [\w-]+:/)[0]!;
  const command = JSON.parse(source.match(/test:\s*(\[[^\n]+\])/)![1]!) as string[];
  expect(command.slice(0, 3)).toEqual(["CMD", "node", "-e"]);
  for (const available of [true, false]) {
    const queries: string[] = []; const exits: number[] = []; const connections: string[] = [];
    const load = async (module: string) => module.endsWith("config.js") ? configuration : {
      createDatabasePool: (url: string) => {
        connections.push(url);
        return { query: async (sql: string) => { queries.push(sql); if (!available) throw new Error("synthetic offline database"); return { rows: [{ "?column?": 1 }] }; } };
      }
    };
    // Execute the manifest command, keeping configuration/export resolution real
    // and replacing only its external SQL transport and process termination.
    await new Function("importModule", "process", `return ${command[3]!.replaceAll("import(", "importModule(")}`)(load, { exit: (code: number) => exits.push(code) });
    expect(connections).toEqual(["postgresql://fixture@127.0.0.1:15440/fixture"]);
    expect(queries).toEqual(["SELECT 1"]);
    expect(exits).toEqual([available ? 0 : 1]);
  }
});
