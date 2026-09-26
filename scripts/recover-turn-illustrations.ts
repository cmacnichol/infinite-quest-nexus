import { logger } from "../packages/logger/src/index.js";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { createDatabasePool } from "../packages/database/src/pool.js";
import { recoverUnattachedIllustrations } from "../packages/database/src/illustration-recovery.js";

const args = process.argv.slice(2);
if (!args.includes("--owner") || !args.includes("--campaign") || args.some(arg => !["--owner", "--campaign", "--apply"].includes(arg) && arg.startsWith("--"))) {
  throw new Error("Usage: tsx scripts/recover-turn-illustrations.ts --owner UUID --campaign UUID [--apply]");
}
const ownerUserId = z.uuid().parse(args[args.indexOf("--owner") + 1]);
const campaignId = z.uuid().parse(args[args.indexOf("--campaign") + 1]);
const databaseUrl = process.env.DATABASE_URL || (process.env.DATABASE_URL_FILE
  ? (await readFile(process.env.DATABASE_URL_FILE, "utf8")).trim() : "");
if (!databaseUrl) throw new Error("DATABASE_URL or DATABASE_URL_FILE is required.");
const pool = createDatabasePool(databaseUrl, 1);
try {
  logger.info({ event: "illustration_recovery_report", apply: args.includes("--apply"), results: await recoverUnattachedIllustrations(pool, { ownerUserId, campaignId, apply: args.includes("--apply") }) });
} finally {
  await pool.end();
}
