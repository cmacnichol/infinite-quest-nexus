import { posix } from "node:path";
import {
  isPrivateStorageInventorySource,
  parseProductionSourceAst,
} from "./check-private-storage-boundaries.mjs";

const MAINTENANCE_COMPOSITION = "services/runtime/src/private-asset-maintenance-composition.ts";
const MAINTENANCE_SCHEDULER = "packages/application/src/assets/private-asset-maintenance-scheduler.ts";
const E3G_MAINTENANCE_CONSUMER = "services/worker/src/worker.ts";
const LEGACY_BACKFILL = "runAssetMetadataBackfill";
const CREATE_DATABASE_POOL = "createDatabasePool";

function resolveModule(file, target) {
  if (typeof target !== "string" || !target.startsWith(".")) return target;
  return posix.normalize(posix.join(posix.dirname(file), target))
    .replace(/\.(?:cjs|js|mjs)$/u, ".ts");
}

function moduleTarget(node) {
  if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type)) {
    return node.source?.value;
  }
  if (node.type === "ImportExpression") return node.source?.value;
  if (node.type === "CallExpression"
    && (node.callee?.type === "Import"
      || (node.callee?.type === "Identifier" && node.callee.name === "require"))) {
    return node.arguments?.[0]?.value;
  }
  return undefined;
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (["loc", "start", "end", "extra", "errors", "tokens", "comments"].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit);
    } else {
      walk(value, visit);
    }
  }
}

/**
 * Executable Task 14e3e7/e3g graph guard. Its only authority is the private
 * e5/e6 graph, and only the named worker composition root may consume it.
 */
export function checkPrivateAssetMaintenanceBoundaries(sources) {
  const normalized = new Map();
  const violations = [];
  for (const source of sources) {
    const file = source.file.replaceAll("\\", "/");
    if (!isPrivateStorageInventorySource(file)) continue;
    try {
      normalized.set(file, {
        file,
        program: parseProductionSourceAst(file, source.text),
      });
    } catch (error) {
      violations.push(`${file}: asset-maintenance boundary AST parse failed: ${error.message}`);
    }
  }
  if (!normalized.has(MAINTENANCE_COMPOSITION)) {
    violations.push(`${MAINTENANCE_COMPOSITION}: required private asset-maintenance runtime composition is missing`);
  }
  if (!normalized.has(MAINTENANCE_SCHEDULER)) {
    violations.push(`${MAINTENANCE_SCHEDULER}: required private asset-maintenance scheduler contract is missing`);
  }

  const edges = new Map();
  for (const { file, program } of normalized.values()) {
    const targets = new Set();
    walk(program, (node) => {
      const target = moduleTarget(node);
      if (typeof target === "string") targets.add(resolveModule(file, target));
    });
    edges.set(file, targets);
  }

  for (const [file, targets] of edges) {
    if (file !== MAINTENANCE_COMPOSITION
      && file !== E3G_MAINTENANCE_CONSUMER
      && targets.has(MAINTENANCE_COMPOSITION)) {
      violations.push(`${file}: private asset-maintenance composition may be consumed only by ${E3G_MAINTENANCE_CONSUMER}`);
    }
    if (file !== MAINTENANCE_COMPOSITION && targets.has(MAINTENANCE_SCHEDULER)) {
      violations.push(`${file}: private asset-maintenance scheduler may be consumed only by the named private runtime composition`);
    }
  }

  const graph = new Set();
  const queue = [MAINTENANCE_COMPOSITION];
  while (queue.length > 0) {
    const file = queue.shift();
    if (!file || graph.has(file)) continue;
    graph.add(file);
    for (const target of edges.get(file) ?? []) {
      if (target.startsWith("services/api/src/")) {
        violations.push(`${file}: private asset-maintenance graph must not reach services/api/src via ${target}`);
        continue;
      }
      if (target.startsWith("services/worker/src/") || target === "services/runtime/src/main.ts") {
        violations.push(`${file}: private asset-maintenance graph must not reach a live role binding via ${target}`);
        continue;
      }
      if (normalized.has(target) && !graph.has(target)) queue.push(target);
    }
  }

  for (const file of graph) {
    const program = normalized.get(file)?.program;
    if (!program) continue;
    walk(program, (node) => {
      if (node.type === "Identifier" && node.name === LEGACY_BACKFILL) {
        violations.push(`${file}:${node.loc?.start.line ?? 1}: private asset-maintenance graph must not select ${LEGACY_BACKFILL}`);
      }
      if (node.type === "CallExpression"
        && node.callee?.type === "Identifier"
        && node.callee.name === CREATE_DATABASE_POOL) {
        violations.push(`${file}:${node.callee.loc?.start.line ?? 1}: private asset-maintenance graph must not create an additional database pool`);
      }
    });
  }
  return [...new Set(violations)];
}
