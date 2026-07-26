// JSON payloads should remain far below this even at the largest supported model output.
export const MAX_PROVIDER_JSON_RESPONSE_BYTES = 4 * 1024 * 1024;
// Streaming envelopes add protocol overhead, so SSE receives a separate conservative ceiling.
export const MAX_PROVIDER_SSE_RESPONSE_BYTES = 8 * 1024 * 1024;
// Sogni workflow snapshots contain metadata and temporary URLs, not image bytes.
export const MAX_SOGNI_RESPONSE_BYTES = 2 * 1024 * 1024;
// Artifact persistence accepts up to two 20 MiB images from one provider response.
export const MAX_IMAGE_ARTIFACT_BYTES = 20 * 1024 * 1024;
const MAX_BASE64_IMAGE_BYTES = Math.ceil(MAX_IMAGE_ARTIFACT_BYTES / 3) * 4;
// Allow two maximum-size base64 artifacts plus conservative JSON/metadata overhead.
export const MAX_IMAGE_PROVIDER_RESPONSE_BYTES = MAX_BASE64_IMAGE_BYTES * 2 + 1024 * 1024;

export class ProviderResponseTooLargeError extends Error {
  readonly code = "provider_response_too_large";
  readonly statusCode = 502;
  readonly expose = true;
  readonly permanent = true;
  readonly retryable = false;

  constructor(readonly limitBytes: number) {
    super("The provider response exceeded the server's safe size limit.");
    this.name = "ProviderResponseTooLargeError";
  }
}

export async function readBoundedResponseText(response: Response, limitBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
    await response.body?.cancel();
    throw new ProviderResponseTooLargeError(limitBytes);
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > limitBytes) {
        await reader.cancel();
        throw new ProviderResponseTooLargeError(limitBytes);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
