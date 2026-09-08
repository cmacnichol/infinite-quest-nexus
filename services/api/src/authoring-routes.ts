import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  authoringApplyReceiptSchema,
  authoringApplySchema,
  authoringCapabilitiesSchema,
  authoringJobListQuerySchema,
  authoringJobPageSchema,
  authoringJobViewSchema,
  authoringRetrySchema,
  authoringRevisionCommandSchema,
  authoringReviewSchema,
  authoringSubmitSchema,
  authoringSourceSynthesisSchema
} from "../../../packages/contracts/src/authoring.js";
import { sourceAuthoringInputSchema, sourceFactReviewSchema } from "../../../packages/contracts/src/source-authoring.js";
import { normalizeSourceDocument } from "../../../packages/domain/src/source-authoring.js";
import type { AuthoringApplication } from "../../../packages/application/src/authoring/types.js";
import { AuthoringApplicationError } from "../../../packages/application/src/authoring/types.js";
import type { OwnerScope } from "../../../packages/application/src/generation/types.js";

const MAXIMUM_INPUT_BYTES = 2 * 1024 * 1024;
const AUTHORING_BODY_LIMIT_BYTES = MAXIMUM_INPUT_BYTES + 256 * 1024;
const activeJobLimit = 5 as const;

const identifierSchema = z.string().trim().min(1).max(200);
const paramsSchema = z.object({ id: identifierSchema }).strict();

type AdmissionDecision = Readonly<{ allowed: boolean; leaseId?: string | null; retryAfterSeconds?: number }>;

export type AuthoringRoutesOptions = Readonly<{
  application: AuthoringApplication;
  enabled: boolean;
  sourceEnabled?: boolean;
  resolveOwner(): Promise<OwnerScope>;
  acquireAdmission(scope: OwnerScope): Promise<AdmissionDecision>;
  releaseAdmission?(leaseId: string): Promise<void>;
}>;

class AuthoringRouteError extends Error {
  readonly expose = true;
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}

function mapAuthoringError(error: unknown): AuthoringRouteError | null {
  if (!(error instanceof AuthoringApplicationError)) return null;
  switch (error.code) {
    case "authoring_not_found": return new AuthoringRouteError(404, error.code, "Authoring job not found.");
    case "authoring_revision_conflict": return new AuthoringRouteError(409, error.code, "The authoring job changed. Refresh and try again.");
    case "authoring_idempotency_conflict": return new AuthoringRouteError(409, error.code, "This idempotency key was already used for a different request.");
    case "authoring_input_too_large": return new AuthoringRouteError(413, error.code, "The authoring request exceeds the durable input limit.");
    case "authoring_active_job_limit": return new AuthoringRouteError(429, error.code, "Finish, cancel, or discard an existing proposal before creating another.");
    case "choose_source_facts": return new AuthoringRouteError(409, error.code, "Choose at least one supported source fact before synthesis.");
    case "authoring_apply_unavailable": return new AuthoringRouteError(409, error.code, "Applying authoring proposals is not available yet.");
    default: return new AuthoringRouteError(409, error.code, "The authoring job cannot accept that command now.");
  }
}

function unavailable(): AuthoringRouteError {
  return new AuthoringRouteError(503, "authoring_disabled", "Durable authoring jobs are not enabled.");
}

function sourceUnavailable(): AuthoringRouteError {
  return new AuthoringRouteError(503, "source_authoring_disabled", "Story-source execution is paused.");
}

function sourceEnabled(options: AuthoringRoutesOptions): boolean {
  return options.sourceEnabled !== false;
}

/** Reject an unknown boundary before it can create a durable source proposal. */
function assertSourceAdmission(input: z.infer<typeof sourceAuthoringInputSchema>): void {
  const source = normalizeSourceDocument(input.name, input.text, "source-admission");
  if (!source.paragraphs.some((paragraph) => paragraph.id === input.boundaryParagraphId)) {
    throw new AuthoringRouteError(400, "authoring_invalid_request", "The selected source boundary is invalid.");
  }
}

async function ownedSourceJob(options: AuthoringRoutesOptions, id: string): Promise<OwnerScope> {
  const scope = await options.resolveOwner();
  const job = await options.application.get(scope, id);
  if (!job) throw new AuthoringRouteError(404, "authoring_not_found", "Authoring job not found.");
  if (job.kind === "story_source" && !sourceEnabled(options)) throw sourceUnavailable();
  return scope;
}

async function command<T>(request: { log: { error(value: unknown, message?: string): void }; id: string }, reply: { code(value: number): { send(value: unknown): unknown }; header(name: string, value: string): unknown }, work: () => Promise<T>): Promise<T | unknown> {
  try { return await work(); }
  catch (error) {
    if (error instanceof AuthoringRouteError) throw error;
    if (error instanceof z.ZodError) {
      throw new AuthoringRouteError(400, "authoring_invalid_request", "The authoring request is invalid.");
    }
    const mapped = mapAuthoringError(error);
    if (mapped) throw mapped;
    request.log.error({ correlationId: request.id, code: "authoring_command_failed" }, "authoring_command_failed");
    return reply.code(500).send({ error: "Internal server error", message: "The authoring request failed. Use the correlation ID to locate server diagnostics.", correlationId: request.id, details: {} });
  }
}

async function withAdmission<T>(options: AuthoringRoutesOptions, scope: OwnerScope, reply: { code(value: number): { send(value: unknown): unknown }; header(name: string, value: string): unknown }, work: () => Promise<T>): Promise<T | unknown> {
  const admission = await options.acquireAdmission(scope);
  if (!admission.allowed) {
    if (admission.retryAfterSeconds) reply.header("Retry-After", String(admission.retryAfterSeconds));
    return reply.code(429).send({ error: "Too many requests", message: "Try again shortly.", code: "authoring_rate_limited", details: {} });
  }
  try { return await work(); }
  finally { if (admission.leaseId && options.releaseAdmission) await options.releaseAdmission(admission.leaseId); }
}

