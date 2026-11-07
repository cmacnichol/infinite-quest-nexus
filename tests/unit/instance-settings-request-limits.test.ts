import { describe, expect, it, vi } from "vitest";
import { resolveRequestPolicy } from "../../packages/domain/src/instance-settings.js";
import { settingsFixture } from "../fixtures/instance-settings.js";
import { runtimePolicy, bootstrap } from "../helpers/instance-settings-runtime.js";
import { resolveRuntimeSettingsState, settingsDigest } from "../../services/runtime/src/instance-settings.js";

describe("installation request policy", () => {
  it("maps all nine validated request fields and excludes deployment security", () => {
    const s = settingsFixture();
    expect(resolveRequestPolicy(s, runtimePolicy())).toEqual(Object.fromEntries(Object.entries(s).filter(([key]) => key.startsWith("api"))));
    expect(Object.keys(resolveRequestPolicy(s, runtimePolicy()))).toHaveLength(9);
  });
  it("rejects bounds and shortened windows without approved compensating counts", () => {
    const s = settingsFixture(), policy = runtimePolicy();
    expect(() => resolveRequestPolicy({...s, apiDefaultBodyLimitBytes: 1}, policy)).toThrow();
    expect(() => resolveRequestPolicy({...s, apiRateLimitWindowSeconds: s.apiRateLimitWindowSeconds / 2}, policy)).toThrow();
  });
  it("uses only active request controls while a new revision is requested", () => {
    const active = settingsFixture(), policy = runtimePolicy();
    const state = {installationId:policy.installationId, mode:"database" as const, schemaVersion:1, activeRevision:"1", requestedRevision:"2", activationEpoch:"1", active, requested:{...active, apiDefaultBodyLimitBytes: active.apiDefaultBodyLimitBytes * 2}, policyDigest:settingsDigest(policy)};
    expect(resolveRuntimeSettingsState(state, bootstrap(), policy).config.security.apiDefaultBodyLimitBytes).toBe(active.apiDefaultBodyLimitBytes);
  });
});

import { request } from "node:http";
import { buildServer } from "../../services/api/src/server.js";
import { inertStorageServerOptions } from "../helpers/build-server-options.js";
import type { DatabasePool } from "../../packages/database/src/pool.js";
describe("active Fastify ingress boundaries", () => {
  const pool = {query:async()=>({rows:[]})} as unknown as DatabasePool;
  it("accepts exact default/import bytes and rejects limit+1 before handlers", async () => {
    const config = bootstrap();
    config.logLevel="silent"; config.systemArchiveEnabled=false;
    config.security.apiDefaultBodyLimitBytes=65536;
    config.security.apiImportBodyLimitBytes=1048576;
    const app = await buildServer(inertStorageServerOptions({config,pool}));
    app.post("/body-probe",async request=>({bytes:Buffer.byteLength(request.body as string)}));
    app.post("/import-probe",{bodyLimit:config.security.apiImportBodyLimitBytes},async request=>({bytes:Buffer.byteLength(request.body as string)}));
    try {
      for (const [url,limit] of [["/body-probe",65536],["/import-probe",1048576]] as const) {
        expect((await app.inject({method:"POST",url,headers:{"content-type":"text/plain"},payload:"x".repeat(limit)})).json()).toEqual({bytes:limit});
        expect((await app.inject({method:"POST",url,headers:{"content-type":"text/plain"},payload:"x".repeat(limit+1)})).statusCode).toBe(413);
      }
      await app.listen({host:"127.0.0.1",port:0});
      const address=app.server.address();
      if (!address || typeof address==="string") throw new Error("Expected listening port");
      const status=await new Promise<number|undefined>((resolve,reject)=>{
        const req=request({hostname:"127.0.0.1",port:address.port,path:"/body-probe",method:"POST",headers:{"content-type":"text/plain","content-length":"65537"}},res=>{resolve(res.statusCode);res.resume();req.destroy();});
        req.on("error",reject);
        req.flushHeaders(); // Send no body: response proves rejection before buffering.
      });
      expect(status).toBe(413);
    } finally {await app.close();}
  });
});


