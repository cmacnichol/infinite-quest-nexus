import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { buildContentSecurityPolicy } from "../packages/security/src/content-security-policy.js";

const appRoot = resolve("apps/web-next/dist");
const fixtureRoot = resolve(".tmp/web-awesome-fixture");

function isSafeAppNavigation(url: string): boolean {
  const rawPath = url.split(/[?#]/u, 1)[0] ?? "";
  if (!rawPath.startsWith("/app/")) return false;
  let pathname: string;
  try {
    pathname = decodeURIComponent(rawPath);
  } catch {
    return false;
  }
  if (pathname.includes("\\") || pathname.includes("\0")) return false;
  if (pathname === "/app/assets" || pathname.startsWith("/app/assets/")) return false;
  const segments = pathname.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) return false;
  const finalSegment = segments.at(-1) ?? "";
  return finalSegment === "" || !finalSegment.includes(".");
}

async function main(): Promise<void> {
  const server = Fastify();
  const csp = buildContentSecurityPolicy([]);
  server.addHook("onRequest", async (_request, reply) => {
    reply.header("Content-Security-Policy", csp);
  });
  server.get("/health", async () => ({ status: "ok" }));
  server.get("/app", async (_request, reply) => reply.redirect("/app/", 308));

  await server.register(fastifyStatic, {
    root: appRoot,
    prefix: "/app/",
    decorateReply: false
  });
  await server.register(fastifyStatic, {
    root: fixtureRoot,
    prefix: "/ui-test/",
    decorateReply: false
  });

  server.setNotFoundHandler(async (request, reply) => {
    if (request.method === "GET" && isSafeAppNavigation(request.url)) {
      return reply.type("text/html; charset=utf-8").send(await readFile(resolve(appRoot, "index.html"), "utf8"));
    }
    return reply.code(404).send({ statusCode: 404, error: "Not Found" });
  });

  const close = async () => {
    await server.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  await server.listen({ host: "127.0.0.1", port: 43175 });
}

void main();
