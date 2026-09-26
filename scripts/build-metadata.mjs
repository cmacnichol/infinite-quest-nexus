import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function buildMetadataFromGit(io = {
  revParse: () => execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  statusPorcelain: () => execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }),
  now: () => new Date()
}) {
  return { commit: io.revParse(), dirty: io.statusPorcelain().trim().length > 0, date: io.now().toISOString() };
}

// Prints shell-compatible assignments for `docker compose build`.
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const metadata = buildMetadataFromGit();
  process.stdout.write(`NEXUS_BUILD_COMMIT=${metadata.commit}\nNEXUS_BUILD_DIRTY=${metadata.dirty}\nNEXUS_BUILD_DATE=${metadata.date}\n`);
}
