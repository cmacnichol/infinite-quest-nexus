import { posix } from "node:path";
import {
  isPrivateStorageInventorySource,
  parseProductionSourceAst,
} from "./check-private-storage-boundaries.mjs";
import { readPrivateCompositionParitySources } from "./check-private-composition-parity-boundaries.mjs";

const RETIRED_API_AUTHORITIES = new Set([
  "services/api/src/asset-service.ts",
  "services/api/src/asset-archive-service.ts",
  "services/api/src/campaign-archive-service.ts",
  "services/api/src/import-service.ts",
  "services/api/src/infinite-worlds-import-service.ts",
  "services/api/src/service-helpers.ts",
]);

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

export function readLegacyAuthoritySources(root) {
  return readPrivateCompositionParitySources(root);
}

/**
 * Task 14e3h executable inventory. Retired API services must be absent and no
 * production module may keep a static, dynamic, re-export, or require edge to
 * their former paths. Historical pre-cutover oracles belong under tests/ only.
 */
export function checkLegacyAuthorityRemoval(sources) {
  const violations = [];
  for (const source of sources) {
    const file = source.file.replaceAll("\\", "/");
    if (RETIRED_API_AUTHORITIES.has(file)) {
      violations.push(`${file}: retired API authority must be deleted from the production tree`);
      continue;
    }
    if (!isPrivateStorageInventorySource(file)) continue;
    let program;
    try {
      program = parseProductionSourceAst(file, source.text);
    } catch (error) {
      violations.push(`${file}: legacy-authority inventory AST parse failed: ${error.message}`);
      continue;
    }
    walk(program, (node) => {
      const target = moduleTarget(node);
      if (typeof target !== "string") return;
      const resolved = resolveModule(file, target);
      if (RETIRED_API_AUTHORITIES.has(resolved)) {
        violations.push(`${file}:${node.loc?.start.line ?? 1}: production import reaches retired authority ${resolved}`);
      }
    });
  }
  return [...new Set(violations)].sort();
}
