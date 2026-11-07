import { once } from "node:events";
import { request } from "node:http";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { installLocalHttpDrain } from "../../services/api/src/local-http-drain.js";

it("drains a disconnected handler and rejects new API work while restart status stays reachable", async () => {
  const app = Fastify();
  let draining = false;
  const waitForDrain = installLocalHttpDrain(app, () => draining);
  let markEntered!: () => void;
  const entered = new Promise<void>(resolve => { markEntered = resolve; });
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const committed: string[] = [];
  app.post("/api/example", async () => {
    markEntered();
    await released;
    committed.push("completed");
    return { ok: true };
  });
  app.get("/api/v1/settings/instance/restart/:id", async () => ({ status: "draining" }));
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const client = request(url + "/api/example", { method: "POST" });
    client.on("error", () => {});
    client.end();
    await entered;
    const closed = once(client, "close").catch(() => {});
    client.destroy();
    await closed;
    draining = true;
    const drained = waitForDrain().then(() => committed.push("drained"));
    expect((await app.inject({ method: "POST", url: "/api/example" })).statusCode).toBe(503);
    expect((await app.inject("/api/v1/settings/instance/restart/test")).statusCode).toBe(200);
    expect(committed).toEqual([]);
    release();
    await drained;
    expect(committed).toEqual(["completed", "drained"]);
  } finally {
    release();
    await app.close();
  }
});
