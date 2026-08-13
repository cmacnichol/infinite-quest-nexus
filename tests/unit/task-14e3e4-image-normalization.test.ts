import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("Task 14e3e4 neutral imported-image normalization", () => {
  it("verifies a raw import artifact and emits the deterministic normalized thumbnail", async () => {
    const module = await import("../../services/runtime/src/private-image-normalization.js");
    const bytes = await sharp({
      create: {
        width: 640,
        height: 320,
        channels: 3,
        background: { r: 21, g: 43, b: 65 }
      }
    }).png().toBuffer();

    const normalized = await module.normalizePrivateImageArtifact({
      bytes,
      declaredMimeType: "image/png",
      maximumBytes: 5_000_000,
      maximumPixels: 2_000_000,
      diagnosticPrefix: "portable_import_image"
    });

    expect(normalized.original).toMatchObject({
      mimeType: "image/png",
      byteLength: bytes.byteLength,
      contentHash: sha256(bytes),
      technicalMetadata: {
        state: "verified",
        pixelWidth: 640,
        pixelHeight: 320,
        format: "png",
        pages: 1
      }
    });
    expect(normalized.thumbnail).toMatchObject({
      slot: {
        derivativeKind: "thumbnail",
        transformVersion: 1,
        pixelWidth: 480,
        pixelHeight: 240
      },
      artifact: {
        mimeType: "image/webp",
        contentHash: sha256(normalized.thumbnail.artifact.bytes)
      }
    });
  });

  it("rejects multi-page GIF input instead of recording false single-page verification", async () => {
    const module = await import("../../services/runtime/src/private-image-normalization.js");
    const width = 2;
    const height = 2;
    const channels = 4;
    const first = Buffer.alloc(width * height * channels);
    const second = Buffer.alloc(width * height * channels);
    for (let index = 0; index < first.length; index += channels) {
      first[index] = 255;
      first[index + 3] = 255;
      second[index + 1] = 255;
      second[index + 3] = 255;
    }
    const bytes = await sharp(Buffer.concat([first, second]), {
      raw: { width, height: height * 2, channels, pageHeight: height }
    }).gif({ loop: 0, delay: [100, 100] }).toBuffer();
    await expect(sharp(bytes, { pages: 1 }).metadata()).resolves.toMatchObject({ pages: 2 });

    await expect(module.normalizePrivateImageArtifact({
      bytes,
      declaredMimeType: "image/gif",
      maximumBytes: 5_000_000,
      maximumPixels: 2_000_000,
      diagnosticPrefix: "portable_import_image"
    })).rejects.toThrow("portable_import_image_dimensions_invalid");
  });
});
