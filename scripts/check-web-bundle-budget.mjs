import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ENTRY_BUDGET_BYTES = 200 * 1024;
const LAZY_CHUNK_BUDGET_BYTES = 100 * 1024;

function gzipSize(file) {
  return gzipSync(readFileSync(file)).byteLength;
}

export function inspectWebBundleBudget(rootDirectory = process.cwd()) {
  const distDirectory = path.join(rootDirectory, "apps/web-next/dist");
  const manifestPath = path.join(distDirectory, ".vite/manifest.json");
  if (!existsSync(manifestPath)) {
    return {
      mode: "report-only",
      reason: "apps/web-next/dist/.vite/manifest.json is not present"
    };
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const chunks = Object.entries(manifest)
    .filter(([, entry]) => typeof entry === "object" && entry !== null && typeof entry.file === "string")
    .map(([source, entry]) => ({
      source,
      entry: Boolean(entry.isEntry),
      gzipBytes: gzipSize(path.join(distDirectory, entry.file))
    }))
    .sort((left, right) => left.source.localeCompare(right.source));

  return {
    mode: "report-only",
    budgets: {
      entryGzipBytes: ENTRY_BUDGET_BYTES,
      lazyChunkGzipBytes: LAZY_CHUNK_BUDGET_BYTES
    },
    chunks
  };
}

function formatBytes(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function report(result) {
  if (result.reason) {
    process.stdout.write(`Web bundle budget: report only (${result.reason}).\n`);
    return;
  }

  process.stdout.write("Web bundle budget: report only until Slice 1 enables enforcement.\n");
  for (const chunk of result.chunks) {
    const budget = chunk.entry ? result.budgets.entryGzipBytes : result.budgets.lazyChunkGzipBytes;
    process.stdout.write(`- ${chunk.source}: ${formatBytes(chunk.gzipBytes)} gzip (budget ${formatBytes(budget)})\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  report(inspectWebBundleBudget());
}
