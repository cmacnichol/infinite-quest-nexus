import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { checkClientBoundaries } from "./check-client-boundaries.mjs";

const output = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" },
);
const files = [...new Set(output.split(/\r?\n/u).filter(Boolean))].sort();
const violations = [];

// The root client is retained as a historical artifact, but is never shipped or
// exercised by the application. Compatibility code is limited to explicit data
// migration boundaries; it does not permit loading or serving the historical UI.
const HISTORICAL_CLIENT_ALLOWLIST = new Set(["index.html"]);
const LEGACY_MIGRATION_ALLOWLIST = [
  "apps/web/public/nexus.js",
  "packages/contracts/src/imports.ts",
  "packages/domain/src/infinite-worlds.ts",
  "services/api/src/archive-routes.ts",
  "services/api/src/import-service.ts",
  "services/api/src/infinite-worlds-import-service.ts",
  "services/api/src/server.ts"
];

const RETIRED_WORLD_CAMPAIGN_AUTHORITY = [
  "services/api/src/campaign-state-service.ts",
  "services/api/src/campaign-transfer-service.ts",
  "services/api/src/character-profile-service.ts",
  "services/api/src/dashboard-service.ts",
  "services/api/src/generation-service.ts",
  "services/api/src/user-service.ts",
  "services/api/src/world-generation-progress-service.ts",
  "services/api/src/world-generator-service.ts",
  "services/api/src/world-service.ts"
];
const REQUIRED_WORLD_CAMPAIGN_BOUNDARIES = [
  "packages/database/src/play-loop-read-repository.ts"
];
const RETIRED_PROVIDER_AUTHORITY = [
  "services/api/src/provider-service.ts",
  "services/api/src/prompt-library-service.ts",
  "services/api/src/turn-intent-service.ts",
  "services/api/src/cost-service.ts",
  "services/api/src/task-14d-character-profile-organizer-bridge.ts",
  "services/api/src/task-14d-world-generation-bridge.ts"
];

const codeExtension = /\.(?:cjs|html|js|mjs|ts)$/u;
const activeCode = /^(?:apps|packages|services)\//u;
const runtimeConfiguration = /^(?:Dockerfile|compose(?:\.[^/]+)?\.ya?ml|\.env\.example|deploy\/.*\.ya?ml|apps\/|packages\/|services\/)/u;
const consoleWrite = /\bconsole\s*\.\s*(?:debug|error|info|log|trace|warn)\s*\(/u;
const historicalRuntimeReference = /\blegacyIndex(?:Path|Cache)?\b|\bLEGACY_INDEX_PATH\b|(?:COPY|ADD)\s+(?:\.\/)?index\.html\b|\/app\/index\.html\b|\b(?:readFile|resolve)\s*\(\s*["']index\.html["']/u;
const legacyMigrationMarker = /infiniteQuestNexusClientState\.v1|\/imports\/legacy-story|\bLegacyStory\b|\blegacyStorySchema\b/u;

const browserNetworkAllowlist = new Map([
  ["apps/web/public/image-library-browser.js", new Set(["fetch(path,"])],
  ["apps/web/public/nexus.js", new Set(["fetch(path,"])],
  ["apps/web/public/story.js", new Set(["fetch(url,"])]
]);

function normalizedText(file) {
  try {
    return readFileSync(file, "utf8").replaceAll("\r\n", "\n");
  } catch {
    return null;
  }
}

function lineNumber(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

function checkBrowserNetworkCalls(file, text) {
  if (!file.startsWith("apps/web/public/") || !file.endsWith(".js")) return;

  const allowedCalls = browserNetworkAllowlist.get(file) ?? new Set();
  for (const match of text.matchAll(/\bfetch\s*\(([^\n]{0,120})/gu)) {
    const call = `fetch(${match[1] ?? ""}`;
    const directlyUsesApi = /^fetch\(\s*["'`]\/api\/v1\//u.test(call);
    if (!directlyUsesApi && ![...allowedCalls].some((allowed) => call.startsWith(allowed))) {
      violations.push(`${file}:${lineNumber(text, match.index)}: browser fetch must use the Nexus API`);
    }
  }

  for (const match of text.matchAll(/\b(?:EventSource|WebSocket)\s*\(([^\n]{0,120})/gu)) {
    const target = match[1] ?? "";
    if (!/^\s*["'`]\/api\/v1\//u.test(target)) {
      violations.push(`${file}:${lineNumber(text, match.index)}: browser streaming connections must use the Nexus API`);
    }
  }
}

for (const file of files) {
  const normalized = file.replaceAll("\\", "/");
  if (!codeExtension.test(normalized) && !runtimeConfiguration.test(normalized)) continue;

  const text = normalizedText(file);
  if (text === null) continue;

  if (codeExtension.test(normalized) && consoleWrite.test(text) && !HISTORICAL_CLIENT_ALLOWLIST.has(normalized)) {
    violations.push(`${normalized}: direct console writes are prohibited; use the shared logger`);
  }

  if (runtimeConfiguration.test(normalized) && historicalRuntimeReference.test(text)) {
    violations.push(`${normalized}: the historical root index.html must not be loaded or shipped at runtime`);
  }

  if (activeCode.test(normalized) && legacyMigrationMarker.test(text) && !LEGACY_MIGRATION_ALLOWLIST.includes(normalized)) {
    violations.push(`${normalized}: legacy client compatibility must remain inside the reviewed migration boundary`);
  }

  if (activeCode.test(normalized)) checkBrowserNetworkCalls(normalized, text);
}

for (const migrationFile of LEGACY_MIGRATION_ALLOWLIST) {
  if (!files.includes(migrationFile)) {
    violations.push(`${migrationFile}: stale legacy-migration allowlist entry`);
  }
}

for (const retiredFile of RETIRED_WORLD_CAMPAIGN_AUTHORITY) {
  if (normalizedText(retiredFile) !== null) {
    violations.push(`${retiredFile}: retired Task 14c authority must not remain callable`);
  }
}

for (const retiredFile of RETIRED_PROVIDER_AUTHORITY) {
  if (normalizedText(retiredFile) !== null) {
    violations.push(`${retiredFile}: retired Task 14d authority must not remain callable`);
  }
}

for (const requiredFile of REQUIRED_WORLD_CAMPAIGN_BOUNDARIES) {
  if (normalizedText(requiredFile) === null) {
    violations.push(`${requiredFile}: required Task 14c/14d boundary is missing`);
  }
}

violations.push(...checkClientBoundaries());

if (violations.length > 0) {
  process.stderr.write("Repository boundary check failed:\n");
  for (const violation of violations) process.stderr.write(`- ${violation}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Repository boundary check passed for ${files.length} candidate files.\n`);
}
