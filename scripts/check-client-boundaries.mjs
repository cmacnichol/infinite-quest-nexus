import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API } from "typescript/unstable/sync";
import * as ts from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";

const SOURCE_FILE_PATTERN = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
const CLIENT_CORE_GLOBALS = new Set([
  "AbortController",
  "Buffer",
  "Date",
  "EventSource",
  "WebSocket",
  "XMLHttpRequest",
  "__dirname",
  "__filename",
  "clearInterval",
  "clearTimeout",
  "crypto",
  "document",
  "fetch",
  "indexedDB",
  "localStorage",
  "module",
  "navigator",
  "performance",
  "process",
  "require",
  "sessionStorage",
  "setInterval",
  "setTimeout",
  "window"
]);
const FRAMEWORK_IMPORT_PATTERN = /^(?:@angular\/|@solidjs\/|@sveltejs\/|@vue\/|lit(?:\/|$)|next(?:\/|$)|preact(?:\/|$)|react(?:\/|$)|react-dom(?:\/|$)|solid-js(?:\/|$)|svelte(?:\/|$)|vue(?:\/|$))/u;
const DOM_MANIPULATION_METHODS = new Set([
  "after",
  "append",
  "appendChild",
  "before",
  "createElement",
  "createTextNode",
  "insertAdjacentElement",
  "insertAdjacentHTML",
  "insertAdjacentText",
  "prepend",
  "remove",
  "removeChild",
  "replaceChild",
  "replaceChildren",
  "replaceWith"
]);
const DOM_PROPERTY_WRITES = new Set(["className", "innerHTML", "innerText", "outerHTML", "textContent"]);
const APPLICATION_PLATFORM_LIBRARIES = new Set([
  "dom",
  "dom.asynciterable",
  "dom.iterable",
  "scripthost",
  "webworker",
  "webworker.asynciterable",
  "webworker.importscripts",
  "webworker.iterable"
]);
const ASSIGNMENT_OPERATOR_KINDS = new Set([
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.SlashEqualsToken
]);

// These worker imports predate packages/application. Each exception is narrow
// and names the work package that removes it; new cross-role imports fail.
const CROSS_ROLE_IMPORT_ALLOWLIST = new Map();

export function crossRoleImportAllowlistCount() {
  return CROSS_ROLE_IMPORT_ALLOWLIST.size;
}

function normalizedPath(file) {
  return file.replaceAll("\\", "/");
}

function relativeModulePath(file, specifier) {
  if (!specifier.startsWith(".")) return null;
  return path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
}

function relativeReferencePath(file, reference) {
  const normalizedReference = reference.replaceAll("\\", "/");
  if (normalizedReference.startsWith("/") || /^[A-Za-z]:\//u.test(normalizedReference)) return null;
  return path.posix.normalize(path.posix.join(path.posix.dirname(file), normalizedReference));
}

function resolvedImportedFile(file, specifier, sourceFiles) {
  const target = relativeModulePath(file, specifier);
  if (target === null) return null;

  const extension = path.posix.extname(target);
  const withoutExtension = extension ? target.slice(0, -extension.length) : target;
  const candidates = [target];
  if (extension === ".js" || extension === ".jsx") candidates.push(`${withoutExtension}.ts`, `${withoutExtension}.tsx`);
  if (extension === ".mjs") candidates.push(`${withoutExtension}.mts`);
  if (extension === ".cjs") candidates.push(`${withoutExtension}.cts`);
  if (!extension) {
    candidates.push(
      `${target}.ts`,
      `${target}.tsx`,
      `${target}.mts`,
      `${target}.cts`,
      `${target}/index.ts`,
      `${target}/index.tsx`,
      `${target}/index.mts`,
      `${target}/index.cts`
    );
  }
  return candidates.find((candidate) => sourceFiles.has(candidate)) ?? null;
}

function moduleSpecifierText(node) {
  const literal = ts.isLiteralTypeNode(node) ? node.literal : node;
  return ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal) ? literal.text : null;
}

function importedModules(sourceFile) {
  const modules = [];

  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const specifier = moduleSpecifierText(node.moduleSpecifier);
      if (specifier !== null) modules.push(specifier);
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const specifier = moduleSpecifierText(node.moduleReference.expression);
      if (specifier !== null) modules.push(specifier);
    }
    if (ts.isImportTypeNode(node)) {
      const specifier = moduleSpecifierText(node.argument);
      if (specifier !== null) modules.push(specifier);
    }
    const isDynamicImport = ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const isCanonicalRequire = ts.isCallExpression(node)
      && node.arguments.length === 1
      && ts.isIdentifier(node.expression)
      && node.expression.text === "require";
    if ((isDynamicImport || isCanonicalRequire) && node.arguments.length > 0) {
      const specifier = moduleSpecifierText(node.arguments[0]);
      if (specifier !== null) modules.push(specifier);
    }
    node.forEachChild(visit);
  }

  visit(sourceFile);
  return [...new Set(modules)];
}

