import { z } from "zod";
import { settingsRevisionSchema, type LocalSettingsRestartOperation } from "../../../packages/contracts/src/instance-settings.js";
import { SettingsConflictError } from "../../../packages/application/src/settings/index.js";
import { lockSettingsState, readSettingsState } from "../../../packages/database/src/instance-settings-repository.js";
import { withTransaction, type DatabasePool } from "../../../packages/database/src/pool.js";

type Row = { expected_active_revision: string | null; expected_epoch: string; id: string; revision: string; status: LocalSettingsRestartOperation["status"]; error: string | null };
function operation(row: Row): LocalSettingsRestartOperation {
  return { operationId: row.id, revision: row.revision, status: row.status, ...(row.error ? { error: row.error } : {}) };
}

/** Durable, installation-local state. The caller must prove exclusive local process ownership. */
export function createLocalSettingsRestartStore(pool: DatabasePool) {
  return {
    async start(revision: string, id: string): Promise<{ operation: LocalSettingsRestartOperation; expectedActiveRevision: string | null; expectedEpoch: string }> {
      settingsRevisionSchema.parse(revision);
      z.string().uuid().parse(id);
      return withTransaction(pool, async client => {
        await lockSettingsState(client);
        const existing = await client.query<Row>("SELECT id,revision,status,error,expected_active_revision,expected_epoch FROM local_settings_restart_operations WHERE id=$1 FOR UPDATE", [id]);
        if (existing.rows[0]) {
          if (existing.rows[0].revision !== revision) throw new Error("settings_restart_id_conflict");
          return { operation: operation(existing.rows[0]), expectedActiveRevision: existing.rows[0].expected_active_revision, expectedEpoch: existing.rows[0].expected_epoch };
        }
        const state = await readSettingsState(client);
        if (state.requestedRevision !== revision) throw new SettingsConflictError(state.requestedRevision);
        const pending = await client.query<Row>("SELECT id,revision,status,error,expected_active_revision,expected_epoch FROM local_settings_restart_operations WHERE status IN ('draining','restarting') FOR UPDATE");
        if (pending.rows[0]) throw new Error("settings_restart_id_conflict");
        if (state.activeRevision === revision) {
          const completed = await client.query<Row>("SELECT id,revision,status,error,expected_active_revision,expected_epoch FROM local_settings_restart_operations WHERE revision=$1 AND status='ready' ORDER BY created_at DESC LIMIT 1", [revision]);
          if (completed.rows[0]) return { operation: operation(completed.rows[0]), expectedActiveRevision: completed.rows[0].expected_active_revision, expectedEpoch: completed.rows[0].expected_epoch };
          throw new Error("settings_revision_already_active");
        }
        const { rows: [row] } = await client.query<Row>("INSERT INTO local_settings_restart_operations(id,revision,expected_active_revision,expected_epoch,status) VALUES($1,$2,$3,$4,'draining') RETURNING id,revision,status,error,expected_active_revision,expected_epoch", [id, revision, state.activeRevision, state.activationEpoch]);
        return { operation: operation(row!), expectedActiveRevision: row!.expected_active_revision, expectedEpoch: row!.expected_epoch };
      });
    },
    async status(id: string): Promise<LocalSettingsRestartOperation> {
      const { rows: [row] } = await pool.query<Row>("SELECT id,revision,status,error FROM local_settings_restart_operations WHERE id=$1", [id]);
      if (!row) throw new Error("settings_restart_not_found");
      return operation(row);
    },
    async setStatus(id: string, status: "restarting" | "ready" | "failed", error?: string): Promise<void> {
      await pool.query("UPDATE local_settings_restart_operations SET status=$2,error=$3,updated_at=clock_timestamp() WHERE id=$1 AND status IN ('draining','restarting')", [id,status,error ?? null]);
    },
    async setFailure(id: string, error: string): Promise<void> {
      await pool.query("UPDATE local_settings_restart_operations SET error=$2,updated_at=clock_timestamp() WHERE id=$1 AND status='failed'", [id,error]);
    },
    async recoverInterrupted(): Promise<string | undefined> {
      const { rows } = await pool.query<Pick<Row, "id" | "status">>(`UPDATE local_settings_restart_operations o
        SET status=CASE WHEN s.active_revision=o.revision AND s.activation_epoch=o.expected_epoch+1
          AND EXISTS (SELECT 1 FROM instance_settings_events e WHERE e.kind='activation' AND e.revision=o.revision AND e.maintenance_reference='local-restart/' || o.id::text)
          THEN 'restarting' ELSE 'failed' END,
        error=CASE WHEN s.active_revision=o.revision AND s.activation_epoch=o.expected_epoch+1
          AND EXISTS (SELECT 1 FROM instance_settings_events e WHERE e.kind='activation' AND e.revision=o.revision AND e.maintenance_reference='local-restart/' || o.id::text)
          THEN NULL ELSE 'interrupted' END, updated_at=clock_timestamp()
        FROM instance_settings_state s WHERE o.status IN ('draining','restarting') RETURNING o.id,o.status`);
      return rows.find(row => row.status === "restarting")?.id;
    }
  };
}
