export function normalizeExactOrigin(value: string, settingName: string): string {
  if (value === "*") throw new Error(`${settingName} does not allow wildcard origins.`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${settingName} contains an invalid origin '${value}'.`);
  }
  if (!["http:", "https:"].includes(url.protocol)
      || url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash) {
    throw new Error(`${settingName} entries must be exact HTTP(S) origins without credentials, paths, queries, or fragments.`);
  }
  return url.origin;
}

export function parseExactOriginList(value: string | undefined, settingName: string): string[] {
  const entries = value?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [];
  return [...new Set(entries.map((entry) => normalizeExactOrigin(entry, settingName)))];
}
