import { randomBytes } from "node:crypto";
import { chmod, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

const operatorKey = process.env.CREDENTIAL_ENCRYPTION_KEY?.trim();
const keyFile = process.env.CREDENTIAL_ENCRYPTION_KEY_FILE;

if (operatorKey) process.exit(0);
if (!keyFile) throw new Error("CREDENTIAL_ENCRYPTION_KEY_FILE is required when no CREDENTIAL_ENCRYPTION_KEY is supplied.");

await mkdir(dirname(keyFile), { recursive: true, mode: 0o700 });
await chmod(dirname(keyFile), 0o700);

try {
  const handle = await open(keyFile, "wx", 0o600);
  try {
    await handle.writeFile(`${randomBytes(32).toString("hex")}\n`, "utf8");
  } finally {
    await handle.close();
  }
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
}
