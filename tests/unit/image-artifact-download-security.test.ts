import { describe, expect, it, vi } from "vitest";
import { downloadArtifact } from "../../services/api/src/image-service.js";

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

describe("provider artifact download security", () => {
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
