import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { request as undiciRequest } from "undici";

type JobKind = "export" | "import";

export type SystemArchiveImportConfirmation = Readonly<{
  archiveFingerprint: string;
  acknowledgeSensitiveArchive: boolean;
  acknowledgeEmptyDestination: boolean;
  acknowledgeInvalidatedAccess: boolean;
  acknowledgeProviderReentry: boolean;
  acknowledgeNonCancellableBoundary: boolean;
}>;

type PartialSystemArchiveImportConfirmation = Readonly<{
  archiveFingerprint?: string;
  acknowledgeSensitiveArchive: boolean;
  acknowledgeEmptyDestination: boolean;
  acknowledgeInvalidatedAccess: boolean;
  acknowledgeProviderReentry: boolean;
  acknowledgeNonCancellableBoundary: boolean;
}>;

export type SystemArchiveCliArgs =
  | Readonly<{ command: "export"; baseUrl: string; output: string; idempotencyKey: string }>
  | Readonly<{
    command: "import";
    baseUrl: string;
    file: string;
    confirmation: PartialSystemArchiveImportConfirmation;
    idempotencyKey: string;
    chunkBytes: number;
    upload?: string;
  }>
  | Readonly<{ command: "status"; baseUrl: string; job: string; kind?: JobKind }>
  | Readonly<{ command: "cancel"; baseUrl: string; job: string; kind: JobKind }>;

type HttpResponse = Readonly<{
  statusCode: number;
  headers?: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array> & Readonly<{
    json?(): Promise<unknown>;
    text?(): Promise<string>;
  }>;
}>;

type HttpRequest = (
  url: string,
  options?: Readonly<{
    method?: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
  }>,
) => Promise<HttpResponse>;

type WritableOutput = Readonly<{ write(value: string): unknown }>;

export type SystemArchiveCliDependencies = Readonly<{
  request: HttpRequest;
  stdout: WritableOutput;
  stderr: WritableOutput;
  isInteractive: boolean;
  sleep(milliseconds: number): Promise<void>;
  statFile(path: string): Promise<Readonly<{ byteLength: number; sha256: string }>>;
  readChunks(path: string, chunkBytes: number, start: number): AsyncIterable<Uint8Array>;
  existingBytes(path: string): Promise<number>;
  writeDownload(path: string, chunks: AsyncIterable<Uint8Array>, append: boolean): Promise<void>;
  confirmImport(preview: Readonly<Record<string, unknown>>): Promise<SystemArchiveImportConfirmation>;
}>;

const ACKNOWLEDGEMENT_FLAGS = new Set([
  "--acknowledge-sensitive-archive",
  "--acknowledge-empty-destination",
  "--acknowledge-invalidated-access",
  "--acknowledge-provider-reentry",
  "--acknowledge-non-cancellable-boundary",
]);

function usage(message?: string): Error {
  return new Error([
    message,
    "Usage:",
    "  pnpm system-archive -- export --base-url URL --output FILE [--idempotency-key KEY]",
    "  pnpm system-archive -- import --base-url URL --file FILE [--upload UUID] [--chunk-bytes N] [--idempotency-key KEY]",
    "    Interactive terminals confirm the exact Preview after it is displayed.",
    "    Noninteractive commit additionally requires --confirm-fingerprint SHA256 and all five --acknowledge-* flags.",
    "  pnpm system-archive -- status --base-url URL --job UUID [--kind export|import]",
    "  pnpm system-archive -- cancel --base-url URL --job UUID --kind export|import",
  ].filter(Boolean).join("\n"));
}

function flags(argv: readonly string[]): Map<string, string | true> {
  const values = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (!item.startsWith("--")) throw usage(`Unexpected argument: ${item}`);
    if (ACKNOWLEDGEMENT_FLAGS.has(item)) {
      values.set(item, true);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw usage(`${item} requires a value.`);
    values.set(item, value);
    index += 1;
  }
  return values;
}

