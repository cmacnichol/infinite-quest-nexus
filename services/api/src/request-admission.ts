import { LEGACY_STORY_IMPORT_PATH, LEGACY_STORY_PREVIEW_PATH } from "../../../packages/contracts/src/imports.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabasePool, RuntimeConfig } from "../../../packages/database/src/index.js";
import { initialOwnerId } from "../../../packages/database/src/pool.js";
import { acquireAdmission, releaseAdmission, renewAdmission, AdmissionControlUnavailableError, type AdmissionPolicy } from "./admission-service.js";
export type RequestAdmissionPort = {acquire:typeof acquireAdmission;release:typeof releaseAdmission;renew?:typeof renewAdmission};
const PROVIDER_POST = new Set([
  "/api/v1/provider-text/generate", "/api/v1/providers/discover-models",
  "/api/v1/providers/discover-presets", "/api/v1/providers/resolve-preset"
]);
const PROVIDER_GET = new Set([
  "/api/v1/providers/:providerId/models", "/api/v1/providers/:providerId/presets",
  "/api/v1/providers/:providerId/presets/:slug"
]);
const IMPORT_POST = new Set([
  LEGACY_STORY_PREVIEW_PATH, LEGACY_STORY_IMPORT_PATH,
  "/api/v1/imports/world/preview", "/api/v1/imports/world",
  "/api/v1/imports/infinite-worlds/preview", "/api/v1/imports/infinite-worlds",
  "/api/v1/imports/campaign-archive/preview", "/api/v1/imports/campaign-archive"
]);
const generationRouteIds = z.object({ worldId: z.uuid().optional(), campaignId: z.uuid().optional(), jobId: z.uuid().optional() });
const GENERATION_POST = new Set([
  "/api/v1/worlds/generate-preview", "/api/v1/worlds/playable-characters/generate-preview",
  "/api/v1/worlds/:worldId/draft/playable-characters/generate",
  "/api/v1/worlds/:worldId/draft/playable-characters/organize",
  "/api/v1/campaigns/:campaignId/character-profile/organize",
  "/api/v1/campaigns/:campaignId/turn-input/classify", "/api/v1/campaigns/:campaignId/generations",
  "/api/v1/campaigns/:campaignId/generations/retry-latest", "/api/v1/generation-jobs/:jobId/retry"
]);
export function requestOperation(method:string, route:string):AdmissionPolicy["key"]|null {
  if ((method==="POST" && PROVIDER_POST.has(route)) || (["GET","HEAD"].includes(method) && PROVIDER_GET.has(route))) return "provider";
  if (method==="POST" && IMPORT_POST.has(route)) return "import";
  if (method==="POST" && GENERATION_POST.has(route)) return "generation";
  return null;
}
export function installRequestAdmission(app:FastifyInstance,pool:DatabasePool,config:RuntimeConfig,port:RequestAdmissionPort={acquire:acquireAdmission,release:releaseAdmission}):{isReady():boolean} {
  type State = {leaseId:string;owner:string;requestId:string;key:AdmissionPolicy["key"];pendingHandlers:number;responseEnded:boolean;released:boolean;timer:ReturnType<typeof setTimeout>|null;renewal:Promise<void>;done:Promise<void>;finish:()=>void};
  const states=new WeakMap<FastifyRequest,State>();
  const active=new Set<State>();
  let unavailable=false;
  const release=async(request:FastifyRequest)=>{
    const state=states.get(request);
    if(!state || state.released || !state.responseEnded || state.pendingHandlers>0)return;
    state.released=true;
    if(state.timer)clearTimeout(state.timer);
    try{await state.renewal;await port.release(pool,state.leaseId);}
    catch(error){unavailable=true;request.log.error({err:error},"admission_release_failed");}
    finally{active.delete(state);state.finish();}
  };
  // Handler lifetime and socket lifetime are independent: an upstream call may
  // ignore disconnection. Never return its capacity before its promise settles.
  app.addHook("onRoute",options=>{
    const methods=Array.isArray(options.method)?options.method:[options.method];
    if(!methods.some(method=>requestOperation(method,options.url)))return;
    const handler=options.handler;
    options.handler=async function(request,reply){
      const state=states.get(request);
      if(state)state.pendingHandlers++;
      try {
        if(state?.responseEnded)return;
        return await handler.call(this,request,reply);
      }finally{
        if(state)state.pendingHandlers--;
        await release(request);
      }
    };
  });
  app.addHook("onRequest",async(request,reply)=>{
    const key=requestOperation(request.method,request.routeOptions.url ?? "");
    if (!key) return;
    if(unavailable)throw new AdmissionControlUnavailableError();
    const length=request.headers["content-length"];
    if (length !== undefined && /^\d+$/.test(length) && Number(length)>request.routeOptions.bodyLimit) {
      throw Object.assign(new Error("Request body is too large."),{statusCode:413,code:"FST_ERR_CTP_BODY_TOO_LARGE"});
    }
    if (key === "import" && request.headers["content-type"]?.split(";",1)[0]?.trim().toLowerCase()==="multipart/form-data") {
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
    // Invalid path IDs must not resolve an owner or consume a request from their budget.
    if (key === "generation") generationRouteIds.parse(request.params);
    const limits=config.security;
    const owner=await initialOwnerId(pool),requestId=randomUUID();
    const decision=await port.acquire(pool,owner,requestId,{
      key,windowSeconds:limits.apiRateLimitWindowSeconds,
      maxRequests:key==="provider"?limits.apiRateLimitProviderRequests:key==="import"?limits.apiRateLimitImportRequests:limits.apiRateLimitGenerationRequests,
      maxConcurrent:key==="provider"?limits.apiConcurrencyProviderRequests:key==="import"?limits.apiConcurrencyImportRequests:null,
      durableRequest:key!=="generation",
      leaseSeconds:config.workerLeaseSeconds
    });
    if (!decision.allowed) return reply.header("Retry-After",String(decision.retryAfterSeconds)).code(429).send({code:"request_rate_limited",message:"Try again shortly."});
    if (decision.leaseId) {
      let finish!:()=>void;
      const done=new Promise<void>(resolve=>{finish=resolve;});
      const state:State={leaseId:decision.leaseId,owner,requestId,key,pendingHandlers:0,responseEnded:false,released:false,timer:null,renewal:Promise.resolve(),done,finish};
      states.set(request,state);active.add(state);
      const ended=()=>{state.responseEnded=true;void release(request);};
      reply.raw.once("close",ended);
      request.raw.once("aborted",ended);
      const renew=()=>{
        if(state.released||unavailable)return;
        state.renewal=(port.renew??renewAdmission)(pool,state.leaseId,owner,requestId,key,config.workerLeaseSeconds).catch(()=>{
          unavailable=true;
          if(!reply.sent)reply.code(503).send({code:"ADMISSION_CONTROL_UNAVAILABLE"});
          else if(!reply.raw.writableEnded)reply.raw.destroy();
        }).finally(()=>{
          if(!state.released&&!unavailable){state.timer=setTimeout(renew,Math.max(25,config.workerLeaseSeconds*1000/3));state.timer.unref();}
        });
      };
      state.timer=setTimeout(renew,Math.max(25,config.workerLeaseSeconds*1000/3));state.timer.unref();
      if(request.raw.aborted||reply.raw.destroyed){state.responseEnded=true;await release(request);}
    }
  });
  app.addHook("onResponse",async request=>{const state=states.get(request);if(state)state.responseEnded=true;await release(request);});
  app.addHook("onClose",async()=>{await Promise.all([...active].map(state=>state.done));});
  return {isReady:()=>!unavailable};
}
