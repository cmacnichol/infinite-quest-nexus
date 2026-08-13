import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import {
  isPrivateStorageInventorySource,
  parseProductionSourceAst,
} from "./check-private-storage-boundaries.mjs";

const SOURCE_EXTENSION = /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u;
const STORAGE = "services/runtime/src/asset-import-composition.ts";
const NORMALIZED = "services/runtime/src/normalized-asset-publication-composition.ts";
const ILLUSTRATION = "services/runtime/src/illustration-asset-publication-composition.ts";
const PORTABLE_NORMALIZED = "services/runtime/src/portable-normalized-asset-publication-composition.ts";
const PORTABLE = "services/runtime/src/portable-import-export-composition.ts";
const METADATA = "services/runtime/src/private-asset-metadata-backfill-composition.ts";
const RECOVERY = "services/runtime/src/private-filesystem-recovery-composition.ts";
const SCHEDULER = "packages/application/src/assets/private-asset-maintenance-scheduler.ts";
const MAINTENANCE = "services/runtime/src/private-asset-maintenance-composition.ts";
const API_ASSETS = "services/runtime/src/api-asset-composition.ts";
const API_PORTABLE = "services/runtime/src/api-portable-import-export-composition.ts";
const WORKER = "services/worker/src/worker.ts";
const CAPACITY_SOURCE_FILES = Object.freeze([
  "packages/database/src/config.ts",
  "services/worker/src/worker.ts",
  "compose.yaml",
  "deploy/swarm/stack.yaml",
]);

const PRIVATE_ENTRY_POINTS = Object.freeze([
  Object.freeze({ file: STORAGE, factory: "createAssetImportStorageComposition", consumers: Object.freeze([NORMALIZED, METADATA, RECOVERY, API_ASSETS]) }),
  Object.freeze({ file: NORMALIZED, factory: "createPrivateNormalizedAssetPublicationComposition", consumers: Object.freeze([ILLUSTRATION, PORTABLE_NORMALIZED, RECOVERY]) }),
  Object.freeze({ file: ILLUSTRATION, factory: "createPrivateIllustrationAssetPublicationComposition", consumers: Object.freeze([WORKER]) }),
  Object.freeze({ file: PORTABLE_NORMALIZED, factory: "createPrivatePortableNormalizedAssetPublicationComposition", consumers: Object.freeze([PORTABLE, RECOVERY]) }),
  Object.freeze({ file: PORTABLE, factory: "createPortableImportExportComposition", consumers: Object.freeze([API_PORTABLE]) }),
  Object.freeze({ file: METADATA, factory: "createPrivateAssetMetadataBackfillComposition", consumers: Object.freeze([MAINTENANCE]) }),
  Object.freeze({ file: RECOVERY, factory: "createPrivateFilesystemRecoveryComposition", consumers: Object.freeze([MAINTENANCE]) }),
  Object.freeze({ file: SCHEDULER, factory: "createPrivateAssetMaintenanceScheduler", consumers: Object.freeze([MAINTENANCE]) }),
  Object.freeze({ file: MAINTENANCE, factory: "createPrivateAssetMaintenanceComposition", consumers: Object.freeze([WORKER]) }),
]);

const LEGACY_RUNTIME_MODULES = new Set([
  "services/runtime/src/illustration-image-job-adapter.ts",
  "services/runtime/src/illustration-platform-adapter.ts",
  "services/runtime/src/illustration-platform-bindings.ts",
  "services/runtime/src/illustration-composition.ts",
]);
const LEGACY_API_MODULE = /services\/api\/src\/(?:asset-service|asset-archive-service|campaign-archive-service|import-service|infinite-worlds-import-service)\.ts$/u;
const LEGACY_WRITER = /^(?:writeContentAddressed|completePortImageJob|lockOriginalImages|persist[A-Za-z0-9_]*Image)$/u;
const PUBLIC_BARREL = /^(?:packages\/(?:application|contracts|domain)\/src(?:\/(?:assets|imports|illustration))?|services\/runtime\/src)/u;

