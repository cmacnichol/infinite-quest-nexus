import { readFile } from "node:fs/promises";
import { createDatabasePool, initialOwnerId, loadRuntimeConfig } from "../../../packages/database/src/index.js";
import { createInstanceSettingsRepository } from "../../../packages/database/src/instance-settings-repository.js";
import { instanceSettingsSchema, settingsRevisionSchema } from "../../../packages/contracts/src/instance-settings.js";
import { recoverRequestAdmission } from "./admission-recovery.js";
import { loadDeploymentSettingsPolicy, settingsDigest, loadActiveRuntimeSettings, readSettingsRuntimeReports, settingsReportsCompatible } from "./instance-settings.js";
import { createSettingsActivationGuard } from "./settings-activation.js";
import { createSeedPolicy, exportSettingsSeed, runInstanceSettingsCommand, runAdmissionRecoveryCommand } from "./settings-operator.js";
import { exportRollback, verifyRollback, transitionToEnvironment } from "./settings-rollback.js";

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));
const output = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");

async function main(args: string[]) {
  const [command, ...options] = args;
  function operands(...names: string[]) {
    if (options.length !== 2 * names.length || names.some((name, i) => options[2 * i] !== name || !options[2 * i + 1])) {
      throw new Error("settings_arguments_invalid");
    }
    return names.map((_, i) => options[2 * i + 1]!);
  }
  if (command === "create-policy") {
    const [input, installationId] = operands("--input", "--installation-id");
    output(createSeedPolicy(await readJson(input!), installationId!));
    return 0;
  }
  if (command === "verify-rollback") {
    const [input] = operands("--input");
    const policy = loadDeploymentSettingsPolicy(process.env.INSTANCE_SETTINGS_POLICY_FILE ?? "");
    output({ status: "ok", effectiveDigest: verifyRollback(await readJson(input!), policy).effectiveDigest });
    return 0;
  }

  const config = loadRuntimeConfig();
  if (command === "export-seed") {
    operands();
    output(exportSettingsSeed(config));
    return 0;
  }
  const pool = createDatabasePool(config.databaseUrl, config.databaseMaxConnections);
  try {
    if (command === "recover-admission") {
      return await runAdmissionRecoveryCommand(args, { output, readJson, recoverAdmission: input => recoverRequestAdmission(pool, input) });
    }
    const policy = loadDeploymentSettingsPolicy(config.instanceSettingsPolicyFile ?? "");
    if (policy.systemArchiveAllowLimitIncrease && config.systemArchiveAllowLimitIncrease !== true) throw new Error("settings_deployment_divergence");
    if (command === "export-rollback") {
      operands();
      output(await exportRollback(pool, config, policy));
      return 0;
    }
    const actor = { userId: await initialOwnerId(pool), cliReference: "settings-operator-cli" };
    if (command === "return-to-environment") {
      const [input, reference] = operands("--input", "--maintenance");
      await transitionToEnvironment(pool, config, policy, await readJson(input!), reference!, actor);
      output({ status: "ok", mode: "environment" });
      return 0;
    }
    const repository = createInstanceSettingsRepository(pool, { activationGuard: createSettingsActivationGuard(policy) });
    return await runInstanceSettingsCommand(args, {
      config, policy, repository, actor, output, readJson,
      readRevision: async revision => {
        const { rows: [row] } = await pool.query("SELECT snapshot FROM instance_settings_revisions WHERE revision=$1", [settingsRevisionSchema.parse(revision)]);
        return instanceSettingsSchema.parse(row?.snapshot);
      },
      status: async () => {
        const state = await repository.read();
        const reports = await readSettingsRuntimeReports(pool);
        const resolved = await loadActiveRuntimeSettings(pool, config, policy);
        const ready = state.mode === "database" && settingsReportsCompatible(reports, resolved, policy, true);
        return { mode: state.mode, activeRevision: state.activeRevision, requestedRevision: state.requestedRevision,
          activationEpoch: state.activationEpoch, policyDigest: settingsDigest(policy), ready, reports };
      }
    });
  } finally { await pool.end(); }
}

try { process.exitCode = await main(process.argv.slice(2)); }
catch (error) {
  const code = error instanceof Error && /^settings_[a-z_]+$/.test(error.message) ? error.message : "settings_operator_initialization_failed";
  output({ status: "error", code });
  process.exitCode = 1;
}
