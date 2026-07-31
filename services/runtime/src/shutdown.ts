import { logger } from "../../../packages/logger/src/index.js";

type ClosablePool = {
  end(): Promise<void>;
};

type ForceExit = (code: number) => void;

export const DATABASE_POOL_SHUTDOWN_TIMEOUT_MS = 4_000;

export async function closeDatabasePool(
  pool: ClosablePool,
  timeoutMs = DATABASE_POOL_SHUTDOWN_TIMEOUT_MS,
  forceExit: ForceExit = (code) => process.exit(code)
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const closed = await Promise.race([
    pool.end().then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref();
    })
  ]);
  if (timer) clearTimeout(timer);
  if (!closed) {
    logger.error({
      event: "database_pool_shutdown_timeout",
      timeoutMs
    });
    forceExit(1);
  }
  return closed;
}
