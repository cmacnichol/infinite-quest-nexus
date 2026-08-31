import type { Plugin } from "vite";
import { icons } from "@awesome.me/webawesome/dist/components/icon/library.system.js";

const assetPrefix = "web-awesome/system/";
const assetPathPattern = /^web-awesome\/system\/[a-z0-9-]+\/[a-z0-9-]+\.svg$/u;
const namePattern = /^[a-z0-9-]+$/u;

const webAwesomeLicense = `Copyright (c) 2025 Fonticons, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const iconNotice = "Font Awesome Free icons are included under their embedded license notices.\n";

function systemAssets(): Map<string, string> {
  const assets = new Map<string, string>();
  const manifest: Record<string, Record<string, string>> = {};

  for (const [variant, entries] of Object.entries(icons)) {
    if (!namePattern.test(variant)) throw new Error(`Unexpected Web Awesome icon variant: ${variant}`);
    manifest[variant] = {};
    for (const [name, source] of Object.entries(entries)) {
      if (!namePattern.test(name)) throw new Error(`Unexpected Web Awesome icon name: ${name}`);
      const path = `${assetPrefix}${variant}/${name}.svg`;
      if (!assetPathPattern.test(path)) throw new Error(`Invalid Web Awesome icon asset path: ${path}`);
      manifest[variant][name] = path;
      assets.set(path, source);
    }
  }

  assets.set(`${assetPrefix}manifest.json`, `${JSON.stringify(manifest)}\n`);
  assets.set("web-awesome/LICENSE.txt", webAwesomeLicense);
  assets.set(`${assetPrefix}NOTICE.txt`, iconNotice);
  return assets;
}

function contentType(path: string): string {
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  return "text/plain; charset=utf-8";
}

export function webAwesomeAssets(): Plugin {
  const assets = systemAssets();

  return {
    name: "web-awesome-system-assets",
    generateBundle() {
      for (const [fileName, source] of assets) {
        this.emitFile({ type: "asset", fileName, source });
      }
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const requestUrl = new URL(request.url ?? "/", "http://localhost");
        const base = server.config.base.endsWith("/") ? server.config.base : `${server.config.base}/`;
        if (!requestUrl.pathname.startsWith(base)) return next();
        const asset = assets.get(requestUrl.pathname.slice(base.length));
        if (!asset) return next();
        response.statusCode = 200;
        response.setHeader("Content-Type", contentType(requestUrl.pathname));
        response.setHeader("Cache-Control", "no-cache");
        response.end(asset);
      });
    }
  };
}
