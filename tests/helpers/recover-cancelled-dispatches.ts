import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export function runDispatchRecovery(manifest: unknown, reference: string): void {
  // The integration harness replaces TEST_DATABASE_URL with this file's isolated database.
  const database = new URL(process.env.TEST_DATABASE_URL!);
  const password = decodeURIComponent(database.password);
  database.password = "";
  const variables = ["-X", "-w", "-v", `manifest=${JSON.stringify(manifest)}`, "-v", `reference=${reference}`, "-f", "-"];
  const external = process.env.INFINITEQUEST_TEST_DATABASE_URL !== undefined;
  const container = process.env.INFINITEQUEST_TEST_POSTGRES_CONTAINER;
  if (container && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container)) throw new Error("Invalid test PostgreSQL container name.");
  const useHostPsql = external && !container;
  const result = spawnSync(useHostPsql ? "psql" : "docker", useHostPsql
    ? ["--dbname", database.toString(), ...variables]
    : ["exec", "-i", container ?? "infinitequest-integration-postgres", "psql",
      "-U", decodeURIComponent(database.username), "-d", database.pathname.slice(1), ...variables], {
    input: readFileSync("scripts/recover-cancelled-dispatches.sql"),
    encoding: "utf8",
    env: useHostPsql ? { ...process.env, PGPASSWORD: password } : process.env,
    timeout: 15_000,
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Dispatch recovery failed: ${result.stderr}`);
}
