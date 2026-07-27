import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureTestDatabase } from "../../scripts/ensure-test-database.mjs";
import { configureIntegrationDatabase } from "../../tests/integration/ensure-test-database.setup.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryProjectRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "infinitequest-test-database-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("ensureTestDatabase", () => {
  it("creates local credentials, starts the dedicated Compose service, and creates a missing root database", async () => {
    const projectRoot = await temporaryProjectRoot();
    const execute = vi.fn(async () => undefined);
    const queries: string[] = [];
    const client = {
      connect: vi.fn(async () => undefined),
      query: vi.fn(async (query: string) => {
        queries.push(query);
        if (query.includes("SELECT datname")) return { rows: [] };
        return { rows: [] };
      }),
      end: vi.fn(async () => undefined)
    };

    const config = await ensureTestDatabase({
      projectRoot,
      execute,
      createClient: () => client,
      generatePassword: () => "generated-test-password",
      sleep: async () => undefined
    });

    expect(config).toMatchObject({
      databaseName: "infinitequest_test",
      databaseUrl: "postgresql://infinitequest_test:generated-test-password@127.0.0.1:55432/infinitequest_test",
      environmentFile: join(projectRoot, ".env.test.local")
    });
    expect(await readFile(config.environmentFile, "utf8")).toContain("POSTGRES_PASSWORD=generated-test-password");
    expect(execute).toHaveBeenCalledWith("docker.exe", [
      "compose",
      "--env-file", config.environmentFile,
      "--project-name", "infinitequest-test",
      "--file", join(projectRoot, "compose.test.yaml"),
      "up", "--detach", "integration-postgres"
    ], { cwd: projectRoot });
    expect(queries).toEqual(expect.arrayContaining([
      "SELECT datname FROM pg_database WHERE datname = 'infinitequest_test'",
      "CREATE DATABASE \"infinitequest_test\""
    ]));
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("reuses recorded credentials and does not recreate an existing root database", async () => {
    const projectRoot = await temporaryProjectRoot();
    await (await import("node:fs/promises")).writeFile(
      join(projectRoot, ".env.test.local"),
      "POSTGRES_PASSWORD=recorded-test-password\n",
      "utf8"
    );
    const queries: string[] = [];
    const client = {
      connect: vi.fn(async () => undefined),
      query: vi.fn(async (query: string) => {
        queries.push(query);
        return { rows: [{ datname: "infinitequest_test" }] };
      }),
      end: vi.fn(async () => undefined)
    };

    const config = await ensureTestDatabase({
      projectRoot,
      execute: async () => undefined,
      createClient: () => client,
      generatePassword: () => "must-not-be-used",
      sleep: async () => undefined
    });

    expect(config.databaseUrl).toBe("postgresql://infinitequest_test:recorded-test-password@127.0.0.1:55432/infinitequest_test");
    expect(queries).toContain("SELECT datname FROM pg_database WHERE datname = 'infinitequest_test'");
    expect(queries).not.toContain("CREATE DATABASE \"infinitequest_test\"");
  });

  it("publishes the provisioned root URL before integration modules load", async () => {
    const originalUrl = process.env.TEST_DATABASE_URL;
    try {
      await configureIntegrationDatabase({
        ensure: async () => ({
          databaseName: "infinitequest_test",
          databaseUrl: "postgresql://infinitequest_test:password@127.0.0.1:55432/infinitequest_test",
          adminDatabaseUrl: "postgresql://infinitequest_test:password@127.0.0.1:55432/postgres",
          environmentFile: ".env.test.local"
        })
      });

      expect(process.env.TEST_DATABASE_URL).toBe("postgresql://infinitequest_test:password@127.0.0.1:55432/infinitequest_test");
    } finally {
      if (originalUrl === undefined) delete process.env.TEST_DATABASE_URL;
      else process.env.TEST_DATABASE_URL = originalUrl;
    }
  });
});
