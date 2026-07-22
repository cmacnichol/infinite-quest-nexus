import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

const output = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" },
);
const files = [...new Set(output.split(/\r?\n/u).filter(Boolean))].sort();
const violations = [];

const forbiddenPath = /(^|\/)(?:local-data|backups?|exports?|saves?)(?:\/|$)/iu;
const forbiddenExtension = /\.(?:backup|dump|key|p12|pfx|pem|story)$/iu;
const highConfidenceSecrets = [
  { label: "private key material", pattern: /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/u },
  { label: "GitHub access token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/u },
  { label: "OpenAI-style secret key", pattern: /\bsk-[A-Za-z0-9_-]{24,}\b/u },
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/u },
];

function isAllowedEnvironmentExample(file) {
  return file === ".env.example" || file.endsWith("/.env.example");
}

function containsStoryExport(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.hasOwn(value, "world") && Object.hasOwn(value, "turns");
}

for (const file of files) {
  const normalized = file.replaceAll("\\", "/");

  if (forbiddenPath.test(normalized)) {
    violations.push(`${normalized}: local save/export/backup path is not allowed`);
  }

  if (forbiddenExtension.test(normalized)) {
    violations.push(`${normalized}: sensitive or story-export file extension is not allowed`);
  }

  if ((normalized === ".env" || normalized.includes("/.env")) && !isAllowedEnvironmentExample(normalized)) {
    violations.push(`${normalized}: environment files other than .env.example are not allowed`);
  }

  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }

  for (const secret of highConfidenceSecrets) {
    if (secret.pattern.test(text)) {
      violations.push(`${normalized}: possible ${secret.label}`);
    }
  }

  if (extname(normalized).toLowerCase() !== ".json") {
    continue;
  }

  try {
    const parsed = JSON.parse(text);
    if (!containsStoryExport(parsed)) {
      continue;
    }

    const isSyntheticFixture =
      normalized.startsWith("tests/fixtures/") &&
      parsed.world?.title === "Synthetic Test World";
    if (!isSyntheticFixture) {
      violations.push(`${normalized}: story-shaped JSON is only allowed as a named synthetic test fixture`);
    }
  } catch {
    // Syntax validation belongs to the consuming build or test. This check only
    // identifies parseable portable story exports.
  }
}

if (violations.length > 0) {
  process.stderr.write("Repository data-safety check failed:\n");
  for (const violation of violations) {
    process.stderr.write(`- ${violation}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(`Repository data-safety check passed for ${files.length} candidate files.\n`);
}
