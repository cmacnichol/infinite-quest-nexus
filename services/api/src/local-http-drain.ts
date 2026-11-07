import type { FastifyInstance } from "fastify";

const RESTART_PATH = "/api/v1/settings/instance/restart";

/** Wait for both the HTTP response and the work an admitted handler performs. */
export function installLocalHttpDrain(app: FastifyInstance, isDraining: () => boolean): () => Promise<void> {
  const active = new Set<Promise<void>>();
  function begin() {
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    active.add(done);
    return () => { active.delete(done); finish(); };
  }

  function isWork(path: string) {
    return path.startsWith("/api/") && path !== RESTART_PATH && !path.startsWith(RESTART_PATH + "/");
  }

  app.addHook("onRequest", async (request, reply) => {
    const path = request.routeOptions.url ?? request.url.split("?", 1)[0]!;
    if (!isWork(path)) return;
    if (isDraining()) return reply.code(503).send({ code: "settings_restart_draining" });
    const finish = begin();
    reply.raw.once("finish", finish);
    reply.raw.once("close", finish);
  });

  app.addHook("onRoute", options => {
    if (!isWork(options.url)) return;
    const handler = options.handler;
    options.handler = async function (request, reply) {
      if (reply.raw.destroyed) return;
      const finish = begin();
      try {
        return await handler.call(this, request, reply);
      } finally {
        finish();
      }
    };
  });

  return async () => {
    // Requests admitted before drain can finish parsing and enter their handler.
    while (active.size) await Promise.all(active);
  };
}
