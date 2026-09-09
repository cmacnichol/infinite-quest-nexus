import net from "node:net";

const postgresHost = process.env.STORY_ONLY_POSTGRES_HOST?.trim();
if (postgresHost !== "infinitequest-story-only-test") {
  throw new Error("Story-only signal runner requires the dedicated infinitequest-story-only-test PostgreSQL container.");
}

const proxy = net.createServer((client) => {
  const upstream = net.connect({ host: postgresHost, port: 5432 });
  client.pipe(upstream).pipe(client);
  const close = () => { client.destroy(); upstream.destroy(); };
  client.once("error", close);
  upstream.once("error", close);
});

await new Promise<void>((resolveProxy, rejectProxy) => {
  proxy.once("error", rejectProxy);
  proxy.listen(15439, "127.0.0.1", () => { proxy.off("error", rejectProxy); resolveProxy(); });
});
proxy.unref();

await import("./story-only-ui-runtime.js");
