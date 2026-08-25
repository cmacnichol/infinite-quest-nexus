import { metaResponseSchema, sessionResponseSchema } from "../../../packages/contracts/src/client-api.js";
import {
  systemArchiveJobViewSchema,
  systemImportPreviewViewSchema,
  systemUploadViewSchema,
  type SystemArchiveJobKind,
  type SystemArchiveJobView,
  type SystemArchiveUploadView,
  type SystemImportPreviewView
} from "../../../packages/contracts/src/system-archives.js";

export type { SystemArchiveJobView, SystemImportPreviewView };
export type SystemUploadView = SystemArchiveUploadView;

export type SystemArchiveCapability = Readonly<{ systemArchive: boolean }>;
export type SystemUploadProgress = Readonly<{
  phase: "hashing" | "uploading" | "completing";
  receivedBytes: number;
  byteLength: number;
}>;

export type CreateSystemUploadOptions = Readonly<{
  signal?: AbortSignal;
  onProgress?(progress: SystemUploadProgress): void;
  onUploadAvailable?(upload: SystemUploadView): void;
}>;

export interface DataTransferApi {
  capability(signal?: AbortSignal): Promise<SystemArchiveCapability>;
  sessionOwnerId(signal?: AbortSignal): Promise<string>;
  createExport(idempotencyKey: string, signal?: AbortSignal): Promise<SystemArchiveJobView>;
  getJob(kind: SystemArchiveJobKind, jobId: string, signal?: AbortSignal): Promise<SystemArchiveJobView>;
  cancelJob(kind: SystemArchiveJobKind, jobId: string, signal?: AbortSignal): Promise<SystemArchiveJobView>;
  downloadUrl(jobId: string): string;
  createUpload(file: File, options?: CreateSystemUploadOptions): Promise<SystemUploadView>;
  getUpload(uploadId: string, signal?: AbortSignal): Promise<SystemUploadView>;
  cancelUpload(uploadId: string, signal?: AbortSignal): Promise<SystemUploadView>;
  preview(uploadHandle: string, signal?: AbortSignal): Promise<SystemImportPreviewView>;
  commit(previewHandle: string, idempotencyKey: string, signal?: AbortSignal): Promise<SystemArchiveJobView>;
}

export class DataTransferApiError extends Error {
  readonly status: number | null;
  readonly code: string;

  constructor(message: string, status: number | null, code = "data-transfer-request-failed") {
    super(message);
    this.name = "DataTransferApiError";
    this.status = status;
    this.code = code;
  }
}

const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

class IncrementalSha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);
  private readonly buffer = new Uint8Array(64);
  private bufferLength = 0;
  private bytesHashed = 0;

  update(bytes: Uint8Array): void {
    this.bytesHashed += bytes.byteLength;
    let offset = 0;
    if (this.bufferLength > 0) {
      const needed = 64 - this.bufferLength;
      const copied = Math.min(needed, bytes.byteLength);
      this.buffer.set(bytes.subarray(0, copied), this.bufferLength);
      this.bufferLength += copied;
      offset += copied;
      if (this.bufferLength === 64) {
        this.process(this.buffer);
        this.bufferLength = 0;
      }
    }
    while (offset + 64 <= bytes.byteLength) {
      this.process(bytes.subarray(offset, offset + 64));
      offset += 64;
    }
    if (offset < bytes.byteLength) {
      this.buffer.set(bytes.subarray(offset), 0);
      this.bufferLength = bytes.byteLength - offset;
    }
  }

  digestHex(): string {
    const final = new Uint8Array(this.bufferLength < 56 ? 64 : 128);
    final.set(this.buffer.subarray(0, this.bufferLength));
    final[this.bufferLength] = 0x80;
    const bitLengthHigh = Math.floor(this.bytesHashed / 0x20000000);
    const bitLengthLow = (this.bytesHashed * 8) >>> 0;
    const lengthOffset = final.byteLength - 8;
    const view = new DataView(final.buffer);
    view.setUint32(lengthOffset, bitLengthHigh, false);
    view.setUint32(lengthOffset + 4, bitLengthLow, false);
    for (let offset = 0; offset < final.byteLength; offset += 64) {
      this.process(final.subarray(offset, offset + 64));
    }
    return [...this.state].map((value) => value.toString(16).padStart(8, "0")).join("");
  }

  private process(block: Uint8Array): void {
    const words = new Uint32Array(64);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15]!;
      const right = words[index - 2]!;
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const first = (h! + sum1 + choice + SHA256_CONSTANTS[index]! + words[index]!) >>> 0;
      const sum0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const second = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + first) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) >>> 0;
    }
    this.state[0] = (this.state[0]! + a!) >>> 0;
    this.state[1] = (this.state[1]! + b!) >>> 0;
    this.state[2] = (this.state[2]! + c!) >>> 0;
    this.state[3] = (this.state[3]! + d!) >>> 0;
    this.state[4] = (this.state[4]! + e!) >>> 0;
    this.state[5] = (this.state[5]! + f!) >>> 0;
    this.state[6] = (this.state[6]! + g!) >>> 0;
    this.state[7] = (this.state[7]! + h!) >>> 0;
  }
}

function positiveChunkBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Data Transfer chunk size must be a positive safe integer.");
  return value;
}

export async function sha256File(
  file: Blob,
  chunkBytes = 4 * 1024 * 1024,
  onProgress?: (bytesHashed: number) => void,
  signal?: AbortSignal
): Promise<string> {
  const chunkSize = positiveChunkBytes(chunkBytes);
  const hash = new IncrementalSha256();
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Transfer cancelled", "AbortError");
    hash.update(new Uint8Array(await file.slice(offset, Math.min(file.size, offset + chunkSize)).arrayBuffer()));
    onProgress?.(Math.min(file.size, offset + chunkSize));
  }
  return hash.digestHex();
}

function sha256Bytes(bytes: Uint8Array): string {
  const hash = new IncrementalSha256();
  hash.update(bytes);
  return hash.digestHex();
}

type StoredUpload = Readonly<{
  id: string;
  byteLength: number;
  sha256: string;
  chunkBytes: number;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(value: unknown): string {
  if (!isRecord(value)) return "data-transfer-request-failed";
  if (typeof value.error === "string") return value.error;
  if (typeof value.code === "string") return value.code;
  if (isRecord(value.details) && typeof value.details.code === "string") return value.details.code;
  return "data-transfer-request-failed";
}

async function requestJson(fetchImpl: typeof fetch, url: string, init: RequestInit = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      headers: { Accept: "application/json", ...(init.headers ?? {}) }
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new DataTransferApiError(error instanceof Error ? error.message : "Data Transfer could not reach the server.", null, "network");
  }
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    const message = isRecord(value) && typeof value.message === "string"
      ? value.message
      : `Data Transfer request failed with status ${response.status}.`;
    throw new DataTransferApiError(message, response.status, errorCode(value));
  }
  return value;
}

function parseStoredUpload(value: string | null): StoredUpload | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || typeof parsed.id !== "string" || typeof parsed.sha256 !== "string"
      || !Number.isSafeInteger(parsed.byteLength) || !Number.isSafeInteger(parsed.chunkBytes)) return null;
    return {
      id: parsed.id,
      byteLength: Number(parsed.byteLength),
      sha256: parsed.sha256,
      chunkBytes: Number(parsed.chunkBytes)
    };
  } catch {
    return null;
  }
}

function uploadStorageKey(byteLength: number, sha256: string): string {
  return `infiniteQuest.systemArchiveUpload.v1:${byteLength}:${sha256}`;
}

export type DataTransferApiOptions = Readonly<{
  fetchImpl?: typeof fetch;
  storage?: Storage | null;
  chunkBytes?: number;
}>;

