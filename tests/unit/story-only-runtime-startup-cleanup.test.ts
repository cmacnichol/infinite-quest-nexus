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
  createProvider: vi.fn()
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

vi.mock("../../packages/database/src/migrate.js", () => ({ migrateDatabase: seams.migrateDatabase }));

import { startStoryOnlyRuntime } from "../helpers/story-only-runtime-fixture.js";

describe("story-only runtime startup cleanup", () => {
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
      if (args[0] === "network") networking.push([...args]);
      if (args.includes("services/runtime/src/main.ts")) runtimeDatabaseUrl = args.find(value => value.startsWith("DATABASE_URL="))?.slice("DATABASE_URL=".length);
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
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
      expect(seams.queries).toEqual(expect.arrayContaining([expect.stringMatching(/^DROP DATABASE IF EXISTS "infinitequest_storyonly_/u)]));
    } finally {
      fetchSpy.mockRestore();
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

});
