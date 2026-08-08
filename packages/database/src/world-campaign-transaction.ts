import type {
  WorldCampaignCommandContext,
  WorldCampaignReadContext,
  WorldCampaignTransactionPort
} from "../../application/src/world-campaign/index.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";
import { withTransaction } from "./pool.js";

const databaseClient = Symbol("worldCampaignDatabaseClient");

type PostgresWorldCampaignContext = Readonly<{
  [databaseClient]: DatabaseClient;
}>;

function context(client: DatabaseClient): PostgresWorldCampaignContext {
  return Object.freeze({ [databaseClient]: client });
}

export function runPostgresWorldCampaignCommandWithClient<T>(
  client: DatabaseClient,
  work: (transaction: WorldCampaignCommandContext) => Promise<T>,
): Promise<T> {
  return work(context(client));
}

export function worldCampaignDatabaseClient(
  transaction: WorldCampaignCommandContext | WorldCampaignReadContext,
): DatabaseClient {
  if (!(databaseClient in transaction)) {
    throw new TypeError("World campaign repository operations require the caller-owned database client.");
  }
  return (transaction as PostgresWorldCampaignContext)[databaseClient];
}

export function createPostgresWorldCampaignTransactionPort(
  pool: DatabasePool,
): WorldCampaignTransactionPort {
  return {
    command: (work) => withTransaction(pool, (client) => work(context(client))),
    async read(work) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const value = await work(context(client));
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  };
}