export function createDataTransferApi(options: DataTransferApiOptions = {}): DataTransferApi {
  const fetchImpl = options.fetchImpl ?? fetch;
  const chunkBytes = positiveChunkBytes(options.chunkBytes ?? 4 * 1024 * 1024);
  let storage = options.storage;
  if (storage === undefined) {
    try {
      storage = globalThis.localStorage;
    } catch {
      storage = null;
    }
  }

  const jsonHeaders = { "Content-Type": "application/json" };

  async function getUpload(uploadId: string, signal?: AbortSignal): Promise<SystemUploadView> {
    const value = await requestJson(fetchImpl, `/api/v1/system-imports/uploads/${encodeURIComponent(uploadId)}`, { signal });
    return systemUploadViewSchema.parse(value);
  }

  return {
    async capability(signal) {
      const value = metaResponseSchema.parse(await requestJson(fetchImpl, "/api/v1/meta", { signal }));
      return { systemArchive: value.capabilities.systemArchive };
    },
    async sessionOwnerId(signal) {
      const value = sessionResponseSchema.parse(await requestJson(fetchImpl, "/api/v1/session", { signal }));
      return value.user.id;
    },
    async createExport(idempotencyKey, signal) {
      const value = await requestJson(fetchImpl, "/api/v1/system-exports", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ idempotencyKey }),
        signal
      });
      return systemArchiveJobViewSchema.parse(value);
    },
    async getJob(kind, jobId, signal) {
      const segment = kind === "export" ? "system-exports" : "system-imports";
      const value = await requestJson(fetchImpl, `/api/v1/${segment}/${encodeURIComponent(jobId)}`, { signal });
      const job = systemArchiveJobViewSchema.parse(value);
      if (job.kind !== kind) throw new DataTransferApiError("System Archive job kind did not match the requested operation.", 500, "invalid_response");
      return job;
    },
    async cancelJob(kind, jobId, signal) {
      const segment = kind === "export" ? "system-exports" : "system-imports";
      const value = await requestJson(fetchImpl, `/api/v1/${segment}/${encodeURIComponent(jobId)}`, { method: "DELETE", signal });
      const job = systemArchiveJobViewSchema.parse(value);
      if (job.kind !== kind) throw new DataTransferApiError("System Archive job kind did not match the requested operation.", 500, "invalid_response");
      return job;
    },
    downloadUrl(jobId) {
      return `/api/v1/system-exports/${encodeURIComponent(jobId)}/download`;
    },
    async createUpload(file, uploadOptions = {}) {
      if (file.size < 1) throw new DataTransferApiError("System Archive file must not be empty.", 400, "system-archive-upload-length-invalid");
      uploadOptions.onProgress?.({ phase: "hashing", receivedBytes: 0, byteLength: file.size });
      const hash = await sha256File(file, chunkBytes, (receivedBytes) => {
        uploadOptions.onProgress?.({ phase: "hashing", receivedBytes, byteLength: file.size });
      }, uploadOptions.signal);
      const key = uploadStorageKey(file.size, hash);
      const stored = parseStoredUpload(storage?.getItem(key) ?? null);
      let current: SystemUploadView | null = null;
      if (stored && stored.byteLength === file.size && stored.sha256 === hash && stored.chunkBytes === chunkBytes) {
        try {
          current = await getUpload(stored.id, uploadOptions.signal);
          if (!["created", "uploading", "completed"].includes(current.status) || current.byteLength !== file.size) current = null;
        } catch (error) {
          if (error instanceof DataTransferApiError && [404, 410].includes(error.status ?? 0)) current = null;
          else throw error;
        }
      }
      if (!current) {
        const created = await requestJson(fetchImpl, "/api/v1/system-imports/uploads", {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ byteLength: file.size, sha256: hash }),
          signal: uploadOptions.signal
        });
        current = systemUploadViewSchema.parse(created);
        storage?.setItem(key, JSON.stringify({ id: current.id, byteLength: file.size, sha256: hash, chunkBytes } satisfies StoredUpload));
      }
      uploadOptions.onUploadAvailable?.(current);
      uploadOptions.onProgress?.({ phase: "uploading", receivedBytes: current.receivedBytes, byteLength: file.size });
      if (current.status === "completed") return current;
      let offset = current.receivedBytes;
      if (offset % chunkBytes !== 0 && offset !== file.size) {
        throw new DataTransferApiError("Durable upload progress does not align with this client's chunk boundary.", 409, "system-archive-upload-resume-conflict");
      }
      let index = Math.floor(offset / chunkBytes);
      while (offset < file.size) {
        if (uploadOptions.signal?.aborted) throw uploadOptions.signal.reason ?? new DOMException("Transfer cancelled", "AbortError");
        const end = Math.min(file.size, offset + chunkBytes);
        const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
        const value = await requestJson(fetchImpl, `/api/v1/system-imports/uploads/${encodeURIComponent(current.id)}/chunks/${index}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(bytes.byteLength),
            "Content-Range": `bytes ${offset}-${end - 1}/${file.size}`,
            "X-Chunk-SHA256": sha256Bytes(bytes)
          },
          body: bytes,
          signal: uploadOptions.signal
        });
        current = systemUploadViewSchema.parse(value);
        uploadOptions.onUploadAvailable?.(current);
        offset = current.receivedBytes;
        index += 1;
        uploadOptions.onProgress?.({ phase: "uploading", receivedBytes: offset, byteLength: file.size });
      }
      uploadOptions.onProgress?.({ phase: "completing", receivedBytes: offset, byteLength: file.size });
      const completed = systemUploadViewSchema.parse(await requestJson(
        fetchImpl,
        `/api/v1/system-imports/uploads/${encodeURIComponent(current.id)}/complete`,
        { method: "POST", signal: uploadOptions.signal }
      ));
      uploadOptions.onUploadAvailable?.(completed);
      uploadOptions.onProgress?.({ phase: "completing", receivedBytes: completed.receivedBytes, byteLength: file.size });
      return completed;
    },
    getUpload,
    async cancelUpload(uploadId, signal) {
      const value = await requestJson(fetchImpl, `/api/v1/system-imports/uploads/${encodeURIComponent(uploadId)}`, { method: "DELETE", signal });
      return systemUploadViewSchema.parse(value);
    },
    async preview(uploadHandle, signal) {
      const value = await requestJson(fetchImpl, "/api/v1/system-imports/preview", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ uploadId: uploadHandle }),
        signal
      });
      return systemImportPreviewViewSchema.parse(value);
    },
    async commit(previewHandle, idempotencyKey, signal) {
      const value = await requestJson(fetchImpl, "/api/v1/system-imports", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          previewHandle,
          idempotencyKey,
          acknowledgeSensitiveArchive: true,
          acknowledgeEmptyDestination: true,
          acknowledgeInvalidatedAccess: true,
          acknowledgeProviderReentry: true,
          acknowledgeNonCancellableBoundary: true
        }),
        signal
      });
      return systemArchiveJobViewSchema.parse(value);
    }
  };
}

export const dataTransferApi = createDataTransferApi();
