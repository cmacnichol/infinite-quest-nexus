const PROHIBITED_IDENTITY_KEYS = new Set(["user_id", "userId", "owner_user_id", "ownerUserId"]);
const PROHIBITED_SECRET_TOKENS = new Set(["credential", "credentials", "token", "secret", "password"]);
const PROHIBITED_WHOLE_SECRET_KEYS = new Set(["apikey"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function semanticKeyTokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .split(/[^a-zA-Z0-9]+/gu)
    .filter((token) => token.length > 0)
    .map((token) => token.toLowerCase());
}

function isProhibitedCharacterWorkspaceKey(key: string): boolean {
  if (PROHIBITED_IDENTITY_KEYS.has(key)) return true;
  const tokens = semanticKeyTokens(key);
  return tokens.some((token) => PROHIBITED_SECRET_TOKENS.has(token)) ||
    tokens.some((token, index) => token === "api" && tokens[index + 1] === "key") ||
    (tokens.length === 1 && PROHIBITED_WHOLE_SECRET_KEYS.has(tokens[0] ?? ""));
}

/** Recursively removes application identity and credential-shaped fields at browser boundaries. */
export function sanitizeCharacterWorkspaceValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeCharacterWorkspaceValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isProhibitedCharacterWorkspaceKey(key))
      .map(([key, child]) => [key, sanitizeCharacterWorkspaceValue(child)])
  );
}
