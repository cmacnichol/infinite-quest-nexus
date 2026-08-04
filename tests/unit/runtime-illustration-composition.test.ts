import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  IllustrationApplication,
  IllustrationApplicationDependencies,
  IllustrationWorkerApplication,
  IllustrationWorkerExecutor,
  IllustrationWorkerStateMachinePort
} from "../../packages/application/src/index.js";
import type { DatabasePool } from "../../packages/database/src/pool.js";
import {
  createApiIllustrationApplication,
  createIllustrationWorkerExecutor,
  createWorkerIllustrationApplication,
  type ApiIllustrationCompositionFactories,
  type IllustrationWorkerLanes,
  type WorkerIllustrationCompositionFactories
} from "../../services/runtime/src/illustration-composition.js";
import { createIllustrationWorkerStateMachine } from "../../services/runtime/src/illustration-worker-state-adapter.js";

async function productionTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return ["generated", "__generated__", "test", "tests", "__tests__"].includes(entry.name)
        ? []
        : productionTypeScriptFiles(path);
    }
    return entry.isFile()
      && entry.name.endsWith(".ts")
      && !entry.name.endsWith(".test.ts")
      && !entry.name.endsWith(".spec.ts")
      ? [path]
      : [];
  }));
  return files.flat();
}

type SourceToken = Readonly<{
  kind: "punctuation" | "string" | "word";
  value: string;
}>;

function canStartRegexLiteral(tokens: readonly SourceToken[]): boolean {
  const previous = tokens.at(-1);
  if (!previous) return true;
  if (previous.kind === "word") {
    return new Set([
      "await", "case", "delete", "do", "else", "in", "instanceof", "new",
      "of", "return", "throw", "typeof", "void", "yield"
    ]).has(previous.value);
  }
  return new Set([
    "(", "[", "{", ",", ";", ":", "=", "!", "~", "?", "+", "-", "*",
    "%", "&", "|", "^", "<", ">"
  ]).has(previous.value);
}

function skipRegexLiteral(source: string, index: number): number {
  let inCharacterClass = false;
  index += 1;
  while (index < source.length) {
    const character = source[index]!;
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "[") inCharacterClass = true;
    if (character === "]") inCharacterClass = false;
    if (character === "/" && !inCharacterClass) {
      index += 1;
      while (/[A-Za-z]/.test(source[index] ?? "")) index += 1;
      return index;
    }
    if (character === "\n" || character === "\r") return index;
    index += 1;
  }
  return index;
}

function sourceTokens(source: string): SourceToken[] {
  const tokens: SourceToken[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index]!;
    const nextCharacter = source[index + 1];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && nextCharacter === "/") {
      index = source.indexOf("\n", index + 2);
      if (index === -1) break;
      continue;
    }
    if (character === "/" && nextCharacter === "*") {
      const commentEnd = source.indexOf("*/", index + 2);
      index = commentEnd === -1 ? source.length : commentEnd + 2;
      continue;
    }
    if (character === "/" && canStartRegexLiteral(tokens)) {
      index = skipRegexLiteral(source, index);
      continue;
    }
    if (character === "'" || character === '"') {
      const quote = character;
      let value = "";
      index += 1;
      while (index < source.length && source[index] !== quote) {
        const stringCharacter = source[index]!;
        if (stringCharacter === "\\") {
          value += stringCharacter;
          index += 1;
        }
        value += source[index] ?? "";
        index += 1;
      }
      if (source[index] === quote) index += 1;
      tokens.push({ kind: "string", value });
      continue;
    }
    if (character === "`") {
      index += 1;
      while (index < source.length && source[index] !== "`") {
        index += source[index] === "\\" ? 2 : 1;
      }
      if (source[index] === "`") index += 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      const wordStart = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index]!)) index += 1;
      tokens.push({ kind: "word", value: source.slice(wordStart, index) });
      continue;
    }
    tokens.push({ kind: "punctuation", value: character });
    index += 1;
  }
  return tokens;
}

