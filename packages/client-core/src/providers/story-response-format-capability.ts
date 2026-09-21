import { CURRENT_STORY_RESPONSE_FORMAT_CAPABILITY_IDENTITY } from "@infinite-quest/contracts";

type ExactStoryCapabilityOptions = Readonly<{
  modelId: string;
  streaming: boolean;
  isUnexpired: (expiresAt: string) => boolean;
}>;

export function isExactStoryResponseFormatCapability(capability: unknown, options: ExactStoryCapabilityOptions): boolean {
  if (!capability || typeof capability !== "object") return false;
  const value = capability as Record<string, unknown>;
  if (value.version !== 1 || value.model !== options.modelId || !Array.isArray(value.operations)) return false;
  return value.operations.some((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const operation = candidate as Record<string, unknown>;
    const expiresAt = typeof operation.expiresAt === "string" ? operation.expiresAt : null;
    return operation.operation === "story"
      && operation.streaming === options.streaming
      && operation.status === "verified"
      && operation.schemaVersion === CURRENT_STORY_RESPONSE_FORMAT_CAPABILITY_IDENTITY.schemaVersion
      && operation.schemaHash === CURRENT_STORY_RESPONSE_FORMAT_CAPABILITY_IDENTITY.schemaHash
      && expiresAt !== null
      && options.isUnexpired(expiresAt);
  });
}
