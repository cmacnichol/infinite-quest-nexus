import { parse } from "@babel/parser";

const PRODUCTION_SOURCE = /^(?:apps|packages|services)\//u;
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

function staticMember(node) {
  const unwrap = (value) => {
    let current = value;
    while (current && [
      "TSAsExpression",
      "TSTypeAssertion",
      "TSNonNullExpression",
      "TSSatisfiesExpression",
      "ParenthesizedExpression"
    ].includes(current.type)) {
      current = current.expression;
    }
    return current;
  };
  const member = unwrap(node.property ?? node.key);
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
  if (!PRODUCTION_SOURCE.test(normalized) || !/\.(?:cjs|js|jsx|mjs|mts|ts|tsx)$/u.test(normalized)) {
    return [];
  }
  const languagePlugins = /\.(?:ts|mts)$/u.test(normalized)
    ? ["typescript"]
    : /\.(?:tsx)$/u.test(normalized)
      ? ["typescript", "jsx"]
      : ["jsx"];
  let syntaxTree;
  try {
    syntaxTree = parse(text, {
      sourceType: "unambiguous",
      sourceFilename: normalized,
      errorRecovery: true,
      plugins: [...languagePlugins, "importAttributes"]
    });
  } catch (error) {
    return [`${normalized}: private storage boundary AST parse failed: ${(error).message}`];
  }
  const violations = new Set();
  const add = (node, message) => {
    violations.add(`${normalized}:${lineNumber(node)}: ${message}`);
  };
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (isHistoricalStorageHelper(moduleTarget(node))) {
      add(node, "production source must not import historical storage helpers");
    }
    if (node.type === "Identifier" && RETIRED_IDENTIFIERS.has(node.name)) {
      add(node, `retired private storage seam identifier ${node.name} is prohibited`);
    }
    const member = staticMember(node);
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
  visit(syntaxTree.program);
  return [...violations];
}