function hasRuntimeImport(source: string, apiFilePath: string): boolean {
  const apiSourceMarker = `${sep}services${sep}api${sep}src${sep}`;
  const apiSourceOffset = apiFilePath.lastIndexOf(apiSourceMarker);
  if (apiSourceOffset === -1) return false;
  const runtimeRoot = resolve(apiFilePath.slice(0, apiSourceOffset), "services/runtime");
  const isRuntimeSpecifier = (specifier: string): boolean => {
    if (!specifier.startsWith(".")) return false;
    const importedPath = resolve(dirname(apiFilePath), specifier);
    return importedPath === runtimeRoot || importedPath.startsWith(`${runtimeRoot}${sep}`);
  };
  const tokens = sourceTokens(source);
  return tokens.some((token, index) => {
    if (token.kind !== "string" || !isRuntimeSpecifier(token.value)) return false;
    const previous = tokens[index - 1];
    const beforePrevious = tokens[index - 2];
    const isBareImportCall = previous?.value === "("
      && beforePrevious?.value === "import"
      && tokens[index - 3]?.value !== ".";
    const isBareRequireCall = previous?.value === "("
      && beforePrevious?.value === "require"
      && tokens[index - 3]?.value !== ".";
    return previous?.value === "from"
      || previous?.value === "import"
      || isBareImportCall
      || isBareRequireCall;
  });
}