function isClientCoreImportAllowed(file, specifier) {
  if (specifier === "@infinite-quest/contracts") return true;
  const target = relativeModulePath(file, specifier);
  return target !== null && target.startsWith("packages/client-core/");
}

function isClientWebImportAllowed(file, specifier) {
  if (specifier === "@infinite-quest/client-core" || specifier === "@infinite-quest/contracts" || specifier === "zod") return true;
  const target = relativeModulePath(file, specifier);
  return target !== null && (target.startsWith("packages/client-web/") || target.startsWith("packages/client-core/"));
}

function isApplicationImportAllowed(file, specifier) {
  if (specifier === "@infinite-quest/contracts") return true;
  const target = relativeModulePath(file, specifier);
  return target !== null && target.startsWith("packages/application/");
}

function checkClientCore(file, sourceFile, violations) {
  for (const specifier of importedModules(sourceFile)) {
    if (specifier.startsWith("node:")) {
      violations.push(`${file}: client-core import ${specifier} is prohibited`);
    } else if (FRAMEWORK_IMPORT_PATTERN.test(specifier)) {
      violations.push(`${file}: client-core import ${specifier} is a prohibited framework dependency`);
    } else if (!isClientCoreImportAllowed(file, specifier)) {
      violations.push(`${file}: client-core import ${specifier} is outside client-core or contracts`);
    }
  }

  function visit(node) {
    if (ts.isIdentifier(node) && CLIENT_CORE_GLOBALS.has(node.text)) {
      violations.push(`${file}: client-core must not use platform global ${node.text}`);
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Math" && node.name.text === "random") {
      violations.push(`${file}: client-core must not use random-ID dependency Math.random`);
    }
    node.forEachChild(visit);
  }

  visit(sourceFile);
}

function checkClientWeb(file, sourceFile, violations) {
  for (const specifier of importedModules(sourceFile)) {
    if (FRAMEWORK_IMPORT_PATTERN.test(specifier)) {
      violations.push(`${file}: client-web import ${specifier} is a prohibited framework dependency`);
    } else if (!isClientWebImportAllowed(file, specifier)) {
      violations.push(`${file}: client-web import ${specifier} is outside client-web, client-core, or contracts`);
    }
  }

  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && DOM_MANIPULATION_METHODS.has(node.expression.name.text)) {
      violations.push(`${file}: client-web must not manipulate rendered DOM via ${node.expression.name.text}`);
    }
    if (ts.isBinaryExpression(node) && ASSIGNMENT_OPERATOR_KINDS.has(node.operatorToken.kind) && ts.isPropertyAccessExpression(node.left) && DOM_PROPERTY_WRITES.has(node.left.name.text)) {
      violations.push(`${file}: client-web must not manipulate rendered DOM property ${node.left.name.text}`);
    }
    node.forEachChild(visit);
  }

  visit(sourceFile);
}

function checkApplication(file, sourceFile, violations) {
  for (const specifier of importedModules(sourceFile)) {
    if (specifier.startsWith("node:")) {
      violations.push(`${file}: application import ${specifier} is prohibited`);
    } else if (!isApplicationImportAllowed(file, specifier)) {
      violations.push(`${file}: application import ${specifier} is outside packages/application or contracts`);
    }
  }

  for (const reference of sourceFile.typeReferenceDirectives) {
    violations.push(`${file}: application reference types ${reference.fileName} is prohibited`);
  }
  for (const reference of sourceFile.libReferenceDirectives) {
    if (APPLICATION_PLATFORM_LIBRARIES.has(reference.fileName.toLowerCase())) {
      violations.push(`${file}: application reference lib ${reference.fileName} is prohibited`);
    }
  }
  for (const reference of sourceFile.referencedFiles) {
    const target = relativeReferencePath(file, reference.fileName);
    if (target === null || !target.startsWith("packages/application/")) {
      violations.push(`${file}: application reference path ${reference.fileName} is outside packages/application`);
    }
  }

  function visit(node) {
    const isDynamicImport = ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const isCanonicalRequire = ts.isCallExpression(node)
      && node.arguments.length === 1
      && ts.isIdentifier(node.expression)
      && node.expression.text === "require";
    if (isDynamicImport || isCanonicalRequire) {
      const specifier = node.arguments.length > 0 ? moduleSpecifierText(node.arguments[0]) : null;
      if (specifier === null) {
        const kind = isDynamicImport ? "dynamic import" : "require";
        violations.push(`${file}: application ${kind} specifier must be a string literal`);
      }
    }
    node.forEachChild(visit);
  }

  visit(sourceFile);
}

