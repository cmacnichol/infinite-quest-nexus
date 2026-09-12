import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createDatabasePool, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { importLegacyStory } from "../legacy-api/src/import-service.js";
import { memoryGeneration } from "./memory-applications.js";
import { createProvider } from "./provider-application-fixtures.js";
import { createStoryOnlySyntheticProvider, type StoryOnlySyntheticProvider } from "./story-only-synthetic-provider.js";

const DEDICATED_HOST = "127.0.0.1";
const DEDICATED_PORT = "15439";
const DEDICATED_DATABASE = "infinitequest_storyonly_test";
const OWNED_DATABASE_PREFIX = "infinitequest_storyonly_";
const RUNTIME_PORT = 18081;
const CREDENTIAL_SECRET = "story-only-runtime-test-credential-secret";
const STORY_ONLY_POSTGRES_CONTAINER = "infinitequest-story-only-test";

export type StoryOnlyRuntimeRenderer = "native" | "web-awesome";

export function resolveStoryOnlyRuntimeRenderer(value: unknown): StoryOnlyRuntimeRenderer {
  if (value === undefined) return "native";
  if (value === "native" || value === "web-awesome") return value;
  throw new Error("Unsupported story-only runtime renderer. Use native or web-awesome.");
}

export function storyOnlyRuntimeDockerBuildArgs(renderer: StoryOnlyRuntimeRenderer, dockerImage: string): string[] {
  return ["build", "--build-arg", `VITE_UI_COMPONENTS=${renderer}`, "--file", "tests/helpers/story-only-runtime.Dockerfile", "--tag", dockerImage, "."];
}

export type StoryOnlyRuntimeTarget = Readonly<{ host: string; port: string; database: string; baseUrl: URL }>;

export function assertStoryOnlyRuntimeTarget(databaseUrl: string): StoryOnlyRuntimeTarget {
  const target = new URL(databaseUrl);
  const database = target.pathname.replace(/^\//u, "");
  if (target.protocol !== "postgresql:" || target.hostname !== DEDICATED_HOST || target.port !== DEDICATED_PORT || database !== DEDICATED_DATABASE) {
    throw new Error("Story-only runtime requires the dedicated localhost test database target.");
  }
  return Object.freeze({ host: target.hostname, port: target.port, database, baseUrl: target });
}

export function assertOwnedStoryOnlyDatabase(databaseName: string): string {
  if (!new RegExp(`^${OWNED_DATABASE_PREFIX}[a-z0-9_]+$`, "u").test(databaseName) || databaseName === DEDICATED_DATABASE) {
    throw new Error("Story-only runtime cleanup is restricted to a uniquely owned database.");
  }
  return databaseName;
}

export async function pollStoryOnlyRuntime<T extends { status: string }>(
  read: () => Promise<T>,
  options: Readonly<{ timeoutMs: number; pollIntervalMs: number }>
): Promise<T> {
  const terminal = new Set(["completed", "failed", "cancelled", "recoverable"]);
  const deadline = Date.now() + options.timeoutMs;
  let latest: T;
  do {
    latest = await read();
    if (terminal.has(latest.status)) return latest;
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, options.pollIntervalMs));
  } while (Date.now() < deadline);
  throw new Error("Story-only runtime did not reach a terminal state before its timeout.");
}

