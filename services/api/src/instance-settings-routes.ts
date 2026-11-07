import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { settingsRevisionSchema, settingsOperatorSessionRequestSchema, instanceSettingsPatchSchema, localSettingsRestartRequestSchema, localSettingsRestartOperationSchema, type LocalSettingsRestartOperation } from "../../../packages/contracts/src/instance-settings.js";
import { SettingsConflictError } from "../../../packages/application/src/settings/index.js";
import { SettingsHttpError, type SettingsOperatorSessionPort } from "./settings-operator-session.js";
import { OriginNotAllowedError } from "./request-security.js";

const COOKIE = "iq_settings_operator";
const COOKIE_OPTIONS = "Path=/api/v1/settings; HttpOnly; Secure; SameSite=Strict";
const MANAGEMENT_BODY_LIMIT = 65536;
function cookie(request: FastifyRequest): string {
  const values = (request.headers.cookie ?? "").split(";")
    .map(part => part.trim()).filter(part => part.startsWith(`${COOKIE}=`));
  return values.length === 1 ? values[0]!.slice(COOKIE.length + 1) : "";
}
export type LocalSettingsRestartPort = {
  isDraining(): boolean;
  start(revision: string, operationId: string): Promise<LocalSettingsRestartOperation>;
  status(operationId: string): Promise<LocalSettingsRestartOperation>;
};
export type InstanceSettingsHttpPort = {
  read(): Promise<unknown>;
  patch(input: unknown, actor: import("../../../packages/application/src/settings/index.js").SettingsActor): Promise<unknown>;
  history(cursor: string | undefined, limit: number): Promise<unknown>;
};
export function registerInstanceSettingsRoutes(app: FastifyInstance, options: {
  settings: InstanceSettingsHttpPort;
  operatorSessions: SettingsOperatorSessionPort;
  resolveActor(request: FastifyRequest): Promise<string>;
  enabled(): boolean;
  accessMode?: "local-single-user" | "protected" | undefined;
  localSettingsRestart?: LocalSettingsRestartPort | undefined;
}): void {
  app.register(async scope => {
    scope.setErrorHandler((error, _request, reply) => {
      if (error instanceof SettingsConflictError) {
        return reply.code(409).send({ code: "settings_conflict", currentRevision: error.currentRevision });
      }
      if (error instanceof Error && ["settings_restart_id_conflict", "settings_revision_already_active"].includes(error.message)) return reply.code(409).send({ code: error.message });
      if (error instanceof Error && error.message === "settings_restart_not_found") return reply.code(404).send({ code: "settings_restart_not_found" });
      if (error instanceof OriginNotAllowedError) {
        return reply.code(403).send({ code: "settings_origin_invalid" });
      }
      if (error instanceof SettingsHttpError) {
        return reply.code(error.statusCode).send({ code: error.code });
      }
      if (error instanceof z.ZodError) {
        return reply.code(422).send({ code: "settings_input_invalid" });
      }
      if (error instanceof Error && "code" in error) {
        if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
          return reply.code(413).send({ code: "settings_body_too_large" });
        }
        if (["FST_ERR_CTP_INVALID_JSON_BODY", "FST_ERR_CTP_EMPTY_JSON_BODY", "FST_ERR_CTP_INVALID_MEDIA_TYPE"].includes(String(error.code))) {
          return reply.code(422).send({ code: "settings_input_invalid" });
        }
      }
      return reply.code(503).send({ code: "settings_unavailable" });
    });
    scope.addHook("onRequest", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (options.accessMode === "local-single-user") {
        // Never trust proxy metadata in local mode, including when Fastify trusts a proxy.
        if (Object.keys(request.headers).some(name => name === "forwarded" || name.startsWith("x-forwarded-") || name === "x-real-ip")) throw new SettingsHttpError(403, "settings_local_authority_invalid");
        const host = request.headers.host ?? "";
        if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::(?:[1-9]\d{0,4}))?$/.test(host)) throw new SettingsHttpError(403, "settings_local_authority_invalid");
        const expectedOrigin = `http://${host}`;
        if (request.protocol !== "http" || (request.headers.origin !== undefined && request.headers.origin !== expectedOrigin)) throw new SettingsHttpError(403, "settings_origin_invalid");
        if (request.headers["sec-fetch-site"] === "cross-site") throw new SettingsHttpError(403, "settings_origin_invalid");
        if (request.method !== "GET" && (request.headers.origin !== expectedOrigin || request.headers["x-settings-local"] !== "1")) throw new SettingsHttpError(403, "settings_origin_invalid");
        return;
      }
      if (request.protocol !== "https") throw new SettingsHttpError(403, "settings_https_required");
      // Read-only same-origin browser GETs may omit Origin; all supplied origins remain exact.
      const requiresOrigin = request.method !== "GET" || request.headers.origin !== undefined;
      if (requiresOrigin && request.headers.origin !== `https://${request.headers.host}`) {
        throw new SettingsHttpError(403, "settings_origin_invalid");
      }
    });
    const enabled = () => {
      if (!options.enabled()) throw new SettingsHttpError(503, "settings_management_disabled");
    };
    const authorize = async (request: FastifyRequest, mutation = false) => {
      enabled();
      const actor = await options.resolveActor(request);
      if (options.accessMode === "local-single-user") return { userId: actor, localSingleUser: true as const };
      const csrf = request.headers["x-settings-csrf"];
      if (mutation && (typeof csrf !== "string" || !csrf)) {
        throw new SettingsHttpError(403, "settings_csrf_invalid");
      }
      const session = await options.operatorSessions.authorize(cookie(request), actor, mutation ? csrf as string : undefined);
      return { userId: actor, operatorSessionId: session.id };
    };
    const routeOptions = { bodyLimit: MANAGEMENT_BODY_LIMIT };
    scope.get("/api/v1/settings/operator-session", routeOptions, async request => {
      if (!options.enabled()) return { managementEnabled: false, unlocked: false };
      if (options.accessMode === "local-single-user") return { managementEnabled: true, unlocked: true, accessMode: "local-single-user" };
      try {
        const session = await options.operatorSessions.restore(cookie(request), await options.resolveActor(request));
        return {
          managementEnabled: true, unlocked: true,
          csrfToken: session.csrfToken, expiresAt: session.expiresAt.toISOString()
        };
      } catch (error) {
        if (error instanceof SettingsHttpError && error.statusCode === 401) {
          return { managementEnabled: true, unlocked: false };
        }
        throw error;
      }
    });
    scope.post("/api/v1/settings/operator-session", routeOptions, async (request, reply) => {
      enabled();
      if (options.accessMode === "local-single-user") throw new SettingsHttpError(404, "settings_unavailable");
      const body = settingsOperatorSessionRequestSchema.parse(request.body);
      const session = await options.operatorSessions.unlock(body.managementKey, await options.resolveActor(request), request.ip);
      reply.header("Set-Cookie", `${COOKIE}=${session.token}; ${COOKIE_OPTIONS}; Max-Age=900`);
      return { csrfToken: session.csrfToken, expiresAt: session.expiresAt.toISOString() };
    });
    scope.delete("/api/v1/settings/operator-session", routeOptions, async (request, reply) => {
      if (options.accessMode === "local-single-user") throw new SettingsHttpError(404, "settings_unavailable");
      await authorize(request, true);
      await options.operatorSessions.revoke(cookie(request), await options.resolveActor(request), request.headers["x-settings-csrf"] as string);
      reply.header("Set-Cookie", `${COOKIE}=; ${COOKIE_OPTIONS}; Max-Age=0`);
      return reply.code(204).send();
    });
    scope.get("/api/v1/settings/instance", routeOptions, async request => {
      await authorize(request);
      return options.settings.read();
    });
    scope.patch("/api/v1/settings/instance", routeOptions, async request => {
      const actor = await authorize(request, true);
      return options.settings.patch(instanceSettingsPatchSchema.parse(request.body), actor);
    });
    if (options.accessMode === "local-single-user" && options.localSettingsRestart) {
      const restart = options.localSettingsRestart;
      scope.post("/api/v1/settings/instance/restart", routeOptions, async request => {
        await authorize(request, true);
        const { expectedRequestedRevision, operationId } = localSettingsRestartRequestSchema.parse(request.body);
        return localSettingsRestartOperationSchema.parse(await restart.start(expectedRequestedRevision, operationId));
      });
      scope.get("/api/v1/settings/instance/restart/:operationId", routeOptions, async request => {
        await authorize(request);
        const { operationId } = z.object({ operationId: z.string().uuid() }).strict().parse(request.params);
        return localSettingsRestartOperationSchema.parse(await restart.status(operationId));
      });
    }
    scope.get("/api/v1/settings/instance/history", routeOptions, async request => {
      await authorize(request);
      const query = z.object({
        cursor: settingsRevisionSchema.optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50)
      }).strict().parse(request.query);
      return options.settings.history(query.cursor, query.limit);
    });
  });
}
