import { spawn } from "node:child_process";
import { vitestCommand } from "./node-tool-command.mjs";

// Each focused matrix intentionally uses stable initial-owner and lease fixture
// values. Run one Vitest invocation per file so its setup-isolated-database
// lifecycle cannot be shared with another file, even when Vitest reuses a
// serial worker for the normal integration command.
const E8_MATRIX_FILES = Object.freeze([
  "tests/integration/task-14e3e1c-normalized-publication-repository.integration.test.ts",
  "tests/integration/task-14e3e2-normalized-publication-composition.integration.test.ts",
  "tests/integration/task-14e3e3-illustration-publication.integration.test.ts",
  "tests/integration/task-14e3e3-illustration-publication-matrix.integration.test.ts",
  "tests/integration/task-14e3e4-portable-normalized-publication.integration.test.ts",
  "tests/integration/task-14e3e5-asset-metadata-backfill.integration.test.ts",
  "tests/integration/task-14e3e6-filesystem-recovery.integration.test.ts",
  "tests/integration/task-14e3e7-maintenance-scheduler.integration.test.ts",
  "tests/integration/task-14e3e8-private-parity.integration.test.ts",
]);

for (const testFile of E8_MATRIX_FILES) {
  await new Promise((resolve, reject) => {
    const command = vitestCommand(["run", "--config", "vitest.integration.config.ts", testFile]);
    const child = spawn(command.executable, command.arguments, {
      stdio: "inherit",
      env: process.env,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`e8 isolated matrix failed for ${testFile} (${signal ?? `exit ${code ?? "unknown"}`})`));
    });
  });
}
