import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const seams = vi.hoisted(() => ({
  queries: [] as string[],
  createDatabasePool: vi.fn(),
  spawn: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
  migrateDatabase: vi.fn(),
  importLegacyStory: vi.fn(),
  createProvider: vi.fn(),
  createSyntheticProvider: vi.fn()
}));

vi.mock("../../packages/database/src/pool.js", () => ({
  createDatabasePool: seams.createDatabasePool
}));

vi.mock("node:child_process", () => ({
  spawn: seams.spawn
}));

vi.mock("node:fs/promises", () => ({
  mkdir: seams.mkdir,
  rm: seams.rm
}));

vi.mock("../legacy-api/src/import-service.js", () => ({
  importLegacyStory: seams.importLegacyStory
}));

vi.mock("../helpers/memory-applications.js", () => ({
  memoryGeneration: vi.fn()
}));

vi.mock("../helpers/provider-application-fixtures.js", () => ({
  createProvider: seams.createProvider
}));

vi.mock("../helpers/story-only-synthetic-provider.js", () => ({
  createStoryOnlySyntheticProvider: seams.createSyntheticProvider
}));

vi.mock("../../packages/database/src/migrate.js", () => ({ migrateDatabase: seams.migrateDatabase }));

import { startStoryOnlyRuntime } from "../helpers/story-only-runtime-fixture.js";

