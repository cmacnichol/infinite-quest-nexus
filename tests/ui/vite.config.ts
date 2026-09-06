import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { webAwesomeAssets } from "../../apps/web-next/build/web-awesome-assets.js";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export default {
  root: resolve(repositoryRoot, "tests/ui"),
  base: "/ui-test/",
  plugins: [webAwesomeAssets()],
  build: {
    emptyOutDir: true,
    outDir: resolve(repositoryRoot, ".tmp/web-awesome-fixture")
  }
};
