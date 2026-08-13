import { Readable } from "node:stream";
import type {
  PrivateBoundedStreamSession,
  PrivateStreamTerminalReason
} from "../../../packages/application/src/assets/private-secure-storage.js";

type CloseEmitter = Readonly<{
  once(event: "close", listener: () => void): unknown;
}>;

/**
 * Bridges a bounded private storage session into a Fastify response stream.
 * The adapter keeps path authority and owns idempotent session finalization;
 * this route layer supplies the observable HTTP terminal reason.
 */
export function createAssetDeliveryStream(
  session: Pick<PrivateBoundedStreamSession, "chunks" | "finalize">,
  response: CloseEmitter,
): Readable {
  let responseClosed = false;
  let terminalReason: PrivateStreamTerminalReason = "eof";
  const chunks = (async function* (): AsyncGenerator<Uint8Array> {
    try {
      for await (const chunk of session.chunks) yield chunk;
    } catch (error) {
      terminalReason = responseClosed ? "close" : "read_failure";
      throw error;
    } finally {
      await session.finalize(terminalReason).catch(() => undefined);
    }
  })();
  const stream = Readable.from(chunks);
  response.once("close", () => {
    responseClosed = true;
    terminalReason = "close";
    void session.finalize("close").catch(() => undefined);
    if (!stream.destroyed) stream.destroy();
  });
  return stream;
}
