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

function sensitiveConfigurationKey(key: string): boolean {
  const normalized = key.replaceAll(/[^a-z]/gi, "").toLowerCase();
  return SENSITIVE_CONFIGURATION_KEYS.has(normalized)
    || /(?:apikey|secret|token|password|passphrase|privatekey|credential)$/.test(normalized);
}

export function sanitizeSensitiveConfiguration(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeSensitiveConfiguration);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !sensitiveConfigurationKey(key))
    .map(([key, entry]) => [key, sanitizeSensitiveConfiguration(entry)]));
}
