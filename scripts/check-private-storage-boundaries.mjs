import { parse } from "@babel/parser";
import { posix } from "node:path";

const PRODUCTION_SOURCE = /^(?:apps|packages|services)\//u;
const JAVASCRIPT_TYPESCRIPT_SOURCE = /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u;
const STORAGE_COMPOSITION_FILE = "services/runtime/src/asset-import-composition.ts";
const STORAGE_COMPOSITION_FACTORY = "createAssetImportStorageComposition";
const ASSET_PUBLICATION_COMPOSITION_FACTORY = "createAssetPublicationComposition";
const PORTABLE_COMPOSITION_FILE = "services/runtime/src/portable-import-export-composition.ts";
const NORMALIZED_PUBLICATION_REPOSITORY_FILE = "packages/database/src/normalized-asset-publication-repository.ts";
const NORMALIZED_PUBLICATION_COMPOSITION_FILE = "services/runtime/src/normalized-asset-publication-composition.ts";
const NORMALIZED_PUBLICATION_COMPOSITION_FACTORY = "createPrivateNormalizedAssetPublicationComposition";
const NORMALIZED_PUBLICATION_CONTRACT_FILE = "packages/application/src/assets/private-normalized-asset-publication.ts";
const PORTABLE_NORMALIZED_PUBLICATION_REPOSITORY_FILE = "packages/database/src/portable-normalized-asset-publication-repository.ts";
const PORTABLE_NORMALIZED_PUBLICATION_REPOSITORY_FACTORY = "createPostgresPortableNormalizedAssetPublicationRepository";
const PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FILE = "services/runtime/src/portable-normalized-asset-publication-composition.ts";
const PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FACTORY = "createPrivatePortableNormalizedAssetPublicationComposition";
const PORTABLE_NORMALIZED_PUBLICATION_CONTRACT_FILE = "packages/application/src/imports/private-normalized-portable-publication.ts";
const ILLUSTRATION_PUBLICATION_REPOSITORY_FILE = "packages/database/src/illustration-asset-publication-repository.ts";
const ILLUSTRATION_PUBLICATION_COMPOSITION_FILE = "services/runtime/src/illustration-asset-publication-composition.ts";
const ILLUSTRATION_PUBLICATION_COMPOSITION_FACTORY = "createPrivateIllustrationAssetPublicationComposition";
const ILLUSTRATION_PUBLICATION_CONTRACT_FILE = "packages/application/src/illustration/private-illustration-asset-publication.ts";
const ILLUSTRATION_LEGACY_RUNTIME_FILES = new Set([
  "services/runtime/src/illustration-image-job-adapter.ts",
  "services/runtime/src/illustration-platform-adapter.ts",
  "services/runtime/src/illustration-platform-bindings.ts",
  "services/runtime/src/illustration-composition.ts"
]);
const ILLUSTRATION_LEGACY_WRITER_IDENTIFIERS = new Set([
  "persistTurnImage",
  "persistWorldCover",
  "lockOriginalImages",
  "completePortImageJob"
]);
const PORTABLE_NORMALIZED_LEGACY_AUTHORITY_FILES = new Set([
  STORAGE_COMPOSITION_FILE,
  "packages/application/src/imports/private-portable-composition.ts"
]);
const PORTABLE_NORMALIZED_LEGACY_WRITER_IDENTIFIERS = new Set([
  ASSET_PUBLICATION_COMPOSITION_FACTORY,
  "PrivateCallerTransactionAssetPublisher",
  "PrivateImportedAssetAttachment",
  "PrivateReservedImportedAsset",
  "transactionalPublisher",
  "writeContentAddressed",
  "reserveImportedAssets",
  "reserveImportedAssetsInTransaction",
  "attachImportedAssets",
  "discardPreparedImportedAssets",
  "recoverImportedAssets",
  "finalizeImportedAssets"
]);
const API_FILESYSTEM_COMPATIBILITY_FILE = "services/api/src/portable-archive-filesystem-adapter.ts";
const NEUTRAL_FILESYSTEM_ADAPTER_FILE = "services/runtime/src/secure-filesystem-adapter.ts";
const CONCRETE_STORAGE_FACTORIES = new Map([
  ["createPostgresDurableFilesystemRepository", "packages/database/src/durable-filesystem-repository.ts"],
  ["createPostgresAssetPublicationRepository", "packages/database/src/asset-publication-repository.ts"],
  ["createPostgresSecureStorageRepository", "packages/database/src/secure-storage-repository.ts"],
  ["createPostgresImportRepository", "packages/database/src/import-repository.ts"],
  ["createPostgresFinalizedAssetDeliveryRepository", "packages/database/src/finalized-asset-delivery-repository.ts"],
  ["createSecureFilesystemAdapter", NEUTRAL_FILESYSTEM_ADAPTER_FILE]
]);

export function isPrivateStorageInventorySource(file) {
  const normalized = file.replaceAll("\\", "/");
  return PRODUCTION_SOURCE.test(normalized) && JAVASCRIPT_TYPESCRIPT_SOURCE.test(normalized);
}

const RETIRED_IDENTIFIERS = new Set([
  "PrivateFilesystemCapabilityPersistencePort",
  "PrivateFilesystemDeliveryGrantPersistencePort",
  "PrivateStorageLocatorRedemptionPort",
  "DatabaseIssuedStorageLocator",
  "createPostgresAssetStorageLocatorRedemptionRepository"
]);
const RETIRED_MEMBER_NAMES = new Set([
  "issueDeliveryGrant",
  "redeemDeliveryGrant",
  "redeemStorageLocator"
]);

function lineNumber(node) {
  return node.loc?.start.line ?? 1;
}

export function parseProductionSourceAst(file, text) {
  const languagePlugins = /\.(?:cts|mts|ts)$/u.test(file)
    ? ["typescript"]
    : /\.(?:tsx)$/u.test(file)
      ? ["typescript", "jsx"]
      : ["jsx"];
  return parse(text, {
    sourceType: "unambiguous",
    sourceFilename: file,
    errorRecovery: true,
    plugins: [...languagePlugins, "importAttributes"]
  }).program;
}

