import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];
const bootstrapScript = resolve("scripts/ensure-local-credential-encryption-key.mjs");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryKeyPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "infinitequest-local-key-"));
  temporaryDirectories.push(directory);
  return join(directory, "credential-encryption-key");
}

async function runBootstrap(keyPath: string, credentialEncryptionKey?: string): Promise<void> {
  await execFile(process.execPath, [bootstrapScript], {
    env: {
      ...process.env,
      CREDENTIAL_ENCRYPTION_KEY_FILE: keyPath,
      ...(credentialEncryptionKey === undefined ? {} : { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey })
    }
  });
}

describe("local credential encryption-key bootstrap", () => {
  it("creates a persistent owner-only random key when no operator key is supplied", async () => {
    const keyPath = await temporaryKeyPath();

    await runBootstrap(keyPath);

    const key = (await readFile(keyPath, "utf8")).trim();
    expect(key).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.runIf(process.platform !== "win32")("creates the local key with owner-only POSIX permissions", async () => {
    const keyPath = await temporaryKeyPath();

    await runBootstrap(keyPath);

    expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
  });

  it("reuses the existing local key across later starts", async () => {
    const keyPath = await temporaryKeyPath();
    await writeFile(keyPath, "preserved-local-key\n", { mode: 0o600 });

    await runBootstrap(keyPath);

    await expect(readFile(keyPath, "utf8")).resolves.toBe("preserved-local-key\n");
  });

  it("does not create a local key when an operator supplies one", async () => {
    const keyPath = await temporaryKeyPath();

    await runBootstrap(keyPath, "operator-provided-key");

    await expect(stat(keyPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
