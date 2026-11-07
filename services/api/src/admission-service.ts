import type {
  DatabaseClient,
  DatabasePool
} from "../../../packages/database/src/pool.js";

export type AdmissionPolicy = {
  key: "provider" | "generation" | "import";
  windowSeconds: number;
  maxRequests: number;
  maxConcurrent: number | null;
  leaseSeconds: number;
  durableRequest?: boolean;
};

export type AdmissionDecision =
  | {
      allowed: true;
      leaseId: string | null;
      remaining: number;
      expiresAt: Date;
    }
  | {
      allowed: false;
      retryAfterSeconds: number;
    };

export class AdmissionControlUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = "ADMISSION_CONTROL_UNAVAILABLE";
  readonly expose = true;

  constructor() {
    super("Admission control is temporarily unavailable.");
    this.name = "AdmissionControlUnavailableError";
  }
}

type BucketRow = {
  accepted_count: number;
  window_expires_at: Date;
};

type LeaseRow = {
  id: string;
};

type ConcurrencyRow = {
  active_count: number;
  retry_at: Date | null;
};

function fixedWindow(now: Date, windowSeconds: number): {
  startedAt: Date;
  expiresAt: Date;
} {
  const windowMilliseconds = windowSeconds * 1000;
  const startedAtMilliseconds = Math.floor(now.getTime() / windowMilliseconds) * windowMilliseconds;
  return {
    startedAt: new Date(startedAtMilliseconds),
    expiresAt: new Date(startedAtMilliseconds + windowMilliseconds)
  };
}

function retryAfterSeconds(now: Date, retryAt: Date): number {
  return Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 1000));
}

async function rollback(client: DatabaseClient): Promise<void> {
  await client.query("ROLLBACK");
}

async function cleanupExpiredBuckets(client: DatabaseClient, now: Date): Promise<void> {
  await client.query(
    `DELETE FROM api_admission_buckets
      WHERE ctid IN (
        SELECT ctid
         FROM api_admission_buckets
         WHERE window_expires_at < $1::timestamptz - interval '1 hour'
         ORDER BY window_expires_at
         LIMIT 100
      )`,
    [now]
  );
  // Reviewed windows cannot exceed one hour. Retain timestamp authority for
  // at least that lookback, independently of legacy fixed-window cleanup.
  await client.query(`DELETE FROM api_admission_events WHERE id IN (
    SELECT id FROM api_admission_events WHERE accepted_at < $1::timestamptz-interval '1 hour' LIMIT 100)`,[now]);
  await client.query(`DELETE FROM api_admission_windows WHERE ctid IN (
    SELECT ctid FROM api_admission_windows WHERE window_expires_at < $1::timestamptz-interval '1 hour' LIMIT 100)`,[now]);
}

