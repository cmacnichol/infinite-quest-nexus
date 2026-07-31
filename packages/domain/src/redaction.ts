const SENSITIVE_CONFIGURATION_KEYS = new Set([
  "apikey",
  "customapikey",
  "lmstudioapikey",
  "imageapikey",
  "token",
  "accesstoken",
  "password",
  "authorization",
  "encryptedapikey",
  "credentialnonce",
  "credentialauthtag"
]);

export function sanitizeSensitiveConfiguration(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeSensitiveConfiguration);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !SENSITIVE_CONFIGURATION_KEYS.has(key.replaceAll(/[^a-z]/gi, "").toLowerCase()))
    .map(([key, entry]) => [key, sanitizeSensitiveConfiguration(entry)]));
}