function resolveModule(file, target, candidates) {
  if (typeof target !== "string" || !target.startsWith(".")) return target;
  const base = posix.normalize(posix.join(posix.dirname(file), target));
  if (/\.(?:cjs|cts|js|jsx|mjs|mts|tsx)$/u.test(base)) {
    return base.replace(/\.(?:cjs|cts|js|jsx|mjs|mts|tsx)$/u, ".ts");
  }
  // CommonJS and literal dynamic imports may omit their extension. Resolve
  // only a scanned exact module or directory-index candidate so a guessed
  // path cannot bypass the private-consumer inventory or create false edges.
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
    if (candidates?.has(candidate)) return candidate;
  }
  return base;
}

function moduleTarget(node) {
  if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type)) return node.source?.value;
  if (node.type === "ImportExpression") return node.source?.value;
  if (node.type === "CallExpression" && (node.callee?.type === "Import" || node.callee?.type === "Identifier" && node.callee.name === "require")) {
    return node.arguments?.[0]?.value;
  }
  return undefined;
}

function importedName(specifier) {
  if (specifier.type !== "ImportSpecifier") return null;
  return specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value;
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (["loc", "start", "end", "extra", "errors", "tokens", "comments"].includes(key)) continue;
    if (Array.isArray(value)) for (const child of value) walk(child, visit);
    else walk(value, visit);
  }
}

function isIdentifier(node, name) {
  return node?.type === "Identifier" && node.name === name;
}

function isLiteral(node, value) {
  return (node?.type === "StringLiteral" || node?.type === "NumericLiteral" || node?.type === "Literal")
    && node.value === value;
}

function isRoleCheck(node, role) {
  if (node?.type !== "BinaryExpression" || !["===", "=="].includes(node.operator)) return false;
  return isIdentifier(node.left, "roleValue") && isLiteral(node.right, role)
    || isLiteral(node.left, role) && isIdentifier(node.right, "roleValue");
}

function isGenerationCapacityFormula(node, increment) {
  return node?.type === "BinaryExpression"
    && node.operator === "+"
    && isIdentifier(node.left, "workerGenerationConcurrency")
    && isLiteral(node.right, increment);
}

function requiredWorkerCapacityEvidence(text) {
  let program;
  try {
    program = parseProductionSourceAst("packages/database/src/config.ts", text);
  } catch (error) {
    return Object.freeze({ worker: false, all: false, parseError: error.message });
  }
  let worker = false;
  let all = false;
  walk(program, (node) => {
    if (node.type !== "VariableDeclarator" || !isIdentifier(node.id, "requiredWorkerConnections")) return;
    const workerCondition = node.init;
    const allCondition = workerCondition?.alternate;
    if (workerCondition?.type === "ConditionalExpression"
      && isRoleCheck(workerCondition.test, "worker")
      && isGenerationCapacityFormula(workerCondition.consequent, 4)) {
      worker = true;
    }
    if (allCondition?.type === "ConditionalExpression"
      && isRoleCheck(allCondition.test, "all")
      && isGenerationCapacityFormula(allCondition.consequent, 8)) {
      all = true;
    }
  });
  return Object.freeze({ worker, all, parseError: null });
}

