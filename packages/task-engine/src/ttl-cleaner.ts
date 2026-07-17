import { randomUUID } from "node:crypto";
import type { TaskRepository } from "../../persistence-postgres/src/index.js";

export interface TtlCleanerTickResult {
  renewed: number;
  expired: number;
  purged: number;
}

export interface TtlCleanerOptions {
  batchSize?: number;
  purgeGraceMs?: number;
  onMetric?: (outcome: "renewed" | "expired" | "purged" | "error", amount?: number) => void;
}

export class TtlCleaner {
  readonly #batchSize: number;
  readonly #purgeGraceMs: number;
  readonly #onMetric: TtlCleanerOptions["onMetric"];

  constructor(
    readonly repository: TaskRepository,
    options: TtlCleanerOptions = {},
  ) {
    this.#batchSize = options.batchSize ?? 128;
    this.#purgeGraceMs = options.purgeGraceMs ?? 86_400_000;
    if (!Number.isInteger(this.#batchSize) || this.#batchSize < 1) {
      throw new RangeError("TTL_CLEANER_BATCH_SIZE_INVALID");
    }
    if (!Number.isInteger(this.#purgeGraceMs) || this.#purgeGraceMs < 1) {
      throw new RangeError("TTL_PURGE_GRACE_MS_INVALID");
    }
    this.#onMetric = options.onMetric;
  }

  async tick(now = new Date()): Promise<TtlCleanerTickResult> {
    const client = await this.repository.pool.connect();
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
        `SELECT task_id FROM provider_task
         WHERE expired_at IS NOT NULL AND purge_after <= $1
           AND NOT EXISTS (
             SELECT 1 FROM outbox_event
             WHERE aggregate_id=provider_task.task_id AND published_at IS NULL
           )
         ORDER BY purge_after, task_id
         FOR UPDATE SKIP LOCKED LIMIT $2`,
        [now, this.#batchSize],
      );
      const taskIds = purgeDue.rows.map((row) => row.task_id);
      if (taskIds.length > 0) {
        await client.query("DELETE FROM idempotency_record WHERE task_id = ANY($1::uuid[])", [
          taskIds,
        ]);
        await client.query("DELETE FROM outbox_event WHERE aggregate_id = ANY($1::uuid[])", [
          taskIds,
        ]);
        await client.query("DELETE FROM admission_intent WHERE task_id = ANY($1::uuid[])", [
          taskIds,
        ]);
        await client.query("DELETE FROM provider_task WHERE task_id = ANY($1::uuid[])", [taskIds]);
      }
      await client.query("COMMIT");
      const result = {
        renewed: renewed.rowCount ?? 0,
        expired: expired.rowCount ?? 0,
        purged: taskIds.length,
      };
      if (result.renewed > 0) this.#onMetric?.("renewed", result.renewed);
      if (result.expired > 0) this.#onMetric?.("expired", result.expired);
      if (result.purged > 0) this.#onMetric?.("purged", result.purged);
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      this.#onMetric?.("error");
      throw error;
    } finally {
      client.release();
    }
  }
}