function importedName(specifier) {
  if (specifier.type !== "ImportSpecifier") return null;
  return specifier.imported.type === "Identifier"
    ? specifier.imported.name
    : specifier.imported.value;
}

function resolvedModule(file, target) {
  if (typeof target !== "string" || !target.startsWith(".")) return target;
  return posix.normalize(posix.join(posix.dirname(file), target))
    .replace(/\.(?:cjs|js|mjs)$/u, ".ts");
}

function concreteFactoryForTarget(file, target) {
  const resolved = resolvedModule(file, target);
  return [...CONCRETE_STORAGE_FACTORIES.entries()]
    .find(([, definition]) => definition === resolved)?.[0] ?? null;
}

function targetsStorageComposition(file, target) {
  return resolvedModule(file, target) === STORAGE_COMPOSITION_FILE;
}

function targetsNormalizedPublicationRepository(file, target) {
  return resolvedModule(file, target) === NORMALIZED_PUBLICATION_REPOSITORY_FILE;
}

function targetsNormalizedPublicationComposition(file, target) {
  return resolvedModule(file, target) === NORMALIZED_PUBLICATION_COMPOSITION_FILE;
}

function targetsNormalizedPublicationContract(file, target) {
  return resolvedModule(file, target) === NORMALIZED_PUBLICATION_CONTRACT_FILE;
}

function targetsPortableNormalizedPublicationRepository(file, target) {
  return resolvedModule(file, target) === PORTABLE_NORMALIZED_PUBLICATION_REPOSITORY_FILE;
}

function targetsPortableNormalizedPublicationComposition(file, target) {
  return resolvedModule(file, target) === PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FILE;
}

function targetsPortableNormalizedPublicationContract(file, target) {
  return resolvedModule(file, target) === PORTABLE_NORMALIZED_PUBLICATION_CONTRACT_FILE;
}

function targetsIllustrationPublicationComposition(file, target) {
  return resolvedModule(file, target) === ILLUSTRATION_PUBLICATION_COMPOSITION_FILE;
}

function targetsIllustrationPublicationRepository(file, target) {
  return resolvedModule(file, target) === ILLUSTRATION_PUBLICATION_REPOSITORY_FILE;
}

function targetsIllustrationPublicationContract(file, target) {
  return resolvedModule(file, target) === ILLUSTRATION_PUBLICATION_CONTRACT_FILE;
}

function targetsApiFilesystemCompatibility(file, target) {
  return resolvedModule(file, target) === API_FILESYSTEM_COMPATIBILITY_FILE;
}

function trackedSymbolForTarget(file, target) {
  const factory = concreteFactoryForTarget(file, target);
  if (factory) return factory;
  if (targetsStorageComposition(file, target)) return STORAGE_COMPOSITION_FACTORY;
  if (targetsNormalizedPublicationComposition(file, target)) {
    return NORMALIZED_PUBLICATION_COMPOSITION_FACTORY;
  }
  if (targetsPortableNormalizedPublicationRepository(file, target)) {
    return PORTABLE_NORMALIZED_PUBLICATION_REPOSITORY_FACTORY;
  }
  if (targetsPortableNormalizedPublicationComposition(file, target)) {
    return PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FACTORY;
  }
  if (targetsIllustrationPublicationComposition(file, target)) {
    return ILLUSTRATION_PUBLICATION_COMPOSITION_FACTORY;
  }
  return null;
}

function isPrivateContractName(name) {
  return /^(?:Private|DurableFilesystem|FinalizedAssetDeliveryResolver|SecureFilesystem)/u.test(name);
}

function isApplicationPublicBarrel(target) {
  if (typeof target !== "string") return false;
  const normalized = target.replaceAll("\\", "/");
  return normalized === "@infinite-quest/application"
    || /packages\/application\/src\/(?:assets|illustration|imports)\/index\.(?:c?js|mjs|ts)$/u.test(normalized)
    || /application\/src\/(?:assets|illustration|imports)\/index\.(?:c?js|mjs|ts)$/u.test(normalized);
}

function isApplicationPublicBarrelFile(file) {
  return /^packages\/application\/src\/(?:index|(?:assets|illustration|imports)\/index)\.ts$/u.test(file);
}

function isCanonicalNormalizedCompositionImport(file, node) {
  if (![
    ILLUSTRATION_PUBLICATION_COMPOSITION_FILE,
    PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FILE
  ].includes(file) || node.type !== "ImportDeclaration") return false;
  const factoryImports = node.specifiers.filter((specifier) => (
    specifier.type === "ImportSpecifier"
    && importedName(specifier) === NORMALIZED_PUBLICATION_COMPOSITION_FACTORY
    && specifier.local.name === NORMALIZED_PUBLICATION_COMPOSITION_FACTORY
    && specifier.importKind !== "type"
  ));
  return factoryImports.length === 1
    && node.specifiers.every((specifier) => factoryImports.includes(specifier)
      || (specifier.type === "ImportSpecifier" && specifier.importKind === "type"));
}

function isCanonicalPortableNormalizedCompositionImport(file, node) {
  return file === PORTABLE_COMPOSITION_FILE
    && node.type === "ImportDeclaration"
    && node.specifiers.length === 1
    && node.specifiers[0]?.type === "ImportSpecifier"
    && importedName(node.specifiers[0]) === PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FACTORY
    && node.specifiers[0].local.name === PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FACTORY;
}