export function safeStoryOnlyRuntimeSummary(input: Readonly<{
  databaseUrl: string;
  provider: Awaited<ReturnType<StoryOnlySyntheticProvider["summary"]>>;
  runtimeBaseUrl: string;
  renderer: StoryOnlyRuntimeRenderer;
}>) {
  return Object.freeze({
    database: new URL(input.databaseUrl).pathname.replace(/^\//u, ""),
    providerOperations: input.provider.operations,
    providerRequestCount: input.provider.total,
    renderer: input.renderer,
    runtimeBaseUrl: input.runtimeBaseUrl
  });
}

export type StoryOnlyRuntimeFixture = Readonly<{
  baseUrl: string;
  campaignId: string;
  emptyStoryCampaignId: string;
  emptyStoryCampaignMobileId: string;
  emptyNewUiStoryCampaignId: string;
  emptyNewUiStoryCampaignMobileId: string;
  actionOnlyCampaignId: string;
  databaseName: string;
  renderer: StoryOnlyRuntimeRenderer;
  provider: StoryOnlySyntheticProvider;
  summary(): Promise<ReturnType<typeof safeStoryOnlyRuntimeSummary>>;
  close(): Promise<void>;
}>;

export function createStoryOnlyRuntimeCleanup(steps: readonly (() => Promise<void>)[]): () => Promise<void> {
  let closed: Promise<void> | undefined;
  return () => closed ??= (async () => {
    const failures: unknown[] = [];
    for (const step of steps) {
      try { await step(); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Story-only runtime cleanup failed.");
  })();
}

export function storyOnlyDockerCleanupNames(allocated: Readonly<{ runtime: boolean; provider: boolean; postgresConnection: boolean; network: boolean; image: boolean }>): string[] {
  return [
    ...(allocated.runtime ? ["runtime"] : []),
    ...(allocated.provider ? ["provider"] : []),
    ...(allocated.postgresConnection ? ["postgresConnection"] : []),
    ...(allocated.network ? ["network"] : []),
    ...(allocated.image ? ["image"] : [])
  ];
}

export function closeStoryOnlyRuntimeInput(input: Readonly<{ pause(): void; destroy(): void }>): void {
  input.pause();
  input.destroy();
}

export function createStoryOnlyRuntimeLifecycle<T>(
  start: (signal: AbortSignal) => Promise<T>,
  dispose: (value: T) => Promise<void>,
  options: Readonly<{ deferStart?: boolean }> = {}
) {
  const controller = new AbortController();
  let started: Promise<T> | undefined;
  const begin = () => started ??= start(controller.signal);
  if (!options.deferStart) begin();
  let closing = false;
  let initialization: Promise<boolean> | undefined;
  let closed: Promise<void> | undefined;
  return Object.freeze({
    get result() { return begin(); },
    start: begin,
    initialize: (initialize: (value: T, isRunning: () => boolean) => Promise<void>) => initialization ??= (async () => {
      const value = await begin();
      if (closing) return false;
      await initialize(value, () => !closing);
      return !closing;
    })(),
    close: () => closed ??= (async () => {
      closing = true;
      controller.abort();
      const failures: unknown[] = [];
      try { await initialization; } catch (error) { failures.push(error); }
      if (started) {
        try { await dispose(await started); } catch (error) { failures.push(error); }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Story-only runtime lifecycle shutdown failed.");
    })()
  });
}

function ownedDatabaseUrl(target: StoryOnlyRuntimeTarget, databaseName: string): string {
  const url = new URL(target.baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export async function waitForStoryOnlyRuntimeReady(baseUrl: string, runtime?: ChildProcess, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (runtime && runtime.exitCode !== null) {
      throw new Error("Story-only runtime exited before readiness.");
    }
    try {
      const response = await fetch(`${baseUrl}/health/ready`);
      if (response.ok) return;
    } catch { /* startup has not bound the port yet */ }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100));
  } while (Date.now() < deadline);
  throw new Error("Story-only runtime did not become ready before its timeout.");
}

function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child) return Promise.resolve();
  if (child.exitCode !== null || child.killed) return Promise.resolve();
  return new Promise((resolveStop) => {
    const timeout = setTimeout(() => { child.kill("SIGKILL"); }, 5_000);
    child.once("exit", () => { clearTimeout(timeout); resolveStop(); });
    child.kill("SIGTERM");
  });
}

function runCommand(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => { output = `${output}${chunk.toString("utf8")}`; });
    child.stderr?.on("data", (chunk: Buffer) => { output = `${output}${chunk.toString("utf8")}`; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveCommand(output.trim()) : reject(new Error(`Story-only runtime command failed (${command}).`)));
  });
}

function dockerDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.hostname = STORY_ONLY_POSTGRES_CONTAINER;
  url.port = "5432";
  return url.toString();
}

function safeDockerDiagnostic(value: string): string {
  return value.replace(/postgresql:\/\/[^\s]+/gu, "[database-url-redacted]")
    .replace(/(?:api[_-]?key|credential|secret|password)\s*[:=]\s*\S+/giu, "[sensitive-value-redacted]")
    .replace(/\s+/gu, " ").trim().slice(-600);
}

async function dockerProviderControl<T>(containerName: string, path: "/__scenario" | "/__summary", body?: unknown): Promise<T> {
  const script = "const path=process.argv[1];const body=process.argv[2];fetch('http://127.0.0.1:8081'+path,body===undefined?undefined:{method:'POST',headers:{'content-type':'application/json'},body}).then(async response=>{const text=await response.text();if(!response.ok){process.stderr.write(`control request failed (${response.status})`);process.exitCode=1;return;}process.stdout.write(text);}).catch(error=>{process.stderr.write(String(error));process.exitCode=1;});";
  const args = ["exec", containerName, "node", "-e", script, path];
  if (body !== undefined) args.push(JSON.stringify(body));
  return JSON.parse(await runCommand("docker", args)) as T;
}

