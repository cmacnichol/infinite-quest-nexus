import Fastify from "fastify";
import { describe,it,expect } from "vitest";
import { registerInstanceSettingsRoutes } from "../../services/api/src/instance-settings-routes.js";
import { installRequestSecurity } from "../../services/api/src/request-security.js";
import { bootstrap } from "../helpers/instance-settings-runtime.js";
import { SettingsHttpError } from "../../services/api/src/settings-operator-session.js";
function fixture(enabled=true,trustProxy=true,parentSecurity=false,bodyLimit=1048576,accessMode?: "local-single-user", restart?: import("../../services/api/src/instance-settings-routes.js").LocalSettingsRestartPort) {
 const app=Fastify({trustProxy,bodyLimit});
 if(parentSecurity)installRequestSecurity(app,bootstrap());
 registerInstanceSettingsRoutes(app,{accessMode,localSettingsRestart:restart,enabled:()=>enabled,resolveActor:async()=>"actor",settings:{read:async()=>({safe:true}),patch:async()=>({safe:true}),history:async()=>({events:[],nextCursor:null})},operatorSessions:{unlock:async()=>({token:"a".repeat(43),csrfToken:"csrf",expiresAt:new Date()}),authorize:async(token,_actor,csrf)=>{if(!token)throw new SettingsHttpError(401,"settings_unlock_required");if(csrf!==undefined&&csrf!=="csrf")throw new SettingsHttpError(403,"settings_csrf_invalid");return {id:"session"} as any;},restore:async(token)=>{if(!token)throw new SettingsHttpError(401,"settings_unlock_required");return {csrfToken:"csrf",expiresAt:new Date()};},revoke:async()=>{}}});return app;
}
const headers={host:"nexus.test","x-forwarded-proto":"https",origin:"https://nexus.test"};
describe("protected installation routes",()=>{
 it("requires TLS, exact origin and unlock while exposing only capability",async()=>{
  const app=fixture();
  expect((await app.inject({url:"/api/v1/settings/instance",headers})).statusCode).toBe(401);
  for(const origin of [undefined,"null","https://evil.test"]){expect((await app.inject({method:"POST",url:"/api/v1/settings/operator-session",headers:origin?{...headers,origin}:{host:headers.host,"x-forwarded-proto":"https"},payload:{managementKey:"secret"}})).statusCode).toBe(403);}
  expect((await app.inject({url:"/api/v1/settings/operator-session",headers:{host:"nexus.test"}})).statusCode).toBe(403);
  expect((await app.inject({url:"/api/v1/settings/operator-session",headers:{host:headers.host,"x-forwarded-proto":"https"}})).json()).toEqual({managementEnabled:true,unlocked:false});await app.close();
 });
 it("requires CSRF, limits bodies, rejects unknown input and has no activation endpoint",async()=>{
  const app=fixture();const authenticated={...headers,cookie:"iq_settings_operator="+"a".repeat(43)};
  expect((await app.inject({method:"PATCH",url:"/api/v1/settings/instance",headers:authenticated,payload:{}})).statusCode).toBe(403);
  expect((await app.inject({method:"POST",url:"/api/v1/settings/operator-session",headers,payload:{managementKey:"secret",actor:"forged"}})).statusCode).toBe(422);
  expect((await app.inject({method:"POST",url:"/api/v1/settings/operator-session",headers,payload:{managementKey:"s".repeat(70000)}})).statusCode).toBe(413);
  expect((await app.inject({method:"POST",url:"/api/v1/settings/instance/activate",headers})).statusCode).toBe(404);await app.close();
 });
 it("refuses a forged forwarded TLS header without trusted proxy configuration",async()=>{const app=fixture(true,false);expect((await app.inject({url:"/api/v1/settings/operator-session",headers})).statusCode).toBe(403);await app.close();});
 it("preserves forbidden status from production parent origin protection",async()=>{const app=fixture(true,true,true);const response=await app.inject({method:"POST",url:"/api/v1/settings/operator-session",headers:{...headers,origin:"https://evil.test"},payload:{managementKey:"planted-secret"}});expect(response.statusCode).toBe(403);expect(response.json()).toEqual({code:"settings_origin_invalid"});expect(response.body).not.toContain("planted-secret");await app.close();});
 it("reports disabled management",async()=>{const app=fixture(false);expect((await app.inject({url:"/api/v1/settings/operator-session",headers:{host:headers.host,"x-forwarded-proto":"https"}})).json()).toEqual({managementEnabled:false,unlocked:false});expect((await app.inject({url:"/api/v1/settings/instance",headers})).statusCode).toBe(503);await app.close();});
 it("keeps the management limit at exactly 65536 bytes independently of the default limit",async()=>{
  for (const bodyLimit of [1,1048576]) {
   const app=fixture(true,true,false,bodyLimit);
   const body=JSON.stringify({managementKey:"secret"});
   const payload=body+" ".repeat(65536-Buffer.byteLength(body));
   expect((await app.inject({method:"POST",url:"/api/v1/settings/operator-session",headers:{...headers,"content-type":"application/json"},payload})).statusCode).toBe(200);
   expect((await app.inject({method:"POST",url:"/api/v1/settings/operator-session",headers:{...headers,"content-type":"application/json"},payload:payload+" "})).statusCode).toBe(413);
   await app.close();
  }
 });

});

