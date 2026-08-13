import { parse } from "@babel/parser";

const LIVE_BINDING_FILES = Object.freeze([
  "services/api/src/server.ts",
  "services/api/src/archive-routes.ts",
  "services/worker/src/worker.ts",
  "services/runtime/src/main.ts",
  "services/runtime/src/runtime-role.ts",
  "services/runtime/src/illustration-composition.ts",
  "services/runtime/src/illustration-platform-adapter.ts",
  "services/runtime/src/illustration-platform-bindings.ts",
]);

const REQUIRED_IMPORTS = Object.freeze({
  "services/api/src/server.ts": Object.freeze([
    "./asset-service.js",
    "./import-service.js",
    "./infinite-worlds-import-service.js",
    "./archive-routes.js",
  ]),
  "services/api/src/archive-routes.ts": Object.freeze([
    "./campaign-archive-service.js",
    "./import-service.js",
  ]),
  "services/worker/src/worker.ts": Object.freeze([
    "../../api/src/asset-service.js",
  ]),
});

const PRIVATE_COMPOSITION_FACTORY = /^create(?:Private[A-Za-z0-9]*|AssetImportStorage|PortableImportExport)Composition$/u;
const PRIVATE_COMPOSITION_MODULE = /(?:^|\/)private-[^/]+|(?:^|\/)(?:asset-import|portable-import-export)-composition(?:\.js)?$/u;

function program(file, text) {
  try {
    return parse(text, {
      sourceType: "module",
      plugins: ["typescript", "importAttributes", "dynamicImport"],
    });
  } catch (error) {
    return { error: `${file}: production boundary AST must parse: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function importedModules(ast) {
  return new Set(ast.program.body
    .filter((node) => node.type === "ImportDeclaration")
    .map((node) => node.source.value)
    .filter((value) => typeof value === "string"));
}

function identifierExists(ast, name) {
  let found = false;
  const visit = (node) => {
    if (!node || typeof node !== "object" || found) return;
    if (node.type === "Identifier" && node.name === name) {
      found = true;
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (["loc", "start", "end", "extra", "comments", "tokens"].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(visit);
      else visit(value);
    }
  };
  visit(ast);
  return found;
}

function privateCompositionReferenceExists(ast) {
  let found = false;
  const visit = (node) => {
    if (!node || typeof node !== "object" || found) return;
    if (node.type === "Identifier" && PRIVATE_COMPOSITION_FACTORY.test(node.name)) {
      found = true;
      return;
    }
    if (node.type === "StringLiteral" && PRIVATE_COMPOSITION_MODULE.test(node.value)) {
      found = true;
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (["loc", "start", "end", "extra", "comments", "tokens"].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(visit);
      else visit(value);
    }
  };
  visit(ast);
  return found;
}

function liveWorkerLaneNames(ast) {
  let names = null;
  const visit = (node) => {
    if (!node || typeof node !== "object" || names) return;
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && node.id.name === "lanes"
      && node.init?.type === "ArrayExpression") {
      names = node.init.elements.flatMap((element) => {
        if (element?.type !== "ObjectExpression") return [];
        const name = element.properties.find((property) => property.type === "ObjectProperty"
          && property.key?.type === "Identifier" && property.key.name === "name");
        return name?.value?.type === "StringLiteral" ? [name.value.value] : [];
      });
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (["loc", "start", "end", "extra", "comments", "tokens"].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(visit);
      else visit(value);
    }
  };
  visit(ast);
  return names;
}

/**
 * Verifies that production bindings are still legacy-only before Task 14e3g.
 * Input is supplied by tests so hostile graphs can prove the guard rejects a
 * live private-composition import instead of merely matching today's source.
 */
export function collectProductionComposedParityViolations(sources) {
  const byFile = new Map(sources.map((source) => [source.file.replaceAll("\\", "/"), source.text]));
  const violations = new Set();

  for (const file of LIVE_BINDING_FILES) {
    const text = byFile.get(file);
    if (typeof text !== "string") {
      violations.add(`${file}: required live binding source is missing`);
      continue;
    }
    const ast = program(file, text);
    if ("error" in ast) {
      violations.add(ast.error);
      continue;
    }
    if (privateCompositionReferenceExists(ast)) {
      violations.add(`${file}: private composition factory must not enter a live binding before e3g`);
    }
    const expected = REQUIRED_IMPORTS[file] ?? [];
    const imports = importedModules(ast);
    for (const module of expected) {
      if (!imports.has(module)) {
        violations.add(`${file}: required active legacy import is missing: ${module}`);
      }
    }
    if (file === "services/worker/src/worker.ts" && !identifierExists(ast, "runAssetMetadataBackfill")) {
      violations.add("services/worker/src/worker.ts: active worker asset lane must retain runAssetMetadataBackfill until e3g");
    }
    if (file === "services/worker/src/worker.ts") {
      const lanes = liveWorkerLaneNames(ast);
      if (!lanes || lanes.length !== 3 || new Set(lanes).size !== 3
        || !["illustration", "chronicle", "asset"].every((name) => lanes.includes(name))) {
        violations.add("services/worker/src/worker.ts: active worker lanes must remain exactly illustration, chronicle, and asset until e3g");
      }
    }
  }
  return [...violations].sort();
}
