import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);

function packageCli(packageName, relativePath) {
  return resolve(dirname(require.resolve(`${packageName}/package.json`)), relativePath);
}

function command(cli, argumentsList) {
  return Object.freeze({
    executable: process.execPath,
    arguments: Object.freeze([cli, ...argumentsList]),
  });
}

export function typescriptCommand(argumentsList) {
  return command(packageCli("typescript", "bin/tsc"), argumentsList);
}

export function tsxCommand(argumentsList) {
  return command(packageCli("tsx", "dist/cli.mjs"), argumentsList);
}

export function vitestCommand(argumentsList) {
  return command(packageCli("vitest", "vitest.mjs"), argumentsList);
}