describe("story-only runtime startup cleanup", () => {
  it.each(["provider", "runtime"] as const)("removes an allocated %s container after docker startup fails", async (component) => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    if (!originalPlatform) throw new Error("Missing process platform descriptor");
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const commands: string[][] = [];
    const removedIds: string[] = [];
    const inspectedNames: string[] = [];
    const labels = (args: string[]) => Object.fromEntries(args.flatMap((value, index) => value === "--label" && args[index + 1] ? [args[index + 1]!.split("=", 2) as [string, string]] : []));
    seams.queries.length = 0;
    seams.createDatabasePool.mockReset();
    seams.spawn.mockReset();
    seams.mkdir.mockReset();
    seams.rm.mockReset();
    seams.mkdir.mockResolvedValue(undefined);
    seams.rm.mockResolvedValue(undefined);
    seams.migrateDatabase.mockResolvedValue(undefined);
    seams.createProvider.mockResolvedValue({ id: "10000000-0000-4000-8000-000000000001" });
    seams.importLegacyStory.mockResolvedValue({ campaignId: "10000000-0000-4000-8000-000000000002" });
    seams.createDatabasePool.mockReturnValue({
      query: async (sql: string) => { seams.queries.push(sql); },
      end: async () => undefined
    });
    seams.spawn.mockImplementation((_command: string, args: string[]) => {
      commands.push([...args]);
      let stdoutText = "";
      if (args[0] === "inspect" && args[1] !== "--format") {
        const name = args.at(-1);
        if (!name) throw new Error("Container inspect did not include a name");
        inspectedNames.push(name);
        const attempted = commands.find(command => command[0] === "run" && command.includes(name));
        if (!attempted) throw new Error("Inspected a container that was not attempted by this test");
        const configStart = attempted.lastIndexOf("node");
        stdoutText = JSON.stringify([{
          Id: name.startsWith("iq-runtime-") ? "a".repeat(64) : "b".repeat(64),
          Name: `/${name}`,
          Config: { Image: attempted[configStart - 1], Cmd: attempted.slice(configStart), Labels: labels(attempted) }
        }]);
      }
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
      if (stdoutText) queueMicrotask(() => child.stdout.emit("data", Buffer.from(stdoutText)));
      const isTargetStart = args[0] === "run" && (component === "provider"
        ? args.includes("scripts/story-only-synthetic-provider.ts")
        : args.includes("services/runtime/src/main.ts"));
      queueMicrotask(() => child.emit("exit", isTargetStart ? 1 : 0));
      if (args[0] === "rm") removedIds.push(args.at(-1) ?? "");
      return child;
    });
    try {
      const failure = await startStoryOnlyRuntime({
        databaseUrl: "postgresql://test:secret@127.0.0.1:15439/infinitequest_storyonly_test"
      }).then(() => undefined, (error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect(inspectedNames).toHaveLength(component === "provider" ? 1 : 2);
      expect(inspectedNames.some(name => (component === "provider" ? /^iq-provider-/u : /^iq-runtime-/u).test(name))).toBe(true);
      if (component === "runtime") expect(inspectedNames.some(name => /^iq-provider-/u.test(name))).toBe(true);
      expect(removedIds).toEqual(component === "provider" ? ["b".repeat(64)] : ["a".repeat(64), "b".repeat(64)]);
      expect(commands.filter(args => args[0] === "network" && args[1] === "disconnect")).toHaveLength(1);
      expect(commands.filter(args => args[0] === "rm").flatMap(args => args.slice(2))).not.toContain("infinitequest-story-only-test");
      expect(seams.queries.filter(sql => sql.startsWith("DROP DATABASE"))).toHaveLength(1);
      expect(seams.createDatabasePool.mock.results[0]?.value.end).toBeDefined();
    } finally {
      fetchSpy.mockRestore();
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  it("passes only explicit Docker runtime settings while preserving host spawn environment", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    if (!originalPlatform) throw new Error("Missing process platform descriptor");
    const originalCanary = process.env.STORY_ONLY_HOST_SECRET_CANARY;
    const originalTemp = process.env.TEMP;
    const originalTmp = process.env.TMP;
    const originalPath = process.env.PATH;
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
    process.env.STORY_ONLY_HOST_SECRET_CANARY = "must-not-enter-docker";
    process.env.TEMP = "host-temp-path";
    process.env.TMP = "host-tmp-path";
    process.env.PATH = "host-path-value";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const runArgs: string[][] = [];
    const dockerCommands: string[][] = [];
    seams.queries.length = 0;
    seams.createDatabasePool.mockReset();
    seams.spawn.mockReset();
    seams.mkdir.mockReset();
    seams.rm.mockReset();
    seams.mkdir.mockResolvedValue(undefined);
    seams.rm.mockResolvedValue(undefined);
    seams.migrateDatabase.mockResolvedValue(undefined);
    seams.createProvider.mockResolvedValue({ id: "10000000-0000-4000-8000-000000000001" });
    seams.importLegacyStory.mockResolvedValue({ campaignId: "10000000-0000-4000-8000-000000000002" });
    seams.createDatabasePool.mockReturnValue({ query: async (sql: string) => { seams.queries.push(sql); }, end: async () => undefined });
    seams.spawn.mockImplementation((_command: string, args: string[]) => {
      dockerCommands.push([...args]);
      runArgs.push([...args]);
      let stdoutText = "";
      if (args[0] === "inspect" && args[1] !== "--format") {
        const name = args[1];
        const attempted = dockerCommands.find(command => command[0] === "run" && command.includes(name ?? ""));
        if (!name || !attempted) throw new Error("Expected an attempted owned container inspect");
        const commandIndex = attempted.lastIndexOf("node");
        const labels = Object.fromEntries(attempted.flatMap((value, index) => value === "--label" && attempted[index + 1]
          ? [attempted[index + 1]!.split("=", 2) as [string, string]] : []));
        stdoutText = JSON.stringify([{
          Id: name.startsWith("iq-runtime-") ? "a".repeat(64) : "b".repeat(64), Name: `/${name}`,
          Config: { Image: attempted[commandIndex - 1], Cmd: attempted.slice(commandIndex), Labels: labels }
        }]);
      }
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
      if (stdoutText) queueMicrotask(() => child.stdout.emit("data", Buffer.from(stdoutText)));
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    });
    try {
      const fixture = await startStoryOnlyRuntime({ databaseUrl: "postgresql://test:secret@127.0.0.1:15439/infinitequest_storyonly_test" });
      try {
        const runtimeArgs = runArgs.find(args => args[0] === "run" && args.includes("services/runtime/src/main.ts"));
        expect(runtimeArgs).toBeDefined();
        const dockerEnvironment = runtimeArgs!.flatMap((value, index) => value === "--env" && runtimeArgs![index + 1] ? [runtimeArgs![index + 1]!] : []);
        expect(dockerEnvironment).toEqual(expect.arrayContaining([
          "APP_ROLE=all", "APP_HOST=0.0.0.0", "APP_PORT=8080", expect.stringMatching(/^DATABASE_URL=/u),
          "DATABASE_MAX_CONNECTIONS=12", expect.stringMatching(/^CREDENTIAL_ENCRYPTION_KEY=/u),
          expect.stringMatching(/^PROVIDER_NETWORK_ALLOWLIST=iq-provider-/u), "LEGACY_WEB_ROOT=/app/apps/web/dist",
          "NEXT_WEB_ROOT=/app/apps/web-next/dist", "ASSET_STORAGE_ROOT=/tmp/story-only/assets",
          "ARCHIVE_STORAGE_ROOT=/tmp/story-only/archives", "LOG_LEVEL=silent"
        ]));
        const providerArgs = runArgs.find(args => args[0] === "run" && args.includes("scripts/story-only-synthetic-provider.ts"));
        expect(providerArgs).toBeDefined();
        expect(providerArgs!.flatMap((value, index) => value === "--env" && providerArgs![index + 1] ? [providerArgs![index + 1]!] : []))
          .toEqual(["STORY_ONLY_SYNTHETIC_PROVIDER_HOST=0.0.0.0"]);
        expect(dockerEnvironment.join("\n")).not.toMatch(/(?:^|\n)(?:PATH|TEMP|TMP|STORY_ONLY_HOST_SECRET_CANARY)=/u);
        expect(process.env.STORY_ONLY_HOST_SECRET_CANARY).toBe("must-not-enter-docker");
        expect(dockerEnvironment.join("\n")).not.toContain("must-not-enter-docker");
      } finally {
        await fixture.close();
      }
    } finally {
      fetchSpy.mockRestore();
      if (originalCanary === undefined) delete process.env.STORY_ONLY_HOST_SECRET_CANARY;
      else process.env.STORY_ONLY_HOST_SECRET_CANARY = originalCanary;
      if (originalTemp === undefined) delete process.env.TEMP;
      else process.env.TEMP = originalTemp;
      if (originalTmp === undefined) delete process.env.TMP;
      else process.env.TMP = originalTmp;
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  it("merges explicit settings into native host spawn without mutating process.env", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    if (!originalPlatform) throw new Error("Missing process platform descriptor");
    const originalCanary = process.env.STORY_ONLY_HOST_SECRET_CANARY;
    const originalTemp = process.env.TEMP;
    const originalTmp = process.env.TMP;
    const originalPath = process.env.PATH;
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "linux" });
    process.env.STORY_ONLY_HOST_SECRET_CANARY = "preserved-on-host";
    process.env.TEMP = "host-temp-path";
    process.env.TMP = "host-tmp-path";
    process.env.PATH = "host-path-value";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    let runtimeEnvironment: NodeJS.ProcessEnv | undefined;
    let hostChild: (EventEmitter & { exitCode: number | null; killed: boolean; kill(signal?: NodeJS.Signals | number): boolean }) | undefined;
    const providerClose = vi.fn();
    seams.queries.length = 0;
    seams.createDatabasePool.mockReset();
    seams.spawn.mockReset();
    seams.mkdir.mockReset();
    seams.rm.mockReset();
    seams.mkdir.mockResolvedValue(undefined);
    seams.rm.mockResolvedValue(undefined);
    seams.migrateDatabase.mockResolvedValue(undefined);
    seams.createProvider.mockResolvedValue({ id: "10000000-0000-4000-8000-000000000001" });
    seams.importLegacyStory.mockResolvedValue({ campaignId: "10000000-0000-4000-8000-000000000002" });
    seams.createSyntheticProvider.mockReset();
    seams.createSyntheticProvider.mockResolvedValue({ baseUrl: "http://127.0.0.1:8081", close: providerClose });
    seams.createDatabasePool.mockReturnValue({ query: async (sql: string) => { seams.queries.push(sql); }, end: async () => undefined });
    seams.spawn.mockImplementation((_command: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      runtimeEnvironment = options.env;
      const child = Object.assign(new EventEmitter(), {
        exitCode: null as number | null,
        killed: false,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: () => {
          if (hostChild) {
            hostChild.killed = true;
            hostChild.exitCode = 0;
          }
          queueMicrotask(() => hostChild?.emit("exit", 0));
          return true;
        }
      });
      hostChild = child;
      return child;
    });
    try {
      const fixture = await startStoryOnlyRuntime({ databaseUrl: "postgresql://test:secret@127.0.0.1:15439/infinitequest_storyonly_test" });
      try {
        expect(runtimeEnvironment).toMatchObject({
          APP_ROLE: "all", DATABASE_URL: expect.stringContaining(fixture.databaseName),
          CREDENTIAL_ENCRYPTION_KEY: expect.any(String), PATH: "host-path-value", TEMP: "host-temp-path", TMP: "host-tmp-path",
          STORY_ONLY_HOST_SECRET_CANARY: "preserved-on-host"
        });
        expect(process.env).toMatchObject({
          PATH: "host-path-value", TEMP: "host-temp-path", TMP: "host-tmp-path",
          STORY_ONLY_HOST_SECRET_CANARY: "preserved-on-host"
        });
      } finally {
        await fixture.close();
      }
      expect(hostChild?.killed).toBe(true);
      expect(providerClose).toHaveBeenCalledOnce();
    } finally {
      fetchSpy.mockRestore();
      if (originalCanary === undefined) delete process.env.STORY_ONLY_HOST_SECRET_CANARY;
      else process.env.STORY_ONLY_HOST_SECRET_CANARY = originalCanary;
      if (originalTemp === undefined) delete process.env.TEMP;
      else process.env.TEMP = originalTemp;
      if (originalTmp === undefined) delete process.env.TMP;
      else process.env.TMP = originalTmp;
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  it("does not remove unallocated resources when database allocation fails", async () => {
    seams.queries.length = 0;
    seams.createDatabasePool.mockReset();
    seams.spawn.mockReset();
    seams.mkdir.mockReset();
    seams.rm.mockReset();
    seams.createDatabasePool.mockReturnValue({
      query: async (sql: string) => {
        seams.queries.push(sql);
        if (sql.startsWith("CREATE DATABASE")) throw new Error("create database failed");
      },
      end: async () => undefined
    });

    await expect(startStoryOnlyRuntime({
      databaseUrl: "postgresql://test:secret@127.0.0.1:15439/infinitequest_storyonly_test"
    })).rejects.toThrow("create database failed");

    expect(seams.queries).toHaveLength(1);
    expect(seams.queries[0]).toMatch(/^CREATE DATABASE/u);
    expect(seams.spawn).not.toHaveBeenCalled();
    expect(seams.rm).not.toHaveBeenCalled();
  });

  it("attempts allocated database cleanup and preserves its failure after asset allocation fails", async () => {
    seams.queries.length = 0;
    seams.createDatabasePool.mockReset();
    seams.spawn.mockReset();
    seams.mkdir.mockReset();
    seams.rm.mockReset();
    seams.createDatabasePool.mockReturnValue({
      query: async (sql: string) => {
        seams.queries.push(sql);
        if (sql.startsWith("DROP DATABASE")) throw new Error("drop owned database failed");
      },
      end: async () => undefined
    });
    seams.mkdir.mockRejectedValue(new Error("create asset directory failed"));

    const failure = await startStoryOnlyRuntime({
      databaseUrl: "postgresql://test:secret@127.0.0.1:15439/infinitequest_storyonly_test"
    }).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(failure).toMatchObject({ name: "AggregateError", errors: expect.arrayContaining([
      expect.objectContaining({ message: "create asset directory failed" }),
      expect.objectContaining({ message: "Story-only runtime cleanup failed." })
    ]) });
    expect(seams.queries).toEqual(expect.arrayContaining([
      expect.stringMatching(/^CREATE DATABASE/u),
      expect.stringMatching(/^SELECT pg_terminate_backend/u),
      expect.stringMatching(/^DROP DATABASE/u)
    ]));
    expect(seams.spawn).not.toHaveBeenCalled();
    expect(seams.rm).not.toHaveBeenCalled();
  });
  it("rejects an unsafe explicit container before allocating any resource", async () => {
    seams.createDatabasePool.mockReset();
    seams.spawn.mockReset();
    seams.mkdir.mockReset();
    seams.createDatabasePool.mockImplementation(() => { throw new Error("Unexpected database allocation"); });
    await expect(startStoryOnlyRuntime({
      databaseUrl: "postgresql://test:secret@127.0.0.1:15439/infinitequest_storyonly_test",
      postgresContainer: "--unrelated-container"
    })).rejects.toThrow("PostgreSQL container");
    expect(seams.createDatabasePool).not.toHaveBeenCalled();
    expect(seams.spawn).not.toHaveBeenCalled();
    expect(seams.mkdir).not.toHaveBeenCalled();
  });

  it.each([
    { mode: "failed provider startup", container: "iq-owned-test-postgres", failProvider: true },
    { mode: "successful explicit cleanup", container: "iq-owned-test-postgres", failProvider: false },
    { mode: "successful default cleanup", container: undefined, failProvider: false }
  ])("uses one PostgreSQL identity for $mode", async ({ container, failProvider }) => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    if (!originalPlatform) throw new Error("Missing process platform descriptor");
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const networking: string[][] = [];
    const dockerCommands: string[][] = [];
    let runtimeDatabaseUrl: string | undefined;
    seams.queries.length = 0;
    seams.createDatabasePool.mockReset();
    seams.spawn.mockReset();
    seams.mkdir.mockReset();
    seams.rm.mockReset();
    seams.mkdir.mockResolvedValue(undefined);
    seams.rm.mockResolvedValue(undefined);
    seams.migrateDatabase.mockResolvedValue(undefined);
    seams.createProvider.mockResolvedValue({ id: "10000000-0000-4000-8000-000000000001" });
    seams.importLegacyStory.mockResolvedValue({ campaignId: "10000000-0000-4000-8000-000000000002" });
    seams.createDatabasePool.mockReturnValue({
      query: async (sql: string) => { seams.queries.push(sql); },
      end: async () => undefined
    });
    seams.spawn.mockImplementation((_command: string, args: string[]) => {
      // Retain only non-sensitive network arguments and the synthetic database URL.
      dockerCommands.push([...args]);
      if (args[0] === "network") networking.push([...args]);
      if (args.includes("services/runtime/src/main.ts")) runtimeDatabaseUrl = args.find(value => value.startsWith("DATABASE_URL="))?.slice("DATABASE_URL=".length);
      let stdoutText = "";
      if (args[0] === "inspect" && args[1] !== "--format") {
        const name = args[1];
        const attempted = dockerCommands.find(command => command[0] === "run" && command.includes(name ?? ""));
        if (!name || !attempted) throw new Error("Expected an attempted owned container inspect");
        const commandIndex = attempted.lastIndexOf("node");
        const labels = Object.fromEntries(attempted.flatMap((value, index) => value === "--label" && attempted[index + 1]
          ? [attempted[index + 1]!.split("=", 2) as [string, string]] : []));
        stdoutText = JSON.stringify([{
          Id: "b".repeat(64), Name: `/${name}`,
          Config: { Image: attempted[commandIndex - 1], Cmd: attempted.slice(commandIndex), Labels: labels }
        }]);
      }
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
      if (stdoutText) queueMicrotask(() => child.stdout.emit("data", Buffer.from(stdoutText)));
      queueMicrotask(() => child.emit("exit", failProvider && args.includes("scripts/story-only-synthetic-provider.ts") ? 1 : 0));
      return child;
    });
    try {
      const options = {
        databaseUrl: "postgresql://test:secret@127.0.0.1:15439/infinitequest_storyonly_test?application_name=owned-harness",
        ...(container === undefined ? {} : { postgresContainer: container })
      };
      if (failProvider) await expect(startStoryOnlyRuntime(options)).rejects.toThrow("command failed");
      else {
        const fixture = await startStoryOnlyRuntime(options);
        await fixture.close();
        await fixture.close();
        if (!runtimeDatabaseUrl) throw new Error("Runtime database URL was not captured");
        const translated = new URL(runtimeDatabaseUrl);
        expect(translated.hostname).toBe(container ?? "infinitequest-story-only-test");
        expect(translated.port).toBe("5432");
        expect(translated.pathname).toBe('/' + fixture.databaseName);
        expect(translated.username).toBe("test");
        expect(translated.password).toBe("secret");
        expect(translated.searchParams.get("application_name")).toBe("owned-harness");
      }
      const connect = networking.filter(args => args[1] === "connect");
      const disconnect = networking.filter(args => args[1] === "disconnect");
      expect(connect).toHaveLength(1);
      expect(disconnect).toHaveLength(1);
      expect(connect[0]?.[3]).toBe(container ?? "infinitequest-story-only-test");
      expect(disconnect[0]?.slice(2)).toEqual(connect[0]?.slice(2));
      expect(seams.queries.filter(sql => sql.startsWith("DROP DATABASE"))).toHaveLength(1);
      expect(dockerCommands.filter(args => args[0] === "rm")).toHaveLength(failProvider ? 1 : 2);
      expect(seams.queries).toEqual(expect.arrayContaining([expect.stringMatching(/^DROP DATABASE IF EXISTS "infinitequest_storyonly_/u)]));
    } finally {
      fetchSpy.mockRestore();
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

});
