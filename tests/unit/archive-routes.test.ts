import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { bindExportArtifactCleanup, createLegacyArchiveAssetSource } from "../../services/api/src/archive-routes.js";

describe("campaign archive route helpers", () => {
  it("defers each legacy ZIP asset read until the importer requests that asset", async () => {
    const reads: string[] = [];
    const assets = createLegacyArchiveAssetSource(
      ["assets/first.png", "assets/second.png"],
      async (path) => {
        reads.push(path);
        return Buffer.from(path, "utf8");
      }
    );

    expect([...assets.assetIds()]).toEqual(["first", "second"]);
    expect(reads).toEqual([]);

    await expect(assets.read("second")).resolves.toEqual(Buffer.from("assets/second.png", "utf8"));
    expect(reads).toEqual(["assets/second.png"]);
  });

  it("waits for the export stream to close after an aborted response and retries bounded cleanup", async () => {
    const stream = new Readable({ read() {}, emitClose: false });
    const response = new EventEmitter();
    let attempts = 0;

    bindExportArtifactCleanup(stream, response, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("simulated Windows sharing violation");
    });

    response.emit("close");
    expect(stream.destroyed).toBe(true);
    expect(attempts).toBe(0);

    stream.emit("close");
    await expect.poll(() => attempts).toBe(2);
  });

  it("bounds failed export cleanup attempts and logs only a safe error code", async () => {
    const stream = new Readable({ read() {}, emitClose: false });
    const response = new EventEmitter();
    const logs: Array<{ bindings: Record<string, unknown>; message: string }> = [];
    let attempts = 0;

    bindExportArtifactCleanup(
      stream,
      response,
      async () => {
        attempts += 1;
        throw Object.assign(new Error("C:\\private\\archive.zip"), { code: "EPERM" });
      },
      { warn: (bindings, message) => { logs.push({ bindings, message }); } }
    );

    stream.emit("close");
    await expect.poll(() => attempts).toBe(3);
    expect(logs).toEqual([
      { bindings: { attempt: 1, maxAttempts: 3, errorCode: "EPERM" }, message: "campaign export artifact cleanup failed" },
      { bindings: { attempt: 2, maxAttempts: 3, errorCode: "EPERM" }, message: "campaign export artifact cleanup failed" },
      { bindings: { attempt: 3, maxAttempts: 3, errorCode: "EPERM" }, message: "campaign export artifact cleanup failed" }
    ]);
    expect(JSON.stringify(logs)).not.toContain("private");
  });
});