export async function acquireAdmission(
  pool: DatabasePool,
  ownerUserId: string,
  requestId: string,
  policy: AdmissionPolicy,
  now = new Date()
): Promise<AdmissionDecision> {
  let client: DatabaseClient | undefined;
  let transactionOpen = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionOpen = true;

    const window = fixedWindow(now, policy.windowSeconds);
    const lockKey = `${ownerUserId}:${policy.key}`;
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
    await client.query(
      `DELETE FROM api_admission_leases
        WHERE owner_user_id = $1 AND operation = $2 AND expires_at <= $3 AND NOT request_running`,
      [ownerUserId, policy.key, now]
    );

    // Keep the old bucket key and SQL contract for rollback binaries. accounted_count
    // separates our timestamped events from history written by older binaries.
    const history = await client.query<{window_started_at:Date;window_expires_at:Date;unknown_count:number}>(
      `SELECT window_started_at, window_expires_at, accepted_count-accounted_count AS unknown_count
       FROM api_admission_buckets WHERE owner_user_id=$1 AND operation=$2
       AND window_expires_at>$3 AND accepted_count>accounted_count`,
      [ownerUserId, policy.key, new Date(now.getTime()-3600000)]
    );
    const unknownActive = history.rows.find(row => row.window_expires_at > now);
    await client.query(
      `INSERT INTO api_admission_windows(owner_user_id,operation,window_started_at,window_expires_at,max_requests)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_user_id,operation,window_started_at,window_expires_at)
       DO UPDATE SET max_requests=LEAST(api_admission_windows.max_requests,EXCLUDED.max_requests)`,
      [ownerUserId,policy.key,window.startedAt,window.expiresAt,policy.maxRequests]
    );
    const budgets = await client.query<{window_started_at:Date;window_expires_at:Date;max_requests:number;accepted_count:number}>(
      `SELECT w.window_started_at,w.window_expires_at,w.max_requests,
        (SELECT count(*)::int FROM api_admission_events e WHERE e.owner_user_id=w.owner_user_id
         AND e.operation=w.operation AND e.accepted_at>=w.window_started_at AND e.accepted_at<w.window_expires_at) AS accepted_count
       FROM api_admission_windows w WHERE w.owner_user_id=$1 AND w.operation=$2 AND w.window_expires_at>$3`,
      [ownerUserId,policy.key,now]
    );
    let availableRemaining = unknownActive ? 0 : policy.maxRequests;
    let retryAt = unknownActive?.window_expires_at ?? window.expiresAt;
    for (const budget of budgets.rows) {
      const unknown = history.rows.filter(row => row.window_expires_at>budget.window_started_at && row.window_started_at<budget.window_expires_at).reduce((sum,row)=>sum+row.unknown_count,0);
      const available = budget.max_requests-budget.accepted_count-unknown;
      availableRemaining=Math.min(availableRemaining,available);
      if (available<=0 && budget.window_expires_at>retryAt) retryAt=budget.window_expires_at;
    }

    if (policy.maxConcurrent !== null) {
      const duplicate = await client.query<LeaseRow>(
        `SELECT id
           FROM api_admission_leases
          WHERE owner_user_id = $1 AND operation = $2 AND request_id = $3`,
        [ownerUserId, policy.key, requestId]
      );
      if (duplicate.rows[0]) {
        const remaining = Math.max(0, availableRemaining);
        await cleanupExpiredBuckets(client, now);
        await client.query("COMMIT");
        transactionOpen = false;
        return {
          allowed: true,
          remaining,
          expiresAt: window.expiresAt,
          leaseId: duplicate.rows[0].id
        };
      }

      const concurrency = await client.query<ConcurrencyRow>(
        `SELECT count(*)::int AS active_count, min(expires_at) AS retry_at
           FROM api_admission_leases
          WHERE owner_user_id = $1 AND operation = $2`,
        [ownerUserId, policy.key]
      );
      const active = concurrency.rows[0]?.active_count ?? 0;
      if (active >= policy.maxConcurrent) {
        const retryAt = concurrency.rows[0]?.retry_at
          ?? new Date(now.getTime() + policy.leaseSeconds * 1000);
        await client.query("COMMIT");
        transactionOpen = false;
        return { allowed: false, retryAfterSeconds: retryAfterSeconds(now, retryAt) };
      }
    }

    if (availableRemaining<=0) {
      await client.query("COMMIT");
      transactionOpen=false;
      return {allowed:false,retryAfterSeconds:retryAfterSeconds(now,retryAt)};
    }
    const remaining=availableRemaining-1;
    await client.query(`INSERT INTO api_admission_events(owner_user_id,operation,accepted_at) VALUES($1,$2,$3)`,[ownerUserId,policy.key,now]);
    await client.query(
      `INSERT INTO api_admission_buckets(owner_user_id,operation,window_started_at,window_expires_at,accepted_count,accounted_count)
       VALUES($1,$2,$3,$4,1,1) ON CONFLICT(owner_user_id,operation,window_started_at)
       DO UPDATE SET accepted_count=api_admission_buckets.accepted_count+1,
       accounted_count=api_admission_buckets.accounted_count+1,
       window_expires_at=GREATEST(api_admission_buckets.window_expires_at,EXCLUDED.window_expires_at),updated_at=now()`,
      [ownerUserId,policy.key,window.startedAt,window.expiresAt]
    );

    let leaseId: string | null = null;
    if (policy.maxConcurrent !== null) {
      const lease = await client.query<LeaseRow>(
        `INSERT INTO api_admission_leases (
           owner_user_id, operation, request_id, expires_at, request_running
         ) VALUES ($1,$2,$3,$4,$5)
         RETURNING id`,
        [
          ownerUserId,
          policy.key,
          requestId,
          new Date(now.getTime() + policy.leaseSeconds * 1000),
          policy.durableRequest === true
        ]
      );
      const insertedLeaseId = lease.rows[0]?.id;
      if (!insertedLeaseId) throw new Error("Admission lease creation returned no identifier.");
      leaseId = insertedLeaseId;
    }

    await cleanupExpiredBuckets(client, now);
    await client.query("COMMIT");
    transactionOpen = false;
    return {
      allowed: true,
      remaining,
      expiresAt: window.expiresAt,
      leaseId
    };
  } catch {
    if (client && transactionOpen) {
      try {
        await rollback(client);
      } catch {
        // The safe admission error below intentionally hides rollback and storage details.
      }
    }
    throw new AdmissionControlUnavailableError();
  } finally {
    client?.release();
  }
}

export async function releaseAdmission(pool: DatabasePool, leaseId: string): Promise<void> {
  try {
    await pool.query("DELETE FROM api_admission_leases WHERE id = $1", [leaseId]);
  } catch {
    throw new AdmissionControlUnavailableError();
  }
}

/** Renewal cannot recreate a missing lease or change owner/request authority. */
export async function renewAdmission(pool:DatabasePool,leaseId:string,ownerUserId:string,requestId:string,operation:AdmissionPolicy["key"],leaseSeconds:number):Promise<void> {
  try {
    const result=await pool.query(`UPDATE api_admission_leases SET expires_at=clock_timestamp()+$6*interval '1 second'
      WHERE id=$1 AND owner_user_id=$2 AND request_id=$3 AND operation=$4 AND request_running=$5`,
      [leaseId,ownerUserId,requestId,operation,true,leaseSeconds]);
    if(result.rowCount!==1)throw new Error("lease_lost");
  }catch{throw new AdmissionControlUnavailableError();}
}
