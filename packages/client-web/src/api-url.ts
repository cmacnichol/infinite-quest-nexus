function hasUnsafeUrlCharacters(value: string): boolean {
  return /[\\\u0000-\u001F\u007F]/.test(value);
}

function hasDotSegment(value: string): boolean {
  return value.split("/").some((segment) => {
    try {
      const decoded = decodeURIComponent(segment);
      return decoded === "." || decoded === "..";
    } catch {
      return false;
    }
  });
}

export function normalizeBasePath(basePath: string): string {
  if (
    /^[a-z][a-z\d+.-]*:/i.test(basePath) ||
    basePath.startsWith("//") ||
    !basePath.startsWith("/") ||
    hasUnsafeUrlCharacters(basePath) ||
    hasDotSegment(basePath)
  ) {
    throw new TypeError("Base path must be API-relative and begin with '/'.");
  }
  return basePath.replace(/\/+$/, "");
}

export function apiPath(basePath: string, path: string): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith("//") || hasUnsafeUrlCharacters(path)) {
    throw new TypeError("Request path must be API-relative.");
  }
  if (!path.startsWith("/")) {
    throw new TypeError("Request path must begin with '/'.");
  }
  const delimiterIndex = path.search(/[?#]/);
  const pathname = delimiterIndex === -1 ? path : path.slice(0, delimiterIndex);
  if (hasDotSegment(pathname)) {
    throw new TypeError("Request path must not contain '.' or '..' segments.");
  }
  const joined = `${basePath}${path}`;
  const prefix = basePath === "" ? "/" : `${basePath}/`;
  if (!new URL(joined, "https://boundary.invalid").pathname.startsWith(prefix)) {
    throw new TypeError("Request path must stay within the API base path.");
  }
  return joined;
}
