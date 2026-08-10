import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { bindExportArtifactCleanup } from "../../services/api/src/archive-routes.js";

describe("Task 14e3f active campaign-export stream cleanup", () => {
  it("destroys the bound export stream on response close and cleans its artifact once", async () => {
    const stream = new PassThrough();
    const response = new EventEmitter();
    const cleanup = vi.fn(async () => undefined);

    bindExportArtifactCleanup(stream, response, cleanup);
    response.emit("close");
    response.emit("close");

    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
    expect(stream.destroyed).toBe(true);
  });
});
