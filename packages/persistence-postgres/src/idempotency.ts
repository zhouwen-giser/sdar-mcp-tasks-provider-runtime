import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AuthorizationContext } from "../../domain/src/index.js";

export interface IdempotencyInput {
  authorization: AuthorizationContext;
  operationName: string;
  idempotencyKey: string;
  argumentHash: string;
}

export type StoredInvocation =
  { kind: "task"; taskId: string } | { kind: "result"; result: Record<string, unknown> };

interface IdempotencyRow {
  argument_hash: string;
  stable_task_id: string;
  state: "PENDING" | "COMPLETE";
  task_id: string | null;
  synchronous_result: Record<string, unknown> | null;
}

export class IdempotencyRepository {
  constructor(readonly pool: Pool) {}

  async execute(
    input: IdempotencyInput,
    invoke: (stableTaskId: string, recovering: boolean) => Promise<StoredInvocation>,
  ): Promise<StoredInvocation> {
    const client = await this.pool.connect();
    const lockKey = lockIdentity(input);
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
      const row = await this.#find(client, input);
      if (row !== undefined && row.argument_hash !== input.argumentHash) {
        throw new Error("IDEMPOTENCY_KEY_CONFLICT");
      }
      if (row?.state === "COMPLETE") return completed(row);

      const recovering = row !== undefined;
      const stableTaskId = row?.stable_task_id ?? randomUUID();
      if (row === undefined) {
        await client.query(
          `INSERT INTO idempotency_record
            (authorization_context_hash, operation_name, idempotency_key,
             argument_hash, execution_mode, simulation_key, stable_task_id, state)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING')`,
          [
            input.authorization.hash,
            input.operationName,
            input.idempotencyKey,
            input.argumentHash,
            input.authorization.executionMode,
            input.authorization.simulationId ?? "",
            stableTaskId,
          ],
        );
      }

      const outcome = await invoke(stableTaskId, recovering);
      if (outcome.kind === "task") {
        await client.query(
          `UPDATE idempotency_record SET state='COMPLETE', task_id=$6,
             updated_at=clock_timestamp()
           WHERE authorization_context_hash=$1 AND operation_name=$2
             AND idempotency_key=$3 AND execution_mode=$4 AND simulation_key=$5`,
          keyValues(input, outcome.taskId),
        );
      } else {
        await client.query(
          `UPDATE idempotency_record SET state='COMPLETE', synchronous_result=$6::jsonb,
             updated_at=clock_timestamp()
           WHERE authorization_context_hash=$1 AND operation_name=$2
             AND idempotency_key=$3 AND execution_mode=$4 AND simulation_key=$5`,
          keyValues(input, JSON.stringify(outcome.result)),
        );
      }
      return outcome;
    } finally {
      await client
        .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey])
        .catch(() => undefined);
      client.release();
    }
  }

  async #find(client: PoolClient, input: IdempotencyInput): Promise<IdempotencyRow | undefined> {
    const result = await client.query<IdempotencyRow>(
      `SELECT argument_hash, stable_task_id, state, task_id, synchronous_result
       FROM idempotency_record
       WHERE authorization_context_hash=$1 AND operation_name=$2
         AND idempotency_key=$3 AND execution_mode=$4 AND simulation_key=$5`,
      keyValues(input),
    );
    return result.rows[0];
  }
}

function completed(row: IdempotencyRow): StoredInvocation {
  if (row.task_id !== null) return { kind: "task", taskId: row.task_id };
  if (row.synchronous_result !== null) return { kind: "result", result: row.synchronous_result };
  throw new Error("INVALID_COMPLETED_IDEMPOTENCY_RECORD");
}

function keyValues(input: IdempotencyInput, extra?: unknown): unknown[] {
  return [
    input.authorization.hash,
    input.operationName,
    input.idempotencyKey,
    input.authorization.executionMode,
    input.authorization.simulationId ?? "",
    ...(extra === undefined ? [] : [extra]),
  ];
}

function lockIdentity(input: IdempotencyInput): string {
  return JSON.stringify([
    input.authorization.hash,
    input.operationName,
    input.idempotencyKey,
    input.authorization.executionMode,
    input.authorization.simulationId,
  ]);
}
