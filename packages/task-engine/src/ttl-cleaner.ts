import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { TaskRepository } from "../../persistence-postgres/src/index.js";

export interface TtlCleanerTickResult {
  renewed: number;
  expired: number;
  purged: number;
  blocked: number;
}

export interface TtlCleanerOptions {
  batchSize?: number;
  purgeGraceMs?: number;
  recoveryLeaseMs?: number;
  onMetric?: (
    outcome: "renewed" | "expired" | "purged" | "blocked" | "error",
    amount?: number,
  ) => void;
}

export class TtlCleaner {
  readonly #batchSize: number;
  readonly #purgeGraceMs: number;
  readonly #recoveryLeaseMs: number;
  readonly #onMetric: TtlCleanerOptions["onMetric"];

  constructor(
    readonly repository: TaskRepository,
    options: TtlCleanerOptions = {},
  ) {
    this.#batchSize = options.batchSize ?? 128;
    this.#purgeGraceMs = options.purgeGraceMs ?? 86_400_000;
    this.#recoveryLeaseMs = options.recoveryLeaseMs ?? 30_000;
    if (!Number.isInteger(this.#batchSize) || this.#batchSize < 1) {
      throw new RangeError("TTL_CLEANER_BATCH_SIZE_INVALID");
    }
    if (!Number.isInteger(this.#purgeGraceMs) || this.#purgeGraceMs < 1) {
      throw new RangeError("TTL_PURGE_GRACE_MS_INVALID");
    }
    if (!Number.isInteger(this.#recoveryLeaseMs) || this.#recoveryLeaseMs < 1) {
      throw new RangeError("RECOVERY_LEASE_MS_INVALID");
    }
    this.#onMetric = options.onMetric;
  }

  async tick(now = new Date()): Promise<TtlCleanerTickResult> {
    const client = await this.repository.pool.connect();
    let purged = 0;
    let blocked = 0;
    try {
      await client.query("BEGIN");
      const renewed = await client.query<{ task_id: string }>(
        `WITH due AS (
           SELECT task_id FROM provider_task
           WHERE internal_state NOT LIKE 'TERMINAL_%'
             AND ttl_ms IS NOT NULL
             AND (handle_expires_at IS NULL OR handle_expires_at <= $1)
           ORDER BY handle_expires_at NULLS FIRST, task_id
           FOR UPDATE SKIP LOCKED LIMIT $2
         )
         UPDATE provider_task task
         SET handle_expires_at=$1 + (task.ttl_ms * interval '1 millisecond')
         FROM due WHERE task.task_id=due.task_id
         RETURNING task.task_id`,
        [now, this.#batchSize],
      );
      const expired = await client.query<{ task_id: string }>(
        `WITH due AS (
           SELECT task_id FROM provider_task
           WHERE internal_state LIKE 'TERMINAL_%'
             AND expired_at IS NULL
             AND handle_expires_at IS NOT NULL
             AND handle_expires_at <= $1
           ORDER BY handle_expires_at, task_id
           FOR UPDATE SKIP LOCKED LIMIT $2
         )
         UPDATE provider_task task
         SET expired_at=$1,
             purge_after=$1 + ($3 * interval '1 millisecond')
         FROM due WHERE task.task_id=due.task_id
         RETURNING task.task_id`,
        [now, this.#batchSize, this.#purgeGraceMs],
      );
      for (const row of expired.rows) {
        await client.query(
          `INSERT INTO outbox_event(event_id,event_key,aggregate_id,event_type,payload)
           VALUES ($1,$2,$3,'task.expired',$4::jsonb)
           ON CONFLICT (event_key) DO NOTHING`,
          [
            randomUUID(),
            `${row.task_id}:expired`,
            row.task_id,
            JSON.stringify({ taskId: row.task_id, expiredAt: now.toISOString() }),
          ],
        );
      }
      const purgeDue = await client.query<{ task_id: string }>(
        `SELECT task_id
         FROM provider_task
         WHERE internal_state LIKE 'TERMINAL_%'
           AND expired_at IS NOT NULL
           AND purge_after <= $1
           AND NOT EXISTS (
             SELECT 1
             FROM outbox_event outbox
             WHERE outbox.aggregate_id = provider_task.task_id
               AND outbox.published_at IS NULL
           )
           AND NOT EXISTS (
             SELECT 1
             FROM task_command command
             WHERE command.task_id = provider_task.task_id
               AND command.state IN ('PENDING', 'CLAIMED', 'RETRY_WAIT')
           )
           AND NOT EXISTS (
             SELECT 1
             FROM admission_intent admission
              WHERE admission.task_id = provider_task.task_id
                AND admission.state IN ('PENDING', 'ACCEPTED', 'UNCERTAIN')
             )
         ORDER BY purge_after, task_id
         FOR UPDATE SKIP LOCKED LIMIT $2`,
        [now, this.#batchSize],
      );
      for (const row of purgeDue.rows) {
        const lockOwner = await this.#acquireRecoveryLease(client, row.task_id);
        if (lockOwner === null) {
          blocked += 1;
          continue;
        }
        try {
          await client.query("DELETE FROM task_input_request WHERE task_id=$1", [row.task_id]);
          await client.query("DELETE FROM idempotency_record WHERE task_id=$1", [row.task_id]);
          await client.query("DELETE FROM task_command WHERE task_id=$1", [row.task_id]);
          await client.query("DELETE FROM admission_intent WHERE task_id=$1", [row.task_id]);
          await client.query("DELETE FROM provider_task WHERE task_id=$1", [row.task_id]);
          purged += 1;
        } finally {
          await this.#releaseRecoveryLease(client, row.task_id, lockOwner);
        }
      }
      await client.query("COMMIT");
      const result = {
        renewed: renewed.rowCount ?? 0,
        expired: expired.rowCount ?? 0,
        purged,
        blocked,
      };
      if (result.renewed > 0) this.#onMetric?.("renewed", result.renewed);
      if (result.expired > 0) this.#onMetric?.("expired", result.expired);
      if (result.purged > 0) this.#onMetric?.("purged", result.purged);
      if (result.blocked > 0) this.#onMetric?.("blocked", result.blocked);
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      this.#onMetric?.("error");
      throw error;
    } finally {
      client.release();
    }
  }

  async #acquireRecoveryLease(client: PoolClient, taskId: string): Promise<string | null> {
    const leaseKey = `sdar-recovery:${taskId}`;
    const ownerId = randomUUID();
    const claimed = await client.query<{ owner_id: string }>(
      `INSERT INTO runtime_lease(lease_key, owner_id, fencing_token, expires_at)
       VALUES ($1,$2,1,clock_timestamp() + ($3::text || ' milliseconds')::interval)
       ON CONFLICT (lease_key) DO UPDATE SET
         owner_id=EXCLUDED.owner_id,
         fencing_token=runtime_lease.fencing_token+1,
         expires_at=EXCLUDED.expires_at,
         updated_at=clock_timestamp()
       WHERE runtime_lease.expires_at <= clock_timestamp()
       RETURNING owner_id`,
      [leaseKey, ownerId, this.#recoveryLeaseMs],
    );
    return claimed.rowCount === 1 ? (claimed.rows[0]?.owner_id ?? null) : null;
  }

  async #releaseRecoveryLease(client: PoolClient, taskId: string, ownerId: string): Promise<void> {
    await client.query("DELETE FROM runtime_lease WHERE lease_key=$1 AND owner_id=$2", [
      `sdar-recovery:${taskId}`,
      ownerId,
    ]);
  }
}
