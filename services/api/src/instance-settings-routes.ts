import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { settingsRevisionSchema, settingsOperatorSessionRequestSchema, instanceSettingsPatchSchema } from "../../../packages/contracts/src/instance-settings.js";
import { SettingsConflictError } from "../../../packages/application/src/settings/index.js";
import { SettingsHttpError, type SettingsOperatorSessionPort } from "./settings-operator-session.js";
const COOKIE = "iq_settings_operator";
const cookie = (request: FastifyRequest) => {
  const values = (request.headers.cookie ?? "").split(";").map(part=>part.trim()).filter(part=>part.startsWith(`${COOKIE}=`));
  return values.length===1 ? values[0]!.slice(COOKIE.length+1) : "";
};
const cookieOptions = "Path=/api/v1/settings; HttpOnly; Secure; SameSite=Strict";
export type InstanceSettingsHttpPort = {
  read(): Promise<unknown>;
  patch(input: unknown, actor: {userId:string;operatorSessionId:string}): Promise<unknown>;
  history(cursor: string|undefined, limit: number): Promise<unknown>;
};
export function registerInstanceSettingsRoutes(app: FastifyInstance, options: {
  settings: InstanceSettingsHttpPort; operatorSessions: SettingsOperatorSessionPort;
  resolveActor(request: FastifyRequest): Promise<string>; enabled(): boolean;
}): void {
  app.register(async scope => {
    scope.setErrorHandler((error,_request,reply)=>{
      if(error instanceof SettingsConflictError) return reply.code(409).send({code:"settings_conflict",currentRevision:error.currentRevision});
      if(error instanceof SettingsHttpError) return reply.code(error.statusCode).send({code:error.code});
      if(error instanceof z.ZodError) return reply.code(422).send({code:"settings_input_invalid"});
      if(error instanceof Error && "code" in error && error.code==="FST_ERR_CTP_BODY_TOO_LARGE") return reply.code(413).send({code:"settings_body_too_large"});
      if(error instanceof Error && "code" in error && ["FST_ERR_CTP_INVALID_JSON_BODY", "FST_ERR_CTP_EMPTY_JSON_BODY", "FST_ERR_CTP_INVALID_MEDIA_TYPE"].includes(String(error.code))) return reply.code(422).send({code:"settings_input_invalid"});
      return reply.code(503).send({code:"settings_unavailable"});
    });
    scope.addHook("onRequest",async(request,reply)=>{
      reply.header("Cache-Control","no-store");
      if(request.protocol!=="https") throw new SettingsHttpError(403,"settings_https_required");
      // Require exact textual origin; configured CORS exceptions never grant operator access.
      if((request.method!=="GET" || request.headers.origin!==undefined) && request.headers.origin!==`https://${request.headers.host}`) throw new SettingsHttpError(403,"settings_origin_invalid");
    });
    const enabled=()=>{if(!options.enabled())throw new SettingsHttpError(503,"settings_management_disabled");};
    const authorize=async(request:FastifyRequest,mutation=false)=>{
      enabled();const actor=await options.resolveActor(request);
      const csrf=request.headers["x-settings-csrf"];
      if(mutation && (typeof csrf!=="string" || !csrf))throw new SettingsHttpError(403,"settings_csrf_invalid");
      const session=await options.operatorSessions.authorize(cookie(request),actor,mutation?csrf as string:undefined);
      return {userId:actor,operatorSessionId:session.id};
    };
    scope.get("/api/v1/settings/operator-session",{bodyLimit:65536},async request=>{
      if(!options.enabled())return {managementEnabled:false,unlocked:false};
      try {const session=await options.operatorSessions.restore(cookie(request),await options.resolveActor(request));return {managementEnabled:true,unlocked:true,csrfToken:session.csrfToken,expiresAt:session.expiresAt.toISOString()};}
      catch(error){if(error instanceof SettingsHttpError && error.statusCode===401)return {managementEnabled:true,unlocked:false};throw error;}
    });
    scope.post("/api/v1/settings/operator-session",{bodyLimit:65536},async(request,reply)=>{
      enabled();const body=settingsOperatorSessionRequestSchema.parse(request.body);
      const session=await options.operatorSessions.unlock(body.managementKey,await options.resolveActor(request),request.ip);
      reply.header("Set-Cookie",`${COOKIE}=${session.token}; ${cookieOptions}; Max-Age=900`);
      return {csrfToken:session.csrfToken,expiresAt:session.expiresAt.toISOString()};
    });
    scope.delete("/api/v1/settings/operator-session",{bodyLimit:65536},async(request,reply)=>{
      await authorize(request,true);
      await options.operatorSessions.revoke(cookie(request),await options.resolveActor(request),request.headers["x-settings-csrf"] as string);
      reply.header("Set-Cookie",`${COOKIE}=; ${cookieOptions}; Max-Age=0`);return reply.code(204).send();
    });
    scope.get("/api/v1/settings/instance",{bodyLimit:65536},async request=>{await authorize(request);return options.settings.read();});
    scope.patch("/api/v1/settings/instance",{bodyLimit:65536},async request=>{const actor=await authorize(request,true);return options.settings.patch(instanceSettingsPatchSchema.parse(request.body),actor);});
    scope.get("/api/v1/settings/instance/history",{bodyLimit:65536},async request=>{
      await authorize(request);const query=z.object({cursor:settingsRevisionSchema.optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).strict().parse(request.query);return options.settings.history(query.cursor,query.limit);
    });
  });
}
