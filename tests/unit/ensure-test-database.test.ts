import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dockerCommandForPlatform,
  ensureTestDatabase
} from "../../scripts/ensure-test-database.mjs";
import { configureIntegrationDatabase } from "../../tests/integration/ensure-test-database.setup.js";

const temporaryDirectories: string[] = [];
const realSetTimeout = globalThis.setTimeout;
const originalTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const originalOptInTestDatabaseUrl = process.env.INFINITEQUEST_TEST_DATABASE_URL;

afterEach(async () => {
  vi.useRealTimers();
  if (originalTestDatabaseUrl === undefined) delete process.env.TEST_DATABASE_URL;
  else process.env.TEST_DATABASE_URL = originalTestDatabaseUrl;
  if (originalOptInTestDatabaseUrl === undefined) delete process.env.INFINITEQUEST_TEST_DATABASE_URL;
  else process.env.INFINITEQUEST_TEST_DATABASE_URL = originalOptInTestDatabaseUrl;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryProjectRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "infinitequest-test-database-"));
  temporaryDirectories.push(directory);
  return directory;
}

// Polls on the real clock while fake timers are installed. A fixed real-time
// sleep flakes under parallel suite load, where the filesystem work that
// precedes the first connection attempt can take longer than the sleep.
async function waitOnRealClock(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition did not become true on the real clock.");
    await new Promise<void>((resolvePromise) => {
      realSetTimeout(resolvePromise, 1);
    });
  }
}