function required(values: Map<string, string | true>, name: string): string {
  const value = values.get(name);
  if (typeof value !== "string" || value.trim().length === 0) throw usage(`${name} is required.`);
  return value.trim();
}

function baseUrl(values: Map<string, string | true>): string {
  const value = required(values, "--base-url").replace(/\/+$/u, "");
  const parsed = new URL(value);
  if (!(["http:", "https:"] as string[]).includes(parsed.protocol) || parsed.username || parsed.password) {
    throw usage("--base-url must be an HTTP(S) origin without embedded credentials.");
  }
  return value;
}

function kind(values: Map<string, string | true>, requiredKind: boolean): JobKind | undefined {
  const value = values.get("--kind");
  if (value === undefined && !requiredKind) return undefined;
  if (value !== "export" && value !== "import") throw usage("--kind must be export or import.");
  return value;
}

export function parseSystemArchiveCliArgs(argv: readonly string[]): SystemArchiveCliArgs {
  const [command, ...rest] = argv;
  if (!command || !["export", "import", "status", "cancel"].includes(command)) throw usage();
  const values = flags(rest);
  const commonBaseUrl = baseUrl(values);
  if (command === "export") {
    return Object.freeze({
      command,
      baseUrl: commonBaseUrl,
      output: required(values, "--output"),
      idempotencyKey: typeof values.get("--idempotency-key") === "string"
        ? String(values.get("--idempotency-key"))
        : `system-export:${randomUUID()}`,
    });
  }
  if (command === "import") {
    const rawChunkBytes = typeof values.get("--chunk-bytes") === "string"
      ? Number(values.get("--chunk-bytes"))
      : 16_777_216;
    if (!Number.isSafeInteger(rawChunkBytes) || rawChunkBytes < 1 || rawChunkBytes > 67_108_864) {
      throw usage("--chunk-bytes must be a whole number from 1 through 67108864.");
    }
    const rawConfirmationFingerprint = values.get("--confirm-fingerprint");
    if (rawConfirmationFingerprint !== undefined
      && (typeof rawConfirmationFingerprint !== "string"
        || !/^[a-f0-9]{64}$/u.test(rawConfirmationFingerprint))) {
      throw usage("--confirm-fingerprint must be the lowercase SHA-256 fingerprint from the exact Preview.");
    }
    return Object.freeze({
      command,
      baseUrl: commonBaseUrl,
      file: required(values, "--file"),
      confirmation: Object.freeze({
        ...(typeof rawConfirmationFingerprint === "string"
          ? { archiveFingerprint: rawConfirmationFingerprint }
          : {}),
        acknowledgeSensitiveArchive: values.get("--acknowledge-sensitive-archive") === true,
        acknowledgeEmptyDestination: values.get("--acknowledge-empty-destination") === true,
        acknowledgeInvalidatedAccess: values.get("--acknowledge-invalidated-access") === true,
        acknowledgeProviderReentry: values.get("--acknowledge-provider-reentry") === true,
        acknowledgeNonCancellableBoundary: values.get("--acknowledge-non-cancellable-boundary") === true,
      }),
      idempotencyKey: typeof values.get("--idempotency-key") === "string"
        ? String(values.get("--idempotency-key"))
        : `system-import:${randomUUID()}`,
      chunkBytes: rawChunkBytes,
      ...(typeof values.get("--upload") === "string"
        ? { upload: String(values.get("--upload")) }
        : {}),
    });
  }
  if (command === "status") {
    const selectedKind = kind(values, false);
    return Object.freeze({
      command,
      baseUrl: commonBaseUrl,
      job: required(values, "--job"),
      ...(selectedKind === undefined ? {} : { kind: selectedKind }),
    });
  }
  return Object.freeze({
    command: "cancel" as const,
    baseUrl: commonBaseUrl,
    job: required(values, "--job"),
    kind: kind(values, true)!,
  });
}

