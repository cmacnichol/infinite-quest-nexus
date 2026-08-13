import { createHash } from "node:crypto";
import sharp from "sharp";
import type {
  PrivateNormalizedAssetArtifact,
  PrivateNormalizedAssetDerivative
} from "../../../packages/application/src/assets/private-normalized-asset-publication.js";

const THUMBNAIL_TRANSFORM_VERSION = 1;
const THUMBNAIL_MAXIMUM_EDGE = 480;
type SharpMetadata = Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;

type SupportedImageFormat = Readonly<{
  format: "png" | "jpeg" | "webp" | "gif";
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
}>;

export type PrivateNormalizedImageArtifact = Readonly<{
  original: PrivateNormalizedAssetArtifact;
  thumbnail: PrivateNormalizedAssetDerivative;
}>;

export type PrivateInspectedImageArtifact = Readonly<{
  mimeType: SupportedImageFormat["mimeType"];
  pixelCount: number;
  technicalMetadata: PrivateNormalizedAssetArtifact["technicalMetadata"];
}>;

function stableError(prefix: string, suffix: string): Error {
  return new Error(`${prefix}_${suffix}`);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function signedFormat(bytes: Uint8Array): SupportedImageFormat | null {
  if (bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a) {
    return { format: "png", mimeType: "image/png" };
  }
  if (bytes.length >= 3
    && bytes[0] === 0xff
    && bytes[1] === 0xd8
    && bytes[2] === 0xff) {
    return { format: "jpeg", mimeType: "image/jpeg" };
  }
  if (bytes.length >= 12
    && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") {
    return { format: "webp", mimeType: "image/webp" };
  }
  if (bytes.length >= 6) {
    const signature = String.fromCharCode(...bytes.subarray(0, 6));
    if (signature === "GIF87a" || signature === "GIF89a") {
      return { format: "gif", mimeType: "image/gif" };
    }
  }
  return null;
}

function displayDimensions(
  width: number,
  height: number,
  orientation: number | undefined,
): Readonly<{ width: number; height: number }> {
  return orientation !== undefined && orientation >= 5 && orientation <= 8
    ? { width: height, height: width }
    : { width, height };
}

async function inspectImage(input: Readonly<{
  bytes: Uint8Array;
  declaredMimeType: string;
  maximumBytes: number;
  maximumPixels: number;
  diagnosticPrefix: "illustration_artifact" | "portable_import_image";
}>): Promise<Readonly<{
  signed: SupportedImageFormat;
  metadata: SharpMetadata;
  displayed: Readonly<{ width: number; height: number }>;
}>> {
  if (input.bytes.byteLength < 1 || input.bytes.byteLength > input.maximumBytes) {
    throw stableError(input.diagnosticPrefix, "size_invalid");
  }
  const signed = signedFormat(input.bytes);
  if (!signed) {
    throw stableError(input.diagnosticPrefix, "signature_invalid");
  }
  const declaredMimeType = input.declaredMimeType.split(";", 1)[0]?.trim().toLowerCase();
  if (declaredMimeType !== signed.mimeType) {
    throw stableError(input.diagnosticPrefix, "mime_mismatch");
  }
  const source = Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
  let metadata: SharpMetadata;
  try {
    metadata = await sharp(source, {
      animated: false,
      failOn: "warning",
      limitInputPixels: input.maximumPixels,
      pages: 1,
      sequentialRead: true
    }).metadata();
  } catch {
    throw stableError(input.diagnosticPrefix, "dimensions_invalid");
  }
  if (metadata.format !== signed.format) {
    throw stableError(input.diagnosticPrefix, "mime_mismatch");
  }
  if (!metadata.width || !metadata.height
    || (metadata.pages ?? 1) !== 1
    || metadata.width * metadata.height > input.maximumPixels) {
    throw stableError(input.diagnosticPrefix, "dimensions_invalid");
  }
  return Object.freeze({
    signed,
    metadata,
    displayed: displayDimensions(metadata.width, metadata.height, metadata.orientation)
  });
}

export async function inspectPrivateImageArtifact(input: Readonly<{
  bytes: Uint8Array;
  declaredMimeType: string;
  maximumBytes: number;
  maximumPixels: number;
  diagnosticPrefix: "illustration_artifact" | "portable_import_image";
}>): Promise<PrivateInspectedImageArtifact> {
  const inspected = await inspectImage(input);
  return Object.freeze({
    mimeType: inspected.signed.mimeType,
    pixelCount: inspected.metadata.width! * inspected.metadata.height!,
    technicalMetadata: Object.freeze({
      state: "verified" as const,
      pixelWidth: inspected.displayed.width,
      pixelHeight: inspected.displayed.height,
      format: inspected.signed.format,
      pages: 1,
      orientation: inspected.metadata.orientation ?? null
    })
  });
}

/**
 * Role-neutral bounded image verification. Hashes cover exact source and
 * derivative bytes; Sharp is allowed to decode only the first bounded frame.
 */
export async function normalizePrivateImageArtifact(input: Readonly<{
  bytes: Uint8Array;
  declaredMimeType: string;
  maximumBytes: number;
  maximumPixels: number;
  diagnosticPrefix: "illustration_artifact" | "portable_import_image";
}>): Promise<PrivateNormalizedImageArtifact> {
  const inspected = await inspectImage(input);
  const { signed, metadata, displayed } = inspected;
  const source = Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);

  let thumbnailBytes: Buffer;
  let thumbnailMetadata: SharpMetadata;
  try {
    thumbnailBytes = await sharp(source, {
      animated: false,
      failOn: "warning",
      limitInputPixels: input.maximumPixels,
      pages: 1,
      sequentialRead: true
    })
      .rotate()
      .resize({
        width: THUMBNAIL_MAXIMUM_EDGE,
        height: THUMBNAIL_MAXIMUM_EDGE,
        fit: "inside",
        withoutEnlargement: true
      })
      .webp({ quality: 78, effort: 4, smartSubsample: false })
      .toBuffer();
    thumbnailMetadata = await sharp(thumbnailBytes, {
      animated: false,
      failOn: "warning",
      limitInputPixels: input.maximumPixels,
      pages: 1,
      sequentialRead: true
    }).metadata();
  } catch {
    throw stableError(input.diagnosticPrefix, "decode_invalid");
  }
  if (thumbnailMetadata.format !== "webp"
    || !thumbnailMetadata.width
    || !thumbnailMetadata.height) {
    throw stableError(input.diagnosticPrefix, "decode_invalid");
  }

  const original: PrivateNormalizedAssetArtifact = Object.freeze({
    bytes: new Uint8Array(input.bytes),
    mimeType: signed.mimeType,
    byteLength: input.bytes.byteLength,
    contentHash: sha256(input.bytes),
    technicalMetadata: Object.freeze({
      state: "verified" as const,
      pixelWidth: displayed.width,
      pixelHeight: displayed.height,
      format: signed.format,
      pages: 1,
      orientation: metadata.orientation ?? null
    })
  });
  const thumbnailArtifact: PrivateNormalizedAssetArtifact = Object.freeze({
    bytes: new Uint8Array(thumbnailBytes),
    mimeType: "image/webp" as const,
    byteLength: thumbnailBytes.byteLength,
    contentHash: sha256(thumbnailBytes),
    technicalMetadata: Object.freeze({
      state: "verified" as const,
      pixelWidth: thumbnailMetadata.width,
      pixelHeight: thumbnailMetadata.height,
      format: "webp" as const,
      pages: 1,
      orientation: null
    })
  });
  return Object.freeze({
    original,
    thumbnail: Object.freeze({
      slot: Object.freeze({
        derivativeKind: "thumbnail" as const,
        transformVersion: THUMBNAIL_TRANSFORM_VERSION,
        pixelWidth: thumbnailMetadata.width,
        pixelHeight: thumbnailMetadata.height
      }),
      artifact: thumbnailArtifact
    })
  });
}
