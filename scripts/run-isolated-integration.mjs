import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const INTEGRATION_ROOT = resolve("tests/integration");

export async function discoverIntegrationTestFiles(root = INTEGRATION_ROOT) {
  const files = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".integration.test.ts")) {
        files.push(relative(root, path).split(sep).join("/"));
      }
    }
  }

  await visit(root);
  return files.sort((left, right) => left.localeCompare(right, "en-US"));
}

export function integrationTestArguments(testFile) {
  return [
    "exec",
    "vitest",
    "run",
    "--config",
    "vitest.integration.config.ts",
    testFile,
  ];
}

function run(command, argumentsList) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, argumentsList, {
      stdio: "inherit",
      env: process.env,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(
        `isolated integration test failed for ${argumentsList.at(-1)} (${signal ?? `exit ${code ?? "unknown"}`})`,
      ));
    });
  });
}

export async function runIsolatedIntegrationSuite() {
  const relativeFiles = await discoverIntegrationTestFiles();
  if (relativeFiles.length === 0) {
    throw new Error("No integration test files were discovered.");
  }

  for (const [index, relativeFile] of relativeFiles.entries()) {
    const testFile = `tests/integration/${relativeFile}`;
    process.stdout.write(`[integration ${index + 1}/${relativeFiles.length}] ${testFile}\n`);
    await run(pnpm, integrationTestArguments(testFile));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runIsolatedIntegrationSuite();
}