describe("ensureTestDatabase", () => {
  it.each([
    ["win32", "docker.exe"],
    ["linux", "docker"],
    ["darwin", "docker"]
  ] as const)("uses %s Docker command %s", (platform, expected) => {
    expect(dockerCommandForPlatform(platform)).toBe(expected);
  });

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
    expect(execute).toHaveBeenCalledWith(dockerCommandForPlatform(), [
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

  it("bounds a PostgreSQL connection attempt that never settles", async () => {
    vi.useFakeTimers();
    const projectRoot = await temporaryProjectRoot();
    const clients: Array<{
      connect: ReturnType<typeof vi.fn>;
      query: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    }> = [];
    const readiness = ensureTestDatabase({
      projectRoot,
      execute: async () => undefined,
      createClient: () => {
        const client = {
          connect: vi.fn(() => new Promise<void>(() => undefined)),
          query: vi.fn(async () => ({ rows: [] })),
          end: vi.fn(async () => undefined)
        };
        clients.push(client);
        return client;
      },
      generatePassword: () => "generated-test-password",
      sleep: async () => undefined
    });
    const outcome = readiness.then(
      () => ({ settled: true, error: undefined }),
      (error: unknown) => ({ settled: true, error })
    );

    await waitOnRealClock(() => clients.length >= 1);
    expect(clients).toHaveLength(1);
    await vi.runAllTimersAsync();
    const result = await Promise.race([
      outcome,
      new Promise<{ settled: false; error: undefined }>((resolvePromise) => {
        realSetTimeout(() => resolvePromise({ settled: false, error: undefined }), 5_000);
      })
    ]);

    expect(result.settled).toBe(true);
    expect(result.error).toMatchObject({
      message: expect.stringMatching(
        /did not become ready within 150 seconds: PostgreSQL connection attempt timed out after 1 second/u
      )
    });
    expect(clients).toHaveLength(120);
    expect(clients.every((client) => client.end.mock.calls.length === 1)).toBe(true);
  });

  it("publishes the provisioned root URL before integration modules load", async () => {
    delete process.env.INFINITEQUEST_TEST_DATABASE_URL;
    await configureIntegrationDatabase({
      ensure: async () => ({
        databaseName: "infinitequest_test",
        databaseUrl: "postgresql://infinitequest_test:password@127.0.0.1:55432/infinitequest_test",
        adminDatabaseUrl: "postgresql://infinitequest_test:password@127.0.0.1:55432/postgres",
        environmentFile: ".env.test.local"
      }),
      testDatabaseUrl: undefined
    });

    expect(process.env.TEST_DATABASE_URL).toBe("postgresql://infinitequest_test:password@127.0.0.1:55432/infinitequest_test");
  });

  it.each([
    "postgresql://user:secret@localhost/infinitequest_test",
    "postgres://user:secret@127.0.0.1:55432/infinitequest_test",
    "postgresql://user:secret@localhost/infinitequest_test_worker_2"
  ])("publishes an explicitly configured loopback test database without provisioning: %s", async (databaseUrl) => {
    const ensure = vi.fn(async () => {
      throw new Error("provisioning must be bypassed");
    });

    await configureIntegrationDatabase({ ensure, testDatabaseUrl: databaseUrl });

    expect(ensure).not.toHaveBeenCalled();
    expect(process.env.TEST_DATABASE_URL).toBe(databaseUrl);
  });

  it.each([
    ["malformed URL", "postgresql://user:secret@localhost"],
    ["non-PostgreSQL scheme", "mysql://user:secret@localhost/infinitequest_test"],
    ["remote hostname", "postgresql://user:secret@db.example.test/infinitequest_test"],
    ["remote IPv4 address", "postgresql://user:secret@192.168.1.4/infinitequest_test"],
    ["IPv6 loopback URL", "postgresql://user:secret@[::1]:55432/infinitequest_test"],
    ["non-test database", "postgresql://user:secret@localhost/infinitequest"],
    ["empty database suffix", "postgresql://user:secret@localhost/infinitequest_test_"],
    ["unsafe host override", "postgresql://user:secret@localhost/infinitequest_test?host=remote.example"],
    ["unsafe database override", "postgresql://user:secret@localhost/infinitequest_test?dbname=production"],
    ["unsafe service override", "postgresql://user:secret@localhost/infinitequest_test?service=production"]
  ])("rejects %s without exposing the supplied URL or credentials", async (_description, databaseUrl) => {
    process.env.TEST_DATABASE_URL = "postgresql://existing/test_value";
    const ensure = vi.fn();

    let errorMessage = "";
    try {
      await configureIntegrationDatabase({ ensure, testDatabaseUrl: databaseUrl });
    } catch (error) {
      errorMessage = (error as Error).message;
    }

    expect(errorMessage).not.toBe("");
    expect(errorMessage).not.toContain(databaseUrl);
    expect(errorMessage).not.toContain("secret");
    expect(ensure).not.toHaveBeenCalled();
    expect(process.env.TEST_DATABASE_URL).toBe("postgresql://existing/test_value");
  });

  it("uses the explicit opt-in environment variable and ignores TEST_DATABASE_URL as an override", async () => {
    const ensure = vi.fn(async () => ({
      databaseName: "infinitequest_test",
      databaseUrl: "postgresql://default/password@127.0.0.1:55432/infinitequest_test",
      adminDatabaseUrl: "postgresql://default/password@127.0.0.1:55432/postgres",
      environmentFile: ".env.test.local"
    }));
    process.env.INFINITEQUEST_TEST_DATABASE_URL = "postgresql://optin:secret@localhost/infinitequest_test";
    process.env.TEST_DATABASE_URL = "postgresql://isolated:secret@localhost/infinitequest_test_file";

    await configureIntegrationDatabase({ ensure });

    expect(ensure).not.toHaveBeenCalled();
    expect(process.env.TEST_DATABASE_URL).toBe(process.env.INFINITEQUEST_TEST_DATABASE_URL);
  });

  it("provisions the default database when only the per-file TEST_DATABASE_URL is present", async () => {
    delete process.env.INFINITEQUEST_TEST_DATABASE_URL;
    process.env.TEST_DATABASE_URL = "postgresql://isolated:secret@localhost/infinitequest_test_file";
    const ensure = vi.fn(async () => ({
      databaseName: "infinitequest_test",
      databaseUrl: "postgresql://default/password@127.0.0.1:55432/infinitequest_test",
      adminDatabaseUrl: "postgresql://default/password@127.0.0.1:55432/postgres",
      environmentFile: ".env.test.local"
    }));

    await configureIntegrationDatabase({ ensure });

    expect(ensure).toHaveBeenCalledOnce();
    expect(process.env.TEST_DATABASE_URL).toBe("postgresql://default/password@127.0.0.1:55432/infinitequest_test");
  });
});
