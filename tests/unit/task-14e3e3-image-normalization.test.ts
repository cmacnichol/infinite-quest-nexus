import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { normalizePrivateIllustrationArtifact } from "../../services/runtime/src/illustration-asset-publication-composition.js";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("Task 14e3e3 private illustration image normalization", () => {
  it("verifies raw PNG bytes and emits one deterministic bounded WebP thumbnail", async () => {
    const bytes = await sharp({
      create: {
        width: 800,
        height: 400,
        channels: 3,
        background: { r: 12, g: 34, b: 56 }
      }
    }).png().toBuffer();

    const normalized = await normalizePrivateIllustrationArtifact({
      bytes,
      declaredMimeType: "image/png",
      maximumBytes: 5_000_000,
      maximumPixels: 2_000_000
    });

    expect(normalized.original).toMatchObject({
      mimeType: "image/png",
      byteLength: bytes.byteLength,
      contentHash: sha256(bytes),
      technicalMetadata: {
        state: "verified",
        pixelWidth: 800,
        pixelHeight: 400,
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
        technicalMetadata: {
          state: "verified",
          pixelWidth: 480,
          pixelHeight: 240,
          format: "webp",
          pages: 1
        }
      }
    });
    expect(normalized.thumbnail.artifact.contentHash).toBe(
      sha256(normalized.thumbnail.artifact.bytes),
    );
    const repeated = await normalizePrivateIllustrationArtifact({
      bytes,
      declaredMimeType: "image/png",
      maximumBytes: 5_000_000,
      maximumPixels: 2_000_000
    });
    expect(repeated.thumbnail.artifact.bytes).toEqual(normalized.thumbnail.artifact.bytes);
  });

  it("rejects declared MIME/signature disagreement before publication", async () => {
    const bytes = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 3,
        background: "white"
      }
    }).png().toBuffer();

    await expect(normalizePrivateIllustrationArtifact({
      bytes,
      declaredMimeType: "image/jpeg",
      maximumBytes: 1024,
      maximumPixels: 16
    })).rejects.toThrow("illustration_artifact_mime_mismatch");
  });

  it("rejects undecodable and over-budget images with stable diagnostics", async () => {
    await expect(normalizePrivateIllustrationArtifact({
      bytes: new TextEncoder().encode("not an image"),
      declaredMimeType: "image/png",
      maximumBytes: 1024,
      maximumPixels: 16
    })).rejects.toThrow("illustration_artifact_signature_invalid");

    const bytes = await sharp({
      create: {
        width: 5,
        height: 5,
        channels: 3,
        background: "black"
      }
    }).webp().toBuffer();
    await expect(normalizePrivateIllustrationArtifact({
      bytes,
      declaredMimeType: "image/webp",
      maximumBytes: 1024,
      maximumPixels: 16
    })).rejects.toThrow("illustration_artifact_dimensions_invalid");
  });
});
