import Fastify from "fastify";
import { describe,it,expect } from "vitest";
import { registerInstanceSettingsRoutes } from "../../services/api/src/instance-settings-routes.js";
import { SettingsHttpError } from "../../services/api/src/settings-operator-session.js";
function fixture(enabled=true,trustProxy=true) {
 const app=Fastify({trustProxy});
 registerInstanceSettingsRoutes(app,{enabled:()=>enabled,resolveActor:async()=>"actor",settings:{read:async()=>({safe:true}),patch:async()=>({safe:true}),history:async()=>({events:[],nextCursor:null})},operatorSessions:{unlock:async()=>({token:"a".repeat(43),csrfToken:"csrf",expiresAt:new Date()}),authorize:async(token,_actor,csrf)=>{if(!token)throw new SettingsHttpError(401,"settings_unlock_required");if(csrf!==undefined&&csrf!=="csrf")throw new SettingsHttpError(403,"settings_csrf_invalid");return {id:"session"} as any;},restore:async(token)=>{if(!token)throw new SettingsHttpError(401,"settings_unlock_required");return {csrfToken:"csrf",expiresAt:new Date()};},revoke:async()=>{}}});return app;
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
 it("reports disabled management",async()=>{const app=fixture(false);expect((await app.inject({url:"/api/v1/settings/operator-session",headers:{host:headers.host,"x-forwarded-proto":"https"}})).json()).toEqual({managementEnabled:false,unlocked:false});expect((await app.inject({url:"/api/v1/settings/instance",headers})).statusCode).toBe(503);await app.close();});
});
