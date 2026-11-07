import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

// Run from the repository root with Docker and Chromium available. This creates
// unique Compose projects, networks and volumes, and removes only those projects.
const output = process.env.SETTINGS_PROOF_SCREENSHOTS;
assert.ok(output, "Set SETTINGS_PROOF_SCREENSHOTS to an output directory outside the repository");
const openssl = process.env.OPENSSL ?? "openssl";
const localPort = process.env.SETTINGS_PROOF_LOCAL_PORT ?? "45689";
const protectedPort = process.env.SETTINGS_PROOF_PROTECTED_PORT ?? "45690";
const tlsPort = process.env.SETTINGS_PROOF_TLS_PORT ?? "45691";
const dir = await mkdtemp(join(tmpdir(), "iq-settings-proof-"));
const suffix = randomUUID().slice(0, 8);
const skipBuild = process.env.SETTINGS_PROOF_SKIP_BUILD === "1";
if (skipBuild) assert.ok(process.env.SETTINGS_PROOF_IMAGE, "Skip-build requires an explicitly named existing image");
const proofImage = process.env.SETTINGS_PROOF_IMAGE ?? `infinitequest-nexus:settings-proof-${suffix}`;
const local = `iq-settings-local-${suffix}`;
const protectedProject = `iq-settings-protected-${suffix}`;
const key = `disposable-proof-${randomUUID()}-key`;
const baseEnv = { ...process.env, POSTGRES_PASSWORD: "disposable-proof-password", SETTINGS_PROOF_DIR: dir.replaceAll("\\", "/"), SETTINGS_PROOF_IMAGE: proofImage, PROVIDER_NETWORK_ALLOWLIST: "proof-provider" };
const cli = "/app/dist/services/runtime/src/settings-operator-cli.js";
const localFiles = ["-f", "compose.yaml", "-f", "compose.local-single-user.yaml", "-f", "tests/fixtures/local-single-user-proof.override.yaml"];
const protectedFiles = ["-f", "compose.yaml", "-f", "tests/fixtures/protected-settings-proof.override.yaml"];
const env = (project, port) => ({ ...baseEnv, COMPOSE_PROJECT_NAME: project, APP_PORT: port });
function run(command, args, environment = baseEnv) {
  const result = spawnSync(command, args, { encoding: "utf8", env: environment, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr}\n${result.stdout || result.error || ""}`);
  return result.stdout.trim();
}
const compose = (files, environment, ...args) => run("docker", ["compose", ...files, ...args], environment);
async function ready(port) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health/ready`)).ok) return; } catch { /* starting */ }
    await new Promise(done => setTimeout(done, 1000));
  }
  throw new Error(`Readiness timed out on port ${port}`);
}
function browserProof(extra) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["tests/fixtures/local-single-user-browser-proof.mjs"], {
      env: { ...baseEnv, SETTINGS_PROOF_SCREENSHOTS: resolve(output), ...extra }, stdio: "inherit"
    });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolvePromise() : reject(new Error(`Browser proof exited ${code}`)));
  });
}
let proxy;
try {
  const localEnv = env(local, localPort);
  const protectedEnv = env(protectedProject, protectedPort);
  if (!skipBuild) compose(localFiles, localEnv, "build", "infinitequest-app");
  compose(localFiles, localEnv, "up", "-d");
  await ready(localPort);
  await writeFile(join(dir, "provider.mjs"), `import http from "node:http";
let held, cancelled = false;
http.createServer((req, res) => {
  if (req.url === "/status") { res.end(JSON.stringify({ held: !!held, cancelled })); return; }
  if (req.url === "/release") { if (held) { held.writeHead(200, {"content-type":"application/json"}); held.end(JSON.stringify({data:[{id:"proof-model",object:"model"}]})); held = null; } res.end("ok"); return; }
  if (req.url === "/v1/models") { held = res; req.on("aborted", () => { cancelled = true; }); res.on("close", () => { if (!res.writableFinished) cancelled = true; }); return; }
  res.writeHead(404).end();
}).listen(9090, "0.0.0.0");`);
  run("docker", ["run", "-d", "--name", `${local}-provider`, "--network", `${local}-local-backend`, "--network-alias", "proof-provider", "--mount", `type=bind,src=${dir.replaceAll("\\", "/")},dst=/proof,readonly`, "--entrypoint", "node", proofImage, "/proof/provider.mjs"]);
  await browserProof({ SETTINGS_PROOF_PROJECT: local, SETTINGS_PROOF_BASE: `http://127.0.0.1:${localPort}`, SETTINGS_PROOF_MODE: "local" });
  await writeFile(join(dir, "key"), key);
  const seed = JSON.parse(compose(protectedFiles, protectedEnv, "run", "--rm", "--no-deps", "--entrypoint", "sh", "infinitequest-app", "-c", `node /app/scripts/ensure-local-credential-encryption-key.mjs && exec node ${cli} export-seed`));
  await writeFile(join(dir, "seeds.json"), JSON.stringify([seed]));
  const policy = compose(protectedFiles, protectedEnv, "run", "--rm", "--no-deps", "--entrypoint", "node", "infinitequest-app", cli, "create-policy", "--input", "/proof/seeds.json", "--installation-id", randomUUID());
  await writeFile(join(dir, "policy.json"), policy);
  compose(protectedFiles, protectedEnv, "up", "-d");
  await ready(protectedPort);
  compose(protectedFiles, protectedEnv, "exec", "-T", "infinitequest-app", "node", cli, "seed", "--input", "/proof/seeds.json");

  run(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "tls.key"), "-out", join(dir, "tls.crt"), "-days", "1", "-subj", "/CN=localhost"]);
  proxy = https.createServer({ key: await readFile(join(dir, "tls.key")), cert: await readFile(join(dir, "tls.crt")) }, (request, response) => {
    const upstream = http.request({ hostname: "127.0.0.1", port: protectedPort, path: request.url, method: request.method,
      headers: { ...request.headers, "x-forwarded-proto": "https", "x-forwarded-for": request.socket.remoteAddress } }, result => {
      response.writeHead(result.statusCode, result.headers); result.pipe(response);
    });
    upstream.on("error", () => response.destroy());
    request.pipe(upstream);
  });
  await new Promise((ok, fail) => proxy.listen(Number(tlsPort), "127.0.0.1", ok).once("error", fail));
  await browserProof({ SETTINGS_PROOF_BASE: `https://127.0.0.1:${tlsPort}`, SETTINGS_PROOF_DIRECT_HTTP: `http://127.0.0.1:${protectedPort}`, SETTINGS_PROOF_MODE: "protected", SETTINGS_PROOF_KEY: key });
} finally {
  if (proxy) await new Promise(done => proxy.close(done));
  try { run("docker", ["exec", `${local}-provider`, "node", "-e", "fetch('http://127.0.0.1:9090/release').then(r=>r.text()).then(console.log)"]); } catch { /* provider may not have started */ }
  try { run("docker", ["rm", "-f", `${local}-provider`]); } catch { /* provider may not have started */ }
  for (const [files, environment] of [[localFiles, env(local, localPort)], [protectedFiles, env(protectedProject, protectedPort)]]) {
    try { compose(files, environment, "down", "--volumes", "--remove-orphans"); } catch (error) { process.stderr.write(`Cleanup failed: ${error.message}\n`); }
  }
  if (!skipBuild) {
    try { run("docker", ["image", "rm", proofImage]); } catch (error) { process.stderr.write(`Image cleanup failed: ${error.message}\n`); }
  }
  await rm(dir, { recursive: true, force: true });
}
