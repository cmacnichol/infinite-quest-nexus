import { defineConfig } from "vite";
import { webAwesomeAssets } from "./build/web-awesome-assets.js";

const fastifyTarget = "http://127.0.0.1:8080";

export default defineConfig({
  base: "/app/",
  plugins: [webAwesomeAssets()],
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
