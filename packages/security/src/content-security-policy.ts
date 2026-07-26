export function buildContentSecurityPolicy(imageOrigins: readonly string[]): string {
  const imgSources = ["'self'", "data:", "blob:", ...imageOrigins];
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `img-src ${imgSources.join(" ")}`,
    "connect-src 'self'",
    "font-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'"
  ].join("; ");
}