function checkCrossRoleImports(file, sourceFile, violations) {
  const sourceRole = file.startsWith("services/api/") ? "api" : file.startsWith("services/worker/") ? "worker" : null;
  if (!sourceRole) return;

  for (const specifier of importedModules(sourceFile)) {
    const target = relativeModulePath(file, specifier);
    const targetRole = target?.startsWith("services/api/") ? "api" : target?.startsWith("services/worker/") ? "worker" : null;
    if (!targetRole || targetRole === sourceRole) continue;

    const allowlistKey = `${file} -> ${target}`;
    if (!CROSS_ROLE_IMPORT_ALLOWLIST.has(allowlistKey)) {
      violations.push(`${file}: cross-role import ${specifier} from ${sourceRole} to ${targetRole} is prohibited`);
    }
  }
}

function checkContractsPublicGraph(sourceFiles, violations) {
  const publicIndex = "packages/contracts/src/index.ts";
  if (!sourceFiles.has(publicIndex)) return;

  const visited = new Set();
  const pending = [publicIndex];
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || visited.has(file)) continue;
    visited.add(file);

    const sourceFile = sourceFiles.get(file);
    if (!sourceFile) continue;
    for (const specifier of importedModules(sourceFile)) {
      if (specifier.startsWith("node:")) {
        violations.push(`${file}: contracts public barrel reaches prohibited Node dependency ${specifier}`);
      } else if (FRAMEWORK_IMPORT_PATTERN.test(specifier)) {
        violations.push(`${file}: contracts public barrel reaches prohibited framework dependency ${specifier}`);
      }

      const target = resolvedImportedFile(file, specifier, sourceFiles);
      if (target !== null && !visited.has(target)) pending.push(target);
    }
  }
}

export function collectClientBoundaryViolations(entries) {
  const violations = [];
  const sortedEntries = [...entries]
    .map((entry) => ({ ...entry, file: normalizedPath(entry.file) }))
    .sort((left, right) => left.file.localeCompare(right.file));
  const virtualRoot = "/client-boundary-check";
  const virtualConfig = `${virtualRoot}/tsconfig.json`;
  const virtualFiles = Object.fromEntries(sortedEntries.map((entry) => [
    path.posix.join(virtualRoot, entry.file),
    entry.text
  ]));
  virtualFiles[virtualConfig] = JSON.stringify({
    compilerOptions: { allowJs: true, noLib: true },
    files: sortedEntries.map((entry) => path.posix.join(virtualRoot, entry.file))
  });
  const api = new API({
    cwd: virtualRoot,
    fs: createVirtualFileSystem(virtualFiles)
  });
  const snapshot = api.updateSnapshot({ openProjects: [virtualConfig] });
  const project = snapshot.getProject(virtualConfig);
  const sourceFiles = new Map();

  for (const entry of sortedEntries) {
    const file = entry.file;
    const sourceFile = project?.program.getSourceFile(path.posix.join(virtualRoot, file));
    if (!sourceFile) throw new Error(`TypeScript parser did not load ${file}`);
    sourceFiles.set(file, sourceFile);
    if (file.startsWith("packages/client-core/")) checkClientCore(file, sourceFile, violations);
    if (file.startsWith("packages/client-web/")) checkClientWeb(file, sourceFile, violations);
    if (file.startsWith("packages/application/src/")) checkApplication(file, sourceFile, violations);
    checkCrossRoleImports(file, sourceFile, violations);
  }

  checkContractsPublicGraph(sourceFiles, violations);

  api.close();
  return violations.sort();
}

export function isBoundarySourceFile(file) {
  return SOURCE_FILE_PATTERN.test(file);
}

function repositoryEntries(rootDirectory) {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: rootDirectory, encoding: "utf8" }
  );

  return [...new Set(output.split(/\r?\n/u).filter(isBoundarySourceFile))]
    .filter((file) => existsSync(path.join(rootDirectory, file)))
    .map((file) => ({
      file,
      text: readFileSync(path.join(rootDirectory, file), "utf8")
    }));
}

export function checkClientBoundaries(rootDirectory = process.cwd()) {
  return collectClientBoundaryViolations(repositoryEntries(rootDirectory));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = checkClientBoundaries();
  if (violations.length > 0) {
    process.stderr.write("Client boundary check failed:\n");
    for (const violation of violations) process.stderr.write(`- ${violation}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("Client boundary check passed.\n");
  }
}
