import { defineConfig } from "vite";

const fastifyTarget = "http://127.0.0.1:8080";

export default defineConfig({
  base: "/app/",
  build: {
    emptyOutDir: true,
    manifest: true,
    outDir: "dist"
  },
  server: {
    proxy: {
      "/api": fastifyTarget,
      "/health": fastifyTarget,
      "/nexus": fastifyTarget,
      "/story": fastifyTarget,
      "/vendor": fastifyTarget
    }
  }
});
