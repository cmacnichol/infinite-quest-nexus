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
         WHERE window_expires_at < $1 - interval '1 hour'
         ORDER BY window_expires_at
         LIMIT 100
      )`,
    [now]
  );
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
        WHERE owner_user_id = $1 AND operation = $2 AND expires_at <= $3`,
      [ownerUserId, policy.key, now]
    );

    if (policy.maxConcurrent !== null) {
      const duplicate = await client.query<LeaseRow>(
        `SELECT id
           FROM api_admission_leases
          WHERE owner_user_id = $1 AND operation = $2 AND request_id = $3`,
        [ownerUserId, policy.key, requestId]
      );
      if (duplicate.rows[0]) {
        const bucket = await client.query<Pick<BucketRow, "accepted_count">>(
          `SELECT accepted_count
             FROM api_admission_buckets
            WHERE owner_user_id = $1 AND operation = $2 AND window_started_at = $3`,
          [ownerUserId, policy.key, window.startedAt]
        );
        const remaining = Math.max(0, policy.maxRequests - (bucket.rows[0]?.accepted_count ?? 0));
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
        await rollback(client);
        transactionOpen = false;
        return { allowed: false, retryAfterSeconds: retryAfterSeconds(now, retryAt) };
      }
    }

    const bucket = await client.query<BucketRow>(
      `INSERT INTO api_admission_buckets (
         owner_user_id, operation, window_started_at, window_expires_at, accepted_count
       ) VALUES ($1,$2,$3,$4,1)
       ON CONFLICT (owner_user_id, operation, window_started_at)
       DO UPDATE SET accepted_count = api_admission_buckets.accepted_count + 1, updated_at = now()
       WHERE api_admission_buckets.accepted_count < $5
       RETURNING accepted_count, window_expires_at`,
      [ownerUserId, policy.key, window.startedAt, window.expiresAt, policy.maxRequests]
    );
    const accepted = bucket.rows[0];
    if (!accepted) {
      await rollback(client);
      transactionOpen = false;
      return {
        allowed: false,
        retryAfterSeconds: retryAfterSeconds(now, window.expiresAt)
      };
    }

    let leaseId: string | null = null;
    if (policy.maxConcurrent !== null) {
      const lease = await client.query<LeaseRow>(
        `INSERT INTO api_admission_leases (
           owner_user_id, operation, request_id, expires_at
         ) VALUES ($1,$2,$3,$4)
         RETURNING id`,
        [
          ownerUserId,
          policy.key,
          requestId,
          new Date(now.getTime() + policy.leaseSeconds * 1000)
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
      remaining: Math.max(0, policy.maxRequests - accepted.accepted_count),
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
