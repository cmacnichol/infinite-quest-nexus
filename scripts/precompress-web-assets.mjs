import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import { lstat, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";

const TEXT_EXTENSIONS = new Set([".html", ".js", ".mjs", ".css", ".svg"]);
const REQUIRED_HTML = [
  "apps/web/dist/index.html",
  "apps/web/dist/story.html",
  "apps/web-next/dist/index.html"
];

class PrecompressError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function ensureWithin(rootPath, filePath) {
  const pathFromRoot = relative(rootPath, filePath);
  return pathFromRoot === "" || (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot));
}

function parseProjectRoot(args) {
  if (args.length === 0) return process.cwd();
  if (args.length === 2 && args[0] === "--project-root") return resolve(args[1]);
  throw new PrecompressError("PRECOMPRESS_USAGE", "Usage: node scripts/precompress-web-assets.mjs [--project-root <directory>]");
}

async function collectFiles(projectRoot, publicRoot) {
  const resolvedRoot = resolve(projectRoot, publicRoot);
  let rootStat;
  try {
    rootStat = await lstat(resolvedRoot);
  } catch (error) {
    throw new PrecompressError("PRECOMPRESS_ROOT_MISSING", `Required public root is unavailable: ${publicRoot}`, { cause: error });
  }
  if (rootStat.isSymbolicLink()) {
    throw new PrecompressError("PRECOMPRESS_SYMLINK_REJECTED", `Public root cannot be a symbolic link: ${publicRoot}`);
  }
  if (!rootStat.isDirectory()) {
    throw new PrecompressError("PRECOMPRESS_ROOT_INVALID", `Public root must be a real directory: ${publicRoot}`);
  }
  const realRoot = await realpath(resolvedRoot);
  if (!ensureWithin(projectRoot, realRoot)) {
    throw new PrecompressError("PRECOMPRESS_ROOT_ESCAPE", `Public root resolves outside the project: ${publicRoot}`);
  }

  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const filePath = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new PrecompressError("PRECOMPRESS_SYMLINK_REJECTED", `Symbolic link is not allowed in public roots: ${relative(projectRoot, filePath)}`);
      }
      if (!ensureWithin(realRoot, filePath)) {
        throw new PrecompressError("PRECOMPRESS_PATH_ESCAPE", `Public file resolves outside its root: ${relative(projectRoot, filePath)}`);
      }
      if (entry.isDirectory()) {
        await visit(filePath);
      } else if (entry.isFile()) {
        const realFilePath = await realpath(filePath);
        if (!ensureWithin(realRoot, realFilePath)) {
          throw new PrecompressError("PRECOMPRESS_PATH_ESCAPE", `Public file resolves outside its root: ${relative(projectRoot, filePath)}`);
        }
        files.push(realFilePath);
      }
    }
  }
  await visit(realRoot);
  return { realRoot, files };
}

async function writeVariant(path, bytes) {
  await writeFile(path, bytes);
}

async function precompress(projectRoot) {
  const realProjectRoot = await realpath(projectRoot);
  const roots = await Promise.all([
    collectFiles(realProjectRoot, "apps/web/dist"),
    collectFiles(realProjectRoot, "apps/web-next/dist")
  ]);
  const allFiles = roots.flatMap(({ files }) => files);
  for (const requiredPath of REQUIRED_HTML) {
    const expected = resolve(realProjectRoot, requiredPath);
    if (!allFiles.includes(expected)) {
      throw new PrecompressError("PRECOMPRESS_REQUIRED_HTML_MISSING", `Required HTML entry is missing: ${requiredPath}`);
    }
  }

  const requiredHtml = new Set(REQUIRED_HTML.map((path) => resolve(realProjectRoot, path)));
  for (const filePath of allFiles) {
    const extension = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension)) continue;
    const identity = await readFile(filePath);
    const isRequiredHtml = requiredHtml.has(filePath);
    const gzip = gzipSync(identity, { level: 9 });
    const brotli = brotliCompressSync(identity, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 }
    });
    const gzipPath = `${filePath}.gz`;
    const brotliPath = `${filePath}.br`;
    if (isRequiredHtml || gzip.byteLength < identity.byteLength) {
      await writeVariant(gzipPath, gzip);
    } else {
      await rm(gzipPath, { force: true });
    }
    if (isRequiredHtml || brotli.byteLength < identity.byteLength) {
      await writeVariant(brotliPath, brotli);
    } else {
      await rm(brotliPath, { force: true });
    }
  }
}

try {
  const projectRoot = parseProjectRoot(process.argv.slice(2));
  await precompress(projectRoot);
} catch (error) {
  const code = error instanceof PrecompressError ? error.code : "PRECOMPRESS_FAILED";
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${code}: ${message}\n`);
  process.exitCode = 1;
}
