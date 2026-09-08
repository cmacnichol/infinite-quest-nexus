import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerAuthoringRoutes } from "../../services/api/src/authoring-routes.js";

const OWNER = "00000000-0000-4000-8000-000000000001";
const FOREIGN_OWNER = "00000000-0000-4000-8000-000000000002";
const JOB = "00000000-0000-4000-8000-000000000003";

function view(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB,
    kind: "world_concept" as const,
    revision: 0,
    status: "queued" as const,
    target: { kind: "new_world" as const },
    stages: [],
    expiresAt: "2026-09-13T00:00:00.000Z",
    canApply: false,
    incomplete: true,
    request: {
      kind: "world_concept" as const,
      idempotencyKey: "route-test-key",
      target: { kind: "new_world" as const },
      prompt: "Create a safe durable proposal."
    },
    ...overrides
  };
}

async function server(options: { enabled?: boolean; submit?: () => Promise<unknown> } = {}) {
  const app = Fastify();
  await app.register(registerAuthoringRoutes, {
    enabled: options.enabled ?? true,
    resolveOwner: async () => ({ ownerUserId: OWNER }),
    acquireAdmission: async () => ({ allowed: true as const, leaseId: null, remaining: 1, expiresAt: new Date() }),
    application: {
      submit: async () => options.submit ? options.submit() as never : view() as never,
      get: async (_scope: unknown, id: string) => id === JOB ? view() : null,
      list: async () => ({ jobs: [] }),
      review: async () => view(),
      reviewSourceFacts: async () => view(),
      startSourceSynthesis: async () => view(),
      retry: async () => view(),
      cancel: async () => view(),
      discard: async () => undefined,
      apply: async () => { throw Object.assign(new Error("unavailable"), { code: "authoring_apply_unavailable" }); }
    }
  });
  return app;
}

describe("authoring HTTP commands", () => {
  it("accepts a strictly scoped submission and rejects browser owner spoofing", async () => {
    const app = await server();
    try {
      const accepted = await app.inject({
        method: "POST",
        url: "/api/v1/authoring/jobs",
        payload: { kind: "world_concept", idempotencyKey: "route-test-key", target: { kind: "new_world" }, prompt: "Create a safe durable proposal." }
      });
      expect(accepted.statusCode).toBe(202);
      expect(accepted.json()).toMatchObject({ id: JOB, kind: "world_concept" });

      const spoofed = await app.inject({
        method: "POST",
        url: "/api/v1/authoring/jobs",
        payload: { kind: "world_concept", idempotencyKey: "route-test-key", target: { kind: "new_world" }, prompt: "Create a safe durable proposal.", ownerUserId: FOREIGN_OWNER }
      });
      expect(spoofed.statusCode).toBe(400);
    } finally { await app.close(); }
  });

  it("accepts source submission at the explicit durable endpoint", async () => {
    const app = await server();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/authoring/source-jobs",
        payload: { kind: "story_source", idempotencyKey: "source-route-key", target: { kind: "new_world" }, name: "chapter.txt", text: "Iris crossed the bridge.", mode: "faithful", boundaryParagraphId: "paragraph:0", instructions: "Keep contradictions." }
      });
      expect(response.statusCode).toBe(202);
    } finally { await app.close(); }
  });

  it("returns a fixed safe failure rather than a raw authoring exception", async () => {
    const marker = "authoring-private-content-and-credential";
    const app = await server({ submit: async () => { throw new Error(marker); } });
    const errorLogs: unknown[] = [];
    app.addHook("onRequest", async (request) => {
      (request.log as unknown as { error: (...values: unknown[]) => void }).error = (...values) => errorLogs.push(values);
    });
    try {
      const response = await app.inject({ method: "POST", url: "/api/v1/authoring/jobs", payload: { kind: "world_concept", idempotencyKey: "safe-error", target: { kind: "new_world" }, prompt: "Create a safe durable proposal." } });
      expect(response.statusCode).toBe(500);
      expect(response.payload).not.toContain(marker);
      expect(JSON.stringify(errorLogs)).not.toContain(marker);
    } finally { await app.close(); }
  });

  it("keeps durable submission disabled until the rollout switch is enabled", async () => {
    const app = await server({ enabled: false });
    try {
      const capabilities = await app.inject({ method: "GET", url: "/api/v1/authoring/capabilities" });
      expect(capabilities.statusCode).toBe(200);
      expect(capabilities.json()).toMatchObject({ enabled: false });
      const response = await app.inject({ method: "POST", url: "/api/v1/authoring/jobs", payload: { kind: "world_concept", idempotencyKey: "disabled", target: { kind: "new_world" }, prompt: "Create a safe durable proposal." } });
      expect(response.statusCode).toBe(503);
    } finally { await app.close(); }
  });

  it("registers revision-safe management commands with strict shared request envelopes", async () => {
    const app = await server();
    try {
      expect((await app.inject({ method: "GET", url: "/api/v1/authoring/jobs" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: `/api/v1/authoring/jobs/${JOB}` })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: `/api/v1/authoring/jobs/${JOB}/retry`, payload: { stageId: "stage", expectedRevision: 0 } })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: `/api/v1/authoring/jobs/${JOB}/cancel`, payload: { expectedRevision: 0 } })).statusCode).toBe(200);
      expect((await app.inject({ method: "DELETE", url: `/api/v1/authoring/jobs/${JOB}`, payload: { expectedRevision: 0 } })).statusCode).toBe(204);
      expect((await app.inject({ method: "PUT", url: `/api/v1/authoring/jobs/${JOB}/review`, payload: { unexpected: true } })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: `/api/v1/authoring/jobs/${JOB}/apply`, payload: { unexpected: true } })).statusCode).toBe(400);
    } finally { await app.close(); }
  });
});