function withoutYamlComments(text) {
  return text.split(/\r?\n/u).map((line) => line.replace(/(^|\s)#.*$/u, "$1")).join("\n");
}

function manifestCapacityDefaults(text, role) {
  const commentFree = withoutYamlComments(text);
  const roleLine = new RegExp(`^\\s*APP_ROLE:\\s*${role}\\s*$`, "gmu");
  const matches = [...commentFree.matchAll(roleLine)];
  for (const match of matches) {
    const start = (match.index ?? 0) + match[0].length;
    const nextRole = commentFree.slice(start).search(/^\s*APP_ROLE:\s*[^\n]+$/mu);
    const block = commentFree.slice(start, nextRole < 0 ? undefined : start + nextRole);
    const defaultValue = (name) => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const value = block.match(new RegExp(`^\\s*${escaped}:\\s*\\$\\{${escaped}:-([0-9]+)\\}\\s*$`, "mu"));
      return value ? Number(value[1]) : null;
    };
    const databaseMaxConnections = defaultValue("DATABASE_MAX_CONNECTIONS");
    const workerGenerationConcurrency = defaultValue("WORKER_GENERATION_CONCURRENCY");
    if (databaseMaxConnections !== null && workerGenerationConcurrency !== null) {
      return Object.freeze({ databaseMaxConnections, workerGenerationConcurrency });
    }
  }
  return null;
}

function isPublicBarrel(file) {
  return PUBLIC_BARREL.test(file) && /\/index\.ts$/u.test(file);
}

function isPrivateContractModule(target) {
  return typeof target === "string" && /\/private-[^/]+\.ts$/u.test(target);
}

function moduleEdgeRecords(file, program, candidates) {
  const records = [];
  walk(program, (node) => {
    const target = moduleTarget(node);
    if (typeof target !== "string") return;
    const resolved = resolveModule(file, target, candidates);
    const kind = node.type;
    const names = node.type === "ImportDeclaration"
      ? node.specifiers.filter((specifier) => specifier.type === "ImportSpecifier" && specifier.importKind !== "type")
        .map((specifier) => ({ imported: importedName(specifier), local: specifier.local.name }))
      : [];
    records.push(Object.freeze({ file, node, target: resolved, kind, names: Object.freeze(names) }));
  });
  return records;
}

/** Reads only production TypeScript/JavaScript sources for the executable e8 inventory. */
export function readPrivateCompositionParitySources(root) {
  const source = [];
  const visit = (relative) => {
    const absolute = join(root, relative);
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = posix.join(relative.replaceAll("\\", "/"), entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && SOURCE_EXTENSION.test(entry.name) && isPrivateStorageInventorySource(child)) {
        source.push(Object.freeze({ file: child, text: readFileSync(join(root, child), "utf8") }));
      }
    }
  };
  for (const rootDirectory of ["apps", "packages", "services"]) visit(rootDirectory);
  return Object.freeze(source);
}

/** Reads the four capacity-contract sources whose text is part of the e8 budget. */
export function readPrivateCompositionCapacitySources(root) {
  return Object.freeze(CAPACITY_SOURCE_FILES.map((file) => Object.freeze({
    file,
    text: readFileSync(join(root, file), "utf8"),
  })));
}

/** Freezes the worker pool budget while ensuring private maintenance stays out of deployment manifests. */
export function collectPrivateCompositionCapacityViolations(sources) {
  const byFile = new Map(sources.map((source) => [source.file.replaceAll("\\", "/"), source.text]));
  const violations = new Set();
  const config = byFile.get("packages/database/src/config.ts");
  const worker = byFile.get("services/worker/src/worker.ts");
  if (!config) violations.add("packages/database/src/config.ts: required worker capacity source is missing");
  else {
    const evidence = requiredWorkerCapacityEvidence(config);
    if (evidence.parseError) violations.add(`packages/database/src/config.ts: required worker capacity AST must parse: ${evidence.parseError}`);
    if (!evidence.worker) violations.add("packages/database/src/config.ts: worker pool budget must remain executable generation + 4");
    if (!evidence.all) violations.add("packages/database/src/config.ts: all-process pool budget must remain executable generation + 8");
  }
  if (!worker) violations.add("services/worker/src/worker.ts: required live worker source is missing");
  const manifestRequirements = Object.freeze([
    Object.freeze({ file: "compose.yaml", role: "all", increment: 8, description: "all-process" }),
    Object.freeze({ file: "deploy/swarm/stack.yaml", role: "worker", increment: 4, description: "worker" }),
  ]);
  for (const manifest of manifestRequirements) {
    const text = byFile.get(manifest.file);
    if (!text) violations.add(`${manifest.file}: required deployment capacity source is missing`);
    else if (/createPrivateAssetMaintenance(?:Composition|Scheduler)|private-asset-maintenance/u.test(withoutYamlComments(text))) {
      violations.add(`${manifest.file}: e8 private maintenance must not enter a deployment manifest`);
    } else {
      const defaults = manifestCapacityDefaults(text, manifest.role);
      if (!defaults || defaults.databaseMaxConnections < defaults.workerGenerationConcurrency + manifest.increment) {
        violations.add(`${manifest.file}: ${manifest.description} manifest capacity must remain executable generation + ${manifest.increment} or greater`);
      }
    }
  }
  return [...violations].sort();
}

