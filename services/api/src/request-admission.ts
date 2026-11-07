import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabasePool, RuntimeConfig } from "../../../packages/database/src/index.js";
import { initialOwnerId } from "../../../packages/database/src/pool.js";
import { acquireAdmission, releaseAdmission, type AdmissionPolicy } from "./admission-service.js";
export type RequestAdmissionPort = {acquire:typeof acquireAdmission;release:typeof releaseAdmission};
const PROVIDER_POST = new Set([
  "/api/v1/provider-text/generate", "/api/v1/providers/discover-models",
  "/api/v1/providers/discover-presets", "/api/v1/providers/resolve-preset"
]);
const PROVIDER_GET = new Set([
  "/api/v1/providers/:providerId/models", "/api/v1/providers/:providerId/presets",
  "/api/v1/providers/:providerId/presets/:slug"
]);
const IMPORT_POST = new Set([
  "/api/v1/imports/legacy-story/preview", "/api/v1/imports/legacy-story",
  "/api/v1/imports/world/preview", "/api/v1/imports/world",
  "/api/v1/imports/infinite-worlds/preview", "/api/v1/imports/infinite-worlds",
  "/api/v1/imports/campaign-archive/preview", "/api/v1/imports/campaign-archive"
]);
const GENERATION_POST = new Set([
  "/api/v1/worlds/generate-preview", "/api/v1/worlds/playable-characters/generate-preview",
  "/api/v1/worlds/:worldId/draft/playable-characters/generate",
  "/api/v1/worlds/:worldId/draft/playable-characters/organize",
  "/api/v1/campaigns/:campaignId/character-profile/organize",
  "/api/v1/campaigns/:campaignId/turn-input/classify", "/api/v1/campaigns/:campaignId/generations",
  "/api/v1/campaigns/:campaignId/generations/retry-latest", "/api/v1/generation-jobs/:jobId/retry"
]);
export function requestOperation(method:string, route:string):AdmissionPolicy["key"]|null {
  if ((method==="POST" && PROVIDER_POST.has(route)) || (method==="GET" && PROVIDER_GET.has(route))) return "provider";
  if (method==="POST" && IMPORT_POST.has(route)) return "import";
  if (method==="POST" && GENERATION_POST.has(route)) return "generation";
  return null;
}
export function installRequestAdmission(app:FastifyInstance,pool:DatabasePool,config:RuntimeConfig,port:RequestAdmissionPort={acquire:acquireAdmission,release:releaseAdmission}):void {
  const leases=new WeakMap<FastifyRequest,string>();
  const releases=new WeakMap<FastifyRequest,Promise<void>>();
  const release=async(request:FastifyRequest)=>{
    const pending=releases.get(request);
    if (pending) return pending;
    const lease=leases.get(request);
    if (!lease) return;
    leases.delete(request);
    const completion=port.release(pool,lease);
    releases.set(request,completion);
    await completion;
  };
  app.addHook("onRequest",async(request,reply)=>{
    const key=requestOperation(request.method,request.routeOptions.url ?? "");
    if (!key) return;
    const length=request.headers["content-length"];
    if (length !== undefined && /^\d+$/.test(length) && Number(length)>request.routeOptions.bodyLimit) {
      throw Object.assign(new Error("Request body is too large."),{statusCode:413,code:"FST_ERR_CTP_BODY_TOO_LARGE"});
    }
    if (key === "import" && request.headers["content-type"]?.startsWith("multipart/form-data")) {
      // Multipart consumes IncomingMessage directly, bypassing Fastify's raw-body
      // parser. Observe bytes before its pipe forwards a chunk to field buffers.
      let received=0;
      const count=(chunk:Buffer)=>{
        received+=chunk.byteLength;
        if (received<=request.routeOptions.bodyLimit) return;
        request.raw.off("data",count);
        request.raw.unpipe();
        const error=Object.assign(new Error("Request body is too large."),{statusCode:413,code:"FST_ERR_CTP_BODY_TOO_LARGE"});
        reply.code(413).send(error);
        request.raw.emit("error",error);
        request.raw.resume();
      };
      // Do not put the request into flowing mode while admission or other
      // async ingress hooks are still running. Attach when the parser subscribes.
      const observing=(event:string|symbol)=>{
        if(event!=="data") return;
        request.raw.off("newListener",observing);
        request.raw.prependListener("data",count);
      };
      request.raw.on("newListener",observing);
      reply.raw.once("close",()=>{request.raw.off("data",count);request.raw.off("newListener",observing);});
    }
    const limits=config.security;
    const decision=await port.acquire(pool,await initialOwnerId(pool),randomUUID(),{
      key,windowSeconds:limits.apiRateLimitWindowSeconds,
      maxRequests:key==="provider"?limits.apiRateLimitProviderRequests:key==="import"?limits.apiRateLimitImportRequests:limits.apiRateLimitGenerationRequests,
      maxConcurrent:key==="provider"?limits.apiConcurrencyProviderRequests:key==="import"?limits.apiConcurrencyImportRequests:null,
      leaseSeconds:config.workerLeaseSeconds
    });
    if (!decision.allowed) return reply.header("Retry-After",String(decision.retryAfterSeconds)).code(429).send({code:"request_rate_limited",message:"Try again shortly."});
    if (decision.leaseId) {
      leases.set(request,decision.leaseId);
      // Keep capacity through streaming completion; disconnects also release it.
      reply.raw.once("close",()=>{void release(request).catch(error=>request.log.error({err:error},"admission_release_failed"));});
      if (request.raw.aborted || reply.raw.destroyed) await release(request);
    }
  });
  app.addHook("onResponse",release);
  app.addHook("onRequestAbort",release);
}
