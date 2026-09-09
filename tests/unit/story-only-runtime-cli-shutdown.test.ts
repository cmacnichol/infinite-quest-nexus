import { afterEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({
  fixtureClose: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  rm: vi.fn(),
  summary: vi.fn(),
  writeFile: vi.fn()
}));

vi.mock("node:fs/promises", () => ({
  mkdir: seams.mkdir,
  readFile: seams.readFile,
  rm: seams.rm,
  writeFile: seams.writeFile
}));

vi.mock("../helpers/story-only-runtime-fixture.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers/story-only-runtime-fixture.js")>();
  return {
    ...actual,
    closeStoryOnlyRuntimeInput: vi.fn(),
    startStoryOnlyRuntime: vi.fn(async () => ({
      baseUrl: "http://127.0.0.1:18081",
      campaignId: "campaign-1",
      databaseName: "infinitequest_storyonly_cli",
      close: seams.fixtureClose,
      summary: seams.summary
    }))
  };
});

describe("story-only runtime CLI shutdown", () => {
  const originalExitCode = process.exitCode;
  const originalListeners = new Map(["SIGINT", "SIGTERM", "data"].map((event) => [event, (event === "data" ? process.stdin : process).listeners(event)]));

  const startCli = async () => {
    vi.resetModules();
    seams.fixtureClose.mockReset();
    seams.mkdir.mockReset();
    seams.readFile.mockReset();
    seams.rm.mockReset();
    seams.summary.mockReset();
    seams.writeFile.mockReset();
    seams.fixtureClose.mockRejectedValue(new Error("owned cleanup failed: postgresql://test:secret@127.0.0.1:15439/infinitequest_storyonly_cli"));
    seams.readFile.mockResolvedValue('{"url":"postgresql://test:secret@127.0.0.1:15439/infinitequest_storyonly_test"}');
    seams.summary.mockResolvedValue({ database: "infinitequest_storyonly_cli" });
    await import("../../scripts/story-only-ui-runtime.js");
    seams.rm.mockClear();
  };

  afterEach(() => {
    process.exitCode = originalExitCode;
    for (const event of ["SIGINT", "SIGTERM", "data"]) {
      const target = event === "data" ? process.stdin : process;
      for (const listener of target.listeners(event)) {
        if (!originalListeners.get(event)!.includes(listener)) target.removeListener(event, listener);
      }
    }
    vi.restoreAllMocks();
  });

  it("removes the runtime state and exits nonzero when SIGTERM cleanup fails", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await startCli();
    process.emit("SIGTERM");
    await vi.waitFor(() => expect(process.exitCode).toBe(1));

    expect(seams.rm).toHaveBeenCalledOnce();
    expect(seams.rm).toHaveBeenCalledWith(expect.stringMatching(/runtime\.json$/u), { force: true });
    expect(stderr).toHaveBeenCalledWith("Story-only runtime shutdown failed.\n");
    expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining("postgresql://"));
  });

  it("accepts a Buffer stdin stop command and performs the same shutdown", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await startCli();
    process.stdin.emit("data", Buffer.from("stop"));
    await vi.waitFor(() => expect(process.exitCode).toBe(1));

    expect(seams.fixtureClose).toHaveBeenCalledOnce();
    expect(seams.rm).toHaveBeenCalledWith(expect.stringMatching(/runtime\.json$/u), { force: true });
  });
});