function isPortableNormalizedLegacyWriterIdentifier(name) {
  return PORTABLE_NORMALIZED_LEGACY_WRITER_IDENTIFIERS.has(name)
    || /^persist[A-Za-z0-9_]*Image$/u.test(name);
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

function isHistoricalStorageHelper(target) {
  if (typeof target !== "string") return false;
  const normalized = target.replaceAll("\\", "/");
  return normalized.includes("tests/helpers/")
    || normalized.includes("legacy-private-storage-lifecycle-contracts")
    || normalized.includes("legacy-portable-archive-filesystem-adapter")
    || normalized.includes("private-storage-lifecycle-fake");
}

function unwrapExpression(value) {
  let current = value;
  while (current && [
    "AwaitExpression",
    "ChainExpression",
    "TSAsExpression",
    "TSTypeAssertion",
    "TSNonNullExpression",
    "TSSatisfiesExpression",
    "ParenthesizedExpression"
  ].includes(current.type)) {
    current = current.expression;
  }
  return current;
}

function staticMember(node) {
  const member = unwrapExpression(node.property ?? node.key);
  if (!member) return null;
  if (!node.computed && member.type === "Identifier") {
    return { node: member, name: member.name };
  }
  if (node.computed && member.type === "StringLiteral") {
    return { node: member, name: member.value };
  }
  if (node.computed
    && member.type === "TemplateLiteral"
    && member.expressions.length === 0
    && member.quasis.length === 1) {
    return { node: member, name: member.quasis[0]?.value.cooked ?? member.quasis[0]?.value.raw };
  }
  return null;
}

export function checkPrivateStorageBoundaries(file, text) {
  const normalized = file.replaceAll("\\", "/");
  if (!isPrivateStorageInventorySource(normalized)) {
    return [];
  }
  let parsed;
  try {
    parsed = parseProductionSourceAst(normalized, text);
  } catch (error) {
    return [`${normalized}: private storage boundary AST parse failed: ${(error).message}`];
  }
  const violations = new Set();
  const add = (node, message) => {
    violations.add(`${normalized}:${lineNumber(node)}: ${message}`);
  };
  if (normalized === API_FILESYSTEM_COMPATIBILITY_FILE) {
    const only = parsed.body[0];
    if (parsed.body.length !== 1
      || only?.type !== "ExportAllDeclaration"
      || resolvedModule(normalized, only.source?.value) !== NEUTRAL_FILESYSTEM_ADAPTER_FILE) {
      add(only ?? parsed, `API filesystem compatibility module must be an exact re-export of ${NEUTRAL_FILESYSTEM_ADAPTER_FILE}`);
    }
  }
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (isHistoricalStorageHelper(moduleTarget(node))) {
      add(node, "production source must not import historical storage helpers");
    }
    if (targetsApiFilesystemCompatibility(normalized, moduleTarget(node))) {
      add(node, "production replacement code must not reach the API filesystem compatibility module");
    }
    if (targetsNormalizedPublicationRepository(normalized, moduleTarget(node))
      && normalized !== NORMALIZED_PUBLICATION_REPOSITORY_FILE
      && normalized !== NORMALIZED_PUBLICATION_COMPOSITION_FILE) {
      add(node, `private normalized publication repository may be consumed only by ${NORMALIZED_PUBLICATION_COMPOSITION_FILE}`);
    }
    if (targetsPortableNormalizedPublicationRepository(normalized, moduleTarget(node))
      && normalized !== PORTABLE_NORMALIZED_PUBLICATION_REPOSITORY_FILE
      && normalized !== PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FILE) {
      add(node, `private portable normalized publication repository may be consumed only by ${PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FILE}`);
    }
    if (targetsNormalizedPublicationComposition(normalized, moduleTarget(node))
      && normalized !== NORMALIZED_PUBLICATION_COMPOSITION_FILE
      && !isCanonicalNormalizedCompositionImport(normalized, node)) {
      add(node, `normalized publication seam may be consumed only by ${ILLUSTRATION_PUBLICATION_COMPOSITION_FILE} and ${PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FILE}`);
    }
    if (targetsPortableNormalizedPublicationComposition(normalized, moduleTarget(node))
      && normalized !== PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FILE
      && !isCanonicalPortableNormalizedCompositionImport(normalized, node)) {
      add(node, `portable normalized publication composition may be consumed only by ${PORTABLE_COMPOSITION_FILE}`);
    }
    if (targetsIllustrationPublicationRepository(normalized, moduleTarget(node))
      && normalized !== ILLUSTRATION_PUBLICATION_REPOSITORY_FILE
      && normalized !== ILLUSTRATION_PUBLICATION_COMPOSITION_FILE) {
      add(node, `private illustration publication repository may be consumed only by ${ILLUSTRATION_PUBLICATION_COMPOSITION_FILE}`);
    }
    if (targetsIllustrationPublicationComposition(normalized, moduleTarget(node))
      && normalized !== ILLUSTRATION_PUBLICATION_COMPOSITION_FILE) {
      add(node, "illustration publication composition must remain unbound from production consumers");
    }
    if (isApplicationPublicBarrelFile(normalized)
      && (targetsNormalizedPublicationContract(normalized, moduleTarget(node))
        || targetsPortableNormalizedPublicationContract(normalized, moduleTarget(node))
        || targetsIllustrationPublicationContract(normalized, moduleTarget(node)))) {
      add(node, "private publication contracts must not leak through an application public barrel");
    }
    if (normalized === PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FILE) {
      const target = moduleTarget(node);
      const resolvedTarget = resolvedModule(normalized, target);
      if (typeof resolvedTarget === "string"
        && (resolvedTarget.startsWith("services/api/src/")
          || PORTABLE_NORMALIZED_LEGACY_AUTHORITY_FILES.has(resolvedTarget))) {
        add(node, `portable normalized publication replacement must not reach legacy authority ${resolvedTarget}`);
      }
      if (node.type === "Identifier" && isPortableNormalizedLegacyWriterIdentifier(node.name)) {
        add(node, `portable normalized publication replacement prohibits legacy writer identifier ${node.name}`);
      }
      const portableMember = staticMember(node);
      if (["MemberExpression", "OptionalMemberExpression"].includes(node.type)
        && portableMember
        && isPortableNormalizedLegacyWriterIdentifier(portableMember.name)) {
        add(portableMember.node, `portable normalized publication replacement prohibits legacy writer member ${portableMember.name}`);
      }
    }
    if (node.type === "ImportDeclaration") {
      const target = node.source.value;
      const targetFactory = concreteFactoryForTarget(normalized, target);
      for (const specifier of node.specifiers) {
        const name = importedName(specifier);
        if (specifier.type === "ImportDefaultSpecifier" && targetFactory) {
          add(specifier, `concrete storage factory ${targetFactory} must use its canonical named import in ${STORAGE_COMPOSITION_FILE}`);
        }
        if (specifier.type === "ImportDefaultSpecifier"
          && targetsStorageComposition(normalized, target)
          && normalized !== STORAGE_COMPOSITION_FILE) {
          add(specifier, "storage composition may use only its canonical named import at the normalized publication checkpoint");
        }
        if (specifier.type === "ImportNamespaceSpecifier" && targetFactory
          && normalized !== STORAGE_COMPOSITION_FILE) {
          add(specifier, `concrete storage factory ${targetFactory} may not be exposed through a namespace import`);
        }
        if (specifier.type === "ImportNamespaceSpecifier"
          && targetsStorageComposition(normalized, target)
          && normalized !== STORAGE_COMPOSITION_FILE) {
          add(specifier, "storage composition may use only its canonical named import at the normalized publication checkpoint");
        }
        if (!name) continue;
        if (CONCRETE_STORAGE_FACTORIES.has(name)
          && normalized !== STORAGE_COMPOSITION_FILE
          && normalized !== CONCRETE_STORAGE_FACTORIES.get(name)) {
          add(specifier, `concrete storage factory ${name} may be consumed only by ${STORAGE_COMPOSITION_FILE}`);
        }
        if ([STORAGE_COMPOSITION_FACTORY, ASSET_PUBLICATION_COMPOSITION_FACTORY].includes(name)
          && normalized !== STORAGE_COMPOSITION_FILE
          && !(name === STORAGE_COMPOSITION_FACTORY && normalized === NORMALIZED_PUBLICATION_COMPOSITION_FILE)) {
          add(specifier, "private storage composition must remain unconsumed before its named later checkpoint");
        }
        if (name === PORTABLE_NORMALIZED_PUBLICATION_REPOSITORY_FACTORY
          && normalized !== PORTABLE_NORMALIZED_PUBLICATION_REPOSITORY_FILE
          && normalized !== PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FILE) {
          add(specifier, `private portable normalized publication repository may be consumed only by ${PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FILE}`);
        }
        if (name === PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FACTORY
          && normalized !== PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FILE
          && !isCanonicalPortableNormalizedCompositionImport(normalized, node)) {
          add(specifier, `portable normalized publication composition may be consumed only by ${PORTABLE_COMPOSITION_FILE}`);
        }
        if (isPrivateContractName(name) && isApplicationPublicBarrel(target)) {
          add(specifier, "private storage contracts must use their defining module, not a public barrel");
        }
      }
    }
    if (["ExportAllDeclaration", "ExportNamedDeclaration"].includes(node.type) && node.source) {
      const target = node.source.value;
      const targetFactory = concreteFactoryForTarget(normalized, target);
      const names = (node.specifiers ?? []).flatMap((specifier) => [
        specifier.local?.name ?? specifier.local?.value,
        specifier.exported?.name ?? specifier.exported?.value
      ]).filter(Boolean);
      const namespaceReexport = (node.specifiers ?? [])
        .some((specifier) => specifier.type === "ExportNamespaceSpecifier");
      const allowedApiCompatibility = normalized === API_FILESYSTEM_COMPATIBILITY_FILE
        && targetFactory === "createSecureFilesystemAdapter"
        && resolvedModule(normalized, target) === NEUTRAL_FILESYSTEM_ADAPTER_FILE;
      if (targetFactory && !allowedApiCompatibility
        && (node.type === "ExportAllDeclaration" || namespaceReexport || names.includes(targetFactory))) {
        add(node, `concrete storage factory ${targetFactory} must not be re-exported`);
      }
      if (targetsStorageComposition(normalized, target)
        && (node.type === "ExportAllDeclaration" || namespaceReexport
          || names.includes(STORAGE_COMPOSITION_FACTORY)
          || names.includes(ASSET_PUBLICATION_COMPOSITION_FACTORY))) {
        add(node, "private storage composition must remain unconsumed before its named later checkpoint");
      }
      if (targetsPortableNormalizedPublicationComposition(normalized, target)
        && (node.type === "ExportAllDeclaration" || namespaceReexport
          || names.includes(PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FACTORY))) {
        add(node, `portable normalized publication composition may be consumed only by ${PORTABLE_COMPOSITION_FILE}`);
      }
      if (isApplicationPublicBarrel(target) && names.some(isPrivateContractName)) {
        add(node, "private storage contracts must use their defining module, not a public barrel");
      }
    }
    if ((node.type === "ImportExpression"
      || (node.type === "CallExpression"
        && (node.callee?.type === "Import"
          || (node.callee?.type === "Identifier" && node.callee.name === "require"))))) {
      const target = moduleTarget(node);
      const targetFactory = concreteFactoryForTarget(normalized, target);
      if (targetFactory && normalized !== STORAGE_COMPOSITION_FILE) {
        add(node, `concrete storage factory ${targetFactory} may not be loaded through require or dynamic import`);
      }
      if (targetsStorageComposition(normalized, target) && normalized !== STORAGE_COMPOSITION_FILE) {
        add(node, "private storage composition must remain unconsumed before its named later checkpoint");
      }
      if (targetsNormalizedPublicationComposition(normalized, target)
        && normalized !== NORMALIZED_PUBLICATION_COMPOSITION_FILE
        && normalized !== ILLUSTRATION_PUBLICATION_COMPOSITION_FILE
        && normalized !== PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FILE) {
        add(node, `normalized publication seam may be consumed only by ${ILLUSTRATION_PUBLICATION_COMPOSITION_FILE} and ${PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FILE}`);
      }
      if (targetsPortableNormalizedPublicationComposition(normalized, target)
        && normalized !== PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FILE) {
        add(node, `portable normalized publication composition may be consumed only by ${PORTABLE_COMPOSITION_FILE}`);
      }
      if (targetsIllustrationPublicationComposition(normalized, target)
        && normalized !== ILLUSTRATION_PUBLICATION_COMPOSITION_FILE) {
        add(node, "illustration publication composition must remain unbound from production consumers");
      }
    }
    if (node.type === "Identifier" && RETIRED_IDENTIFIERS.has(node.name)) {
      add(node, `retired private storage seam identifier ${node.name} is prohibited`);
    }
    const member = staticMember(node);
    if (["MemberExpression", "OptionalMemberExpression"].includes(node.type) && member) {
      if (CONCRETE_STORAGE_FACTORIES.has(member.name)
        && normalized !== STORAGE_COMPOSITION_FILE
        && normalized !== CONCRETE_STORAGE_FACTORIES.get(member.name)) {
        add(member.node, `concrete storage factory ${member.name} may be consumed only by ${STORAGE_COMPOSITION_FILE}`);
      }
      if ([STORAGE_COMPOSITION_FACTORY, ASSET_PUBLICATION_COMPOSITION_FACTORY].includes(member.name)
        && normalized !== STORAGE_COMPOSITION_FILE
        && !(member.name === STORAGE_COMPOSITION_FACTORY && normalized === NORMALIZED_PUBLICATION_COMPOSITION_FILE)) {
        add(member.node, "private storage composition must remain unconsumed before its named later checkpoint");
      }
      if (member.name === PORTABLE_NORMALIZED_PUBLICATION_REPOSITORY_FACTORY
        && normalized !== PORTABLE_NORMALIZED_PUBLICATION_REPOSITORY_FILE
        && normalized !== PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FILE) {
        add(member.node, `private portable normalized publication repository may be consumed only by ${PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FILE}`);
      }
      if (member.name === PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FACTORY
        && normalized !== PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FILE
        && normalized !== PORTABLE_COMPOSITION_FILE) {
        add(member.node, `portable normalized publication composition may be consumed only by ${PORTABLE_COMPOSITION_FILE}`);
      }
    }
    if (["MemberExpression", "OptionalMemberExpression", "ObjectMethod", "ObjectProperty", "ClassMethod"].includes(node.type)
      && member
      && RETIRED_MEMBER_NAMES.has(member.name)) {
      add(member.node, `retired private storage member ${member.name} is prohibited`);
    }
    for (const [key, value] of Object.entries(node)) {
      if (["loc", "start", "end", "extra", "errors", "tokens", "comments"].includes(key)) continue;
      if (Array.isArray(value)) {
        for (const child of value) visit(child);
      } else {
        visit(value);
      }
    }
  };
  visit(parsed);
  return [...violations];
}

