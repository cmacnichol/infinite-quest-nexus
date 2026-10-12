import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { downloadArtifact } from "../../services/runtime/src/illustration-image-job-adapter.js";

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

describe("provider artifact download security", () => {
  it("downloads bytes through the production dispatcher with native fetch", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(tinyPng);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a local TCP address.");
    try {
      const result = await downloadArtifact(
        { source: "url", url: "https://artifacts.example/image.png" },
        5_000,
        false,
        {
          // Keep approval and the production dispatcher; route only the test request to a local server.
          fetcher: (_input, init) => fetch(`http://127.0.0.1:${address.port}/image.png`, init),
          resolve: async () => [{ address: "8.8.8.8", family: 4 as const }]
        }
      );
      expect(result).toEqual({ bytes: tinyPng, mimeType: "image/png" });
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("rejects a public artifact redirect to a private address before a second request", async () => {
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      if (String(input) === "https://artifacts.example/start") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://127.0.0.1/internal.png" }
        });
      }
      return new Response(tinyPng, { status: 200, headers: { "content-type": "image/png" } });
    });

    await expect(downloadArtifact(
      { source: "url", url: "https://artifacts.example/start" },
      5_000,
      false,
      {
        fetcher: fetcher as typeof fetch,
        resolve: async () => [{ address: "8.8.8.8", family: 4 as const }]
      }
    )).rejects.toMatchObject({ code: "private_artifact_host", permanent: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