function bodyHeader(headers: HttpResponse["headers"], name: string): string | undefined {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function strongEtagHash(headers: HttpResponse["headers"]): string | null {
  return /^"([a-f0-9]{64})"$/u.exec(bodyHeader(headers, "etag") ?? "")?.[1] ?? null;
}

function unsatisfiedRangeTotal(headers: HttpResponse["headers"]): number | null {
  const match = /^bytes \*\/(0|[1-9]\d*)$/u.exec(bodyHeader(headers, "content-range") ?? "");
  if (!match) return null;
  const total = Number(match[1]);
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}

async function responseJson(response: HttpResponse): Promise<unknown> {
  if (response.body.json) return response.body.json();
  const chunks: Buffer[] = [];
  for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function requestJson(
  dependencies: SystemArchiveCliDependencies,
  url: string,
  method = "GET",
  value?: unknown,
): Promise<Readonly<{ statusCode: number; value: unknown }>> {
  const response = await dependencies.request(url, {
    method,
    ...(value === undefined ? {} : {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    }),
  });
  const parsed = await responseJson(response).catch(() => ({}));
  return { statusCode: response.statusCode, value: parsed };
}

function jobPath(base: string, selectedKind: JobKind, job: string): string {
  return `${base}/api/v1/system-${selectedKind === "export" ? "exports" : "imports"}/${encodeURIComponent(job)}`;
}

async function requireSuccess(
  response: Readonly<{ statusCode: number; value: unknown }>,
  action: string,
): Promise<unknown> {
  if (response.statusCode >= 200 && response.statusCode < 300) return response.value;
  const safe = typeof response.value === "object" && response.value !== null
    ? response.value as { message?: unknown; code?: unknown }
    : {};
  throw new Error(`${action} failed (${response.statusCode}): ${String(safe.code ?? safe.message ?? "request-failed")}`);
}

async function readStatus(
  args: Readonly<{ baseUrl: string; job: string; kind?: JobKind }>,
  dependencies: SystemArchiveCliDependencies,
): Promise<unknown> {
  const kinds: readonly JobKind[] = args.kind ? [args.kind] : ["export", "import"];
  for (const selectedKind of kinds) {
    const response = await requestJson(dependencies, jobPath(args.baseUrl, selectedKind, args.job));
    if (response.statusCode === 404 && !args.kind) continue;
    return requireSuccess(response, "System Archive status");
  }
  throw new Error("System Archive job was not found.");
}

async function waitForJob(
  args: Readonly<{ baseUrl: string; job: string; kind: JobKind }>,
  dependencies: SystemArchiveCliDependencies,
  terminal: ReadonlySet<string>,
): Promise<Record<string, unknown>> {
  for (;;) {
    const value = await readStatus(args, dependencies);
    if (typeof value !== "object" || value === null) throw new Error("System Archive status response is invalid.");
    const job = value as Record<string, unknown>;
    dependencies.stdout.write(`${JSON.stringify(job, null, 2)}\n`);
    const status = String(job.status ?? "");
    if (terminal.has(status)) return job;
    if (["failed", "cancelled", "rolled_back", "expired"].includes(status)) {
      throw new Error(`System Archive job stopped in ${status}.`);
    }
    await dependencies.sleep(1_000);
  }
}

async function runExport(
  args: Extract<SystemArchiveCliArgs, { command: "export" }>,
  dependencies: SystemArchiveCliDependencies,
): Promise<void> {
  const enqueued = await requireSuccess(await requestJson(
    dependencies,
    `${args.baseUrl}/api/v1/system-exports`,
    "POST",
    { idempotencyKey: args.idempotencyKey },
  ), "System Export enqueue") as Record<string, unknown>;
  const job = String(enqueued.id ?? "");
  if (!job) throw new Error("System Export response did not contain a job ID.");
  await waitForJob({ baseUrl: args.baseUrl, job, kind: "export" }, dependencies, new Set(["published"]));

  const downloadUrl = `${jobPath(args.baseUrl, "export", job)}/download`;
  const existing = await dependencies.existingBytes(args.output);
  const response = await dependencies.request(downloadUrl, {
    method: "GET",
    ...(existing > 0 ? { headers: { range: `bytes=${existing}-` } } : {}),
  });
  const restartFullDownload = async () => {
    const restarted = await dependencies.request(downloadUrl, { method: "GET" });
    if (restarted.statusCode !== 200) {
      const error = await responseJson(restarted).catch(() => ({}));
      await requireSuccess({ statusCode: restarted.statusCode, value: error }, "System Export restart");
      throw new Error("System Export restart did not return a complete response.");
    }
    const restartedHash = strongEtagHash(restarted.headers);
    if (!restartedHash) throw new Error("System Export restart did not provide a strong content hash ETag.");
    await dependencies.writeDownload(args.output, restarted.body, false);
    const identity = await dependencies.statFile(args.output);
    const rawLength = bodyHeader(restarted.headers, "content-length");
    if (identity.sha256 !== restartedHash
      || (rawLength !== undefined && Number(rawLength) !== identity.byteLength)) {
      throw new Error("System Export download did not match its content hash ETag.");
    }
  };
  if (response.statusCode === 416 && existing > 0) {
    await responseJson(response).catch(() => ({}));
    const expectedHash = strongEtagHash(response.headers);
    const expectedTotal = unsatisfiedRangeTotal(response.headers);
    if (expectedHash !== null && expectedTotal !== null) {
      const local = await dependencies.statFile(args.output);
      if (local.byteLength === expectedTotal && local.sha256 === expectedHash) {
        dependencies.stdout.write(`Downloaded ${basename(args.output)}.\n`);
        return;
      }
    }
    dependencies.stderr.write("Local download state is not the complete artifact; restarting once from byte zero.\n");
    await restartFullDownload();
    dependencies.stdout.write(`Downloaded ${basename(args.output)}.\n`);
    return;
  }
  if (![200, 206].includes(response.statusCode)) {
    const error = await responseJson(response).catch(() => ({}));
    await requireSuccess({ statusCode: response.statusCode, value: error }, "System Export download");
  }
  const append = response.statusCode === 206 && existing > 0;
  if (response.statusCode === 200 && existing > 0) {
    dependencies.stderr.write("Server restarted the download because the artifact changed.\n");
  }
  const contentRange = bodyHeader(response.headers, "content-range");
  if (append && !contentRange?.startsWith(`bytes ${existing}-`)) {
    throw new Error("System Export resume response did not match the local file length.");
  }
  const expectedHash = strongEtagHash(response.headers);
  if (!expectedHash) throw new Error("System Export download did not provide a strong content hash ETag.");
  await dependencies.writeDownload(args.output, response.body, append);
  const identity = await dependencies.statFile(args.output);
  if (identity.sha256 !== expectedHash) {
    if (!append) throw new Error("System Export download did not match its content hash ETag.");
    dependencies.stderr.write("Partial file did not match this artifact; restarting the download.\n");
    await restartFullDownload();
  }
  dependencies.stdout.write(`Downloaded ${basename(args.output)}.\n`);
}

async function runImport(
  args: Extract<SystemArchiveCliArgs, { command: "import" }>,
  dependencies: SystemArchiveCliDependencies,
): Promise<void> {
  const identity = await dependencies.statFile(args.file);
  const upload = args.upload === undefined
    ? await requireSuccess(await requestJson(
      dependencies,
      `${args.baseUrl}/api/v1/system-imports/uploads`,
      "POST",
      identity,
    ), "System Import upload creation") as Record<string, unknown>
    : await requireSuccess(await requestJson(
      dependencies,
      `${args.baseUrl}/api/v1/system-imports/uploads/${encodeURIComponent(args.upload)}`,
    ), "System Import upload resume") as Record<string, unknown>;
  const uploadId = String(upload.id ?? args.upload ?? "");
  if (!uploadId) throw new Error("System Import upload response did not contain an upload ID.");
  dependencies.stdout.write(`${JSON.stringify(upload, null, 2)}\n`);

  const resumedBytes = args.upload === undefined ? 0 : Number(upload.receivedBytes);
  const uploadByteLength = args.upload === undefined ? identity.byteLength : Number(upload.byteLength);
  const uploadStatus = args.upload === undefined ? String(upload.status ?? "created") : String(upload.status ?? "");
  if (!Number.isSafeInteger(resumedBytes)
    || resumedBytes < 0
    || resumedBytes > identity.byteLength
    || uploadByteLength !== identity.byteLength
    || !["created", "uploading", "completed"].includes(uploadStatus)
    || (resumedBytes !== identity.byteLength && resumedBytes % args.chunkBytes !== 0)) {
    throw new Error("System Import upload resume state does not match this local file and chunk size.");
  }
  if (uploadStatus === "completed" && resumedBytes !== identity.byteLength) {
    throw new Error("System Import completed upload reports an incomplete byte count.");
  }

  let offset = resumedBytes;
  let index = Math.floor(offset / args.chunkBytes);
  for await (const bytes of dependencies.readChunks(args.file, args.chunkBytes, offset)) {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const end = offset + bytes.byteLength - 1;
    const response = await dependencies.request(
      `${args.baseUrl}/api/v1/system-imports/uploads/${encodeURIComponent(uploadId)}/chunks/${index}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(bytes.byteLength),
          "content-range": `bytes ${offset}-${end}/${identity.byteLength}`,
          "x-chunk-sha256": sha256,
        },
        body: bytes,
      },
    );
    const value = await responseJson(response).catch(() => ({}));
    await requireSuccess({ statusCode: response.statusCode, value }, `System Import chunk ${index}`);
    offset = end + 1;
    index += 1;
  }
  if (offset !== identity.byteLength) throw new Error("System Import local file changed while uploading.");

  if (uploadStatus !== "completed") {
    await requireSuccess(await requestJson(
      dependencies,
      `${args.baseUrl}/api/v1/system-imports/uploads/${encodeURIComponent(uploadId)}/complete`,
      "POST",
    ), "System Import upload completion");
  }
  const preview = await requireSuccess(await requestJson(
    dependencies,
    `${args.baseUrl}/api/v1/system-imports/preview`,
    "POST",
    { uploadId },
  ), "System Import preview") as Record<string, unknown>;
  dependencies.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
  if (preview.valid !== true
    || typeof preview.previewHandle !== "string"
    || typeof preview.archiveFingerprint !== "string"
    || !/^[a-f0-9]{64}$/u.test(preview.archiveFingerprint)) {
    throw new Error("System Import preview did not authorize commit.");
  }
  const confirmation = dependencies.isInteractive
    ? await dependencies.confirmImport(preview)
    : args.confirmation;
  const requiredAcknowledgements = [
    ["acknowledgeSensitiveArchive", "acknowledge-sensitive-archive"],
    ["acknowledgeEmptyDestination", "acknowledge-empty-destination"],
    ["acknowledgeInvalidatedAccess", "acknowledge-invalidated-access"],
    ["acknowledgeProviderReentry", "acknowledge-provider-reentry"],
    ["acknowledgeNonCancellableBoundary", "acknowledge-non-cancellable-boundary"],
  ] as const;
  for (const [field, flag] of requiredAcknowledgements) {
    if (confirmation[field] !== true) {
      throw new Error(`System Import requires --${flag} for this exact Preview.`);
    }
  }
  if (confirmation.archiveFingerprint !== preview.archiveFingerprint) {
    throw new Error("System Import confirmation fingerprint does not match the exact Preview.");
  }
  const committed = await requireSuccess(await requestJson(
    dependencies,
    `${args.baseUrl}/api/v1/system-imports`,
    "POST",
    {
      previewHandle: preview.previewHandle,
      idempotencyKey: args.idempotencyKey,
      acknowledgeSensitiveArchive: confirmation.acknowledgeSensitiveArchive,
      acknowledgeEmptyDestination: confirmation.acknowledgeEmptyDestination,
      acknowledgeInvalidatedAccess: confirmation.acknowledgeInvalidatedAccess,
      acknowledgeProviderReentry: confirmation.acknowledgeProviderReentry,
      acknowledgeNonCancellableBoundary: confirmation.acknowledgeNonCancellableBoundary,
    },
  ), "System Import commit") as Record<string, unknown>;
  const job = String(committed.id ?? "");
  if (!job) throw new Error("System Import response did not contain a job ID.");
  await waitForJob({ baseUrl: args.baseUrl, job, kind: "import" }, dependencies, new Set(["completed"]));
}

async function fileIdentity(path: string): Promise<Readonly<{ byteLength: number; sha256: string }>> {
  const info = await stat(path);
  if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 1) {
    throw new Error("System Archive input must be a non-empty regular file.");
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { byteLength: info.size, sha256: hash.digest("hex") };
}

async function existingFileBytes(path: string): Promise<number> {
  try {
    const info = await stat(path);
    return info.isFile() && Number.isSafeInteger(info.size) ? info.size : 0;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return 0;
    throw error;
  }
}

async function writeDownload(
  path: string,
  chunks: AsyncIterable<Uint8Array>,
  append: boolean,
): Promise<void> {
  const stream = createWriteStream(path, { flags: append ? "a" : "w" });
  try {
    for await (const chunk of chunks) {
      if (!stream.write(chunk)) await new Promise<void>((done) => stream.once("drain", done));
    }
    await new Promise<void>((done, reject) => {
      stream.once("error", reject);
      stream.end(done);
    });
  } catch (error) {
    stream.destroy();
    throw error;
  }
}

function defaultDependencies(): SystemArchiveCliDependencies {
  return Object.freeze({
    request: undiciRequest as unknown as HttpRequest,
    stdout: process.stdout,
    stderr: process.stderr,
    isInteractive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    sleep: (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
    statFile: fileIdentity,
    readChunks(path, chunkBytes, start) {
      return createReadStream(path, { highWaterMark: chunkBytes, start });
    },
    existingBytes: existingFileBytes,
    writeDownload,
    async confirmImport(preview) {
      const fingerprint = String(preview.archiveFingerprint ?? "");
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const yes = async (question: string) => (await terminal.question(`${question} Type yes: `))
          .trim().toLowerCase() === "yes";
        return Object.freeze({
          acknowledgeSensitiveArchive: await yes("Acknowledge that this System Archive contains sensitive data."),
          acknowledgeEmptyDestination: await yes("Acknowledge that the Destination Instance must remain empty."),
          acknowledgeInvalidatedAccess: await yes("Acknowledge that external access will be invalidated."),
          acknowledgeProviderReentry: await yes("Acknowledge that provider credentials must be re-entered."),
          acknowledgeNonCancellableBoundary: await yes("Acknowledge that import becomes non-cancellable at the commit boundary."),
          archiveFingerprint: (await terminal.question(
            `Type the exact Preview archive fingerprint ${fingerprint} to commit: `,
          )).trim(),
        });
      } finally {
        terminal.close();
      }
    },
  });
}

export async function runSystemArchiveCli(
  argv: readonly string[],
  overrides: Partial<SystemArchiveCliDependencies> = {},
): Promise<void> {
  const args = parseSystemArchiveCliArgs(argv);
  const dependencies = Object.freeze({ ...defaultDependencies(), ...overrides });
  if (args.command === "export") return runExport(args, dependencies);
  if (args.command === "import") return runImport(args, dependencies);
  if (args.command === "status") {
    dependencies.stdout.write(`${JSON.stringify(await readStatus(args, dependencies), null, 2)}\n`);
    return;
  }
  const result = await requireSuccess(await requestJson(
    dependencies,
    jobPath(args.baseUrl, args.kind, args.job),
    "DELETE",
  ), "System Archive cancellation");
  dependencies.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entry) {
  runSystemArchiveCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
