import { posix } from "node:path";
import {
  isPrivateStorageInventorySource,
  parseProductionSourceAst,
} from "./check-private-storage-boundaries.mjs";

const COMPOSITION = "services/runtime/src/portable-import-export-composition.ts";
const COMPOSITION_FACTORY = "createPortableImportExportComposition";
const PRIVATE_CONTRACT = "packages/application/src/imports/private-portable-composition.ts";
const PUBLIC_BARREL = "packages/application/src/imports/index.ts";
const FORBIDDEN_COMPOSITION_NAMES = new Map([
  ["activeProgressMap", "process-local import progress is forbidden"],
  ["PortableArchiveDownloadView", "buffered production archive views are forbidden"],
  ["downloadPortableExport", "buffered production export helpers are forbidden"],
]);
const RAW_PATH_NAMES = new Set(["relativePath", "storagePath", "rawPath"]);
const LEGACY_AUTHORITY_MODULES = new Map([
  ["import-service", "legacy import service authority is forbidden"],
  ["campaign-archive-service", "legacy campaign archive authority is forbidden"],
  ["infinite-worlds-import-service", "legacy Infinite Worlds authority is forbidden"],
]);

function lineNumber(node) {
  return node.loc?.start.line ?? 1;
}

function unwrapExpression(value) {
  let current = value;
  while (current && [
    "AwaitExpression",
    "ChainExpression",
    "ParenthesizedExpression",
    "TSAsExpression",
    "TSNonNullExpression",
    "TSSatisfiesExpression",
    "TSTypeAssertion",
  ].includes(current.type)) {
    current = current.expression;
  }
  return current;
}

function staticName(node) {
  const value = unwrapExpression(node?.property ?? node?.key);
  if (!value) return null;
  if (!node.computed && value.type === "Identifier") return value.name;
  if (node.computed && value.type === "StringLiteral") return value.value;
  if (node.computed && value.type === "TemplateLiteral"
    && value.expressions.length === 0 && value.quasis.length === 1) {
    return value.quasis[0]?.value.cooked ?? value.quasis[0]?.value.raw ?? null;
  }
  return null;
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

function resolvedModule(file, target) {
  if (typeof target !== "string" || !target.startsWith(".")) return target;
  return posix.normalize(posix.join(posix.dirname(file), target))
    .replace(/\.(?:cjs|cts|js|mjs|mts)$/u, ".ts");
}

function targets(file, target, expected) {
  return resolvedModule(file, target) === expected;
}

function legacyAuthorityMessage(target) {
  if (typeof target !== "string") return null;
  const basename = posix.basename(target.replaceAll("\\", "/")).replace(/\.(?:cjs|cts|js|mjs|mts|ts)$/u, "");
  return LEGACY_AUTHORITY_MODULES.get(basename) ?? null;
}

function walk(node, inspect) {
  if (!node || typeof node !== "object") return;
  inspect(node);
  for (const [key, value] of Object.entries(node)) {
    if (["loc", "start", "end", "extra", "errors", "tokens", "comments"].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const child of value) walk(child, inspect);
    } else {
      walk(value, inspect);
    }
  }
}

function parsedSource(file, text, label) {
  try {
    return { program: parseProductionSourceAst(file, text), violation: null };
  } catch (error) {
    return { program: null, violation: `${file}: ${label} AST parse failed: ${error.message}` };
  }
}

export function checkPortableCompositionBoundaries(file, text) {
  const normalized = file.replaceAll("\\", "/");
  if (!isPrivateStorageInventorySource(normalized)) return [];
  const parsed = parsedSource(normalized, text, "portable composition boundary");
  if (!parsed.program) return [parsed.violation];
  const violations = new Set();
  const add = (node, message) => violations.add(`${normalized}:${lineNumber(node)}: ${message}`);

  walk(parsed.program, (node) => {
    const target = moduleTarget(node);
    if (normalized === COMPOSITION) {
      const legacy = legacyAuthorityMessage(target);
      if (legacy) add(node, legacy);
      if (node.type === "Identifier" && FORBIDDEN_COMPOSITION_NAMES.has(node.name)) {
        add(node, FORBIDDEN_COMPOSITION_NAMES.get(node.name));
      }
      const memberName = staticName(node);
      if (memberName && FORBIDDEN_COMPOSITION_NAMES.has(memberName)) {
        add(node, FORBIDDEN_COMPOSITION_NAMES.get(memberName));
      }
    }
    if (normalized !== COMPOSITION && targets(normalized, target, COMPOSITION)) {
      add(node, "Task 14e3d composition must remain unconsumed until the binding checkpoint");
    }
    if (normalized === PUBLIC_BARREL && targets(normalized, target, PRIVATE_CONTRACT)) {
      add(node, "private portable composition must not enter the public imports barrel");
    }
    if (normalized === PRIVATE_CONTRACT) {
      if (node.type === "Identifier" && RAW_PATH_NAMES.has(node.name)) {
        add(node, "private composition surface must not expose raw filesystem paths");
      }
      const memberName = staticName(node);
      if (memberName && RAW_PATH_NAMES.has(memberName)) {
        add(node, "private composition surface must not expose raw filesystem paths");
      }
    }
  });
  return [...violations];
}

/** Repository-wide AST inventory for the private Task 14e3d composition. */
export function checkPortableCompositionInventory(sources) {
  const violations = [];
  const parsed = new Map();
  for (const source of sources
    .map(({ file, text }) => ({ file: file.replaceAll("\\", "/"), text }))
    .filter(({ file }) => isPrivateStorageInventorySource(file))) {
    const result = parsedSource(source.file, source.text, "portable composition inventory");
    if (!result.program) violations.push(result.violation);
    else parsed.set(source.file, result.program);
  }

  const definitions = [];
  for (const [file, program] of parsed) {
    walk(program, (node) => {
      if (node.type === "FunctionDeclaration" && node.id?.name === COMPOSITION_FACTORY) {
        definitions.push(`${file}:${lineNumber(node)}`);
      }
      const target = moduleTarget(node);
      if (file !== COMPOSITION && targets(file, target, COMPOSITION)) {
        violations.push(`${file}:${lineNumber(node)}: ${COMPOSITION_FACTORY} must remain unconsumed until the binding checkpoint`);
      }
      const memberName = staticName(node);
      if (file !== COMPOSITION
        && ["MemberExpression", "OptionalMemberExpression"].includes(node.type)
        && memberName === COMPOSITION_FACTORY) {
        violations.push(`${file}:${lineNumber(node)}: computed or namespace access to ${COMPOSITION_FACTORY} is prohibited`);
      }
    });
  }
  if (definitions.length !== 1 || !definitions[0]?.startsWith(`${COMPOSITION}:`)) {
    violations.push(`${COMPOSITION}: ${COMPOSITION_FACTORY} must have exactly one canonical production definition`);
  }
  return [...new Set(violations)];
}
