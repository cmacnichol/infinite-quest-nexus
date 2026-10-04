import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/nexus/",
  publicDir: "public",
  plugins: [{
    name: "legacy-management-development-entry",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const stablePath = request.url?.split("?", 1)[0];
        const entryByPath = new Map<string, string>([
          ["/nexus/legacy-management.js", "/src/legacy-management-entry.ts"],
          ["/nexus/nexus.js", "/src/nexus.js"]
        ]);
        const entry = stablePath ? entryByPath.get(stablePath) : undefined;
        if (!entry) return next();
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/javascript");
        response.end(`export * from "/nexus${entry}";`);
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
        "legacy-management": fileURLToPath(new URL("./src/legacy-management-entry.ts", import.meta.url)),
        nexus: fileURLToPath(new URL("./src/nexus.js", import.meta.url))
      },
      output: {
        minifyInternalExports: false,
        assetFileNames: "assets/[name]-[hash][extname]",
        chunkFileNames: "assets/[name]-[hash].js",
        entryFileNames: (chunk) => chunk.name === "legacy-client" || chunk.name === "legacy-management" || chunk.name === "nexus"
          ? `${chunk.name}.js`
          : "assets/[name]-[hash].js"
      }
    }
  }
});
