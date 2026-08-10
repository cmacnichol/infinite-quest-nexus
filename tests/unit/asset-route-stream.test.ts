import { EventEmitter } from "node:events";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createAssetDeliveryStream } from "../../services/api/src/asset-route-stream.js";

describe("createAssetDeliveryStream", () => {
  it("finalizes a completed secure session as eof", async () => {
    const finalize = vi.fn(async () => undefined);
    const response = new EventEmitter();
    const stream = createAssetDeliveryStream({
      chunks: (async function* () {
        yield new Uint8Array([1, 2]);
        yield new Uint8Array([3]);
      })(),
      finalize
    }, response);

    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    await once(stream, "end");

    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3]));
    expect(finalize).toHaveBeenCalledWith("eof");
  });

  it("finalizes an interrupted response as close", async () => {
    const finalize = vi.fn(async () => undefined);
    const response = new EventEmitter();
    const stream = createAssetDeliveryStream({
      chunks: (async function* () {
        yield new Uint8Array([1]);
        await new Promise(() => undefined);
      })(),
      finalize
    }, response);

    response.emit("close");
    await once(stream, "close");

    expect(finalize).toHaveBeenCalledWith("close");
  });
});
