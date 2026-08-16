import { spawn } from "node:child_process";
import { vitestCommand } from "./node-tool-command.mjs";

const E3F_MATRIX_FILES = Object.freeze([
  // Active Fastify legacy-contract families. Each file uses a fresh database
  // because previews, leases, initial-owner fixtures, and generated archives
  // are intentionally durable and cannot be safely shared across children.
  "tests/integration/campaign-archive.integration.test.ts",
  "tests/integration/asset-archive.integration.test.ts",
  "tests/integration/import-memory.integration.test.ts",
  // World JSON and Infinite Worlds use the same live Fastify production graph
  // and server-resolved owner. Keep their full route contract in the e3f
  // process-isolated matrix instead of relying on a source inventory alone.
  "tests/integration/world-campaign-route-application.integration.test.ts",
  "tests/integration/illustration-routes.integration.test.ts",
  // e3f-owned active binding/default-worker sentinel.
  "tests/integration/task-14e3f-production-composed-parity.integration.test.ts",
]);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`e3f isolated matrix failed for ${args.join(" ")} (${signal ?? `exit ${code ?? "unknown"}`})`));
    });
  });
}

// The private e3e0–e8 matrix is a prerequisite rather than an implicit shared
// fixture. It owns its own per-file database lifecycle before this active
// production-binding matrix opens another isolated database.
const unitCommand = vitestCommand(["run",
  "tests/unit/runtime-role-composition.test.ts",
  "tests/unit/task-14e3e8-composition-parity-boundaries.test.ts",
  "tests/unit/task-14e3f-production-composed-boundaries.test.ts",
  "tests/unit/task-14e3f-export-stream-abort.test.ts",
]);
await run(unitCommand.executable, unitCommand.arguments);
await run(process.execPath, ["scripts/run-e8-isolated-integration.mjs"]);

for (const testFile of E3F_MATRIX_FILES) {
  const command = vitestCommand(["run", "--config", "vitest.integration.config.ts", testFile]);
  await run(command.executable, command.arguments);
}
