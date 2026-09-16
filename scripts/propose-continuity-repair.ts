import { privateContinuityArtifactPath } from "./lib/private-continuity-artifact.js";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { buildContinuityRepairProposal, loadContinuityRepairSource, proposalRevisionIsStale } from "./lib/continuity-repair-proposal.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function required(name: string): string {
  const value = argument(name)?.trim();
  if (!value) throw new Error(`${name} requires a value.`);
  return value;
}

export async function main(): Promise<void> {
  if (process.argv.includes("--apply") || argument("--mode") === "apply") throw new Error("This tool only prepares read-only repair proposals; use the existing revision-checked API after separate approval.");
  const campaignId = required("--campaign");
  const ownerUserId = required("--owner-user");
  const worldVersionId = required("--world-version");
  const authorizedBy = required("--authorized-by");
  const expectedRevision = Number(required("--base-revision"));
  const baseTurnNumber = Number(required("--base-turn"));
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new Error("--base-revision must be a non-negative integer.");
  if (!Number.isInteger(baseTurnNumber) || baseTurnNumber < 0) throw new Error("--base-turn must be a non-negative integer.");
  const preflightArtifact = argument("--check-artifact");
  const directory = preflightArtifact ? null : required("--private-artifact-dir");
  const databaseUrl = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL or TEST_DATABASE_URL is required; no connection is inferred.");
  const target = directory ? await privateContinuityArtifactPath(directory, `continuity-repair-${campaignId}-${Date.now()}.json`, fileURLToPath(new URL("..", import.meta.url))) : null;
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const client = await pool.connect();
    try {
      const source = await loadContinuityRepairSource(client, campaignId, ownerUserId, worldVersionId, baseTurnNumber);
      if (source.baseRevision !== expectedRevision) throw new Error(`Stale base revision: expected ${expectedRevision}, current ${source.baseRevision}. No artifact was written.`);
      if (preflightArtifact) {
        const proposal = JSON.parse(await readFile(preflightArtifact, "utf8")) as ReturnType<typeof buildContinuityRepairProposal>;
        if (proposal.campaign.id !== campaignId || proposal.campaign.ownerUserId !== ownerUserId || proposal.campaign.worldVersionId !== worldVersionId
          || proposal.revisionGuard.expectedTurnNumber !== source.activeTurnNumber || proposal.revisionGuard.baseTurnNumber !== source.baseTurnNumber
          || proposalRevisionIsStale(proposal, { stateRevision: source.baseRevision, narrationCorrectionRevisions: source.effectiveNarrations })) throw new Error("The proposal is stale or belongs to another scope. Prepare and review a new proposal.");
        process.stdout.write("Proposal revision and retained narration guards remain current. No state was changed.\n");
        return;
      }
      const artifact = {
        ...buildContinuityRepairProposal(source),
        artifact: { private: true, authorizedBy, createdAt: new Date().toISOString(), retention: "operator-selected", applyPerformed: false }
      };
      await writeFile(target!, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      process.stdout.write(`${target}\n`);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
