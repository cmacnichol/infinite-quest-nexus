import { createHash } from "node:crypto";
import { archiveSha256Schema, canonicalArchiveJson } from "./archives.js";

export function calculateContentFingerprint(input: {
  payloadHashes: readonly string[];
  originalAssetHashes: readonly string[];
}): string {
  const payloadHashes = [...input.payloadHashes].map((hash) => archiveSha256Schema.parse(hash)).sort();
  const originalAssetHashes = [...new Set(input.originalAssetHashes.map((hash) => archiveSha256Schema.parse(hash)))].sort();
  return createHash("sha256")
    .update(canonicalArchiveJson({ payloadHashes, originalAssetHashes }))
    .digest("hex");
}
