import { describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({
  queries: [] as string[],
  createDatabasePool: vi.fn(),
  spawn: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn()
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
  importLegacyStory: vi.fn()
}));

vi.mock("../helpers/memory-applications.js", () => ({
  memoryGeneration: vi.fn()
}));

vi.mock("../helpers/provider-application-fixtures.js", () => ({
  createProvider: vi.fn()
}));

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
});