function dockerSyntheticProvider(containerName: string): StoryOnlySyntheticProvider {
  return Object.freeze({
    baseUrl: `http://${containerName}:8081`,
    async enqueue(response) {
      const result = await dockerProviderControl<{ accepted?: unknown }>(containerName, "/__scenario", response);
      if (result.accepted !== true) throw new Error("Synthetic provider did not accept the queued scenario.");
    },
    async summary() {
      const summary = await dockerProviderControl<{ operations?: unknown; total?: unknown }>(containerName, "/__summary");
      if (typeof summary.total !== "number" || !Number.isSafeInteger(summary.total) || summary.total < 0 || typeof summary.operations !== "object" || summary.operations === null) {
        throw new Error("Synthetic provider returned an invalid operation summary.");
      }
      const operations = Object.entries(summary.operations).reduce<Record<string, number>>((result, [operation, count]) => {
        if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new Error("Synthetic provider returned an invalid operation count.");
        result[operation] = count;
        return result;
      }, {});
      return Object.freeze({ operations: Object.freeze(operations), total: summary.total });
    },
    close: async () => undefined
  });
}

async function dropOwnedDatabase(target: StoryOnlyRuntimeTarget, databaseName: string): Promise<void> {
  assertOwnedStoryOnlyDatabase(databaseName);
  const admin = createDatabasePool(ownedDatabaseUrl(target, "postgres"), 1);
  try {
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [databaseName]);
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  } finally { await admin.end(); }
}

