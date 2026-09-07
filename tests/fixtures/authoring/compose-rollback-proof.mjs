import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// Only this disposable project's four service containers may be changed.
const project = "infinitequest-ai-assist-p2-10-proof";
const composeFile = resolve(process.env.P2_PROOF_COMPOSE_FILE ?? "tests/fixtures/authoring/compose-p2-10.yaml");
const base = process.env.P2_PROOF_BASE_URL ?? "http://127.0.0.1:45680";
assert.equal(new URL(base).hostname, "127.0.0.1");
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const compose = (...args) => docker("compose", "-p", project, "-f", composeFile, ...args);
const pause = ms => new Promise(done => setTimeout(done, ms));
const until = async read => {
  for (let index = 0; index < 100; index += 1) {
    try { const result = await read(); if (result) return result; } catch { /* Role startup. */ }
    await pause(300);
  }
  throw new Error("Disposable role did not become ready.");
};
const counts = () => JSON.parse(docker("exec", `${project}-provider-1`, "node", "-e", "fetch('http://127.0.0.1:9090/counts').then(r=>r.text()).then(text=>process.stdout.write(text))")).calls;
const row = id => JSON.parse(docker("exec", `${project}-postgres-1`, "psql", "-U", "p2proof", "-d", "p2proof", "-At", "-c", `select json_build_object('status',j.status,'attempts',sum(s.attempt_count)) from authoring_jobs j join authoring_job_stages s on s.job_id=j.id where j.id='${id}' group by j.id`));
const disabled = [`${project}-api-disabled`, `${project}-worker-disabled`];
const normal = [`${project}-api-1`, `${project}-worker-1`];
for (const name of normal) assert.equal(docker("inspect", "--format", '{{index .Config.Labels "com.docker.compose.project"}}', name), project);
for (const name of disabled) assert.equal(docker("ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"), "", "Disabled proof name already exists.");
let jobId;
try {
  docker("stop", normal[1]);
  const request = { kind: "world_concept", target: { kind: "new_world" }, idempotencyKey: crypto.randomUUID(), prompt: "Disposable rollback queue proof." };
  const accepted = await fetch(`${base}/api/v1/authoring/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
  assert.equal(accepted.status, 202);
  jobId = (await accepted.json()).id;
  assert.match(jobId, /^[0-9a-f-]{36}$/);
  docker("stop", normal[0]);
  compose("run", "--no-deps", "-d", "--name", disabled[0], "-p", `127.0.0.1:${new URL(base).port}:8080`, "-e", "AI_AUTHORING_JOBS_ENABLED=false", "api");
  compose("run", "--no-deps", "-d", "--name", disabled[1], "-e", "AI_AUTHORING_JOBS_ENABLED=false", "worker");
  const capability = await until(async () => { const response = await fetch(`${base}/api/v1/authoring/capabilities`); return response.ok && response.json(); });
  assert.equal(capability.enabled, false);
  const rejected = await fetch(`${base}/api/v1/authoring/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...request, idempotencyKey: crypto.randomUUID() }) });
  assert.equal(rejected.status, 503);
  const before = { calls: counts(), job: row(jobId) };
  await pause(3500);
  const after = { calls: counts(), job: row(jobId) };
  assert.deepEqual(after, before);
  assert.deepEqual(after.job, { status: "queued", attempts: 0 });
  process.stdout.write(JSON.stringify({ boundary: "both-roles-disabled", capabilityEnabled: false, submissionStatus: rejected.status, observationMilliseconds: 3500, jobId, before, after }) + "\n");
} finally {
  for (const name of disabled) {
    if (docker("ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.Names}}") === name) docker("rm", "-f", name);
  }
  docker("start", ...normal);
}
await until(async () => { const response = await fetch(`${base}/api/v1/authoring/capabilities`); return response.ok && (await response.json()).enabled; });
await until(() => row(jobId).status === "awaiting_review");
process.stdout.write(JSON.stringify({ boundary: "both-roles-restored", jobId, job: row(jobId), providerCalls: counts() }) + "\n");