import { requestOperation } from "../../services/api/src/request-admission.js";
describe("request admission scope",()=>{
  it("excludes management, ordinary provider configuration, progress, health, and authoring's owned admission",()=>{
    for(const [method,path] of [["POST","/api/v1/settings/operator-session"],["POST","/api/v1/providers"],["GET","/api/v1/providers"],["GET","/api/v1/imports/progress"],["GET","/health/ready"],["POST","/api/v1/authoring/jobs"],["POST","/api/v1/generation-jobs/:jobId/cancel"]]) expect(requestOperation(method!,path!)).toBeNull();
  });
});

import Fastify from "fastify";
import { PassThrough } from "node:stream";
import { installRequestAdmission } from "../../services/api/src/request-admission.js";
describe("request lease lifecycle",()=>{
  it("holds streaming capacity until client abort and releases exactly once",async()=>{
    const app=Fastify();
    const pool={query:async()=>({rows:[{id:"11111111-1111-4111-8111-111111111111"}]})} as unknown as DatabasePool;
    const release=vi.fn(async()=>undefined);
    installRequestAdmission(app,pool,bootstrap(),{acquire:async()=>({allowed:true,leaseId:"lease",remaining:1,expiresAt:new Date()}),release});
    const stream=new PassThrough();
    app.get("/api/v1/providers/:providerId/models",(_req,reply)=>{reply.send(stream);stream.write("first");});
    try {
      await app.listen({host:"127.0.0.1",port:0});
      const address=app.server.address();if(!address||typeof address==="string")throw new Error("Expected port");
      await new Promise<void>((resolve,reject)=>{
        const req=request({hostname:"127.0.0.1",port:address.port,path:"/api/v1/providers/id/models"},res=>{
          res.once("data",()=>{try{expect(release).not.toHaveBeenCalled();res.destroy();resolve();}catch(error){reject(error);}});
        });req.on("error",reject);req.end();
      });
      await expect.poll(()=>release.mock.calls.length).toBe(1);
    }finally{stream.destroy();await app.close();}
    expect(release).toHaveBeenCalledTimes(1);
  });
  it("releases a provider lease once after a handler error",async()=>{
    const app=Fastify();
    const pool={query:async()=>({rows:[{id:"11111111-1111-4111-8111-111111111111"}]})} as unknown as DatabasePool;
    const release=vi.fn(async()=>undefined);
    installRequestAdmission(app,pool,bootstrap(),{acquire:async()=>({allowed:true,leaseId:"lease",remaining:1,expiresAt:new Date()}),release});
    app.get("/api/v1/providers/:providerId/models",()=>{throw new Error("provider failure");});
    try{expect((await app.inject({url:"/api/v1/providers/id/models"})).statusCode).toBe(500);await expect.poll(()=>release.mock.calls.length).toBe(1);}finally{await app.close();}
    expect(release).toHaveBeenCalledTimes(1);
  });
});

import { runtimeArchivePolicy } from "../../services/runtime/src/archive-policy.js";
describe("archive request intersections",()=>{
  it("intersects campaign compressed/json/image limits with import and asset ceilings",()=>{
    const config=bootstrap();
    config.security.apiImportBodyLimitBytes=1048576;
    config.security.apiAssetBodyLimitBytes=1048576;
    const limits=runtimeArchivePolicy(config,"campaign").limits;
    expect(limits.maxCompressedBytes).toBe(1048576);
    expect(limits.maxJsonEntryBytes).toBe(1048576);
    expect(limits.maxOriginalImageBytes).toBe(1048576);
    config.campaignArchiveLimits={...config.campaignArchiveLimits,maxCompressedBytes:512,maxJsonEntryBytes:256,maxOriginalImageBytes:128};
    expect(runtimeArchivePolicy(config,"campaign").limits).toMatchObject({maxCompressedBytes:512,maxJsonEntryBytes:256,maxOriginalImageBytes:128});
  });
});

