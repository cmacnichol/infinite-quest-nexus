import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/nexus/",
  publicDir: "public",
  build: {
    copyPublicDir: true,
    emptyOutDir: true,
    manifest: true,
    outDir: "dist",
    rollupOptions: {
      input: {
        "legacy-client": fileURLToPath(new URL("./src/legacy-client-entry.ts", import.meta.url))
      },
      output: {
        assetFileNames: "assets/[name]-[hash][extname]",
        chunkFileNames: "assets/[name]-[hash].js",
        entryFileNames: (chunk) => chunk.name === "legacy-client"
          ? "legacy-client.js"
          : "assets/[name]-[hash].js"
      }
    }
  }
});