/**
 * Executable e3g boundary inventory. Each private capability has one reviewed
 * production composition consumer; additions require a plan change rather
 * than silently becoming reachable through a directory.
 */
export function collectPrivateCompositionParityViolations(sources) {
  const parsed = new Map();
  const violations = new Set();
  for (const source of sources) {
    const file = source.file.replaceAll("\\", "/");
    if (!isPrivateStorageInventorySource(file)) continue;
    try {
      parsed.set(file, parseProductionSourceAst(file, source.text));
    } catch (error) {
      violations.add(`${file}: private composition parity AST parse failed: ${error.message}`);
    }
  }

  const sourceCandidates = new Set(parsed.keys());
  const edges = new Map([...parsed].map(([file, program]) => [file, moduleEdgeRecords(file, program, sourceCandidates)]));
  for (const entry of PRIVATE_ENTRY_POINTS) {
    if (!parsed.has(entry.file)) violations.add(`${entry.file}: required private e8 entry point is missing`);
    else if (!new RegExp(`\\b(?:async\\s+)?function\\s+${entry.factory}\\b`, "u").test(sources.find((source) => source.file.replaceAll("\\", "/") === entry.file)?.text ?? "")) {
      violations.add(`${entry.file}: required private e8 factory ${entry.factory} is missing`);
    }

    const inbound = [...edges.values()].flat().filter((edge) => edge.target === entry.file);
    for (const edge of inbound) {
      if (!entry.consumers.includes(edge.file)) {
        violations.add(`${edge.file}: ${entry.factory} must not bypass its named e3g composition consumer`);
        continue;
      }
      const exactFactoryImport = edge.kind === "ImportDeclaration"
        && edge.names.length === 1
        && edge.names[0]?.imported === entry.factory
        && edge.names[0]?.local === entry.factory;
      if (!exactFactoryImport) violations.add(`${edge.file}: ${entry.factory} requires its exact named private consumer import`);
    }
    for (const consumer of entry.consumers) {
      const matching = inbound.filter((edge) => edge.file === consumer && edge.kind === "ImportDeclaration"
        && edge.names.length === 1 && edge.names[0]?.imported === entry.factory && edge.names[0]?.local === entry.factory);
      if (matching.length !== 1) violations.add(`${entry.factory}: expected exactly one private consumer in ${consumer}`);
    }
  }

  for (const [file, records] of edges) {
    if (!isPublicBarrel(file)) continue;
    for (const edge of records) {
      if (isPrivateContractModule(edge.target)) violations.add(`${file}: private contract must not escape through a public barrel`);
    }
  }

  const roots = PRIVATE_ENTRY_POINTS.map((entry) => entry.file);
  for (const root of roots) {
    const seen = new Set();
    const queue = [root];
    while (queue.length > 0) {
      const file = queue.shift();
      if (!file || seen.has(file)) continue;
      seen.add(file);
      const program = parsed.get(file);
      if (!program) continue;
      for (const edge of edges.get(file) ?? []) {
        if (edge.target.startsWith("services/api/src/")) violations.add(`${root}: private replacement graph must not reach services/api/src via ${edge.target}`);
        if (edge.target.startsWith("services/worker/src/") || edge.target === "services/runtime/src/main.ts") violations.add(`${root}: private replacement graph must not reach a live worker/runtime binding via ${edge.target}`);
        if (LEGACY_API_MODULE.test(edge.target) || LEGACY_RUNTIME_MODULES.has(edge.target)) violations.add(`${root}: private replacement graph must not reach legacy writer authority via ${edge.target}`);
        if (parsed.has(edge.target) && !seen.has(edge.target)) queue.push(edge.target);
      }
      walk(program, (node) => {
        if (node.type === "Identifier" && LEGACY_WRITER.test(node.name)) {
          violations.add(`${file}:${node.loc?.start.line ?? 1}: private replacement graph prohibits legacy writer ${node.name}`);
        }
        if (node.type === "CallExpression"
          && node.callee?.type === "Identifier"
          && node.callee.name === "createDatabasePool") {
          violations.add(`${file}:${node.callee.loc?.start.line ?? 1}: private replacement graph must not create an additional database pool`);
        }
      });
    }
  }
  return [...violations].sort();
}