import multipart from "@fastify/multipart";
import { Readable } from "node:stream";
describe("chunked multipart ingress",()=>{
  it.each(["multipart/form-data", "Multipart/Form-Data"])("bounds exact/+1 total bytes for %s",async(mediaType)=>{
    const app=Fastify({bodyLimit:256});
    const pool={query:async()=>({rows:[{id:"11111111-1111-4111-8111-111111111111"}]})} as unknown as DatabasePool;
    installRequestAdmission(app,pool,bootstrap(),{acquire:async()=>({allowed:true,leaseId:null,remaining:1,expiresAt:new Date()}),release:async()=>undefined});
    await app.register(multipart,{limits:{fileSize:256}});
    app.post("/api/v1/imports/world/preview",async request=>{for await(const part of request.parts())if(part.type==="file")await part.toBuffer();return {accepted:true};});
    const prefix='--b\r\nContent-Disposition: form-data; name="file"; filename="f"\r\nContent-Type: application/octet-stream\r\n\r\n',suffix='\r\n--b--\r\n';
    const data=prefix+"x".repeat(256-Buffer.byteLength(prefix+suffix))+suffix;
    try {
      expect((await app.inject({method:"POST",url:"/api/v1/imports/world/preview",headers:{"content-type":`${mediaType}; boundary=b`},payload:Readable.from(data)})).statusCode).toBe(200);
      expect((await app.inject({method:"POST",url:"/api/v1/imports/world/preview",headers:{"content-type":`${mediaType}; boundary=b`},payload:Readable.from(data+" ")})).statusCode).toBe(413);
    }finally{await app.close();}
  });
});

describe("automatic provider HEAD admission",()=>{
  it("charges the same provider operation for HEAD and GET",()=>{
    expect(requestOperation("HEAD","/api/v1/providers/:providerId/models")).toBe("provider");
  });
  it("retains capacity after socket close until a nonabortable handler settles",async()=>{
    const app=Fastify();const pool={query:async()=>({rows:[{id:"11111111-1111-4111-8111-111111111111"}]})} as unknown as DatabasePool;
    const release=vi.fn(async()=>undefined);let finish!:()=>void,entered!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;});const waiting=new Promise<void>(resolve=>{finish=resolve;});
    installRequestAdmission(app,pool,bootstrap(),{acquire:async()=>({allowed:true,leaseId:"lease",remaining:1,expiresAt:new Date()}),release});
    app.get("/api/v1/providers/:providerId/models",async()=>{entered();await waiting;return {};});
    try{
      await app.listen({host:"127.0.0.1",port:0});const address=app.server.address();if(!address||typeof address==="string")throw new Error("port");
      const req=request({hostname:"127.0.0.1",port:address.port,path:"/api/v1/providers/id/models"});req.on("error",()=>{});req.end();await started;req.destroy();
      await new Promise(resolve=>setTimeout(resolve,30));expect(release).not.toHaveBeenCalled();finish();await expect.poll(()=>release.mock.calls.length).toBe(1);
    }finally{finish();await app.close();}
  });
});

describe("renewal failure retains actual-work ownership",()=>{
  it.each(["database unavailable","lease lost"])("returns503 and blocks new local work after %s without releasing running work",async message=>{
    const app=Fastify(),config=bootstrap();config.workerLeaseSeconds=0.06;
    const pool={query:async()=>({rows:[{id:"11111111-1111-4111-8111-111111111111"}]})} as unknown as DatabasePool;
    const release=vi.fn(async()=>undefined),renew=vi.fn(async()=>{throw new Error(message);});
    let finish!:()=>void,entered!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;}),waiting=new Promise<void>(resolve=>{finish=resolve;});
    installRequestAdmission(app,pool,config,{acquire:async()=>({allowed:true,leaseId:"lease",remaining:1,expiresAt:new Date()}),release,renew});
    app.get("/api/v1/providers/:providerId/models",async()=>{entered();await waiting;return {};});
    try{
      const response=app.inject({url:"/api/v1/providers/id/models"}).then(response=>response);
      await started;expect((await response).statusCode).toBe(503);expect(renew).toHaveBeenCalled();expect(release).not.toHaveBeenCalled();
      expect((await app.inject({url:"/api/v1/providers/id/models"})).statusCode).toBe(503);
      let closed=false;const closing=app.close().then(()=>{closed=true;});
      await new Promise(resolve=>setTimeout(resolve,20));expect(closed).toBe(false);
      finish();await closing;expect(release).toHaveBeenCalledTimes(1);
    }finally{finish();await app.close();}
  });
});