/** HTTP-only owner boundary; this module has no SQL or provider imports. */
export async function registerAuthoringRoutes(app: FastifyInstance, options: AuthoringRoutesOptions): Promise<void> {
  app.get("/api/v1/authoring/capabilities", async () => authoringCapabilitiesSchema.parse({
    enabled: options.enabled,
    supportedKinds: sourceEnabled(options) ? ["world_concept", "character", "story_source"] : ["world_concept", "character"],
    limits: { activeJobsPerOwner: activeJobLimit, maximumInputBytes: MAXIMUM_INPUT_BYTES, listPageSize: 20 }
  }));

  app.post("/api/v1/authoring/jobs", { bodyLimit: AUTHORING_BODY_LIMIT_BYTES }, async (request, reply) => command(request, reply, async () => {
    if (!options.enabled) throw unavailable();
    const input = authoringSubmitSchema.parse(request.body);
    if (input.kind === "story_source") {
      if (!sourceEnabled(options)) throw sourceUnavailable();
      assertSourceAdmission(input);
    }
    const scope = await options.resolveOwner();
    return withAdmission(options, scope, reply, async () => reply.code(202).send(authoringJobViewSchema.parse(await options.application.submit(scope, input))));
  }));

  /** Source intake has a named route so the client cannot accidentally use a concept flow. */
  app.post("/api/v1/authoring/source-jobs", { bodyLimit: AUTHORING_BODY_LIMIT_BYTES }, async (request, reply) => command(request, reply, async () => {
    if (!options.enabled) throw unavailable();
    const input = sourceAuthoringInputSchema.parse(request.body);
    if (!sourceEnabled(options)) throw sourceUnavailable();
    assertSourceAdmission(input);
    const scope = await options.resolveOwner();
    return withAdmission(options, scope, reply, async () => reply.code(202).send(authoringJobViewSchema.parse(await options.application.submit(scope, input))));
  }));

  app.get("/api/v1/authoring/jobs", async (request, reply) => command(request, reply, async () => {
    const query = authoringJobListQuerySchema.parse(request.query);
    return authoringJobPageSchema.parse(await options.application.list(await options.resolveOwner(), query.cursor));
  }));

  app.get("/api/v1/authoring/jobs/:id", async (request, reply) => command(request, reply, async () => {
    const { id } = paramsSchema.parse(request.params);
    const job = await options.application.get(await options.resolveOwner(), id);
    if (!job) throw new AuthoringRouteError(404, "authoring_not_found", "Authoring job not found.");
    return authoringJobViewSchema.parse(job);
  }));

  app.put("/api/v1/authoring/jobs/:id/review", { bodyLimit: AUTHORING_BODY_LIMIT_BYTES }, async (request, reply) => command(request, reply, async () => {
    const { id } = paramsSchema.parse(request.params);
    return authoringJobViewSchema.parse(await options.application.review(await options.resolveOwner(), id, authoringReviewSchema.parse(request.body)));
  }));

  app.put("/api/v1/authoring/source-jobs/:id/facts", { bodyLimit: AUTHORING_BODY_LIMIT_BYTES }, async (request, reply) => command(request, reply, async () => {
    const { id } = paramsSchema.parse(request.params);
    return authoringJobViewSchema.parse(await options.application.reviewSourceFacts(await options.resolveOwner(), id, sourceFactReviewSchema.parse(request.body)));
  }));

  app.post("/api/v1/authoring/source-jobs/:id/synthesis", async (request, reply) => command(request, reply, async () => {
    const { id } = paramsSchema.parse(request.params);
    const scope = await ownedSourceJob(options, id);
    return authoringJobViewSchema.parse(await options.application.startSourceSynthesis(scope, id, authoringSourceSynthesisSchema.parse(request.body).expectedRevision));
  }));

  app.post("/api/v1/authoring/jobs/:id/retry", async (request, reply) => command(request, reply, async () => {
    if (!options.enabled) throw unavailable();
    const { id } = paramsSchema.parse(request.params);
    const input = authoringRetrySchema.parse(request.body);
    const scope = await options.resolveOwner();
    const job = await options.application.get(scope, id);
    if (!job) throw new AuthoringRouteError(404, "authoring_not_found", "Authoring job not found.");
    if (job.kind === "story_source" && !sourceEnabled(options)) throw sourceUnavailable();
    return withAdmission(options, scope, reply, async () => authoringJobViewSchema.parse(await options.application.retry(scope, id, input.stageId, input.expectedRevision)));
  }));

  app.post("/api/v1/authoring/jobs/:id/cancel", async (request, reply) => command(request, reply, async () => {
    const { id } = paramsSchema.parse(request.params);
    return authoringJobViewSchema.parse(await options.application.cancel(await options.resolveOwner(), id, authoringRevisionCommandSchema.parse(request.body).expectedRevision));
  }));

  app.post("/api/v1/authoring/jobs/:id/apply", { bodyLimit: AUTHORING_BODY_LIMIT_BYTES }, async (request, reply) => command(request, reply, async () => {
    const { id } = paramsSchema.parse(request.params);
    return authoringApplyReceiptSchema.parse(await options.application.apply(await options.resolveOwner(), id, authoringApplySchema.parse(request.body)));
  }));

  app.delete("/api/v1/authoring/jobs/:id", async (request, reply) => command(request, reply, async () => {
    const { id } = paramsSchema.parse(request.params);
    await options.application.discard(await options.resolveOwner(), id, authoringRevisionCommandSchema.parse(request.body).expectedRevision);
    return reply.code(204).send();
  }));
}