describe("local single-user installation routes", () => {
 it("permits only explicit loopback authority and exact same-origin mutations", async () => {
  const app=fixture(true,false,false,1048576,"local-single-user");
  const local={host:"localhost:3000"};
  expect((await app.inject({url:"/api/v1/settings/operator-session",headers:local})).json()).toEqual({managementEnabled:true,unlocked:true,accessMode:"local-single-user"});
  expect((await app.inject({url:"/api/v1/settings/instance",headers:local})).statusCode).toBe(200);
  for (const headers of [{host:"evil.test:3000"},{host:"localhost:3000","x-forwarded-for":"127.0.0.1"},{host:"localhost:3000",origin:"http://evil.test"},{host:"localhost:3000","sec-fetch-site":"cross-site"}]) expect((await app.inject({url:"/api/v1/settings/instance",headers})).statusCode).toBe(403);
  const patch={expectedRequestedRevision:"1",changes:{logLevel:"info"},reason:"test"};
  for (const headers of [local,{...local,origin:"http://evil.test","x-settings-local":"1"},{...local,origin:"http://localhost:3000"}]) expect((await app.inject({method:"PATCH",url:"/api/v1/settings/instance",headers,payload:patch})).statusCode).toBe(403);
  expect((await app.inject({method:"PATCH",url:"/api/v1/settings/instance",headers:{...local,origin:"http://localhost:3000","x-settings-local":"1"},payload:patch})).statusCode).toBe(200);
  await app.close();
 });
});

it("only exposes guarded restart operations in local mode", async () => {
 const operation = { operationId: "123e4567-e89b-42d3-a456-426614174000", revision: "2", status: "draining" as const };
 const restart = { isDraining: () => false, start: async (revision: string) => ({ ...operation, revision }), status: async () => operation };
 const local = fixture(true, false, false, 1048576, "local-single-user", restart);
 const headers = { host: "localhost:3000", origin: "http://localhost:3000", "x-settings-local": "1" };
 expect((await local.inject({ method: "POST", url: "/api/v1/settings/instance/restart", headers, payload: { expectedRequestedRevision: "2", operationId: operation.operationId } })).json()).toEqual(operation);
 expect((await local.inject({ method: "POST", url: "/api/v1/settings/instance/restart", headers: { host: "localhost:3000" }, payload: { expectedRequestedRevision: "2", operationId: operation.operationId } })).statusCode).toBe(403);
 expect((await local.inject({ url: "/api/v1/settings/instance/restart/op-1", headers })).statusCode).toBe(422);
 expect((await local.inject({ url: `/api/v1/settings/instance/restart/${operation.operationId}`, headers })).json()).toEqual(operation);
 const protectedApp = fixture(true, true, false, 1048576, undefined, restart);
 expect((await protectedApp.inject({ method: "POST", url: "/api/v1/settings/instance/restart", headers, payload: { expectedRequestedRevision: "2", operationId: operation.operationId } })).statusCode).toBe(404);
 await local.close(); await protectedApp.close();
});
