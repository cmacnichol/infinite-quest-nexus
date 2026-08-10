import { describe, expect, it } from "vitest";
import { detectImageMimeType } from "../../packages/domain/src/image-media.js";

describe("detectImageMimeType", () => {
  it.each([
    ["PNG", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "image/png"],
    ["JPEG", [0xff, 0xd8, 0xff, 0xe0], "image/jpeg"],
    ["WebP", [...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")], "image/webp"],
    ["GIF87a", [...Buffer.from("GIF87a")], "image/gif"],
    ["GIF89a", [...Buffer.from("GIF89a")], "image/gif"],
  ])("detects %s signatures", (_label, bytes, expected) => {
    expect(detectImageMimeType(Uint8Array.from(bytes))).toBe(expected);
  });

  it("falls back to PNG for unknown or truncated input", () => {
    expect(detectImageMimeType(Uint8Array.from([0x01, 0x02]))).toBe("image/png");
  });

  it("respects a Uint8Array view offset", () => {
    const storage = Uint8Array.from([0, 0, 0xff, 0xd8, 0xff, 0xe0, 0]);
    expect(detectImageMimeType(storage.subarray(2, 6))).toBe("image/jpeg");
  });
});