/** Repository-wide executable inventory for the additive Task 14e3b5 graph. */
export function checkAssetImportStorageCompositionInventory(sources) {
  const violations = [];
  const production = sources
    .map(({ file, text }) => ({ file: file.replaceAll("\\", "/"), text }))
    .filter(({ file }) => isPrivateStorageInventorySource(file));
  const parsed = new Map();
  for (const source of production) {
    try {
      parsed.set(source.file, parseProductionSourceAst(source.file, source.text));
    } catch (error) {
      violations.push(`${source.file}: storage composition inventory AST parse failed: ${error.message}`);
    }
  }
  const resolveInventoryModule = (file, target) => {
    const resolved = resolvedModule(file, target);
    if (parsed.has(resolved) || typeof target !== "string" || !target.startsWith(".")) {
      return resolved;
    }
    for (const candidate of [
      `${resolved}.ts`,
      `${resolved}.tsx`,
      `${resolved}.mts`,
      `${resolved}.cts`,
      `${resolved}/index.ts`,
      `${resolved}/index.tsx`,
      `${resolved}/index.mts`,
      `${resolved}/index.cts`
    ]) {
      if (parsed.has(candidate)) return candidate;
    }
    return resolved;
  };

  const definitions = new Map();
  const calls = new Map();
  const imports = new Map();
  const unsafeExposures = new Map();
  const moduleEdges = new Map();
  for (const name of [
    ...CONCRETE_STORAGE_FACTORIES.keys(),
    STORAGE_COMPOSITION_FACTORY,
    ASSET_PUBLICATION_COMPOSITION_FACTORY,
    NORMALIZED_PUBLICATION_COMPOSITION_FACTORY,
    PORTABLE_NORMALIZED_PUBLICATION_REPOSITORY_FACTORY,
    PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FACTORY,
    ILLUSTRATION_PUBLICATION_COMPOSITION_FACTORY
  ]) {
    definitions.set(name, []);
    calls.set(name, []);
    imports.set(name, []);
    unsafeExposures.set(name, []);
  }

  const walk = (node, inspect) => {
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
  };

  const addUnsafeExposure = (file, name, node, form) => {
    unsafeExposures.get(name).push(`${file}:${lineNumber(node)}: ${form}`);
  };

  for (const [file, program] of parsed) {
    const bindings = new Map();
    const moduleBindings = new Map();
    const moduleLoads = new Map();
    const targets = new Set();
    moduleEdges.set(file, targets);

    walk(program, (node) => {
      const target = moduleTarget(node);
      if (typeof target === "string") {
        targets.add(resolveInventoryModule(file, target));
      }
      if (node.type === "FunctionDeclaration" && node.id && definitions.has(node.id.name)) {
        definitions.get(node.id.name).push(file);
      }
      if (node.type === "ImportDeclaration") {
        const target = resolvedModule(file, node.source.value);
        const targetSymbol = trackedSymbolForTarget(file, node.source.value);
        for (const specifier of node.specifiers) {
          const name = importedName(specifier);
          if (name && imports.has(name)) {
            bindings.set(specifier.local.name, name);
            imports.get(name).push({ file, local: specifier.local.name, target });
          }
          if (specifier.type === "ImportNamespaceSpecifier" && targetSymbol) {
            moduleBindings.set(specifier.local.name, targetSymbol);
            addUnsafeExposure(file, targetSymbol, specifier, "namespace import");
          }
          if (specifier.type === "ImportDefaultSpecifier" && targetSymbol) {
            bindings.set(specifier.local.name, targetSymbol);
            addUnsafeExposure(file, targetSymbol, specifier, "default import");
          }
        }
      }
      if (["ExportAllDeclaration", "ExportNamedDeclaration"].includes(node.type) && node.source) {
        const targetSymbol = trackedSymbolForTarget(file, node.source.value);
        const namespaceReexport = (node.specifiers ?? [])
          .some((specifier) => specifier.type === "ExportNamespaceSpecifier");
        const allowedApiCompatibility = file === API_FILESYSTEM_COMPATIBILITY_FILE
          && targetSymbol === "createSecureFilesystemAdapter"
          && resolvedModule(file, node.source.value) === NEUTRAL_FILESYSTEM_ADAPTER_FILE;
        if (targetSymbol && !allowedApiCompatibility
          && (node.type === "ExportAllDeclaration" || namespaceReexport)) {
          addUnsafeExposure(file, targetSymbol, node, "export-all or namespace re-export");
        }
        for (const specifier of node.specifiers ?? []) {
          const name = specifier.local?.name ?? specifier.local?.value;
          if (name && imports.has(name)) {
            addUnsafeExposure(file, name, specifier, "named re-export");
          }
        }
      }
      if (node.type === "ImportExpression"
        || (node.type === "CallExpression"
          && (node.callee?.type === "Import"
            || (node.callee?.type === "Identifier" && node.callee.name === "require")))) {
        const targetSymbol = trackedSymbolForTarget(file, moduleTarget(node));
        if (targetSymbol) {
          moduleLoads.set(node, targetSymbol);
          addUnsafeExposure(file, targetSymbol, node, "require or dynamic import");
        }
      }
    });

    const symbolFromModuleExpression = (value) => {
      const expression = unwrapExpression(value);
      if (!expression) return null;
      if (moduleLoads.has(expression)) return moduleLoads.get(expression);
      if (expression.type === "Identifier") return moduleBindings.get(expression.name) ?? null;
      return null;
    };

    // Bind namespace aliases and destructured aliases before examining calls, so
    // source order cannot hide a tracked symbol from the inventory.
    let changed = true;
    while (changed) {
      changed = false;
      walk(program, (node) => {
        if (node.type !== "VariableDeclarator") return;
        const moduleSymbol = symbolFromModuleExpression(node.init);
        if (moduleSymbol && node.id.type === "Identifier" && !moduleBindings.has(node.id.name)) {
          moduleBindings.set(node.id.name, moduleSymbol);
          changed = true;
        }
        if (moduleSymbol && node.id.type === "ObjectPattern") {
          for (const property of node.id.properties) {
            if (property.type !== "ObjectProperty") continue;
            const member = staticMember(property);
            const local = unwrapExpression(property.value);
            if (member?.name === moduleSymbol && local?.type === "Identifier"
              && bindings.get(local.name) !== moduleSymbol) {
              bindings.set(local.name, moduleSymbol);
              changed = true;
            }
          }
        }
        const initializer = unwrapExpression(node.init);
        if (node.id.type === "Identifier"
          && initializer?.type === "Identifier"
          && bindings.has(initializer.name)
          && bindings.get(node.id.name) !== bindings.get(initializer.name)) {
          bindings.set(node.id.name, bindings.get(initializer.name));
          changed = true;
        }
      });
    }

    walk(program, (node) => {
      if (!["CallExpression", "OptionalCallExpression"].includes(node.type)) return;
      const callee = unwrapExpression(node.callee);
      let name = null;
      if (callee?.type === "Identifier") {
        name = bindings.get(callee.name) ?? (calls.has(callee.name) ? callee.name : null);
      } else if (["MemberExpression", "OptionalMemberExpression"].includes(callee?.type)) {
        const member = staticMember(callee);
        if (member && calls.has(member.name)) name = member.name;
      }
      if (name) calls.get(name).push(file);
    });

    walk(program, (node) => {
      if (node.type !== "ExportNamedDeclaration" || node.source) return;
      for (const specifier of node.specifiers ?? []) {
        const local = specifier.local?.name ?? specifier.local?.value;
        const name = bindings.get(local) ?? (imports.has(local) ? local : null);
        if (name) addUnsafeExposure(file, name, specifier, "local re-export");
      }
    });
  }

  const illustrationReplacementQueue = [ILLUSTRATION_PUBLICATION_COMPOSITION_FILE];
  const illustrationReplacementGraph = new Set();
  while (illustrationReplacementQueue.length > 0) {
    const file = illustrationReplacementQueue.shift();
    if (!file || illustrationReplacementGraph.has(file)) continue;
    illustrationReplacementGraph.add(file);
    for (const target of moduleEdges.get(file) ?? []) {
      if (target.startsWith("services/api/src/")) {
        violations.push(`${file}: illustration publication replacement graph must not reach services/api/src via ${target}`);
        continue;
      }
      if (ILLUSTRATION_LEGACY_RUNTIME_FILES.has(target)) {
        violations.push(`${file}: illustration publication replacement graph must not reach legacy runtime module ${target}`);
        continue;
      }
      if (parsed.has(target) && !illustrationReplacementGraph.has(target)) {
        illustrationReplacementQueue.push(target);
      }
    }
  }

  for (const file of illustrationReplacementGraph) {
    const program = parsed.get(file);
    if (!program) continue;
    walk(program, (node) => {
      if (node.type === "Identifier" && ILLUSTRATION_LEGACY_WRITER_IDENTIFIERS.has(node.name)) {
        violations.push(`${file}:${lineNumber(node)}: illustration publication replacement graph prohibits legacy writer identifier ${node.name}`);
      }
      const member = staticMember(node);
      if (["MemberExpression", "OptionalMemberExpression"].includes(node.type)
        && member
        && ILLUSTRATION_LEGACY_WRITER_IDENTIFIERS.has(member.name)) {
        violations.push(`${file}:${lineNumber(member.node)}: illustration publication replacement graph prohibits legacy writer member ${member.name}`);
      }
    });
  }

  // Treat the already-reviewed e2 normalized publication seam as a terminal
  // authority. The e4 graph may depend on that seam, but it must not gain a
  // parallel route to the retired 0060/API/legacy import writers.
  const portableReplacementQueue = [PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FILE];
  const portableReplacementGraph = new Set();
  while (portableReplacementQueue.length > 0) {
    const file = portableReplacementQueue.shift();
    if (!file || portableReplacementGraph.has(file)) continue;
    portableReplacementGraph.add(file);
    for (const target of moduleEdges.get(file) ?? []) {
      if (target.startsWith("services/api/src/")) {
        violations.push(`${file}: portable normalized publication replacement graph must not reach services/api/src via ${target}`);
        continue;
      }
      if (PORTABLE_NORMALIZED_LEGACY_AUTHORITY_FILES.has(target)) {
        violations.push(`${file}: portable normalized publication replacement graph must not reach legacy authority ${target}`);
        continue;
      }
      if (target === NORMALIZED_PUBLICATION_COMPOSITION_FILE) continue;
      if (parsed.has(target) && !portableReplacementGraph.has(target)) {
        portableReplacementQueue.push(target);
      }
    }
  }

  for (const file of portableReplacementGraph) {
    const program = parsed.get(file);
    if (!program) continue;
    walk(program, (node) => {
      if (node.type === "Identifier" && isPortableNormalizedLegacyWriterIdentifier(node.name)) {
        violations.push(`${file}:${lineNumber(node)}: portable normalized publication replacement graph prohibits legacy writer identifier ${node.name}`);
      }
      const member = staticMember(node);
      if (["MemberExpression", "OptionalMemberExpression"].includes(node.type)
        && member
        && isPortableNormalizedLegacyWriterIdentifier(member.name)) {
        violations.push(`${file}:${lineNumber(member.node)}: portable normalized publication replacement graph prohibits legacy writer member ${member.name}`);
      }
    });
  }

  for (const [name, definitionFile] of CONCRETE_STORAGE_FACTORIES) {
    const foundDefinitions = definitions.get(name);
    if (foundDefinitions.length !== 1 || foundDefinitions[0] !== definitionFile) {
      violations.push(`${name} must have exactly one definition in ${definitionFile}`);
    }
    const foundImports = imports.get(name);
    if (foundImports.length !== 1
      || foundImports[0].file !== STORAGE_COMPOSITION_FILE
      || foundImports[0].target !== definitionFile
      || foundImports[0].local !== name) {
      violations.push(`${name} must be imported directly and exactly once by ${STORAGE_COMPOSITION_FILE}`);
    }
    const foundCalls = calls.get(name);
    if (foundCalls.length !== 1 || foundCalls[0] !== STORAGE_COMPOSITION_FILE) {
      violations.push(`${name} must be called only once in ${STORAGE_COMPOSITION_FILE}`);
    }
    if (unsafeExposures.get(name).length !== 0) {
      violations.push(`${name} has prohibited module exposure: ${unsafeExposures.get(name).join(", ")}`);
    }
  }
  const compositionDefinitions = definitions.get(STORAGE_COMPOSITION_FACTORY);
  if (compositionDefinitions.length !== 1 || compositionDefinitions[0] !== STORAGE_COMPOSITION_FILE) {
    violations.push(`${STORAGE_COMPOSITION_FACTORY} must be defined exactly once in ${STORAGE_COMPOSITION_FILE}`);
  }
  const compositionImports = imports.get(STORAGE_COMPOSITION_FACTORY);
  const compositionCalls = calls.get(STORAGE_COMPOSITION_FACTORY);
  if (compositionImports.length !== 1
    || compositionImports[0].file !== NORMALIZED_PUBLICATION_COMPOSITION_FILE
    || compositionImports[0].target !== STORAGE_COMPOSITION_FILE
    || compositionImports[0].local !== STORAGE_COMPOSITION_FACTORY
    || unsafeExposures.get(STORAGE_COMPOSITION_FACTORY).length !== 0
    || compositionCalls.filter((file) => file !== STORAGE_COMPOSITION_FILE).length !== 1
    || !compositionCalls.includes(NORMALIZED_PUBLICATION_COMPOSITION_FILE)) {
    violations.push(`${STORAGE_COMPOSITION_FACTORY} must be consumed directly and exactly once by ${NORMALIZED_PUBLICATION_COMPOSITION_FILE}`);
  }
  const assetPublicationCompositionDefinitions = definitions.get(ASSET_PUBLICATION_COMPOSITION_FACTORY);
  if (assetPublicationCompositionDefinitions.length !== 1
    || assetPublicationCompositionDefinitions[0] !== STORAGE_COMPOSITION_FILE) {
    violations.push(`${ASSET_PUBLICATION_COMPOSITION_FACTORY} must be defined exactly once in ${STORAGE_COMPOSITION_FILE}`);
  }
  const publicationImports = imports.get(ASSET_PUBLICATION_COMPOSITION_FACTORY);
  const publicationCalls = calls.get(ASSET_PUBLICATION_COMPOSITION_FACTORY);
  if (publicationImports.length !== 0
    || publicationCalls.length !== 0
    || unsafeExposures.get(ASSET_PUBLICATION_COMPOSITION_FACTORY).length !== 0) {
    violations.push(`${ASSET_PUBLICATION_COMPOSITION_FACTORY} must remain unconsumed by production replacement code`);
  }
  const normalizedDefinitions = definitions.get(NORMALIZED_PUBLICATION_COMPOSITION_FACTORY);
  const normalizedImports = imports.get(NORMALIZED_PUBLICATION_COMPOSITION_FACTORY);
  const normalizedCalls = calls.get(NORMALIZED_PUBLICATION_COMPOSITION_FACTORY);
  if (normalizedDefinitions.length !== 1
    || normalizedDefinitions[0] !== NORMALIZED_PUBLICATION_COMPOSITION_FILE) {
    violations.push(`${NORMALIZED_PUBLICATION_COMPOSITION_FACTORY} must be defined exactly once in ${NORMALIZED_PUBLICATION_COMPOSITION_FILE}`);
  }
  const normalizedConsumers = [
    ILLUSTRATION_PUBLICATION_COMPOSITION_FILE,
    PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FILE
  ];
  if (normalizedImports.length !== normalizedConsumers.length
    || normalizedConsumers.some((consumer) => !normalizedImports.some((entry) => (
      entry.file === consumer
      && entry.target === NORMALIZED_PUBLICATION_COMPOSITION_FILE
      && entry.local === NORMALIZED_PUBLICATION_COMPOSITION_FACTORY
    )))
    || normalizedCalls.length !== normalizedConsumers.length
    || normalizedConsumers.some((consumer) => !normalizedCalls.includes(consumer))
    || unsafeExposures.get(NORMALIZED_PUBLICATION_COMPOSITION_FACTORY).length !== 0) {
    violations.push(`${NORMALIZED_PUBLICATION_COMPOSITION_FACTORY} must be consumed directly and exactly once by each named private publication composition`);
  }
  const portableRepositoryDefinitions = definitions.get(PORTABLE_NORMALIZED_PUBLICATION_REPOSITORY_FACTORY);
  const portableRepositoryImports = imports.get(PORTABLE_NORMALIZED_PUBLICATION_REPOSITORY_FACTORY);
  const portableRepositoryCalls = calls.get(PORTABLE_NORMALIZED_PUBLICATION_REPOSITORY_FACTORY);
  if (portableRepositoryDefinitions.length !== 1
    || portableRepositoryDefinitions[0] !== PORTABLE_NORMALIZED_PUBLICATION_REPOSITORY_FILE) {
    violations.push(`${PORTABLE_NORMALIZED_PUBLICATION_REPOSITORY_FACTORY} must be defined exactly once in ${PORTABLE_NORMALIZED_PUBLICATION_REPOSITORY_FILE}`);
  }
  if (portableRepositoryImports.length !== 1
    || portableRepositoryImports[0].file !== PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FILE
    || portableRepositoryImports[0].target !== PORTABLE_NORMALIZED_PUBLICATION_REPOSITORY_FILE
    || portableRepositoryImports[0].local !== PORTABLE_NORMALIZED_PUBLICATION_REPOSITORY_FACTORY
    || portableRepositoryCalls.length !== 1
    || portableRepositoryCalls[0] !== PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FILE
    || unsafeExposures.get(PORTABLE_NORMALIZED_PUBLICATION_REPOSITORY_FACTORY).length !== 0) {
    violations.push(`${PORTABLE_NORMALIZED_PUBLICATION_REPOSITORY_FACTORY} must be consumed directly and exactly once by ${PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FILE}`);
  }
  const portableCompositionDefinitions = definitions.get(PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FACTORY);
  const portableCompositionImports = imports.get(PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FACTORY);
  const portableCompositionCalls = calls.get(PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FACTORY);
  const portableCompositionInboundEdges = [...moduleEdges.entries()]
    .filter(([file, targets]) => file !== PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FILE
      && targets.has(PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FILE))
    .map(([file]) => file);
  if (portableCompositionDefinitions.length !== 1
    || portableCompositionDefinitions[0] !== PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FILE) {
    violations.push(`${PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FACTORY} must be defined exactly once in ${PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FILE}`);
  }
  if (portableCompositionImports.length !== 1
    || portableCompositionImports[0].file !== PORTABLE_COMPOSITION_FILE
    || portableCompositionImports[0].target !== PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FILE
    || portableCompositionImports[0].local !== PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FACTORY
    || portableCompositionCalls.length !== 1
    || portableCompositionCalls[0] !== PORTABLE_COMPOSITION_FILE
    || portableCompositionInboundEdges.length !== 1
    || portableCompositionInboundEdges[0] !== PORTABLE_COMPOSITION_FILE
    || unsafeExposures.get(PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FACTORY).length !== 0) {
    violations.push(`${PORTABLE_NORMALIZED_PUBLICATION_COMPOSITION_FACTORY} must be consumed directly and exactly once by ${PORTABLE_COMPOSITION_FILE}`);
  }
  const illustrationDefinitions = definitions.get(ILLUSTRATION_PUBLICATION_COMPOSITION_FACTORY);
  const illustrationImports = imports.get(ILLUSTRATION_PUBLICATION_COMPOSITION_FACTORY);
  const illustrationCalls = calls.get(ILLUSTRATION_PUBLICATION_COMPOSITION_FACTORY);
  const illustrationInboundEdges = [...moduleEdges.entries()]
    .filter(([file, targets]) => file !== ILLUSTRATION_PUBLICATION_COMPOSITION_FILE
      && targets.has(ILLUSTRATION_PUBLICATION_COMPOSITION_FILE))
    .map(([file]) => file);
  if (illustrationDefinitions.length !== 1
    || illustrationDefinitions[0] !== ILLUSTRATION_PUBLICATION_COMPOSITION_FILE) {
    violations.push(`${ILLUSTRATION_PUBLICATION_COMPOSITION_FACTORY} must be defined exactly once in ${ILLUSTRATION_PUBLICATION_COMPOSITION_FILE}`);
  }
  if (illustrationImports.length !== 0
    || illustrationCalls.length !== 0
    || illustrationInboundEdges.length !== 0
    || unsafeExposures.get(ILLUSTRATION_PUBLICATION_COMPOSITION_FACTORY).length !== 0) {
    violations.push(`${ILLUSTRATION_PUBLICATION_COMPOSITION_FACTORY} must remain unbound from production consumers`);
  }
  return violations;
}