export async function startStoryOnlyRuntime(options: Readonly<{ databaseUrl: string; root?: string; port?: number; renderer?: unknown; signal?: AbortSignal }> ): Promise<StoryOnlyRuntimeFixture> {
  if (options.signal?.aborted) throw new Error("Story-only runtime startup was cancelled.");
  const renderer = resolveStoryOnlyRuntimeRenderer(options.renderer);
  const target = assertStoryOnlyRuntimeTarget(options.databaseUrl);
  const root = resolve(options.root ?? process.cwd());
  const port = options.port ?? RUNTIME_PORT;
  const databaseName = `${OWNED_DATABASE_PREFIX}${randomUUID().replaceAll("-", "")}`;
  const databaseUrl = ownedDatabaseUrl(target, databaseName);
  const assetRoot = resolve(root, "tmp/story-only-test/assets", databaseName);
  const archiveRoot = resolve(root, "tmp/story-only-test/archives", databaseName);
  const admin = createDatabasePool(ownedDatabaseUrl(target, "postgres"), 1);
  let adminClosed = false;
  const closeAdmin = async () => {
    if (!adminClosed) {
      await admin.end();
      adminClosed = true;
    }
  };
  let pool: DatabasePool | undefined;
  let provider: StoryOnlySyntheticProvider | undefined;
  let runtime: ChildProcess | undefined;
  let dockerImageBuilt = false;
  let dockerNetworkCreated = false;
  let postgresConnected = false;
  let dockerProviderStarted = false;
  let dockerRuntimeStarted = false;
  let databaseCreated = false;
  let assetRootCreated = false;
  let archiveRootCreated = false;
  const docker = process.platform === "win32";
  const resourceTag = randomUUID().replaceAll("-", "");
  const dockerImage = `infinitequest-story-only-runtime:${resourceTag}`;
  const dockerNetwork = `iq-storyonly-${resourceTag}`;
  const dockerProvider = `iq-provider-${resourceTag}`;
  const dockerRuntime = `iq-runtime-${resourceTag}`;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;
    if (options.signal?.aborted) throw new Error("Story-only runtime startup was cancelled.");
    await closeAdmin();
    await mkdir(assetRoot, { recursive: true });
    assetRootCreated = true;
    await mkdir(archiveRoot, { recursive: true });
    archiveRootCreated = true;
    pool = createDatabasePool(databaseUrl, 12);
    await migrateDatabase(pool, resolve(root, "database/migrations"));
    if (docker) {
      await runCommand("docker", storyOnlyRuntimeDockerBuildArgs(renderer, dockerImage)); dockerImageBuilt = true;
      await runCommand("docker", ["network", "create", dockerNetwork]); dockerNetworkCreated = true;
      await runCommand("docker", ["network", "connect", dockerNetwork, STORY_ONLY_POSTGRES_CONTAINER]); postgresConnected = true;
      await runCommand("docker", ["run", "--detach", "--name", dockerProvider, "--network", dockerNetwork, "--env", "STORY_ONLY_SYNTHETIC_PROVIDER_HOST=0.0.0.0", dockerImage, "node", "node_modules/tsx/dist/cli.mjs", "scripts/story-only-synthetic-provider.ts"]); dockerProviderStarted = true;
    } else {
      provider = await createStoryOnlySyntheticProvider();
    }
    const profile = await createProvider(pool, {
      name: "Story-only synthetic provider",
      providerType: "openai_compatible",
      providerRole: "text",
      baseUrl: docker ? `http://${dockerProvider}:8081` : provider!.baseUrl,
      defaultModel: "story-only-test",
      contextWindowTokens: 32768,
      maxOutputTokens: 4096,
      temperature: 0,
      enabled: true,
      isDefault: true,
      configuration: {}
    }, CREDENTIAL_SECRET);
    const fixtureStory = (title: string, turnControlStyle: "action_only" | "flexible_action" | "flexible_scene", turns: readonly unknown[]) => storyImportRequestSchema.parse({
      sourceName: `${title.toLowerCase().replaceAll(/[^a-z]+/gu, "-")}.story`,
      story: {
        world: { title, genre: "test", tone: "sanitized", premise: "A safe local fixture.", backgroundStory: "", character: "", firstAction: "Continue the story.", rules: "" },
        settings: { storyLength: "standard", textProviderProfileId: profile.id, turnControlStyle },
        turns, scratchpad: "", trackers: []
      }
    });
    const imported = await importLegacyStory(pool, fixtureStory("Story-only Runtime Fixture", "flexible_action", [{ id: "story-only-runtime-turn-1", turnNumber: 1, action: "Begin.", narration: "The safe fixture begins at a quiet station.", choices: ["Continue"] }]), memoryGeneration(pool, CREDENTIAL_SECRET));
    const emptyStory = await importLegacyStory(pool, fixtureStory("Empty Story Direction Fixture", "flexible_scene", []), memoryGeneration(pool, CREDENTIAL_SECRET));
    const emptyStoryMobile = await importLegacyStory(pool, fixtureStory("Empty Story Direction Mobile Fixture", "flexible_scene", []), memoryGeneration(pool, CREDENTIAL_SECRET));
    const emptyNewUiStory = await importLegacyStory(pool, fixtureStory("Empty New UI Story Direction Fixture", "flexible_scene", []), memoryGeneration(pool, CREDENTIAL_SECRET));
    const emptyNewUiStoryMobile = await importLegacyStory(pool, fixtureStory("Empty New UI Story Direction Mobile Fixture", "flexible_scene", []), memoryGeneration(pool, CREDENTIAL_SECRET));
    const actionOnly = await importLegacyStory(pool, fixtureStory("Action-only Fixture", "action_only", [{ id: "action-only-runtime-turn-1", turnNumber: 1, action: "Begin.", narration: "The action fixture begins.", choices: ["Continue"] }]), memoryGeneration(pool, CREDENTIAL_SECRET));
    await pool.end();
    pool = undefined;
    const runtimeBaseUrl = `http://127.0.0.1:${port}`;
    const runtimeEnvironment = {
      ...process.env,
      APP_ROLE: "all", APP_HOST: "0.0.0.0", APP_PORT: docker ? "8080" : String(port), DATABASE_URL: docker ? dockerDatabaseUrl(databaseUrl) : databaseUrl,
      DATABASE_MAX_CONNECTIONS: "12", CREDENTIAL_ENCRYPTION_KEY: CREDENTIAL_SECRET,
      PROVIDER_NETWORK_ALLOWLIST: docker ? dockerProvider : "127.0.0.1", LEGACY_WEB_ROOT: docker ? "/app/apps/web/dist" : resolve(root, "apps/web/dist"), NEXT_WEB_ROOT: docker ? "/app/apps/web-next/dist" : resolve(root, "apps/web-next/dist"),
      ASSET_STORAGE_ROOT: docker ? "/tmp/story-only/assets" : assetRoot, ARCHIVE_STORAGE_ROOT: docker ? "/tmp/story-only/archives" : archiveRoot, LOG_LEVEL: "silent"
    };
    if (docker) {
      await runCommand("docker", ["run", "--detach", "--name", dockerRuntime, "--network", dockerNetwork, "--publish", `127.0.0.1:${port}:8080`, ...Object.entries(runtimeEnvironment).flatMap(([key, value]) => value === undefined ? [] : ["--env", `${key}=${value}`]), dockerImage, "node", "node_modules/tsx/dist/cli.mjs", "services/runtime/src/main.ts"]); dockerRuntimeStarted = true;
    } else runtime = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "services/runtime/src/main.ts"], {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: runtimeEnvironment
    });
    try {
      await waitForStoryOnlyRuntimeReady(runtimeBaseUrl, runtime);
    } catch (error) {
      if (docker) {
        const diagnostic = await Promise.all([
          runCommand("docker", ["inspect", "--format", "running={{.State.Running}} exit={{.State.ExitCode}} error={{.State.Error}}", dockerRuntime]).catch(() => ""),
          runCommand("docker", ["logs", dockerRuntime]).catch(() => "")
        ]).then((values) => values.filter(Boolean).join(" "));
        if (diagnostic) throw new Error(`Story-only Docker runtime startup failed: ${safeDockerDiagnostic(diagnostic)}`);
      }
      throw error;
    }
    const activeProvider = provider ?? dockerSyntheticProvider(dockerProvider);
    const close = createStoryOnlyRuntimeCleanup([
      async () => stopChild(runtime),
      async () => activeProvider.close(),
      ...(docker ? [
        ...(dockerRuntimeStarted ? [async () => { await runCommand("docker", ["rm", "--force", dockerRuntime]); }] : []),
        ...(dockerProviderStarted ? [async () => { await runCommand("docker", ["rm", "--force", dockerProvider]); }] : []),
        ...(postgresConnected ? [async () => { await runCommand("docker", ["network", "disconnect", dockerNetwork, STORY_ONLY_POSTGRES_CONTAINER]); }] : []),
        ...(dockerNetworkCreated ? [async () => { await runCommand("docker", ["network", "rm", dockerNetwork]); }] : []),
        ...(dockerImageBuilt ? [async () => { await runCommand("docker", ["image", "rm", "--force", dockerImage]); }] : [])
      ] : []),
      async () => dropOwnedDatabase(target, databaseName),
      async () => { await rm(resolve(root, "tmp/story-only-test/assets", databaseName), { recursive: true, force: true }); },
      async () => { await rm(resolve(root, "tmp/story-only-test/archives", databaseName), { recursive: true, force: true }); }
    ]);
    return Object.freeze({
      baseUrl: runtimeBaseUrl, campaignId: imported.campaignId, emptyStoryCampaignId: emptyStory.campaignId, emptyStoryCampaignMobileId: emptyStoryMobile.campaignId, emptyNewUiStoryCampaignId: emptyNewUiStory.campaignId, emptyNewUiStoryCampaignMobileId: emptyNewUiStoryMobile.campaignId, actionOnlyCampaignId: actionOnly.campaignId, databaseName, renderer, provider: activeProvider,
      summary: async () => safeStoryOnlyRuntimeSummary({ databaseUrl, provider: await activeProvider.summary(), renderer, runtimeBaseUrl }),
      close
    });
  } catch (error) {
    const cleanup = createStoryOnlyRuntimeCleanup([
      async () => stopChild(runtime),
      async () => { await pool?.end(); },
      async () => { await provider?.close(); },
      ...(docker ? [
        ...(dockerRuntimeStarted ? [async () => { await runCommand("docker", ["rm", "--force", dockerRuntime]); }] : []),
        ...(dockerProviderStarted ? [async () => { await runCommand("docker", ["rm", "--force", dockerProvider]); }] : []),
        ...(postgresConnected ? [async () => { await runCommand("docker", ["network", "disconnect", dockerNetwork, STORY_ONLY_POSTGRES_CONTAINER]); }] : []),
        ...(dockerNetworkCreated ? [async () => { await runCommand("docker", ["network", "rm", dockerNetwork]); }] : []),
        ...(dockerImageBuilt ? [async () => { await runCommand("docker", ["image", "rm", "--force", dockerImage]); }] : [])
      ] : []),
      closeAdmin,
      ...(databaseCreated ? [async () => dropOwnedDatabase(target, databaseName)] : []),
      ...(assetRootCreated ? [async () => { await rm(assetRoot, { recursive: true, force: true }); }] : []),
      ...(archiveRootCreated ? [async () => { await rm(archiveRoot, { recursive: true, force: true }); }] : [])
    ]);
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Story-only runtime startup and cleanup failed.");
    }
    throw error;
  }
}
