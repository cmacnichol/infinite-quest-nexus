import { registerIconLibrary } from "@awesome.me/webawesome/dist/components/icon/library.js";

type SystemIconManifest = Record<string, Record<string, string>>;

const assetPathPattern = /^web-awesome\/system\/[a-z0-9-]+\/[a-z0-9-]+\.svg$/u;
const namePattern = /^[a-z0-9-]+$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBaseUrl(baseUrl: string): URL {
  const root = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`, window.location.origin);
  if (root.origin !== window.location.origin) throw new Error("System icon assets must be same-origin.");
  return root;
}

function parseManifest(value: unknown, root: URL): SystemIconManifest {
  if (!isRecord(value)) throw new Error("System icon manifest must be an object.");
  const manifest: SystemIconManifest = {};
  for (const [variant, iconEntries] of Object.entries(value)) {
    if (!namePattern.test(variant) || !isRecord(iconEntries)) {
      throw new Error("System icon manifest contains an invalid variant.");
    }
    manifest[variant] = {};
    for (const [name, assetPath] of Object.entries(iconEntries)) {
      if (!namePattern.test(name) || typeof assetPath !== "string" || !assetPathPattern.test(assetPath)) {
        throw new Error("System icon manifest contains an invalid asset.");
      }
      const assetUrl = new URL(assetPath, root);
      if (assetUrl.origin !== root.origin || !assetUrl.pathname.startsWith(root.pathname)) {
        throw new Error("System icon manifest asset escapes the application base URL.");
      }
      manifest[variant][name] = assetPath;
    }
  }
  return manifest;
}

function resolveSystemIcon(manifest: SystemIconManifest, variant: string, name: string): string {
  return manifest[variant]?.[name]
    ?? manifest.regular?.[name]
    ?? manifest.regular?.["circle-question"]
    ?? (() => {
      throw new Error("System icon manifest is missing its fallback icon.");
    })();
}

export async function installSystemIcons(baseUrl: string): Promise<void> {
  const root = normalizeBaseUrl(baseUrl);
  const manifestUrl = new URL("web-awesome/system/manifest.json", root);
  const response = await fetch(manifestUrl);
  if (!response.ok) throw new Error(`Unable to load system icon manifest: ${response.status}`);
  const manifest = parseManifest(await response.json(), root);

  registerIconLibrary("system", {
    resolver: (name, _family, variant) => new URL(resolveSystemIcon(manifest, variant, name), root).toString(),
    mutator: (svg) => {
      if (!svg.hasAttribute("fill")) svg.setAttribute("fill", "currentColor");
    }
  });
}
