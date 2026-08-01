import type { SessionPort } from "@infinite-quest/client-core";

const noOpSessionPort: SessionPort = {
  authorization: async () => ({}),
  onUnauthorized: async () => false
};

export function createNoopSessionPort(): SessionPort {
  return noOpSessionPort;
}
