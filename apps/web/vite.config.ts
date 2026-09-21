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
      preserveEntrySignatures: "strict",
      input: {
        "legacy-client": fileURLToPath(new URL("./src/legacy-client-entry.ts", import.meta.url)),
        "legacy-management": fileURLToPath(new URL("./src/legacy-management-entry.ts", import.meta.url))
      },
      output: {
        minifyInternalExports: false,
        assetFileNames: "assets/[name]-[hash][extname]",
        chunkFileNames: "assets/[name]-[hash].js",
        entryFileNames: (chunk) => chunk.name === "legacy-client" || chunk.name === "legacy-management"
          ? `${chunk.name}.js`
          : "assets/[name]-[hash].js"
      }
    }
  }
});
