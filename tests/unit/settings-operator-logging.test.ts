import {describe,it,expect} from "vitest";
import pino from "pino";
import {createLoggerOptions} from "../../packages/logger/src/index.js";
describe("operator logger redaction",()=>{
 it("removes management bodies, cookies, CSRF and provider/database secrets in those bodies",()=>{
  let captured="";
  const {transport:_transport,...options}=createLoggerOptions();
  const logger=pino({...options,level:"info"},{write(chunk){captured+=chunk;}});
  logger.info({managementKey:"planted-management",csrfToken:"planted-csrf",req:{body:{databaseUrl:"postgresql://planted-secret",apiKey:"planted-provider"},headers:{cookie:"planted-cookie","x-settings-csrf":"planted-csrf"}},res:{headers:{"set-cookie":"planted-cookie"}}});
  expect(captured).not.toContain("planted");expect(captured).toContain("Redacted");
 });
});
