import type { SessionPort } from "../../client-core/src/ports.js";

const noOpSessionPort: SessionPort = {
  authorization: async () => ({}),
  onUnauthorized: async () => false
};

export function createNoopSessionPort(): SessionPort {
  return noOpSessionPort;
}
