import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/nexus/",
  publicDir: "public",
  plugins: [{
    name: "legacy-management-development-entry",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split("?", 1)[0] !== "/nexus/legacy-management.js") return next();
        try {
          const transformed = await server.transformRequest("/src/legacy-management-entry.ts");
          if (!transformed) return next();
          response.statusCode = 200;
          response.setHeader("Content-Type", "text/javascript");
          response.end(transformed.code);
        } catch (error) {
          next(error as Error);
        }
      });
    }
  }],
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