describe("createApiIllustrationApplication", () => {
  it("14a3: keeps every production API TypeScript module free of runtime imports", async () => {
    const apiRoot = dirname(new URL("../../services/api/src/illustration-application-adapter.ts", import.meta.url).pathname);
    const productionFiles = await productionTypeScriptFiles(apiRoot);

    // The scan intentionally excludes test and generated output only. Every
    // hand-authored production .ts module under services/api is a boundary.
    expect(productionFiles.length).toBeGreaterThan(0);
    const sources = await Promise.all(productionFiles.map(async (file) => ({
      file: relative(apiRoot, file),
      path: file,
      source: await readFile(file, "utf8")
    })));

    expect(sources.filter(({ path, source }) => hasRuntimeImport(source, path)))
      .toEqual([]);
  });

  it("recognizes every TypeScript import form that resolves from API source into runtime", () => {
    const apiFile = "/workspace/services/api/src/routes/illustrations.ts";
    const runtimeSpecifier = "../../../runtime/src/thing.js";

    expect(hasRuntimeImport(`import { createThing } from "${runtimeSpecifier}";`, apiFile)).toBe(true);
    expect(hasRuntimeImport(`export { createThing } from "${runtimeSpecifier}";`, apiFile)).toBe(true);
    expect(hasRuntimeImport(`import Runtime = require("${runtimeSpecifier}");`, apiFile)).toBe(true);
    expect(hasRuntimeImport(`const runtime = require("${runtimeSpecifier}");`, apiFile)).toBe(true);
    expect(hasRuntimeImport(`await import("${runtimeSpecifier}");`, apiFile)).toBe(true);
  });

  it("does not mistake comments, ordinary strings, or non-runtime imports for a runtime dependency", () => {
    const apiFile = "/workspace/services/api/src/routes/illustrations.ts";
    const runtimeSpecifier = "../../../runtime/src/thing.js";

    expect(hasRuntimeImport(`// import runtime from "${runtimeSpecifier}";`, apiFile)).toBe(false);
    expect(hasRuntimeImport(`const example = 'require("${runtimeSpecifier}")';`, apiFile)).toBe(false);
    expect(hasRuntimeImport('import { createThing } from "../../shared/src/thing.js";', apiFile)).toBe(false);
    expect(hasRuntimeImport('await import("runtime");', apiFile)).toBe(false);
  });

  it("does not treat member import calls or regex literal bodies as module imports", () => {
    const apiFile = "/workspace/services/api/src/routes/illustrations.ts";
    const runtimeSpecifier = "../../../runtime/src/thing.js";

    expect(hasRuntimeImport(`object.import("${runtimeSpecifier}");`, apiFile)).toBe(false);
    expect(hasRuntimeImport(`const pattern = /import\\("${runtimeSpecifier}"\\)/;`, apiFile)).toBe(false);
  });

  it("terminates while scanning the production server source", async () => {
    const serverPath = new URL("../../services/api/src/server.ts", import.meta.url).pathname;

    await expect(Promise.race([
      readFile(serverPath, "utf8").then((source) => hasRuntimeImport(source, serverPath)),
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error("runtime import scan did not terminate")),
        250,
      )),
    ])).resolves.toBe(false);
  });

  it("14a3: exposes no callable retired API illustration job service", async () => {
    const retiredServices = [
      "../../services/api/src/image-service.ts",
      "../../services/api/src/illustration-resolution-service.ts",
      "../../services/api/src/segmented-illustration-service.ts",
    ];

    await Promise.all(retiredServices.map((path) => expect(access(
      new URL(path, import.meta.url),
    )).rejects.toMatchObject({ code: "ENOENT" })));
  });

  it("constructs the split repositories and application once without querying eagerly", () => {
    const query = vi.fn();
    const pool = { query } as unknown as DatabasePool;
    const repositories = {} as IllustrationApplicationDependencies;
    const application = {} as IllustrationApplication;
    const factories = {
      createRepositories: vi.fn(() => repositories),
      createApplication: vi.fn(() => application)
    } satisfies ApiIllustrationCompositionFactories;

    expect(createApiIllustrationApplication(pool, factories)).toBe(application);
    expect(factories.createRepositories).toHaveBeenCalledOnce();
    expect(factories.createRepositories).toHaveBeenCalledWith(pool);
    expect(factories.createApplication).toHaveBeenCalledOnce();
    expect(factories.createApplication).toHaveBeenCalledWith(repositories);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("createIllustrationWorkerExecutor", () => {
  it("runs prompt, resolution, and image lanes in priority order and stops after one claim", async () => {
    const prompt = vi.fn(async () => false);
    const resolution = vi.fn(async () => true);
    const image = vi.fn(async () => true);
    const executor = createIllustrationWorkerExecutor({
      runPromptHandler: prompt,
      runResolutionHandler: resolution,
      runImageHandler: image
    } as never);
    const request = { workerId: "worker-a", leaseSeconds: 30 };

    await expect(executor.runNextIllustration(request)).resolves.toBe(true);
    expect(prompt).toHaveBeenCalledWith(request);
    expect(resolution).toHaveBeenCalledWith(request);
    expect(image).not.toHaveBeenCalled();
  });

  it("reaches the image lane only when prompt and resolution have no work", async () => {
    const order: string[] = [];
    const lanes: IllustrationWorkerLanes = {
      prompt: async () => { order.push("prompt"); return false; },
      resolution: async () => { order.push("resolution"); return false; },
      image: async () => { order.push("image"); return false; }
    };

    await expect(createIllustrationWorkerExecutor({
      runPromptHandler: lanes.prompt,
      runResolutionHandler: lanes.resolution,
      runImageHandler: lanes.image
    } as never).runNextIllustration({
      workerId: "worker-b",
      leaseSeconds: 45
    })).resolves.toBe(false);
    expect(order).toEqual(["prompt", "resolution", "image"]);
  });
});

describe("createWorkerIllustrationApplication", () => {
  it("14a3: owns the live illustration lane without importing the retired API job services", async () => {
    const source = await readFile(
      new URL("../../services/runtime/src/illustration-composition.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain('from "../../api/src/illustration-image-job-adapter.js"');
    expect(source).not.toContain('from "../../api/src/illustration-resolution-job-adapter.js"');
    expect(source).not.toContain('from "../../api/src/illustration-segment-job-adapter.js"');
  });

  it("binds concrete provider, artifact, and asset ports into the separate worker application", () => {
    const pool = {} as DatabasePool;
    const store = { root: "/var/lib/infinitequest/assets" };
    const lanes = {} as IllustrationWorkerLanes;
    const executor = {} as IllustrationWorkerExecutor;
    const ports = {
      imageProvider: { executeImage: vi.fn() },
      promptRefinement: { refinePrompt: vi.fn() },
      artifactDownload: { downloadArtifact: vi.fn() },
      assets: {
        persistTurnIllustration: vi.fn(),
        persistWorldCover: vi.fn(),
        bindSegmentAsset: vi.fn()
      }
    };
    const state = {} as IllustrationWorkerStateMachinePort;
    const application = {} as IllustrationWorkerApplication;
    const factories = {
      createLanes: vi.fn(() => lanes),
      createState: vi.fn(() => state),
      createExecutor: vi.fn(() => executor),
      createApplication: vi.fn(() => application),
      createPorts: vi.fn(() => ports)
    } as unknown as WorkerIllustrationCompositionFactories;

    expect(createWorkerIllustrationApplication(
      pool,
      "credential-secret",
      store,
      factories
    )).toBe(application);
    expect((factories as unknown as { createPorts: ReturnType<typeof vi.fn> }).createPorts)
      .toHaveBeenCalledWith(pool, "credential-secret", store);
    expect(factories.createLanes).toHaveBeenCalledWith(pool, "credential-secret", store);
    expect(factories.createState).toHaveBeenCalledWith(pool, lanes);
    expect(factories.createExecutor).toHaveBeenCalledWith(state);
    expect(factories.createApplication).toHaveBeenCalledWith({ executor, ports, state });
  });
});

describe("createIllustrationWorkerStateMachine", () => {
  it("preserves prompt, resolution, and image family-specific claim and retry SQL semantics", async () => {
    const statements: Array<Readonly<{ text: string; values: readonly unknown[] | undefined }>> = [];
    const claimedRow = {
      id: "job-1",
      owner_user_id: "owner-1",
      campaign_id: "campaign-1",
      turn_id: "turn-1",
      world_id: null,
      attempts: 1,
      max_attempts: 3
    };
    const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
      statements.push({ text, values });
      if (text.includes("RETURNING")) return { rows: [claimedRow], rowCount: 1 };
      if (text.includes("AS prompt")) {
        return {
          rows: [{ prompt: "A lantern-lit archive", provider_profile_id: null, requested_model: null }],
          rowCount: 1
        };
      }
      if (text.includes("SELECT id, owner_user_id")) return { rows: [claimedRow], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn(async () => client), query } as unknown as DatabasePool;
    const state = createIllustrationWorkerStateMachine(pool, {
      prompt: vi.fn(async () => false),
      resolution: vi.fn(async () => false),
      image: vi.fn(async () => false)
    });
    const request = { workerId: "worker-1", leaseSeconds: 45 };
    const scope = {
      jobId: "job-1",
      ownerUserId: "owner-1",
      workerId: "worker-1",
      leaseSeconds: 45,
      family: "resolution" as const
    };

    await expect(state.claimNextPromptJob(request)).resolves.toMatchObject({ ...scope, family: "prompt" });
    await expect(state.claimNextResolutionJob(request)).resolves.toMatchObject(scope);
    await expect(state.claimNextImageJob(request)).resolves.toMatchObject({ ...scope, family: "image" });
    await expect(state.loadClaimedJob(scope)).resolves.toMatchObject(scope);
    await expect(state.heartbeatClaim(scope)).resolves.toBe(true);
    await expect(state.transitionClaim(scope, {
      status: "recoverable",
      metadata: { code: "matching_failed", message: "retry later" }
    })).resolves.toBe(true);
    await expect(state.scheduleRetry(scope, {
      code: "matching_failed",
      message: "retry later",
      retryAt: "2026-08-04T12:00:00.000Z"
    })).resolves.toBe(true);
    await expect(state.resolvePrompt(scope)).resolves.toEqual({
      prompt: "A lantern-lit archive",
      providerProfileId: null,
      model: null
    });

    const familyStatements = statements.filter(({ text }) => text.includes("illustration_resolution_jobs"));
    expect(familyStatements).toHaveLength(6);
    const promptClaim = statements.find(({ text }) => text.includes("UPDATE illustration_prompt_jobs jobs"));
    const resolutionClaim = familyStatements[0];
    const imageClaim = statements.find(({ text }) => text.includes("UPDATE image_jobs jobs"));
    expect(promptClaim?.text).toMatch(/ORDER BY created_at\s+FOR UPDATE SKIP LOCKED LIMIT 1/);
    expect(resolutionClaim?.text).toContain("ORDER BY created_at ASC");
    expect(resolutionClaim?.text).toContain("reason_code = NULL");
    expect(imageClaim?.text).toContain("ORDER BY COALESCE(next_poll_at, next_attempt_at), created_at");
    expect(resolutionClaim?.text).not.toContain("next_poll_at");
    for (const statement of familyStatements.slice(1)) {
      expect(statement.text).toContain("owner_user_id");
      expect(statement.text).toContain("lease_owner");
      expect(statement.text).toContain("lease_expires_at >= now()");
      expect(statement.values).toEqual(expect.arrayContaining(["job-1", "owner-1", "worker-1"]));
    }
    expect(familyStatements.map(({ text }) => text).join("\n")).not.toContain("error_code");
    expect(familyStatements.map(({ text }) => text).join("\n")).not.toContain("error_message");

    const recoverableTransition = familyStatements.find(({ text }) => text.includes("SET status = $4"));
    expect(recoverableTransition?.values?.[5]).toBe(false);
    expect(recoverableTransition?.text).toContain("completed_at = CASE WHEN $6 THEN now() ELSE NULL END");
    expect(recoverableTransition?.text).toContain("lease_owner = CASE WHEN $6 THEN NULL ELSE lease_owner END");
    expect(recoverableTransition?.text).toContain("lease_expires_at = CASE WHEN $6 THEN NULL ELSE lease_expires_at END");

    const retry = familyStatements.find(({ text }) => text.includes("SET status = 'queued'"));
    expect(retry?.text).toContain("completed_at = NULL");
    expect(retry?.text).toContain("status IN ($7, 'recoverable')");
    expect(retry?.text).toContain("lease_owner = NULL");
    expect(retry?.text).toContain("lease_expires_at = NULL");
  });
});
